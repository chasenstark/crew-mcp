import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveCrewHome } from '../utils/crew-home.js';

const POLL_INTERVAL_MS = 1_000;
/**
 * Time to wait for `state.json` to appear before exiting with a
 * diagnostic. The producer normally writes state.json within
 * milliseconds of dispatch (worktree allocation can lag); 30s gives a
 * generous slack for slow systems while still catching typos / stale
 * run IDs that would otherwise cause `crew-wait` to hang forever.
 */
const STATE_FIRST_APPEARANCE_GRACE_MS = 30_000;
/**
 * The four `markTerminal()` statuses per Decision 4 of the
 * non-blocking-captain plan. `merged`/`merge_conflict`/`discarded` are
 * post-terminal user actions, not dispatch terminations — `crew-wait`
 * does not target them. (Documented in
 * `docs/architecture/run-state-contract.md`.)
 */
const TERMINAL_STATUSES = new Set([
  'success',
  'partial',
  'error',
  'cancelled',
]);

interface PersistedRunState {
  readonly runId?: unknown;
  readonly agentId?: unknown;
  readonly status?: unknown;
  readonly worktreePath?: unknown;
}

export interface WaitForRunTerminalOptions {
  readonly runId: string;
  readonly crewHome?: string;
  readonly pollIntervalMs?: number;
  readonly stateFirstAppearanceGraceMs?: number;
  readonly writeStdout?: (line: string) => void;
  readonly writeStderr?: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/**
 * Thrown when `state.json` for the requested `runId` never appears
 * within the grace window. Distinct from a runtime error so `main()`
 * can map it to a non-zero exit with a precise diagnostic instead of
 * the generic catch-all.
 */
export class CrewWaitUnknownRunError extends Error {
  constructor(public readonly runId: string, public readonly statePath: string) {
    super(
      `crew-wait: state.json for run ${runId} never appeared (looked at ${statePath}). `
      + 'Likely a typo, stale run id, or wrong $CREW_HOME.',
    );
    this.name = 'CrewWaitUnknownRunError';
  }
}

export async function waitForRunTerminal(
  options: WaitForRunTerminalOptions,
): Promise<void> {
  const crewHome = options.crewHome ?? resolveCrewHome();
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const graceMs = options.stateFirstAppearanceGraceMs ?? STATE_FIRST_APPEARANCE_GRACE_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const writeStdout = options.writeStdout ?? ((line) => process.stdout.write(`${line}\n`));
  const statePath = join(crewHome, 'runs', options.runId, 'state.json');
  const startedAtMs = now();

  for (;;) {
    const state = await readStateIfPresent(statePath);
    if (state && typeof state.status === 'string' && TERMINAL_STATUSES.has(state.status)) {
      const runId = typeof state.runId === 'string' ? state.runId : options.runId;
      const agent = typeof state.agentId === 'string' ? state.agentId : '';
      const worktree = typeof state.worktreePath === 'string' ? state.worktreePath : '';
      writeStdout(
        `CREW_WAIT_TERMINAL run_id=${runId} agent=${agent} status=${state.status} worktree=${worktree}`,
      );
      return;
    }

    // Exit with a diagnostic if state.json never appears at all
    // within the grace window. Once the file has appeared even once,
    // we keep polling indefinitely — long-running agents are normal,
    // and it's not crew-wait's job to time out the run itself.
    if (state === undefined && now() - startedAtMs >= graceMs) {
      throw new CrewWaitUnknownRunError(options.runId, statePath);
    }

    await sleep(pollIntervalMs);
  }
}

export function usage(): string {
  return [
    'Usage: crew-wait <run_id>',
    '',
    'Wait for a crew run to reach a terminal state and print one terminal metadata line.',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  if (argv.length !== 1 || argv[0].startsWith('-')) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  await waitForRunTerminal({ runId: argv[0] });
  return 0;
}

async function readStateIfPresent(path: string): Promise<PersistedRunState | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return undefined;
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid crew run state at ${path}: expected JSON object`);
  }
  return parsed as PersistedRunState;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (isInvokedAsCli()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      // CrewWaitUnknownRunError already carries its own crew-wait
      // prefix in `message`; map it to a stable non-zero exit (3) so
      // callers can distinguish "unknown run" from generic failures.
      if (err instanceof CrewWaitUnknownRunError) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = 3;
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`crew-wait: ${message}\n`);
      process.exitCode = 1;
    },
  );
}

/**
 * True when this module is the script Node was invoked with — including
 * via a bin shim that symlinks to it. We compare realpath-resolved
 * absolute paths because npm bin shims (e.g.,
 * `~/.nvm/.../bin/crew-wait`) symlink to `dist/cli/wait.js`, and the
 * naive `import.meta.url === pathToFileURL(argv[1]).href` check would
 * compare the symlink path to the resolved module URL and never match.
 * Tests that import `main` directly leave `argv[1]` pointing at the
 * test runner, so realpath disagrees and main does not auto-run.
 */
function isInvokedAsCli(): boolean {
  if (!process.argv[1]) return false;
  const moduleFile = fileURLToPath(import.meta.url);
  let argvFile: string;
  try {
    argvFile = realpathSync(process.argv[1]);
  } catch {
    // argv[1] doesn't exist (very unusual) — assume not the CLI entry.
    return false;
  }
  let resolvedModuleFile: string;
  try {
    resolvedModuleFile = realpathSync(moduleFile);
  } catch {
    resolvedModuleFile = moduleFile;
  }
  return argvFile === resolvedModuleFile;
}
