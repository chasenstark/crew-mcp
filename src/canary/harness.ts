import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { execa } from 'execa';

import { writeAgentPrefsFile } from '../agent-prefs/store.js';
import { classifyTextFailure } from '../adapters/failure-classifier.js';
import { readRunAuthSidecar } from '../orchestrator/auth/token.js';
import { sendMessageToolHandler } from '../orchestrator/tools/send-message.js';
import { installCommand } from '../cli/commands/install.js';
import {
  applyScenarioPreseed,
  loadCanaryScenarios,
  readCanaryTrace,
  type CanaryScenario,
  type ScenarioAssertion,
} from './scenarios.js';

export const CANARY_HOSTS = ['claude-code', 'codex', 'agy'] as const;
export type CanaryHost = typeof CANARY_HOSTS[number];
export const WAKE_BRIDGE_CAVEAT =
  'codex exec --json does NOT exercise the hosted App Server wake bridge; '
  + 'that path needs the interactive `crew-mcp codex` launcher and stays with manual live smokes.';

export interface RotationSelection {
  readonly host: CanaryHost;
  readonly nextHost: CanaryHost;
}

export interface CanaryTrial {
  readonly scenarioId: string;
  readonly status: 'PASS' | 'FAIL' | 'SKIPPED';
  readonly detail: string;
}

export interface CanaryReport {
  readonly generatedAt: string;
  readonly host: CanaryHost;
  readonly nextHost: CanaryHost;
  readonly trialsPerScenario: number;
  readonly launcherNote: string;
  readonly trials: readonly CanaryTrial[];
}

interface Sandbox {
  readonly root: string;
  readonly repoRoot: string;
  readonly crewHome: string;
}

interface LaunchResult {
  readonly status: 'completed' | 'failed' | 'quota-limited' | 'not-wired';
  readonly detail: string;
  readonly jitNudges: readonly string[];
}

interface HostLauncher {
  readonly host: CanaryHost;
  readonly note: string;
  launch(args: { repoRoot: string; crewHome: string; prompt: string }): Promise<LaunchResult>;
}

export function selectAndAdvanceHost(
  statePath: string,
  requested?: CanaryHost,
): RotationSelection {
  let index = 0;
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as { nextHost?: unknown };
    const persisted = CANARY_HOSTS.indexOf(parsed.nextHost as CanaryHost);
    if (persisted >= 0) index = persisted;
  } catch {
    // Missing or malformed state starts at the first host.
  }
  const host = requested ?? CANARY_HOSTS[index];
  const selectedIndex = CANARY_HOSTS.indexOf(host);
  const nextHost = CANARY_HOSTS[(selectedIndex + 1) % CANARY_HOSTS.length];
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify({ nextHost }, null, 2)}\n`, 'utf-8');
  return { host, nextHost };
}

export function formatCanaryReport(report: CanaryReport): string {
  const rows = loadCanaryScenarios().map((scenario) => {
    const trials = report.trials.filter((trial) => trial.scenarioId === scenario.id);
    const passed = trials.filter((trial) => trial.status === 'PASS').length;
    const skipped = trials.filter((trial) => trial.status === 'SKIPPED').length;
    const detail = trials.map((trial) => `${trial.status}: ${trial.detail}`).join('<br>');
    return `| ${scenario.id} | ${passed}/${report.trialsPerScenario}`
      + `${skipped ? ` (${skipped} skipped)` : ''} | ${detail} |`;
  });
  return [
    `# Crew captain compliance canary — ${report.generatedAt.slice(0, 10)}`,
    '',
    '> TREND signal only. This canary is never a PR or merge gate.',
    '',
    `- Host: \`${report.host}\` (persisted rotation; next: \`${report.nextHost}\`)`,
    `- Trials per scenario: ${report.trialsPerScenario}`,
    `- Launcher: ${report.launcherNote}`,
    '',
    '| Scenario | pass@k | Trial detail |',
    '| --- | ---: | --- |',
    ...rows,
    '',
    '## Scope caveat',
    '',
    WAKE_BRIDGE_CAVEAT,
    '',
  ].join('\n');
}

export function writeCanaryReport(path: string, report: CanaryReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatCanaryReport(report), 'utf-8');
}

