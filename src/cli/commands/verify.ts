/**
 * `crew-mcp verify` — sanity-check installed skill ↔ MCP tool catalog.
 *
 * Checks runtime prerequisites, then reads ~/.crew/install.json to learn what's
 * installed. For each installed target:
 *
 *   1. Skill file still exists.
 *   2. Skill text references every tool in the static catalog (and no
 *      extras — those would be stale references).
 *   3. Host config still contains the crew MCP block.
 *
 * Drift or failed runtime probes produce a clear message and a non-zero exit
 * code so CI / users can wire this into pre-flight scripts. Runtime probes are
 * idempotent, but may create expected Crew state directories.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

import { HOST_ADAPTERS, isGlobalHostId, type HostId } from '../../install/hosts/index.js';
import {
  readInstallManifest,
  type InstalledTarget,
} from '../../install/install-manifest.js';
import {
  absolutizeProjectTarget,
  readProjectInstallManifest,
} from '../../install/project-install-manifest.js';
import {
  projectCrewBinaryResolver,
} from '../../install/crew-binary.js';
import { resolveGitRepoRoot } from '../../install/repo-root.js';
import { parseInstallScope, type InstallScope } from '../../install/scope.js';
import { CATALOG_TOOLS } from '../../install/tool-catalog.js';
import {
  captainSkillTools,
  renderSkill,
  resolvePackageRoot,
  SKILL_MANIFEST,
  templatePathForHost,
} from '../../install/skill-renderer.js';
import { resolvePeerMessageCaps } from '../../orchestrator/peer-messages/caps.js';
import { runPeerMessagesPipeline } from '../../orchestrator/peer-messages/pipeline.js';
import { validatePeerMessagesPreflight } from '../../orchestrator/peer-messages/preflight.js';
import type { PeerMessageInput } from '../../orchestrator/peer-messages/schema.js';
import { resolveCrewHome } from '../../utils/crew-home.js';
import { logger } from '../../utils/logger.js';
import { resolveTargets } from './install.js';
import { CREW_MCP_VERSION } from '../version.js';

const CAPTAIN_CATALOG_TOOLS = captainSkillTools(CATALOG_TOOLS);

export interface VerifyOptions {
  /** Install scope. Defaults to global. */
  scope?: InstallScope | string;
  /** Optional selected targets for project/global verify. */
  target?: string;
  /** Override $HOME (tests). */
  home?: string;
  /** Override repository root for project-scope tests. */
  repoRoot?: string;
  /** Override `<crewHome>` (tests). Defaults to `$CREW_HOME` or `~/.crew`. */
  crewHome?: string;
  /** Override env for runtime cap verification (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Override package root containing canonical skill bodies (tests). */
  packageRoot?: string;
}

export interface VerifyTargetReport {
  host: HostId;
  ok: boolean;
  issues: string[];
}

export type VerifyProbeStatus = 'ok' | 'warn' | 'error';

export interface VerifyProbeReport {
  name: string;
  status: VerifyProbeStatus;
  message: string;
}

export interface VerifyReport {
  ok: boolean;
  probes: VerifyProbeReport[];
  targets: VerifyTargetReport[];
  /** Top-level note when the manifest itself is empty. */
  note?: string;
}

export async function verifyCommand(opts: VerifyOptions = {}): Promise<VerifyReport> {
  const scope = parseInstallScope(opts.scope);
  if (scope === 'project') {
    return verifyProjectCommand(opts);
  }
  return verifyGlobalCommand(opts);
}

