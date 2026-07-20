import { realpathSync, statSync, watch as fsWatch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CODEX_THREAD_ID_ENV,
  decodeCodexBridgeFile,
  wakeCodexThread,
  type WakeCodexThreadOptions,
  type WakeCodexThreadResult,
} from '../codex/app-server-bridge.js';
import {
  decodeRunGenerations,
  runClaimedCodexWake,
  type ClaimedCodexWakeOptions,
  type ClaimedCodexWakeResult,
} from '../codex/wake-delivery.js';
import { resolveCrewHome } from '../utils/crew-home.js';

const CREW_WAIT_POLL_INTERVAL_ENV = 'CREW_WAIT_POLL_INTERVAL_MS';
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MAX_POLL_INTERVAL_MS = 5_000;
const MAX_MULTI_RUN_POLL_INTERVAL_MS = 2_000;
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
 * post-terminal user actions, not dispatch terminations. `crew-wait`
 * reports them distinctly as watcher exit conditions without presenting
 * them as dispatch completions. (Documented in
 * `docs/architecture/run-state-contract.md`.)
 */
const TERMINAL_STATUSES = new Set([
  'success',
  'partial',
  'error',
  'cancelled',
]);
const POST_TERMINAL_STATUSES = new Set([
  'merged',
  'merge_conflict',
  'discarded',
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
  readonly maxPollIntervalMs?: number;
  readonly signal?: AbortSignal;
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

export interface WaitForRunTerminalResult {
  readonly postTerminal: boolean;
}

export interface WaitForRunsTerminalResult {
  readonly postTerminalRunIds: readonly string[];
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
): Promise<WaitForRunTerminalResult> {
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
    signal: options.signal,
  });

  if (watchResult.completed) {
    return { postTerminal: watchResult.postTerminal };
  }

  return waitForRunTerminalByPolling({
    runId: options.runId,
    statePath,
    pollIntervalMs,
    graceMs,
    startedAtMs,
    stateAppeared: watchResult.stateAppeared,
    sleep,
    now,
    writeStdout,
    maxPollIntervalMs: options.maxPollIntervalMs ?? MAX_POLL_INTERVAL_MS,
    signal: options.signal,
  });
}

export async function waitForRunsTerminal(
  options: WaitForRunsTerminalOptions,
): Promise<WaitForRunsTerminalResult> {
  if (options.runIds.length === 0) {
    throw new Error('crew-wait: at least one run_id is required');
  }
  if (options.runIds.length === 1) {
    const result = await waitForRunTerminal({
      runId: options.runIds[0],
      crewHome: options.crewHome,
      pollIntervalMs: options.pollIntervalMs,
      stateFirstAppearanceGraceMs: options.stateFirstAppearanceGraceMs,
      writeStdout: options.writeStdout,
      sleep: options.sleep,
      now: options.now,
      watch: options.watch,
    });
    return {
      postTerminalRunIds: result.postTerminal ? [options.runIds[0]] : [],
    };
  }

  const crewHome = options.crewHome ?? resolveCrewHome();
  const pollIntervalMs = Math.min(
    options.pollIntervalMs ?? resolvePollIntervalMs(),
    MAX_MULTI_RUN_POLL_INTERVAL_MS,
  );
  const writeStdout = options.writeStdout ?? ((line) => process.stdout.write(`${line}\n`));
  const linesByRunId = new Map<string, string>();
  const postTerminalRunIds = new Set<string>();
  const abortController = new AbortController();
  const waits = options.runIds.map(async (runId) => {
    const result = await waitForRunTerminal({
      runId,
      crewHome,
      pollIntervalMs,
      maxPollIntervalMs: MAX_MULTI_RUN_POLL_INTERVAL_MS,
      stateFirstAppearanceGraceMs: options.stateFirstAppearanceGraceMs,
      writeStdout: (line) => linesByRunId.set(runId, line),
      sleep: options.sleep,
      now: options.now,
      watch: options.watch,
      signal: abortController.signal,
    });
    if (result.postTerminal) {
      postTerminalRunIds.add(runId);
    }
  });

  try {
    await Promise.all(waits);
  } catch (err) {
    abortController.abort();
    await Promise.allSettled(waits);
    writeCompletedLines(options.runIds, linesByRunId, writeStdout);
    throw err;
  }

  writeCompletedLines(options.runIds, linesByRunId, writeStdout);
  return {
    postTerminalRunIds: options.runIds.filter((runId) => postTerminalRunIds.has(runId)),
  };
}