export async function runCanary(args: {
  readonly packageRoot: string;
  readonly rotationStatePath: string;
  readonly reportPath: string;
  readonly trialsPerScenario?: number;
  readonly host?: CanaryHost;
  readonly now?: Date;
  readonly log?: (message: string) => void;
}): Promise<CanaryReport> {
  const now = args.now ?? new Date();
  const k = args.trialsPerScenario ?? 2;
  if (!Number.isInteger(k) || k < 1) throw new Error('trialsPerScenario must be a positive integer');
  const rotation = selectAndAdvanceHost(args.rotationStatePath, args.host);
  const launcher = launcherFor(rotation.host);
  const log = args.log ?? console.log;
  log(`canary host=${rotation.host}; next=${rotation.nextHost}; ${launcher.note}`);

  const trials: CanaryTrial[] = [];
  let quotaStop: string | undefined;
  for (const scenario of loadCanaryScenarios()) {
    for (let trial = 0; trial < k; trial += 1) {
      if (quotaStop) {
        trials.push({ scenarioId: scenario.id, status: 'SKIPPED', detail: quotaStop });
        continue;
      }
      const result = await runTrial({
        scenario,
        launcher,
        packageRoot: args.packageRoot,
        now,
      });
      trials.push({ scenarioId: scenario.id, ...result });
      if (result.status === 'SKIPPED' && result.detail.startsWith('quota-limited:')) {
        quotaStop = result.detail;
      }
    }
  }
  const report: CanaryReport = {
    generatedAt: now.toISOString(),
    host: rotation.host,
    nextHost: rotation.nextHost,
    trialsPerScenario: k,
    launcherNote: launcher.note,
    trials,
  };
  writeCanaryReport(args.reportPath, report);
  log(`canary TREND report: ${args.reportPath}`);
  return report;
}

async function runTrial(args: {
  scenario: CanaryScenario;
  launcher: HostLauncher;
  packageRoot: string;
  now: Date;
}): Promise<Omit<CanaryTrial, 'scenarioId'>> {
  if (args.launcher.host !== 'claude-code') {
    return { status: 'SKIPPED', detail: args.launcher.note };
  }
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await provisionSandbox(args.packageRoot);
    applyScenarioPreseed({ scenario: args.scenario, ...sandbox, now: args.now });
    const launch = await args.launcher.launch({
      repoRoot: sandbox.repoRoot,
      crewHome: sandbox.crewHome,
      prompt: args.scenario.captainPrompt,
    });
    if (launch.status === 'quota-limited') {
      return { status: 'SKIPPED', detail: `quota-limited: ${launch.detail}` };
    }
    if (launch.status !== 'completed') {
      return { status: 'FAIL', detail: launch.detail };
    }
    const assertion: ScenarioAssertion = args.scenario.predicate(
      readCanaryTrace(sandbox.crewHome, launch.jitNudges),
    );
    return { status: assertion.pass ? 'PASS' : 'FAIL', detail: assertion.detail };
  } catch (err) {
    return { status: 'FAIL', detail: err instanceof Error ? err.message : String(err) };
  } finally {
    if (sandbox) rmSync(sandbox.root, { recursive: true, force: true });
  }
}