async function verifyGlobalCommand(opts: VerifyOptions = {}): Promise<VerifyReport> {
  const home = opts.home ?? homedir();
  const crewHome = opts.crewHome
    ?? (opts.home ? join(opts.home, '.crew') : resolveCrewHome());
  const probes = await runRuntimeProbes({ crewHome, env: opts.env ?? process.env });
  const manifest = await readInstallManifest(home);
  // No-target global verify walks the manifest directly. Filter out
  // project-only hosts (e.g. agy) that a stale or hand-edited
  // install.json might list: they have no global config to verify and
  // must never be evaluated in global scope. They're covered by
  // `verify --scope project`.
  const installedTargets = opts.target
    ? resolveTargets(opts.target, 'global')
    : (Object.keys(manifest.targets) as HostId[]).filter((id) => {
        if (isGlobalHostId(id)) return true;
        logger.info(
          `crew verify: skipping project-only host "${id}" in global scope; run \`crew-mcp verify --scope project\` to check it.`,
        );
        return false;
      });

  if (installedTargets.length === 0) {
    const note = 'No installed targets. Run `crew install --target <host>` first.';
    logger.info(note);
    return {
      ok: probes.every((probe) => probe.status !== 'error'),
      probes,
      targets: [],
      note,
    };
  }

  const expectedNames = CAPTAIN_CATALOG_TOOLS.map((t) => `mcp__crew__${t.name}`);
  const reports: VerifyTargetReport[] = [];

  for (const targetId of installedTargets) {
    const adapter = HOST_ADAPTERS[targetId];
    const issues: string[] = [];
    const entry = manifest.targets[targetId];
    if (!entry) {
      const report: VerifyTargetReport = {
        host: targetId,
        ok: false,
        issues: [`install manifest missing target: ${targetId}`],
      };
      reports.push(report);
      logger.warn(`crew verify: ${adapter.displayName} drift (1 issue)`);
      logger.warn(`  - ${report.issues[0]}`);
      continue;
    }
    if (entry.version !== CREW_MCP_VERSION) {
      issues.push(
        `installed version ${entry.version || '(missing)'} does not match crew-mcp ${CREW_MCP_VERSION}`,
      );
    }

    // 1. Skill file(s) present + tool-reference parity. Union references
    // across ALL recorded skill files before comparing to the live
    // catalog — a tool present in only one skill is fine; the failure
    // mode is a live tool absent from every skill we installed.
    // Skills crew wrote for this host, PLUS skills it loads from a
    // shared search-path location (sharedSkills — no current host
    // produces them; retained capability). Both must exist and parse
    // for the host to function. Fall back to the back-compat single
    // skillPath only when neither map carries anything.
    const recordedSkillPaths = [
      ...Object.values(entry.skills ?? {}),
      ...Object.values(entry.sharedSkills ?? {}),
    ];
    if (recordedSkillPaths.length === 0 && entry.skillPath) {
      recordedSkillPaths.push(entry.skillPath);
    }
    const union = new Set<string>();
    let anySkillRead = false;
    for (const skillPath of recordedSkillPaths) {
      if (!existsSync(skillPath)) {
        issues.push(`skill file missing: ${skillPath}`);
        continue;
      }
      const skill = await readFile(skillPath, 'utf-8');
      for (const ref of extractToolReferences(skill)) {
        union.add(ref);
      }
      anySkillRead = true;
    }
    if (anySkillRead) {
      const missing = expectedNames.filter((name) => !union.has(name));
      const extras = [...union].filter((name) => !expectedNames.includes(name));
      if (missing.length > 0) {
        issues.push(`skill missing tool references: ${missing.join(', ')}`);
      }
      if (extras.length > 0) {
        issues.push(`skill references unknown tools: ${extras.join(', ')}`);
      }
    }
    issues.push(...await verifyCanonicalSkillContent({
      targetId,
      entry,
      installRoot: home,
      packageRoot: resolvePackageRoot(opts.packageRoot),
      scope: 'global',
    }));

    // 2. Host config still has crew MCP block.
    let config = '';
    if (!existsSync(entry.configPath)) {
      issues.push(`host config missing: ${entry.configPath}`);
    } else {
      config = await readFile(entry.configPath, 'utf-8');
      if (!adapter.hasMcpBlock(config)) {
        issues.push(`host config missing crew MCP block: ${entry.configPath}`);
      }
    }

    if (entry.autoApproved !== false) {
      issues.push(...await verifyAutoApproval({
        targetId,
        config,
        permissionsPath: adapter.permissionsPath?.(home),
      }));
    }

    if (targetId === 'claude-code') {
      issues.push(...await verifyClaudeCrewWaitAllowlist({
        permissionsPath: adapter.permissionsPath?.(home),
        crewWaitCommand: entry.crewWaitCommand,
      }));
    }

    const report: VerifyTargetReport = {
      host: targetId,
      ok: issues.length === 0,
      issues,
    };
    reports.push(report);

    if (report.ok) {
      logger.info(`crew verify: ${adapter.displayName} ✓`);
    } else {
      logger.warn(
        `crew verify: ${adapter.displayName} drift (${report.issues.length} issue${
          report.issues.length === 1 ? '' : 's'
        })`,
      );
      for (const issue of issues) {
        logger.warn(`  - ${issue}`);
      }
    }
  }

  const ok = reports.every((r) => r.ok);
  const probesOk = probes.every((probe) => probe.status !== 'error');
  if (!ok) {
    logger.warn('crew verify: drift detected. Run `crew install --target <host>` to re-sync.');
  }
  if (!probesOk) {
    logger.warn('crew verify: runtime prerequisite probe failed.');
  }
  return { ok: ok && probesOk, probes, targets: reports };
}