function writeCompletedLines(
  runIds: readonly string[],
  linesByRunId: ReadonlyMap<string, string>,
  writeStdout: (line: string) => void,
): void {
  for (const runId of runIds) {
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
  readonly signal?: AbortSignal;
}

interface WatchWaitResult {
  readonly completed: boolean;
  readonly stateAppeared: boolean;
  readonly postTerminal: boolean;
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
    let previousSnapshot: StateSnapshot | undefined;
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
      context.signal?.removeEventListener('abort', abort);
    };

    const finish = (postTerminal: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ completed: true, stateAppeared, postTerminal });
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
      resolve({ completed: false, stateAppeared, postTerminal: false });
    };

    const abort = (): void => {
      fail(new CrewWaitAbortedError());
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

          const snapshot = await readStateSnapshotIfPresent(context.statePath, previousSnapshot);
          previousSnapshot = snapshot;
          if (settled) return;

          if (snapshot) {
            stateAppeared = true;
            clearGraceTimer();
            const exit = watcherExit(snapshot.state, context.runId);
            if (exit) {
              context.writeStdout(exit.line);
              finish(exit.postTerminal);
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

    if (context.signal?.aborted) {
      abort();
      return;
    }
    context.signal?.addEventListener('abort', abort, { once: true });
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
  readonly maxPollIntervalMs: number;
  readonly signal?: AbortSignal;
}

async function waitForRunTerminalByPolling(
  context: PollingWaitContext,
): Promise<WaitForRunTerminalResult> {
  let stateAppeared = context.stateAppeared;
  let previousSnapshot: StateSnapshot | undefined;
  let hasPreviousSnapshot = false;
  let sleepMs = context.pollIntervalMs;

  for (;;) {
    throwIfAborted(context.signal);
    const snapshot = await readStateSnapshotIfPresent(context.statePath, previousSnapshot);
    const changed = !hasPreviousSnapshot || snapshot?.raw !== previousSnapshot?.raw;
    if (changed) {
      sleepMs = context.pollIntervalMs;
    } else {
      sleepMs = nextCrewWaitPollIntervalMs(
        sleepMs,
        context.pollIntervalMs,
        context.maxPollIntervalMs,
      );
    }
    hasPreviousSnapshot = true;
    previousSnapshot = snapshot;

    if (snapshot) {
      stateAppeared = true;
      const exit = watcherExit(snapshot.state, context.runId);
      if (exit) {
        context.writeStdout(exit.line);
        return { postTerminal: exit.postTerminal };
      }
    }

    if (snapshot === undefined && !stateAppeared && context.now() - context.startedAtMs >= context.graceMs) {
      throw new CrewWaitUnknownRunError(context.runId, context.statePath);
    }

    await context.sleep(sleepMs);
    throwIfAborted(context.signal);
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

interface WatcherExit {
  readonly line: string;
  readonly postTerminal: boolean;
}

function watcherExit(state: PersistedRunState, fallbackRunId: string): WatcherExit | undefined {
  if (typeof state.status !== 'string') {
    return undefined;
  }
  const runId = typeof state.runId === 'string' ? state.runId : fallbackRunId;
  if (POST_TERMINAL_STATUSES.has(state.status)) {
    return {
      line: `CREW_WAIT_POST_TERMINAL run_id=${runId} status=${state.status}`,
      postTerminal: true,
    };
  }
  if (!TERMINAL_STATUSES.has(state.status)) {
    return undefined;
  }
  const agent = typeof state.agentId === 'string' ? state.agentId : '';
  const worktree = typeof state.worktreePath === 'string' ? state.worktreePath : '';
  return {
    line: `CREW_WAIT_TERMINAL run_id=${runId} agent=${agent} status=${state.status} worktree=${worktree}`,
    postTerminal: false,
  };
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
    'Usage: crew-wait [--crew-home-base64 <base64url>] [--codex-bridge-base64 <base64url> --run-generations-base64 <base64url>] <run_id...>',
    '',
    'Wait for one or more crew runs to reach terminal or post-terminal state and print one metadata line per run.',
    'When --codex-bridge-base64 is present, start a completion turn for the dispatch-terminal runs on the hosted Codex thread.',
  ].join('\n');
}

export interface CrewWaitMainDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly wakeCodexThread?: (
    options: WakeCodexThreadOptions,
  ) => Promise<WakeCodexThreadResult>;
  readonly runClaimedCodexWake?: (
    options: ClaimedCodexWakeOptions<unknown>,
  ) => Promise<ClaimedCodexWakeResult<unknown>>;
}

export async function main(
  argv = process.argv.slice(2),
  dependencies: CrewWaitMainDependencies = {},
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const parsed = parseCliArgs(argv);
  if (!parsed) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  const crewHome = parsed.crewHome ?? resolveCrewHome();
  const waitResult = await waitForRunsTerminal({
    runIds: parsed.runIds,
    crewHome,
  });
  if (parsed.codexBridgeFile) {
    if (!parsed.runGenerations || parsed.runGenerations.length !== parsed.runIds.length) {
      throw new Error('Codex bridge wake requires one run generation per run id');
    }
    const postTerminalRunIds = new Set(waitResult.postTerminalRunIds);
    const wakeTargets = parsed.runIds.flatMap((runId, index) => (
      postTerminalRunIds.has(runId)
        ? []
        : [{ runId, generation: parsed.runGenerations![index] }]
    ));
    if (wakeTargets.length === 0) {
      return 0;
    }

    const threadId = (dependencies.env ?? process.env)[CODEX_THREAD_ID_ENV];
    const wakeRunIds = wakeTargets.map(({ runId }) => runId);
    const wakeRunGenerations = wakeTargets.map(({ generation }) => generation);
    let claimResult: ClaimedCodexWakeResult<unknown> | undefined;
    const wake = await (dependencies.wakeCodexThread ?? wakeCodexThread)({
      bridgeFile: parsed.codexBridgeFile,
      threadId: threadId ?? '',
      runIds: wakeRunIds,
      guardTurnStart: async (startTurn) => {
        claimResult = await (dependencies.runClaimedCodexWake ?? runClaimedCodexWake)({
          crewHome,
          threadId: threadId ?? '',
          runIds: wakeRunIds,
          runGenerations: wakeRunGenerations,
          startTurn,
        });
        return claimResult.started
          ? { action: 'start', result: claimResult.result }
          : { action: 'skip' };
      },
    });
    if (wake.skipped) {
      process.stdout.write(
        `CREW_WAIT_CODEX_WAKE_SKIPPED thread_id=${threadId} reason=${
          claimResult && !claimResult.started ? claimResult.reason : 'unknown'
        }\n`,
      );
    } else {
      process.stdout.write(
        `CREW_WAIT_CODEX_WAKE_SENT thread_id=${threadId} turn_id=${wake.turnId}\n`,
      );
    }
  }
  return 0;
}

function parseCliArgs(argv: readonly string[]): {
  readonly runIds: readonly string[];
  readonly crewHome?: string;
  readonly codexBridgeFile?: string;
  readonly runGenerations?: readonly number[];
} | undefined {
  const remaining = [...argv];
  let crewHome: string | undefined;
  const flagIndex = remaining.indexOf('--crew-home-base64');
  if (flagIndex >= 0) {
    const encoded = remaining[flagIndex + 1];
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
    try {
      crewHome = Buffer.from(encoded, 'base64url').toString('utf-8');
    } catch {
      return undefined;
    }
    if (!crewHome || Buffer.from(crewHome, 'utf-8').toString('base64url') !== encoded) {
      return undefined;
    }
    remaining.splice(flagIndex, 2);
  }
  let codexBridgeFile: string | undefined;
  const bridgeFlagIndex = remaining.indexOf('--codex-bridge-base64');
  if (bridgeFlagIndex >= 0) {
    const encoded = remaining[bridgeFlagIndex + 1];
    if (!encoded) return undefined;
    try {
      codexBridgeFile = decodeCodexBridgeFile(encoded);
    } catch {
      return undefined;
    }
    remaining.splice(bridgeFlagIndex, 2);
  }
  let runGenerations: readonly number[] | undefined;
  const generationsFlagIndex = remaining.indexOf('--run-generations-base64');
  if (generationsFlagIndex >= 0) {
    const encoded = remaining[generationsFlagIndex + 1];
    if (!encoded) return undefined;
    try {
      runGenerations = decodeRunGenerations(encoded);
    } catch {
      return undefined;
    }
    remaining.splice(generationsFlagIndex, 2);
  }
  if ((codexBridgeFile === undefined) !== (runGenerations === undefined)) {
    return undefined;
  }
  if (remaining.length < 1 || remaining.some((arg) => arg.startsWith('-'))) {
    return undefined;
  }
  if (runGenerations !== undefined && runGenerations.length !== remaining.length) {
    return undefined;
  }
  return {
    runIds: remaining,
    ...(crewHome ? { crewHome } : {}),
    ...(codexBridgeFile ? { codexBridgeFile } : {}),
    ...(runGenerations ? { runGenerations } : {}),
  };
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CrewWaitAbortedError extends Error {
  constructor() {
    super('crew-wait aborted');
    this.name = 'CrewWaitAbortedError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new CrewWaitAbortedError();
  }
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