export async function provisionSandbox(
  packageRoot: string,
  options: { readonly afterRootCreated?: (root: string) => void } = {},
): Promise<Sandbox> {
  const root = mkdtempSync(join(tmpdir(), 'crew-canary-'));
  try {
    options.afterRootCreated?.(root);
    const repoRoot = join(root, 'repo');
    const crewHome = join(root, 'crew-home');
    mkdirSync(repoRoot, { recursive: true });
    await execa('git', ['init', '-q'], { cwd: repoRoot });
    await execa('git', ['config', 'user.email', 'canary@crew.invalid'], { cwd: repoRoot });
    await execa('git', ['config', 'user.name', 'Crew Canary'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), '# Crew canary fixture\n', 'utf-8');
    await execa('git', ['add', 'README.md'], { cwd: repoRoot });
    await execa('git', ['commit', '-qm', 'seed canary fixture'], { cwd: repoRoot });

    const fixturePackage = join(repoRoot, 'node_modules', 'crew-mcp');
    cpSync(join(packageRoot, 'dist'), join(fixturePackage, 'dist'), { recursive: true });
    copyFileSync(join(packageRoot, 'package.json'), join(fixturePackage, 'package.json'));
    const binDir = join(repoRoot, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    for (const [name, target] of [
      ['crew-mcp', '../crew-mcp/dist/index.js'],
      ['crew-wait', '../crew-mcp/dist/cli/wait.js'],
    ] as const) {
      const absoluteTarget = join(binDir, target);
      chmodSync(absoluteTarget, 0o755);
      symlinkSync(target, join(binDir, name));
    }

    const canaryBin = join(fixturePackage, 'dist', 'canary', 'cli.js');
    writeAgentPrefsFile(crewHome, {
      'canary-stub-write': genericStubPrefs(canaryBin, 'write'),
      'canary-stub-message': genericStubPrefs(canaryBin, 'message'),
    });
    const install = await installCommand({
      scope: 'project',
      target: 'claude-code',
      repoRoot,
      crewHome,
      packageRoot,
      skipRunningCheck: true,
      forceWithoutBinary: true,
    });
    if (!install.installed.includes('claude-code')) {
      throw new Error(`sandbox project install failed: ${JSON.stringify(install.skipped)}`);
    }
    return { root, repoRoot: realpathSync(repoRoot), crewHome };
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

function genericStubPrefs(commandPath: string, mode: 'write' | 'message') {
  return {
    adapter: 'generic',
    command: process.execPath,
    args: [commandPath, 'stub-worker', mode],
    strengths: ['canary-only'],
    useWhen: 'Only for the scripted Crew compliance canary.',
  } as const;
}

function launcherFor(host: CanaryHost): HostLauncher {
  if (host === 'claude-code') {
    return {
      host,
      note: 'wired: real `claude -p` captain; GenericAdapter workers are deterministic stubs',
      launch: launchClaudeCaptain,
    };
  }
  // When this launcher is implemented, gate it with the existing Codex
  // rollout-quota probe before spending a session. The probe is deferred with
  // the launcher in this first slice; Claude remains reactive quota -> SKIP.
  const note = host === 'codex'
    ? 'not wired yet: `codex exec --json` captain launcher (no captain launched)'
    : 'not wired yet: agy print-mode captain launcher (no captain launched)';
  return {
    host,
    note,
    launch: async () => ({ status: 'not-wired', detail: note, jitNudges: [] }),
  };
}

async function launchClaudeCaptain(args: {
  repoRoot: string;
  crewHome: string;
  prompt: string;
}): Promise<LaunchResult> {
  const result = await execa(
    'claude',
    [
      '-p',
      '-',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--max-turns',
      '20',
      '--mcp-config',
      join(args.repoRoot, '.mcp.json'),
      '--strict-mcp-config',
    ],
    {
      cwd: args.repoRoot,
      env: { ...process.env, CREW_HOME: args.crewHome },
      input: args.prompt,
      reject: false,
      timeout: Number(process.env.CREW_CANARY_TIMEOUT_MS ?? 300_000),
    },
  );
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const quota = claudeQuotaSignal(stdout, stderr);
  if (quota) return { status: 'quota-limited', detail: quota, jitNudges: [] };
  if (result.exitCode !== 0) {
    return {
      status: 'failed',
      detail: `claude exited ${result.exitCode ?? 'unknown'}: ${stderr.trim().slice(0, 300)}`,
      jitNudges: extractClaudeJitNudges(stdout),
    };
  }
  return {
    status: 'completed',
    detail: 'captain turn completed',
    jitNudges: extractClaudeJitNudges(stdout),
  };
}

function claudeQuotaSignal(stdout: string, stderr: string): string | undefined {
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === 'rate_limit_event') {
        const info = event.rate_limit_info as Record<string, unknown> | undefined;
        if (typeof info?.status === 'string' && info.status.toLowerCase() !== 'allowed') {
          return JSON.stringify(info).slice(0, 240);
        }
      }
      if (event.type === 'result' && event.is_error === true) {
        const signal = [event.terminal_reason, event.result].filter(Boolean).join(' ');
        const failure = classifyTextFailure(signal);
        if (failure.kind === 'quota_exhausted' || failure.kind === 'rate_limited') {
          return failure.rawSignal ?? signal;
        }
      }
    } catch {
      // Ignore non-JSON host output.
    }
  }
  const failure = classifyTextFailure(stderr);
  return failure.kind === 'quota_exhausted' || failure.kind === 'rate_limited'
    ? (failure.rawSignal ?? stderr.slice(0, 240))
    : undefined;
}

function extractClaudeJitNudges(stdout: string): string[] {
  const found = new Set<string>();
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type !== 'user') continue;
      const content = (event.message as { content?: unknown[] } | undefined)?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const record = block as Record<string, unknown>;
        if (record.type !== 'tool_result') continue;
        for (const text of collectStrings(record.content)) {
          if (
            text.includes('orphan_recovery:')
            || text.includes('unsurfaced_terminal:')
            || text.includes('long_poll_loop:')
            || text.includes('watcher_unknown_run_respawn:')
          ) found.add(text);
        }
      }
    } catch {
      // Ignore non-JSON host output.
    }
  }
  return [...found];
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
}

export async function runStubWorker(
  mode: string,
  options: { readonly cwd?: string; readonly crewHome?: string } = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  if (mode === 'write') {
    writeFileSync(join(cwd, 'canary-stub.txt'), 'deterministic canary edit\n', 'utf-8');
    process.stdout.write('Deterministic canary write completed.\n');
    return;
  }
  if (mode !== 'message') throw new Error(`Unknown canary stub mode: ${mode}`);
  const runId = basename(dirname(cwd));
  const crewHome = options.crewHome ?? (process.env.CREW_HOME
    ? resolve(process.env.CREW_HOME)
    : dirname(dirname(dirname(cwd))));
  const sidecar = readRunAuthSidecar(crewHome, runId);
  const result = await sendMessageToolHandler(
    {
      body: 'Deterministic canary worker message.',
      kind: 'status',
      to: { kind: 'captain' },
    },
    {
      crewHome,
      workerAuth: sidecar,
      env: { ...process.env, CREW_RUN_TOKEN: sidecar.token },
    },
  );
  if (result.isError) throw new Error(result.content[0]?.text ?? 'send_message failed');
  process.stdout.write('Deterministic canary send_message completed.\n');
}