async function verifyProjectCommand(opts: VerifyOptions = {}): Promise<VerifyReport> {
  const home = opts.home ?? homedir();
  const repoRoot = await resolveGitRepoRoot({ repoRoot: opts.repoRoot });
  const manifest = await readProjectInstallManifest(repoRoot);
  const targets = opts.target
    ? resolveTargets(opts.target, 'project')
    : Object.keys(manifest.targets) as HostId[];

  if (targets.length === 0) {
    const note = 'No project installed targets. Run `crew-mcp install --scope project --target <host>` first.';
    logger.info(note);
    return { ok: true, probes: [], targets: [], note };
  }

  const expectedNames = CAPTAIN_CATALOG_TOOLS.map((t) => `mcp__crew__${t.name}`);
  const probes: VerifyProbeReport[] = [];
  const reports: VerifyTargetReport[] = [];
  let codexTrustChecked = false;

  for (const targetId of targets) {
    const adapter = HOST_ADAPTERS[targetId];
    const manifestEntry = manifest.targets[targetId];
    const issues: string[] = [];

    if (!manifestEntry) {
      issues.push(`project install manifest missing target: ${targetId}`);
      reports.push({ host: targetId, ok: false, issues });
      logger.warn(`crew verify: ${adapter.displayName} project drift (1 issue)`);
      logger.warn(`  - ${issues[0]}`);
      continue;
    }

    const entry = absolutizeProjectTarget(repoRoot, manifestEntry);
    if (entry.version !== CREW_MCP_VERSION) {
      issues.push(
        `installed version ${entry.version || '(missing)'} does not match crew-mcp ${CREW_MCP_VERSION}`,
      );
    }
    const recordedPaths = new Set(entry.writtenPaths);
    for (const path of recordedPaths) {
      if (!existsSync(path)) {
        issues.push(`recorded project file missing: ${path}`);
      }
    }

    const recordedSkillPaths = [
      ...Object.values(entry.skills ?? {}),
      ...Object.values(entry.sharedSkills ?? {}),
    ];
    if (recordedSkillPaths.length === 0 && entry.skillPath) {
      recordedSkillPaths.push(entry.skillPath);
    }

    const union = new Set<string>();
    let anySkillRead = false;
    for (const skillPath of recordedSkillPaths) {
      if (!existsSync(skillPath)) {
        issues.push(`skill file missing: ${skillPath}`);
        continue;
      }
      const skill = await readFile(skillPath, 'utf-8');
      for (const ref of extractToolReferences(skill)) {
        union.add(ref);
      }
      anySkillRead = true;
    }
    if (anySkillRead) {
      const missing = expectedNames.filter((name) => !union.has(name));
      const extras = [...union].filter((name) => !expectedNames.includes(name));
      if (missing.length > 0) {
        issues.push(`skill missing tool references: ${missing.join(', ')}`);
      }
      if (extras.length > 0) {
        issues.push(`skill references unknown tools: ${extras.join(', ')}`);
      }
    }
    issues.push(...await verifyCanonicalSkillContent({
      targetId,
      entry,
      installRoot: repoRoot,
      packageRoot: resolvePackageRoot(opts.packageRoot),
      scope: 'project',
    }));

    let config = '';
    if (!existsSync(entry.configPath)) {
      issues.push(`host config missing: ${entry.configPath}`);
    } else {
      config = await readFile(entry.configPath, 'utf-8');
      if (!adapter.hasMcpBlock(config)) {
        issues.push(`host config missing crew MCP block: ${entry.configPath}`);
      } else {
        const server = extractProjectServerConfig(targetId, config);
        if (!server) {
          issues.push(`host config crew MCP block is not readable: ${entry.configPath}`);
        } else {
          issues.push(...verifyProjectCommandPortable({
            home,
            repoRoot,
            entryCommand: entry.serverCommand,
            entryArgs: entry.serverArgs,
            configCommand: server.command,
            configArgs: server.args,
          }));
        }
      }
    }

    if (entry.autoApproved !== false) {
      issues.push(...await verifyAutoApproval({
        targetId,
        config,
        permissionsPath: entry.permissionsPath,
      }));
    }

    if (targetId === 'claude-code') {
      issues.push(...await verifyClaudeCrewWaitAllowlist({
        permissionsPath: entry.permissionsPath,
        crewWaitCommand: entry.crewWaitCommand,
      }));
    }

    if (targetId === 'codex' && !codexTrustChecked) {
      codexTrustChecked = true;
      if (!isCodexProjectTrusted(home, repoRoot)) {
        probes.push({
          name: 'codex-project-trust',
          status: 'warn',
          message: `Codex project trust missing for ${repoRoot}; project config is valid but this machine must trust the repo before Codex loads it.`,
        });
      } else {
        probes.push({
          name: 'codex-project-trust',
          status: 'ok',
          message: `Codex project trusted at ${repoRoot}`,
        });
      }
    }

    const report: VerifyTargetReport = {
      host: targetId,
      ok: issues.length === 0,
      issues,
    };
    reports.push(report);

    if (report.ok) {
      logger.info(`crew verify: ${adapter.displayName} project scope ✓`);
    } else {
      logger.warn(
        `crew verify: ${adapter.displayName} project drift (${report.issues.length} issue${
          report.issues.length === 1 ? '' : 's'
        })`,
      );
      for (const issue of issues) {
        logger.warn(`  - ${issue}`);
      }
    }
  }

  for (const probe of probes) {
    if (probe.status === 'ok') {
      logger.info(`crew verify: ${probe.message} ✓`);
    } else {
      logger.warn(`crew verify: WARNING: ${probe.message}`);
    }
  }

  const ok = reports.every((report) => report.ok);
  if (!ok) {
    logger.warn('crew verify: project drift detected. Run `crew-mcp install --scope project --target <host>` to re-sync.');
  }
  return { ok, probes, targets: reports };
}

