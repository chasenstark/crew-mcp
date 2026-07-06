import { realpathSync, statSync, watch as fsWatch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveCrewHome } from '../utils/crew-home.js';

const CREW_WAIT_POLL_INTERVAL_ENV = 'CREW_WAIT_POLL_INTERVAL_MS';
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MAX_POLL_INTERVAL_MS = 5_000;
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

interface StateSnapshot {
  readonly state: PersistedRunState;
  readonly raw: string;
}

interface WatchHandle {
  close(): void;
  on?(event: 'error', listener: (err: Error) => void): unknown;
}

export type CrewWaitWatchFactory = (
  path: string,
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => WatchHandle;

export interface WaitForRunTerminalOptions {
  readonly runId: string;
  readonly crewHome?: string;
  readonly pollIntervalMs?: number;
  readonly stateFirstAppearanceGraceMs?: number;
  readonly writeStdout?: (line: string) => void;
  readonly writeStderr?: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly watch?: CrewWaitWatchFactory;
}

export interface WaitForRunsTerminalOptions {
  readonly runIds: readonly string[];
  readonly crewHome?: string;
  readonly pollIntervalMs?: number;
  readonly stateFirstAppearanceGraceMs?: number;
  readonly writeStdout?: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly watch?: CrewWaitWatchFactory;
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
  const pollIntervalMs = options.pollIntervalMs ?? resolvePollIntervalMs();
  const graceMs = options.stateFirstAppearanceGraceMs ?? STATE_FIRST_APPEARANCE_GRACE_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const writeStdout = options.writeStdout ?? ((line) => process.stdout.write(`${line}\n`));
  const runsPath = join(crewHome, 'runs');
  const runPath = join(runsPath, options.runId);
  const statePath = join(runPath, 'state.json');
  const startedAtMs = now();

  const watchResult = await waitForRunTerminalWithWatch({
    runId: options.runId,
    crewHome,
    runsPath,
    runPath,
    statePath,
    graceMs,
    startedAtMs,
    now,
    writeStdout,
    watch: options.watch ?? defaultWatch,
  });

  if (watchResult.completed) {
    return;
  }

  await waitForRunTerminalByPolling({
    runId: options.runId,
    statePath,
    pollIntervalMs,
    graceMs,
    startedAtMs,
    stateAppeared: watchResult.stateAppeared,
    sleep,
    now,
    writeStdout,
  });
}

export async function waitForRunsTerminal(
  options: WaitForRunsTerminalOptions,
): Promise<void> {
  if (options.runIds.length === 0) {
    throw new Error('crew-wait: at least one run_id is required');
  }
  if (options.runIds.length === 1) {
    await waitForRunTerminal({
      runId: options.runIds[0],
      crewHome: options.crewHome,
      pollIntervalMs: options.pollIntervalMs,
      stateFirstAppearanceGraceMs: options.stateFirstAppearanceGraceMs,
      writeStdout: options.writeStdout,
      sleep: options.sleep,
      now: options.now,
      watch: options.watch,
    });
    return;
  }

  const crewHome = options.crewHome ?? resolveCrewHome();
  const pollIntervalMs = options.pollIntervalMs ?? resolvePollIntervalMs();
  const graceMs = options.stateFirstAppearanceGraceMs ?? STATE_FIRST_APPEARANCE_GRACE_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const writeStdout = options.writeStdout ?? ((line) => process.stdout.write(`${line}\n`));
  const startedAtMs = now();
  const pending = new Set(options.runIds);
  const stateAppeared = new Set<string>();
  const linesByRunId = new Map<string, string>();
  const statePathByRunId = new Map(
    options.runIds.map((runId) => [runId, join(crewHome, 'runs', runId, 'state.json')]),
  );

  while (pending.size > 0) {
    for (const runId of options.runIds) {
      if (!pending.has(runId)) continue;

      const statePath = statePathByRunId.get(runId)!;
      const snapshot = await readStateSnapshotIfPresent(statePath);
      if (snapshot) {
        stateAppeared.add(runId);
        const line = terminalLine(snapshot.state, runId);
        if (line) {
          linesByRunId.set(runId, line);
          pending.delete(runId);
        }
        continue;
      }

      if (!stateAppeared.has(runId) && now() - startedAtMs >= graceMs) {
        for (const completedRunId of options.runIds) {
          const line = linesByRunId.get(completedRunId);
          if (line !== undefined) writeStdout(line);
        }
        throw new CrewWaitUnknownRunError(runId, statePath);
      }
    }

    if (pending.size > 0) {
      await sleep(pollIntervalMs);
    }
  }

  for (const runId of options.runIds) {
    const line = linesByRunId.get(runId);
    if (line !== undefined) writeStdout(line);
  }
}

export function nextCrewWaitPollIntervalMs(
  currentMs: number,
  baseMs: number,
  maxMs = MAX_POLL_INTERVAL_MS,
): number {
  const normalizedBaseMs = Math.max(1, Math.floor(baseMs));
  const normalizedCurrentMs = Math.max(normalizedBaseMs, Math.floor(currentMs));
  const normalizedMaxMs = Math.max(normalizedBaseMs, Math.floor(maxMs));
  return Math.min(normalizedCurrentMs * 2, normalizedMaxMs);
}

function resolvePollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CREW_WAIT_POLL_INTERVAL_ENV];
  if (raw === undefined) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  return parsed;
}