async function verifyCanonicalSkillContent(args: {
  readonly targetId: HostId;
  readonly entry: InstalledTarget;
  readonly installRoot: string;
  readonly packageRoot: string;
  readonly scope: InstallScope;
}): Promise<string[]> {
  const adapter = HOST_ADAPTERS[args.targetId];
  const issues: string[] = [];
  for (const skill of SKILL_MANIFEST) {
    const spec = args.scope === 'project'
      ? adapter.projectSkillInstallSpecFor?.(args.installRoot, skill)
      : adapter.skillInstallSpecFor(args.installRoot, skill);
    if (!spec || spec.skip) continue;
    const installedPath = args.entry.skills?.[skill.id];
    if (!installedPath) {
      issues.push(
        `install manifest missing expected skill ${skill.id}: ${spec.skillPath}`,
      );
      continue;
    }
    if (installedPath !== spec.skillPath) {
      issues.push(
        `install manifest skill path mismatch for ${skill.id}: expected ${spec.skillPath}, got ${installedPath}`,
      );
      continue;
    }
    if (!existsSync(installedPath)) {
      // The general recorded-file pass reports the same missing path with
      // host-neutral wording. Keep canonical verification focused on the
      // manifest contract and avoid duplicating that issue.
      continue;
    }
    const expected = await renderSkill({
      templatePath: templatePathForHost(args.packageRoot, args.targetId),
      skill,
      spec,
      tools: CAPTAIN_CATALOG_TOOLS,
      crewWaitCommand: args.entry.crewWaitCommand,
      packageRoot: args.packageRoot,
    });
    const actual = await readFile(installedPath, 'utf-8');
    if (actual !== expected) {
      issues.push(`skill content stale: ${installedPath}`);
    }
  }
  return issues;
}

/**
 * Extract every `mcp__crew__<name>` token referenced in the skill text.
 * Tokens are matched as whole words (no embedded substrings of larger
 * tool names from other servers). Returns a Set so callers can do
 * fast membership checks.
 */
export function extractToolReferences(skill: string): Set<string> {
  const re = /mcp__crew__[a-z0-9_]+/g;
  const out = new Set<string>();
  for (const match of skill.matchAll(re)) {
    out.add(match[0]);
  }
  return out;
}

interface ProjectServerConfig {
  readonly command: string;
  readonly args: readonly string[];
}

function extractProjectServerConfig(
  targetId: HostId,
  config: string,
): ProjectServerConfig | null {
  // Claude Code and agy both store the crew server as JSON
  // (mcpServers.crew) — Claude at .mcp.json, agy at
  // .agents/mcp_config.json. Same extraction.
  if (targetId === 'claude-code' || targetId === 'agy') {
    try {
      const parsed = JSON.parse(config) as {
        mcpServers?: { crew?: { command?: unknown; args?: unknown } };
      };
      const crew = parsed.mcpServers?.crew;
      if (!crew || typeof crew.command !== 'string' || !Array.isArray(crew.args)) {
        return null;
      }
      return {
        command: crew.command,
        args: crew.args.filter((arg): arg is string => typeof arg === 'string'),
      };
    } catch {
      return null;
    }
  }

  if (targetId === 'codex') {
    const block = extractTomlBlock(config, '[mcp_servers.crew]');
    if (!block) return null;
    const commandMatch = block.match(/^command\s*=\s*"((?:\\.|[^"])*)"/m);
    const argsMatch = block.match(/^args\s*=\s*\[([^\]]*)\]/m);
    if (!commandMatch) return null;
    return {
      command: unescapeTomlString(commandMatch[1]),
      args: argsMatch ? parseTomlStringArray(argsMatch[1]) : [],
    };
  }

  return null;
}