interface WaitContext {
  readonly runId: string;
  readonly statePath: string;
  readonly graceMs: number;
  readonly startedAtMs: number;
  readonly now: () => number;
  readonly writeStdout: (line: string) => void;
}

interface WatchWaitContext extends WaitContext {
  readonly crewHome: string;
  readonly runsPath: string;
  readonly runPath: string;
  readonly watch: CrewWaitWatchFactory;
}

interface WatchWaitResult {
  readonly completed: boolean;
  readonly stateAppeared: boolean;
}

async function waitForRunTerminalWithWatch(
  context: WatchWaitContext,
): Promise<WatchWaitResult> {
  return new Promise<WatchWaitResult>((resolve, reject) => {
    let watcher: WatchHandle | undefined;
    let watchedTarget: WatchTarget | undefined;
    let settled = false;
    let evaluating = false;
    let evaluateAgain = false;
    let stateAppeared = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      if (watcher) {
        watcher.close();
        watcher = undefined;
      }
      watchedTarget = undefined;
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ completed: true, stateAppeared });
    };

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const fallbackToPolling = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ completed: false, stateAppeared });
    };

    const armGraceTimer = (): void => {
      if (stateAppeared || graceTimer) return;
      const remainingMs = context.graceMs - (context.now() - context.startedAtMs);
      if (remainingMs <= 0) {
        fail(new CrewWaitUnknownRunError(context.runId, context.statePath));
        return;
      }
      graceTimer = setTimeout(() => {
        if (!stateAppeared) {
          fail(new CrewWaitUnknownRunError(context.runId, context.statePath));
        }
      }, remainingMs);
    };

    const clearGraceTimer = (): void => {
      if (!graceTimer) return;
      clearTimeout(graceTimer);
      graceTimer = undefined;
    };

    const ensureWatcher = (): boolean => {
      const target = selectWatchTarget(context);
      if (!target) return false;
      if (watchedTarget?.path === target.path && watchedTarget.kind === target.kind) {
        return true;
      }

      if (watcher) {
        watcher.close();
        watcher = undefined;
      }

      let nextWatcher: WatchHandle;
      try {
        nextWatcher = context.watch(target.path, (_eventType, filename) => {
          if (!shouldHandleWatchEvent(target, context.runId, filename)) return;
          void evaluate();
        });
      } catch {
        return false;
      }

      nextWatcher.on?.('error', fallbackToPolling);
      watcher = nextWatcher;
      watchedTarget = target;
      return true;
    };

    const evaluate = async (): Promise<void> => {
      if (settled) return;
      if (evaluating) {
        evaluateAgain = true;
        return;
      }

      evaluating = true;
      try {
        do {
          evaluateAgain = false;
          if (!ensureWatcher()) {
            fallbackToPolling();
            return;
          }

          const snapshot = await readStateSnapshotIfPresent(context.statePath);
          if (settled) return;

          if (snapshot) {
            stateAppeared = true;
            clearGraceTimer();
            const line = terminalLine(snapshot.state, context.runId);
            if (line) {
              context.writeStdout(line);
              finish();
              return;
            }
          } else if (!stateAppeared && context.now() - context.startedAtMs >= context.graceMs) {
            fail(new CrewWaitUnknownRunError(context.runId, context.statePath));
            return;
          }

          if (!ensureWatcher()) {
            fallbackToPolling();
            return;
          }
        } while (evaluateAgain && !settled);
      } catch (err) {
        fail(err);
      } finally {
        evaluating = false;
        if (evaluateAgain && !settled) {
          void evaluate();
        }
      }
    };

    if (!ensureWatcher()) {
      fallbackToPolling();
      return;
    }
    armGraceTimer();
    void evaluate();
  });
}