function verifyProjectCommandPortable(args: {
  readonly home: string;
  readonly repoRoot: string;
  readonly entryCommand: string;
  readonly entryArgs: readonly string[];
  readonly configCommand: string;
  readonly configArgs: readonly string[];
}): string[] {
  const issues: string[] = [];
  if (args.entryCommand !== args.configCommand) {
    issues.push(
      `manifest serverCommand does not match host config command: ${args.entryCommand} != ${args.configCommand}`,
    );
  }
  if (JSON.stringify(args.entryArgs) !== JSON.stringify(args.configArgs)) {
    issues.push(
      `manifest serverArgs do not match host config args: ${JSON.stringify(args.entryArgs)} != ${JSON.stringify(args.configArgs)}`,
    );
  }

  const commandSets = [
    projectCrewBinaryResolver({ repoRoot: args.repoRoot, strategy: 'node-modules-bin', platform: 'darwin' }),
    projectCrewBinaryResolver({ repoRoot: args.repoRoot, strategy: 'node-modules-bin', platform: 'win32' }),
    projectCrewBinaryResolver({ repoRoot: args.repoRoot, strategy: 'npx' }),
  ];
  const matchesPortableCommand = commandSets.some((candidate) =>
    candidate.command === args.configCommand
    && JSON.stringify(candidate.args) === JSON.stringify(args.configArgs),
  );
  if (!matchesPortableCommand) {
    issues.push(
      `project server command is not portable: ${args.configCommand} ${args.configArgs.join(' ')}`.trim(),
    );
  }

  for (const value of [
    args.entryCommand,
    ...args.entryArgs,
    args.configCommand,
    ...args.configArgs,
  ]) {
    const forbidden = forbiddenProjectCommandReason(value, args.home, args.repoRoot);
    if (forbidden) {
      issues.push(`project server command contains ${forbidden}: ${value}`);
    }
  }

  return issues;
}

async function verifyAutoApproval(args: {
  readonly targetId: HostId;
  readonly config: string;
  readonly permissionsPath?: string;
}): Promise<string[]> {
  const issues: string[] = [];
  if (args.targetId === 'claude-code') {
    const permissions = args.permissionsPath && existsSync(args.permissionsPath)
      ? await readFile(args.permissionsPath, 'utf-8')
      : '';
    if (!permissions.includes('mcp__crew__*')) {
      issues.push('Claude Code permissions missing mcp__crew__* auto-approval');
    }
    return issues;
  }

  if (args.targetId === 'codex') {
    for (const tool of CATALOG_TOOLS) {
      const block = extractTomlBlock(args.config, `[mcp_servers.crew.tools.${tool.name}]`);
      if (!block || !/^approval_mode\s*=\s*"approve"/m.test(block)) {
        issues.push(`Codex config missing approval_mode = "approve" for ${tool.name}`);
      }
    }
  }
  return issues;
}

async function verifyClaudeCrewWaitAllowlist(args: {
  readonly permissionsPath?: string;
  readonly crewWaitCommand: string;
}): Promise<string[]> {
  const expected = `Bash(${args.crewWaitCommand}:*)`;
  const permissions = args.permissionsPath && existsSync(args.permissionsPath)
    ? await readFile(args.permissionsPath, 'utf-8')
    : '';
  return permissions.includes(expected)
    ? []
    : [`Claude Code permissions missing ${expected} allowlist`];
}

function forbiddenProjectCommandReason(
  value: string,
  home: string,
  repoRoot: string,
): string | null {
  if (value.length === 0) return null;
  if (home && value.includes(home)) return 'home directory path';
  if (repoRoot && value.includes(repoRoot)) return 'repo-absolute path';
  if (/\bdist[\\/]index\.js\b/.test(value) || /dist\\\\index\.js/.test(value)) {
    return 'dist/index.js path';
  }
  if (value.includes('process.argv')) return 'process.argv reference';
  if (posix.isAbsolute(value) || win32.isAbsolute(value)) return 'absolute path';
  return null;
}

function extractTomlBlock(raw: string, header: string): string | null {
  const start = raw.indexOf(header);
  if (start === -1) return null;
  const afterHeader = start + header.length;
  const next = raw.slice(afterHeader).search(/^\[/m);
  const end = next === -1 ? raw.length : afterHeader + next;
  return raw.slice(start, end);
}

function parseTomlStringArray(raw: string): string[] {
  const values: string[] = [];
  const re = /"((?:\\.|[^"])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    values.push(unescapeTomlString(match[1]));
  }
  return values;
}

function unescapeTomlString(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function isCodexProjectTrusted(home: string, repoRoot: string): boolean {
  const configPath = join(home, '.codex', 'config.toml');
  if (!existsSync(configPath)) return false;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const tableHeader = `[projects.${tomlString(repoRoot)}]`;
    const dotted = `projects.${tomlString(repoRoot)}.trust_level = "trusted"`;
    if (raw.includes(dotted)) return true;
    const block = extractTomlBlock(raw, tableHeader);
    return Boolean(block && /^trust_level\s*=\s*"trusted"/m.test(block));
  } catch {
    return false;
  }
}

function tomlString(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

interface RuntimeProbeOptions {
  readonly crewHome: string;
  readonly env: NodeJS.ProcessEnv;
}

async function runRuntimeProbes(options: RuntimeProbeOptions): Promise<VerifyProbeReport[]> {
  const probes = [
    await verifyStateLocksWritable(options.crewHome),
    await verifyPanelsWritable(options.crewHome),
    verifyPeerMessagesPipeline(options.env),
  ];

  for (const probe of probes) {
    if (probe.status === 'ok') {
      logger.info(`crew verify: ${probe.message} ✓`);
    } else {
      logger.warn(`crew verify: ${probe.message}`);
    }
  }

  return probes;
}

async function verifyStateLocksWritable(crewHome: string): Promise<VerifyProbeReport> {
  const stateLocksDir = join(crewHome, 'state-locks');
  const probePath = join(
    stateLocksDir,
    `verify-probe-${process.pid}-${Date.now()}.tmp`,
  );

  try {
    await mkdir(stateLocksDir, { recursive: true });
  } catch (error) {
    return {
      name: 'state-locks-writable',
      status: 'error',
      message: formatWritableProbeError(
        'state-locks/',
        'create',
        stateLocksDir,
        error,
        stateLocksDir,
      ),
    };
  }

  try {
    await writeFile(probePath, 'crew-mcp verify state-locks probe\n', 'utf-8');
  } catch (error) {
    return {
      name: 'state-locks-writable',
      status: 'error',
      message: formatWritableProbeError('state-locks/', 'write', probePath, error, stateLocksDir),
    };
  }

  try {
    await rm(probePath);
  } catch (error) {
    return {
      name: 'state-locks-writable',
      status: 'error',
      message: formatWritableProbeError('state-locks/', 'delete', probePath, error, stateLocksDir),
    };
  }

  return {
    name: 'state-locks-writable',
    status: 'ok',
    message: `state-locks/ writable at ${stateLocksDir}`,
  };
}

async function verifyPanelsWritable(crewHome: string): Promise<VerifyProbeReport> {
  const panelsDir = join(crewHome, 'panels');
  const probeDir = join(panelsDir, `crew-mcp-verify-probe-${randomUUID()}`);
  const probePath = join(probeDir, 'probe.txt');

  try {
    await mkdir(panelsDir, { recursive: true });
  } catch (error) {
    return {
      name: 'panels-writable',
      status: 'error',
      message: formatWritableProbeError('panels/', 'create', panelsDir, error, panelsDir),
    };
  }

  try {
    await mkdir(probeDir);
  } catch (error) {
    return {
      name: 'panels-writable',
      status: 'error',
      message: formatWritableProbeError('panels/', 'create', probeDir, error, panelsDir),
    };
  }

  try {
    await writeFile(probePath, 'crew-mcp verify panels probe\n', 'utf-8');
  } catch (error) {
    return {
      name: 'panels-writable',
      status: 'error',
      message: formatWritableProbeError('panels/', 'write', probePath, error, panelsDir),
    };
  }

  try {
    await rm(probePath);
  } catch (error) {
    return {
      name: 'panels-writable',
      status: 'error',
      message: formatWritableProbeError('panels/', 'delete', probePath, error, panelsDir),
    };
  }

  try {
    await rmdir(probeDir);
  } catch (error) {
    return {
      name: 'panels-writable',
      status: 'error',
      message: formatWritableProbeError('panels/', 'delete', probeDir, error, panelsDir),
    };
  }

  return {
    name: 'panels-writable',
    status: 'ok',
    message: `panels/ writable at ${panelsDir}`,
  };
}

function verifyPeerMessagesPipeline(env: NodeJS.ProcessEnv): VerifyProbeReport {
  try {
    const defaultCaps = resolvePeerMessageCaps({});
    const defaultExcerptBudget = defaultCaps.excerpt * defaultCaps.maxExcerpts;
    if (defaultCaps.overridesInvalid !== undefined) {
      return {
        name: 'peer-messages-caps-pipeline',
        status: 'error',
        message: `peer_messages default caps unexpectedly invalid: ${defaultCaps.overridesInvalid.join(', ')}`,
      };
    }
    if (
      defaultCaps.body > defaultExcerptBudget
      || defaultExcerptBudget > defaultCaps.aggregate
      || defaultCaps.aggregate > defaultCaps.hardCeiling
      || defaultCaps.hardCeiling > defaultCaps.composedPromptCap
    ) {
      return {
        name: 'peer-messages-caps-pipeline',
        status: 'error',
        message:
          'peer_messages default cap hierarchy invalid: expected body <= excerpt*maxExcerpts <= aggregate <= hardCeiling <= composedPromptCap',
      };
    }

    const caps = resolvePeerMessageCaps(env);
    if (caps.aggregate > caps.hardCeiling || caps.hardCeiling > caps.composedPromptCap) {
      return {
        name: 'peer-messages-caps-pipeline',
        status: 'error',
        message:
          'peer_messages runtime cap hierarchy invalid: expected aggregate <= hardCeiling <= composedPromptCap',
      };
    }

    const input: PeerMessageInput[] = [{
      body: 'Verify peer_messages plumbing.',
      kind: 'note',
      from_label: 'crew-mcp verify',
      files: ['src/cli/commands/verify.ts'],
      excerpts: [{
        file: 'src/cli/commands/verify.ts',
        range: [1, 1],
        text: 'peer_messages verify probe',
      }],
    }];
    const validated = validatePeerMessagesPreflight(input, caps);
    const pipelineResult = runPeerMessagesPipeline(validated, {
      renderedAt: new Date(0).toISOString(),
      renderedInTurn: 0,
      caps,
    });
    if (pipelineResult.rendered.trim().length === 0) {
      return {
        name: 'peer-messages-caps-pipeline',
        status: 'error',
        message: 'peer_messages validation probe rendered an empty prepend block',
      };
    }

    if (caps.overridesInvalid && caps.overridesInvalid.length > 0) {
      return {
        name: 'peer-messages-caps-pipeline',
        status: 'warn',
        message: `peer_messages.cap_overrides_invalid: ${caps.overridesInvalid.join(', ')}`,
      };
    }

    return {
      name: 'peer-messages-caps-pipeline',
      status: 'ok',
      message: 'peer_messages caps and pipeline validate',
    };
  } catch (error) {
    return {
      name: 'peer-messages-caps-pipeline',
      status: 'error',
      message: `peer_messages validation probe failed: ${formatErrorForMessage(error)}`,
    };
  }
}

function formatWritableProbeError(
  label: string,
  action: string,
  path: string,
  error: unknown,
  rootDir: string,
): string {
  const code = errorCode(error);
  const reason = formatErrorForMessage(error);
  return (
    `${label} probe failed to ${action} ${path}: ${code} ${reason}. ` +
    `Fix permissions so crew-mcp can create, write, and delete files under ${rootDir}.`
  );
}

function formatErrorForMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'UNKNOWN';
}