interface PollingWaitContext extends WaitContext {
  readonly pollIntervalMs: number;
  readonly stateAppeared: boolean;
  readonly sleep: (ms: number) => Promise<void>;
}

async function waitForRunTerminalByPolling(context: PollingWaitContext): Promise<void> {
  let stateAppeared = context.stateAppeared;
  let previousSnapshot: StateSnapshot | undefined;
  let hasPreviousSnapshot = false;
  let sleepMs = context.pollIntervalMs;

  for (;;) {
    const snapshot = await readStateSnapshotIfPresent(context.statePath, previousSnapshot);
    const changed = !hasPreviousSnapshot || snapshot?.raw !== previousSnapshot?.raw;
    if (changed) {
      sleepMs = context.pollIntervalMs;
    } else {
      sleepMs = nextCrewWaitPollIntervalMs(sleepMs, context.pollIntervalMs);
    }
    hasPreviousSnapshot = true;
    previousSnapshot = snapshot;

    if (snapshot) {
      stateAppeared = true;
      const line = terminalLine(snapshot.state, context.runId);
      if (line) {
        context.writeStdout(line);
        return;
      }
    }

    if (snapshot === undefined && !stateAppeared && context.now() - context.startedAtMs >= context.graceMs) {
      throw new CrewWaitUnknownRunError(context.runId, context.statePath);
    }

    await context.sleep(sleepMs);
  }
}

interface WatchTarget {
  readonly path: string;
  readonly kind: 'crew-home' | 'runs-dir' | 'run-dir';
}

function selectWatchTarget(context: WatchWaitContext): WatchTarget | undefined {
  // Watch directories, not the state file inode: state.json is written
  // through tmp-plus-rename, so file watchers detach on every update.
  if (isDirectory(context.runPath)) {
    return { path: context.runPath, kind: 'run-dir' };
  }
  if (isDirectory(context.runsPath)) {
    return { path: context.runsPath, kind: 'runs-dir' };
  }
  if (isDirectory(context.crewHome)) {
    return { path: context.crewHome, kind: 'crew-home' };
  }
  return undefined;
}

function shouldHandleWatchEvent(
  target: WatchTarget,
  runId: string,
  filename: string | Buffer | null,
): boolean {
  const name = watchFilenameToString(filename);
  if (name === undefined) return true;

  switch (target.kind) {
    case 'crew-home':
      return name === 'runs';
    case 'runs-dir':
      return name === runId;
    case 'run-dir':
      return name === 'state.json' || name.startsWith('state.json.tmp');
  }
}

function watchFilenameToString(filename: string | Buffer | null): string | undefined {
  if (typeof filename === 'string') return filename;
  if (Buffer.isBuffer(filename)) return filename.toString('utf-8');
  return undefined;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function terminalLine(state: PersistedRunState, fallbackRunId: string): string | undefined {
  if (typeof state.status !== 'string' || !TERMINAL_STATUSES.has(state.status)) {
    return undefined;
  }
  const runId = typeof state.runId === 'string' ? state.runId : fallbackRunId;
  const agent = typeof state.agentId === 'string' ? state.agentId : '';
  const worktree = typeof state.worktreePath === 'string' ? state.worktreePath : '';
  return `CREW_WAIT_TERMINAL run_id=${runId} agent=${agent} status=${state.status} worktree=${worktree}`;
}

function defaultWatch(
  path: string,
  listener: (eventType: string, filename: string | Buffer | null) => void,
): FSWatcher {
  return fsWatch(path, { persistent: true }, (eventType, filename) => {
    listener(eventType, filename);
  });
}

async function readStateSnapshotIfPresent(
  path: string,
  previous?: StateSnapshot,
): Promise<StateSnapshot | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return undefined;
    throw err;
  }
  // Polling ticks mostly observe unchanged bytes; reuse the previous parse.
  if (previous && previous.raw === raw) return previous;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid crew run state at ${path}: expected JSON object`);
  }
  return { state: parsed as PersistedRunState, raw };
}

export function usage(): string {
  return [
    'Usage: crew-wait <run_id...>',
    '',
    'Wait for one or more crew runs to reach terminal state and print one terminal metadata line per run.',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  if (argv.length < 1 || argv.some((arg) => arg.startsWith('-'))) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  await waitForRunsTerminal({ runIds: argv });
  return 0;
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
