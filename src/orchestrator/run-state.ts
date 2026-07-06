/**
 * Per-run state persistence for v2.
 *
 * Each run owns a directory at `<crewHome>/runs/<runId>/` (default
 * `~/.crew/runs/<runId>/`, see `src/utils/crew-home.ts`) that contains
 * its worktree (managed by WorktreeManager), a `state.json` (managed
 * here), and an append-only `events.log` (also here). Together those
 * three files are the durable record of a run that the host CLI can
 * poll, resume, or merge. The directory survives crew-serve restarts.
 *
 * State.json is written by the M2 lifecycle tools:
 *   - run_agent      → create() then markTerminal()
 *   - continue_run   → appendPrompt() then markTerminal() on next terminal
 *   - merge_run      → markMerged() / markMergeConflict()
 *   - discard_run    → markDiscarded() (the worktree is removed alongside)
 *   - get_run_status → read() + readEventsSince() / readFilteredTailFromEnd()
 *
 * Schema is versioned (`schemaVersion`) but only V1 exists today. Reader
 * is strict: unknown schema versions throw rather than silently corrupt.
 * `repoRoot` was added in M3.5 — `read()` tolerates legacy records that
 * were written without it (the field is informational, not load-bearing).
 */

import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  chmodSync,
  openSync,
  fstatSync,
  readSync,
  writeSync,
  closeSync,
  rmSync,
  renameSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { atomicWrite } from '../utils/atomic-write.js';
import { logBestEffortFailure } from '../utils/best-effort.js';
import { logger } from '../utils/logger.js';
import { warnOnce } from '../utils/warn-once.js';
import type { TaskFailure } from '../adapters/types.js';
import { filterEventsTailNoise, isEventsTailNoiseLine } from './events-filter.js';
import { notifyTerminal } from './notifications.js';
import { writeRunReceipt } from './receipts.js';
import {
  resolvePeerMessageCaps,
  type ResolvedCaps,
} from './peer-messages/caps.js';
import { runPeerMessagesPipeline } from './peer-messages/pipeline.js';
import type {
  PeerMessageInput,
  PeerMessageRendered,
} from './peer-messages/schema.js';
import { legacyReadOnlyShim, type RunMode } from './run-mode.js';
import { withStateLock } from './run-state-lock.js';

export type RunStatus =
  | 'running'
  | 'success'
  | 'partial'
  | 'error'
  | 'cancelled'
  | 'merged'
  | 'merge_conflict'
  | 'discarded';

const MERGEABLE_TERMINAL_STATUSES: readonly RunStatus[] = [
  'success',
  'partial',
  'error',
  'cancelled',
  'merge_conflict',
];

const DISCARDABLE_STATUSES: readonly RunStatus[] = [
  'success',
  'partial',
  'error',
  'cancelled',
  'merge_conflict',
];

export interface PromptRecord {
  readonly turn: number;
  readonly prompt: string;
  readonly peer_messages_input?: readonly PeerMessageRendered[];
  /** Non-droppable acceptance-criteria contract injected ahead of peer messages. */
  readonly criteriaContract?: string;
  readonly criteriaSetId?: string;
  readonly criteriaEpoch?: number;
  readonly startedAt: string;
  readonly completedAt?: string;
  /** The adapter's `output` text for this turn. */
  readonly summary?: string;
}

export interface MergeStatus {
  readonly target: string;
  readonly commitSha?: string;
  readonly conflicts?: readonly string[];
}

export interface RunStateV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly agentId: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly worktreePath: string;
  /**
   * Absolute, symlink-resolved path of the host repo this run was
   * dispatched from. Added in M3.5 so runs in a single global
   * `~/.crew/runs/` can be associated back to their origin repo.
   * Optional because v0.2.0-dev records written before M3.5 may
   * lack it; writers always populate.
   */
  readonly repoRoot?: string;
  /**
   * Lifecycle mode for this run — see src/orchestrator/run-mode.ts.
   * Optional for backward compatibility with state.json files written
   * before this field existed; readers derive legacy records via
   * `runModeFromState` (readOnly:true → 'read_only', else 'write').
   * Sticky on `continue_run`.
   */
  readonly runMode?: RunMode;
  /**
   * LEGACY SHIM — do not read this in new code; route through
   * `runModeFromState` / `isMergeable` / `ownsWorktree` instead.
   * Persisted as `!isMergeable(runMode)` so a version-skewed old server
   * that only knows `readOnly` refuses to merge an `ephemeral_review`
   * run rather than treating it as a mergeable write run. (An old
   * `discard_run` will then also skip that run's worktree removal — a
   * hygiene cost the run-GC sweep absorbs, not a correctness one.)
   *
   * Optional for backward compatibility with state.json files written
   * before this field existed (treated as `false` when absent).
   */
  readonly readOnly?: boolean;
  /**
   * PID of the `crew-mcp serve` process that owns this run while it
   * is running. Used by the stale-run sweeper to distinguish
   * "abandoned by a crashed prior server" from "currently being
   * managed by another live server" (which is normal — every host MCP
   * connection spawns its own server). Refreshed on `appendPrompt()`
   * so a `continue_run` re-claims ownership for the server processing
   * the continuation.
   *
   * Optional for backward compatibility. The sweeper SKIPS records
   * without `serverPid` (legacy / pre-fix) — it can't tell whether
   * they're still owned, so it leaves them alone rather than risk
   * killing in-flight work. Users can `discard_run` legacy records
   * manually if they turn out to be truly stale.
   */
  readonly serverPid?: number;
  readonly criteriaSetId?: string;
  readonly criteriaEpoch?: number;
  readonly prompts: readonly PromptRecord[];
  readonly filesChanged: readonly string[];
  /**
   * Provider conversation/session id from the latest terminal turn's
   * `TaskResult.sessionId`. Persisted so `continue_run` can resume a stateful
   * adapter (agy `--conversation <id>`) instead of starting a fresh
   * conversation — without this the id is dropped at terminal persistence and
   * resume silently loses context. Carried across `continue_run` turns
   * (markTerminal preserves it when a turn returns no new id). Optional +
   * additive so older state.json files load without migration.
   */
  readonly sessionId?: string;
  readonly lastError?: string;
  readonly failure?: TaskFailure;
  readonly mergeStatus?: MergeStatus;
  /**
   * Advisory messages from the dispatch layer that aren't part of the
   * agent's own output — surfaced via get_run_status. Today's only
   * producer is the read-only run dirty-tree probe (the agent edited
   * despite a read_only contract). Optional + additive so older
   * state.json files load without migration.
   */
  readonly warnings?: readonly string[];
}

const SCHEMA_VERSION = 1 as const;

/**
 * Upper bound on per-prompt storage in `state.json`. Verbatim prompts are
 * persisted forever on disk; capping prevents an unbounded prompt (giant
 * paste, JSON-stringified structured input, etc.) from bloating state.json
 * across server restarts. Wire payloads already elide prompt text — this
 * cap is purely a disk-hygiene measure. Override via
 * `CREW_PROMPT_STORAGE_CAP_CHARS` (0 disables); default 16K characters.
 */
const DEFAULT_PROMPT_STORAGE_CAP_CHARS = 16 * 1024;

function getPromptStorageCap(): number {
  const raw = process.env.CREW_PROMPT_STORAGE_CAP_CHARS;
  if (raw === undefined) return DEFAULT_PROMPT_STORAGE_CAP_CHARS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    warnOnce('env:CREW_PROMPT_STORAGE_CAP_CHARS', () => {
      logger.warn(
        `CREW_PROMPT_STORAGE_CAP_CHARS is present but is not a non-negative integer; using ${DEFAULT_PROMPT_STORAGE_CAP_CHARS}`,
      );
    });
    return DEFAULT_PROMPT_STORAGE_CAP_CHARS;
  }
  return Math.floor(parsed);
}

/**
 * Truncate a prompt string for storage, appending a marker that records the
 * original byte length so a reader can tell the prompt was clipped. Returns
 * the input unchanged when the cap is 0 (disabled) or the prompt fits.
 */
export function truncatePromptForStorage(prompt: string): string {
  const cap = getPromptStorageCap();
  if (cap === 0 || prompt.length <= cap) return prompt;
  const originalBytes = Buffer.byteLength(prompt, 'utf-8');
  const marker = `\n[... truncated for storage; original was ${originalBytes} bytes]`;
  // Reserve room for the marker; if the cap is so small the marker doesn't
  // fit, return just the marker (user explicitly asked for tiny storage).
  const budget = Math.max(0, cap - marker.length);
  return prompt.slice(0, budget) + marker;
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

export function corruptRunStatePath(statePath: string): string {
  return `${statePath}.corrupt`;
}

export function createCorruptRunStateRecord(args: {
  readonly runId: string;
  readonly statePath: string;
  readonly repoRoot?: string;
  readonly reason: string;
}): RunStateV1 {
  const now = new Date().toISOString();
  const summary = `state.json was corrupt and has been quarantined: ${args.reason}`;
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: args.runId,
    agentId: 'unknown',
    status: 'error',
    startedAt: now,
    completedAt: now,
    worktreePath: join(dirname(args.statePath), 'worktree'),
    ...(args.repoRoot ? { repoRoot: args.repoRoot } : {}),
    prompts: [
      {
        turn: 1,
        prompt: '',
        startedAt: now,
        completedAt: now,
        summary,
      },
    ],
    filesChanged: [],
    lastError: summary,
    failure: {
      kind: 'process',
      confidence: 'high',
      rawSignal: args.reason,
    },
  };
}

export function quarantineCorruptRunState(args: {
  readonly runId: string;
  readonly statePath: string;
  readonly repoRoot?: string;
  readonly reason: string;
}): RunStateV1 {
  const quarantinePath = corruptRunStatePath(args.statePath);
  try {
    renameSync(args.statePath, quarantinePath);
  } catch (err) {
    logger.warn(
      `Failed to quarantine corrupt run state for ${args.runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const state = createCorruptRunStateRecord(args);
  atomicWrite(args.statePath, JSON.stringify(state, null, 2));
  return state;
}

function assertCanMarkMerged(runId: string, status: RunStatus): void {
  if (MERGEABLE_TERMINAL_STATUSES.includes(status)) return;
  if (status === 'running') {
    throw new Error(`run_in_flight: cannot mark run ${runId} merged while it is running`);
  }
  if (status === 'merged') {
    throw new Error(`run_already_merged: run ${runId} is already merged`);
  }
  if (status === 'discarded') {
    throw new Error(`run_already_discarded: cannot mark run ${runId} merged after discard`);
  }
  throw new Error(`run_not_mergeable: cannot mark run ${runId} merged from status ${status}`);
}

function assertCanMarkMergeConflict(runId: string, status: RunStatus): void {
  if (status === 'merge_conflict') return;
  if (MERGEABLE_TERMINAL_STATUSES.includes(status)) return;
  if (status === 'running') {
    throw new Error(`run_in_flight: cannot mark run ${runId} merge_conflict while it is running`);
  }
  throw new Error(`run_not_mergeable: cannot mark run ${runId} merge_conflict from status ${status}`);
}

function assertCanMarkDiscarded(runId: string, status: RunStatus): void {
  if (DISCARDABLE_STATUSES.includes(status)) return;
  if (status === 'running') {
    throw new Error(`run_in_flight: cannot discard run ${runId} while it is running`);
  }
  if (status === 'merged') {
    throw new Error(`run_already_merged: cannot discard run ${runId} after merge`);
  }
  throw new Error(`run_not_discardable: cannot discard run ${runId} from status ${status}`);
}

export interface CreateRunStateInit {
  readonly runId: string;
  readonly agentId: string;
  readonly worktreePath: string;
  readonly initialPrompt: string;
  readonly initialPeerMessagesInput?: readonly PeerMessageInput[];
  readonly contractPrefix?: string;
  readonly criteriaSetId?: string;
  readonly criteriaEpoch?: number;
  /**
   * Lifecycle mode for this run. Persisted so `continue_run` can read
   * it back and stay sticky, and so `merge_run` / `discard_run` can
   * branch on it without consulting the dispatcher. The legacy
   * `readOnly` shim is derived from it (`legacyReadOnlyShim`) — callers
   * pass the mode, never the shim. Defaults to 'write' when omitted.
   */
  readonly runMode?: RunMode;
  /**
   * DEPRECATED legacy input: `readOnly: true` maps to
   * `runMode: 'read_only'` when `runMode` is absent. Prefer `runMode`.
   */
  readonly readOnly?: boolean;
}

export interface RunStateStoreOptions {
  /**
   * Per-user crew home directory (default `~/.crew/`). All run state
   * lives under `<crewHome>/runs/<runId>/`.
   */
  readonly crewHome: string;
  /**
   * Absolute path of the host repo this store is associated with.
   * Persisted into every run's state.json so a global `~/.crew/runs/`
   * can be associated back to origin repos. Symlink-resolved on
   * construction so two paths pointing at the same tree converge.
   */
  readonly repoRoot: string;
}

export interface CreateRunStateResult {
  readonly state: RunStateV1;
  readonly renderedPeerMessages: readonly PeerMessageRendered[];
  readonly composedPrompt: string;
  readonly warnings: readonly string[];
}

export interface AppendPromptOptions {
  readonly userPrompt: string;
  readonly peerMessagesInput?: readonly PeerMessageInput[];
  readonly contractPrefix?: string;
  readonly criteriaSetId?: string;
  readonly criteriaEpoch?: number;
}

export interface AppendPromptResult {
  readonly state: RunStateV1;
  readonly turnNumber: number;
  readonly renderedPeerMessages: readonly PeerMessageRendered[];
  readonly composedPrompt: string;
  readonly warnings: readonly string[];
}

export interface FilteredEventsTail {
  readonly lines: readonly string[];
  /** Raw non-empty events.log line count; equals the next_event_line cursor. */
  readonly totalLineCount: number;
  /** Count of raw lines that survived filterEventsTailNoise. */
  readonly totalFilteredCount: number;
  /** Count of raw lines dropped by filterEventsTailNoise. */
  readonly filteredOutCount: number;
}

const EVENT_LOG_SCAN_CHUNK_BYTES = 64 * 1024;

/**
 * Manages `<crewHome>/runs/<runId>/state.json` + `events.log` files.
 * One instance per (host repo, crew serve) pair; thread-safe enough
 * for the in-process v2 usage pattern (single host CLI session =
 * single crew serve process = serial tool calls).
 */
export class RunStateStore {
  private readonly crewHome: string;
  private readonly runsBasePath: string;
  private readonly repoRootPath: string;
  private readonly resolvedCaps: ResolvedCaps;
  private readonly eventAppendFds = new Map<string, number>();
  private readonly eventReadCursors = new Map<string, { lineCount: number; byteOffset: number }>();
  // Terminal events.log files are immutable (the append fd closes at
  // markTerminal), so the filtered tail is cached per run keyed on file
  // size + requested limit; a size change (external truncation/append)
  // invalidates. Pruned in deleteRunDir.
  private readonly terminalTailCache = new Map<
    string,
    { size: number; limit: number; tail: FilteredEventsTail }
  >();
  // Test seams: count the O(file-size) scan paths so regression tests can
  // assert the incremental-cursor and tail-cache paths actually bypass them.
  private fullEventLogReads = 0;
  private terminalTailScans = 0;
  // mtimeMs-keyed parse cache for state.json (same shape as the list_runs
  // cache). Writers replace the file via rename, so a changed mtime is the
  // invalidation signal — including writes from sibling server processes.
  // Cached objects are shared references: read() callers must treat the
  // result as immutable (all current callers do; updaters spread-copy).
  private readonly parsedStateCache = new Map<string, { mtimeMs: number; state: RunStateV1 }>();
  private overridesInvalidPending: boolean;

  constructor(options: RunStateStoreOptions) {
    this.crewHome = options.crewHome;
    this.runsBasePath = join(options.crewHome, 'runs');
    mkdirSync(this.runsBasePath, { recursive: true });
    mkdirSync(join(options.crewHome, 'state-locks'), { recursive: true });
    this.repoRootPath = resolveRepoRoot(options.repoRoot);
    this.resolvedCaps = resolvePeerMessageCaps(process.env);
    this.overridesInvalidPending = this.resolvedCaps.overridesInvalid !== undefined;
  }

  get repoRoot(): string {
    return this.repoRootPath;
  }

  get caps(): ResolvedCaps {
    return this.resolvedCaps;
  }

  consumeCapOverridesWarning(): readonly string[] {
    if (!this.overridesInvalidPending) {
      return [];
    }
    this.overridesInvalidPending = false;
    const names = this.resolvedCaps.overridesInvalid ?? [];
    if (names.length === 0) {
      return [];
    }
    return [`peer_messages.cap_overrides_invalid: ${names.join(', ')}`];
  }

  /**
   * Create the initial state.json for a new run. Called at the beginning
   * of every run_agent dispatch — before the adapter is invoked. The run
   * directory is created if it doesn't already exist (the worktree
   * manager may have created it first; either order is fine).
   */
  async create(init: CreateRunStateInit): Promise<CreateRunStateResult> {
    return withStateLock({ crewHome: this.crewHome, runId: init.runId }, async () => {
      const now = new Date().toISOString();
      const pipelineResult = runPeerMessagesPipeline(init.initialPeerMessagesInput ?? [], {
        renderedAt: now,
        renderedInTurn: 1,
        caps: this.caps,
      });
      const renderedMessages = pipelineResult.renderedMessages;
      const contractPrefix = init.contractPrefix ?? '';
      const composedPrompt = contractPrefix + pipelineResult.rendered + init.initialPrompt;
      if (composedPrompt.length > this.caps.composedPromptCap) {
        throw new Error(
          `${contractPrefix.length > 0 ? 'criteria.contract_too_large' : 'peer_messages.composed_prompt_too_large'}: ${composedPrompt.length} ` +
          `> ${this.caps.composedPromptCap}`,
        );
      }

      const runMode = init.runMode ?? (init.readOnly === true ? 'read_only' : 'write');
      const state: RunStateV1 = {
        schemaVersion: SCHEMA_VERSION,
        runId: init.runId,
        agentId: init.agentId,
        status: 'running',
        startedAt: now,
        worktreePath: init.worktreePath,
        repoRoot: this.repoRoot,
        serverPid: process.pid,
        runMode,
        ...(legacyReadOnlyShim(runMode) ? { readOnly: true } : {}),
        ...(init.criteriaSetId !== undefined
          ? { criteriaSetId: init.criteriaSetId, criteriaEpoch: init.criteriaEpoch }
          : {}),
        prompts: [
          {
            turn: 1,
            prompt: truncatePromptForStorage(init.initialPrompt),
            ...(renderedMessages.length > 0 ? { peer_messages_input: [...renderedMessages] } : {}),
            ...(contractPrefix.length > 0 ? { criteriaContract: contractPrefix } : {}),
            ...(init.criteriaSetId !== undefined
              ? { criteriaSetId: init.criteriaSetId, criteriaEpoch: init.criteriaEpoch }
              : {}),
            startedAt: now,
          },
        ],
        filesChanged: [],
      };
      this.writeAtomic(init.runId, state);
      // Drop a one-click `tail.command` helper next to events.log. On macOS
      // this is the file extension Terminal.app registers as a launcher: a
      // user can `open` the file (or click a `file://` link to it) and a
      // Terminal window opens running `tail -F` against the run's event log.
      // On Linux/Windows the suffix carries no meaning, but the file is
      // still a runnable shell script — the dispatch markdown only surfaces
      // the clickable form on macOS.
      this.writeTailCommandHelper(init.runId);

      const capWarnings = (init.initialPeerMessagesInput?.length ?? 0) > 0
        ? this.consumeCapOverridesWarning()
        : [];
      return {
        state,
        renderedPeerMessages: renderedMessages,
        composedPrompt,
        warnings: [...pipelineResult.warnings, ...capWarnings],
      };
    });
  }

  /**
   * Absolute path to the run's `tail.command` helper. Always present
   * after `create()` (best-effort; failures during write are swallowed
   * because the helper is a UX nicety, not a correctness requirement).
   */
  tailCommandPath(runId: string): string {
    return join(this.runsBasePath, runId, 'tail.command');
  }

  /**
   * Write `<run-dir>/tail.command` — a tiny shell script that tails the
   * run's events.log indefinitely. Best-effort: any write/chmod failure
   * is logged but doesn't abort the dispatch (the captain's
   * coordination role is not gated on the user's progress channel
   * existing).
   */
  private writeTailCommandHelper(runId: string): void {
    const tailPath = this.tailCommandPath(runId);
    const eventsLog = this.eventsLogPath(runId);
    // `exec` keeps the shell PID == tail PID so closing Terminal.app's
    // window cleanly stops the tail. The trailing single-quote-escaped
    // path tolerates spaces in run-dir names.
    const script = `#!/bin/bash\nexec tail -F '${eventsLog.replace(/'/g, "'\\''")}'\n`;
    try {
      mkdirSync(dirname(tailPath), { recursive: true });
      writeFileSync(tailPath, script, 'utf-8');
      chmodSync(tailPath, 0o755);
    } catch (err) {
      logBestEffortFailure('run-state.tail-command-helper', err);
      // Helper is non-essential; don't block dispatch on an unwritable
      // filesystem (e.g., read-only mount).
    }
  }

  /**
   * Synchronous read path for polling APIs. Writers use per-run locks plus
   * rename-atomic state.json replacement; one-tick-stale reads are acceptable
   * for get_run_status/get_panel_status style polling.
   */
  read(runId: string): RunStateV1 | undefined {
    const path = this.statePath(runId);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch (err) {
      if (isEnoent(err)) {
        this.parsedStateCache.delete(runId);
        return undefined;
      }
      throw err;
    }
    const cached = this.parsedStateCache.get(runId);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.state;
    }
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch (err) {
      if (isEnoent(err)) {
        this.parsedStateCache.delete(runId);
        return undefined;
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return quarantineCorruptRunState({
        runId,
        statePath: path,
        repoRoot: this.repoRootPath,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION
    ) {
      throw new Error(
        `Unknown run-state schemaVersion for ${runId}: expected ${SCHEMA_VERSION}, got ${
          (parsed as { schemaVersion?: unknown })?.schemaVersion ?? 'undefined'
        }`,
      );
    }
    const state = parsed as RunStateV1;
    this.parsedStateCache.set(runId, { mtimeMs, state });
    return state;
  }

  /**
   * Locked atomic update: read, transform, write. Throws if the run doesn't
   * exist (callers should `read` first when they want soft-handling).
   */
  async update(runId: string, updater: (state: RunStateV1) => RunStateV1): Promise<RunStateV1> {
    return withStateLock({ crewHome: this.crewHome, runId }, async () =>
      this.updateLocked(runId, updater));
  }

  private updateLocked(runId: string, updater: (state: RunStateV1) => RunStateV1): RunStateV1 {
    const current = this.read(runId);
    if (!current) {
      throw new Error(`No state.json for run ${runId}; cannot update.`);
    }
    const next = updater(current);
    this.writeAtomic(runId, next);
    return next;
  }

  /**
   * Append a new prompt-record (continue_run case). Resets status to
   * 'running' and clears completedAt — the run is in-flight again.
   * Also re-claims `serverPid` to the current process: the run's new
   * owner is whichever `crew-mcp serve` instance is processing this
   * `continue_run`. Without this refresh, a continued run would carry
   * the original (possibly dead) server's PID, and the stale-run
   * sweeper in any sibling server's startup would mark it abandoned.
   */
  async appendPrompt(
    runId: string,
    options: AppendPromptOptions,
  ): Promise<AppendPromptResult> {
    return withStateLock({ crewHome: this.crewHome, runId }, async () => {
      const fresh = this.read(runId);
      if (!fresh) {
        throw new Error(`peer_messages.run_unknown: ${runId}`);
      }
      if (fresh.status === 'running') {
        throw new Error(`peer_messages.run_in_flight: ${runId}`);
      }
      if (
        fresh.status === 'discarded'
        || fresh.status === 'merged'
        || fresh.status === 'merge_conflict'
      ) {
        throw new Error(`peer_messages.run_terminal: ${runId} status=${fresh.status}`);
      }

      const turnNumber = fresh.prompts.length + 1;
      const now = new Date().toISOString();
      const pipelineResult = runPeerMessagesPipeline(options.peerMessagesInput ?? [], {
        renderedAt: now,
        renderedInTurn: turnNumber,
        caps: this.caps,
      });
      const renderedMessages = pipelineResult.renderedMessages;
      const contractPrefix = options.contractPrefix ?? '';
      const composedPrompt = contractPrefix + pipelineResult.rendered + options.userPrompt;
      if (composedPrompt.length > this.caps.composedPromptCap) {
        throw new Error(
          `${contractPrefix.length > 0 ? 'criteria.contract_too_large' : 'peer_messages.composed_prompt_too_large'}: ${composedPrompt.length} ` +
          `> ${this.caps.composedPromptCap}`,
        );
      }

      const nextState = this.updateLocked(runId, (s) => ({
        ...s,
        status: 'running',
        completedAt: undefined,
        // A new turn starts fresh: clear any prior-turn terminal error so a
        // recovered run (error -> continue_run -> success) doesn't carry a
        // stale `lastError` into its success state. `lastError` leaks into the
        // get_run_status payload, list_runs summary, and run.json receipt, so
        // clearing it here is the single source-of-truth fix.
        lastError: undefined,
        failure: undefined,
        serverPid: process.pid,
        ...(options.criteriaSetId !== undefined
          ? { criteriaSetId: options.criteriaSetId, criteriaEpoch: options.criteriaEpoch }
          : {}),
        prompts: [
          ...s.prompts,
          {
            turn: turnNumber,
            prompt: truncatePromptForStorage(options.userPrompt),
            ...(renderedMessages.length > 0 ? { peer_messages_input: [...renderedMessages] } : {}),
            ...(contractPrefix.length > 0 ? { criteriaContract: contractPrefix } : {}),
            ...(options.criteriaSetId !== undefined
              ? { criteriaSetId: options.criteriaSetId, criteriaEpoch: options.criteriaEpoch }
              : {}),
            startedAt: now,
          },
        ],
      }));

      const capWarnings = (options.peerMessagesInput?.length ?? 0) > 0
        ? this.consumeCapOverridesWarning()
        : [];
      return {
        state: nextState,
        turnNumber,
        renderedPeerMessages: renderedMessages,
        composedPrompt,
        warnings: [...pipelineResult.warnings, ...capWarnings],
      };
    });
  }

  /**
   * Mark a run's last prompt as terminal — set completedAt + status +
   * summary + filesChanged. Used by run_agent and continue_run on
   * dispatch terminal events.
   *
   * Summary length is intentionally uncapped. A 70-run sample
   * (May 2026) showed p50=2K, p90=5.9K, p99=9.9K, max=12K chars.
   * Truncating risks hiding load-bearing verdicts at the end of long
   * reviews; adapters are expected to front-load synthesis (verdict
   * + key findings appear early), making uncapped acceptable for the
   * captain's wire payload. The wire-side trim that DID land:
   * `get_run_status` no longer re-ships per-turn `prompts[].summary`
   * across multi-turn runs (top-level `summary` carries the latest
   * turn). If a future captain hits real compaction problems on
   * very long single-turn runs, revisit — candidate is to keep the
   * top-level summary uncapped but add a `summary_truncated_at`
   * marker when the adapter's output exceeds a configurable cap.
   */
  async markTerminal(
    runId: string,
    args: {
      status: 'success' | 'partial' | 'error' | 'cancelled';
      summary: string;
      filesChanged: readonly string[];
      lastError?: string;
      failure?: TaskFailure;
      /**
       * Provider conversation/session id from this turn's TaskResult. Persisted
       * for resume (agy `--conversation <id>`). When omitted/undefined, the
       * existing persisted id is preserved (a resume turn that returns no new
       * id, or an adapter that doesn't resume, must not erase a good id).
       */
      sessionId?: string;
      /**
       * Advisory messages (e.g., read-only dirty-tree probe). Merged
       * with any pre-existing warnings on the state — warnings
       * accumulate across continue_run turns rather than being
       * overwritten, so the captain sees every contract violation.
       */
      warnings?: readonly string[];
    },
  ): Promise<RunStateV1> {
    const now = new Date().toISOString();
    let changed = false;
    let shouldNotify = false;
    const next = await this.update(runId, (s) => {
      if (s.status !== 'running') {
        return s;
      }
      changed = true;
      // Capture prior status inside the same state-lock acquisition as the
      // terminal write so notification and status-guard decisions observe the
      // same state version.
      shouldNotify = true;
      const prompts = s.prompts.map((p, i): PromptRecord =>
        i === s.prompts.length - 1
          ? { ...p, completedAt: now, summary: args.summary }
          : p,
      );
      const mergedWarnings = args.warnings && args.warnings.length > 0
        ? [...(s.warnings ?? []), ...args.warnings]
        : s.warnings;
      return {
        ...s,
        status: args.status,
        completedAt: now,
        prompts,
        filesChanged: Array.from(new Set([...s.filesChanged, ...args.filesChanged])),
        sessionId: args.sessionId ?? s.sessionId,
        lastError: args.lastError ?? s.lastError,
        failure: args.failure,
        ...(mergedWarnings && mergedWarnings.length > 0 ? { warnings: mergedWarnings } : {}),
      };
    });
    if (!changed) return next;
    if (shouldNotify) {
      notifyTerminal({
        runId: next.runId,
        agentId: next.agentId,
        status: args.status,
      });
    }
    this.closeEventAppendFd(runId);
    writeRunReceipt(this.runDir(runId), next);
    return next;
  }

  async markMerged(
    runId: string,
    args: { target: string; commitSha: string },
  ): Promise<RunStateV1> {
    const next = await this.update(runId, (s) => {
      assertCanMarkMerged(runId, s.status);
      return {
        ...s,
        status: 'merged',
        completedAt: new Date().toISOString(),
        mergeStatus: { target: args.target, commitSha: args.commitSha },
      };
    });
    writeRunReceipt(this.runDir(runId), next);
    return next;
  }

  async markMergeConflict(
    runId: string,
    args: { target: string; conflicts: readonly string[] },
  ): Promise<RunStateV1> {
    const next = await this.update(runId, (s) => {
      assertCanMarkMergeConflict(runId, s.status);
      return {
        ...s,
        status: 'merge_conflict',
        // Stamp the disposition time like markMerged/markDiscarded so conflict
        // receipts don't carry the prior agent-completion time (or null).
        completedAt: new Date().toISOString(),
        mergeStatus: { target: args.target, conflicts: args.conflicts },
      };
    });
    writeRunReceipt(this.runDir(runId), next);
    return next;
  }

  async markDiscarded(runId: string): Promise<RunStateV1 | undefined> {
    return withStateLock({ crewHome: this.crewHome, runId }, async () => {
      const current = this.read(runId);
      if (!current) return undefined;
      if (current.status === 'discarded') return current;
      const next = this.updateLocked(runId, (s) => {
        assertCanMarkDiscarded(runId, s.status);
        return {
          ...s,
          status: 'discarded',
          completedAt: new Date().toISOString(),
        };
      });
      writeRunReceipt(this.runDir(runId), next);
      return next;
    });
  }

  /**
   * Append a single line to the run's events.log. Used by adapters'
   * onStream hook for live progress. Lines are written atomically (single
   * writeSync on a persistent append fd) but no framing — the host CLI
   * gets raw stdout-style chunks.
   */
  appendEvent(runId: string, line: string): void {
    const path = this.eventsLogPath(runId);
    const fd = this.eventAppendFd(runId, path);
    writeSync(fd, line.endsWith('\n') ? line : `${line}\n`, undefined, 'utf-8');
  }

  /**
   * Append several lines in one syscall. Byte-identical to calling
   * appendEvent per line — multi-line stream chunks shouldn't cost one
   * writeSync per rendered progress line.
   */
  appendEvents(runId: string, lines: readonly string[]): void {
    if (lines.length === 0) return;
    if (lines.length === 1) {
      this.appendEvent(runId, lines[0]);
      return;
    }
    const path = this.eventsLogPath(runId);
    const fd = this.eventAppendFd(runId, path);
    const payload = lines
      .map((line) => (line.endsWith('\n') ? line : `${line}\n`))
      .join('');
    writeSync(fd, payload, undefined, 'utf-8');
  }

  private eventAppendFd(runId: string, path: string): number {
    const existing = this.eventAppendFds.get(runId);
    if (existing !== undefined) return existing;
    const fd = openSync(path, 'a');
    this.eventAppendFds.set(runId, fd);
    return fd;
  }

  private closeEventAppendFd(runId: string): void {
    // The read cursor is only useful while the run can still append; drop
    // it with the fd so terminal runs don't accumulate cursor entries for
    // the server's lifetime.
    this.eventReadCursors.delete(runId);
    const fd = this.eventAppendFds.get(runId);
    if (fd === undefined) return;
    this.eventAppendFds.delete(runId);
    try {
      closeSync(fd);
    } catch (err) {
      logBestEffortFailure('run-state.close-event-append-fd', err);
    }
  }

  closeEventAppendHandles(): void {
    for (const runId of Array.from(this.eventAppendFds.keys())) {
      this.closeEventAppendFd(runId);
    }
  }

  /**
   * Return the last `n` lines of the run's events.log. Returns [] if
   * the log doesn't exist. Legacy snapshot accessor; `readEventsSince`
   * is preferred for the captain's poll loop (cursor-based, no
   * re-rendering of already-seen content).
   */
  tailEvents(runId: string, n = 50): string[] {
    const path = this.eventsLogPath(runId);
    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    const lines = content.split('\n').filter((l) => l.length > 0);
    return lines.slice(-n);
  }

  /**
   * Return the last `n` filtered events from the run's events.log.
   *
   * This preserves `readEventsSince(runId, 0)` line semantics: split on
   * LF, ignore empty records, include a final non-newline-terminated
   * partial line. Exact `events_tail_skipped` accounting requires the
   * total filtered survivor count, so this scans the file once in bounded
   * chunks with a UTF-8 decoder, applies the existing tail-noise filter to
   * raw lines, and keeps only a ring buffer of the last `n` survivors.
   */
  readFilteredTailFromEnd(runId: string, n: number): FilteredEventsTail {
    const path = this.eventsLogPath(runId);
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch (err) {
      if (isEnoent(err)) {
        return {
          lines: [],
          totalLineCount: 0,
          totalFilteredCount: 0,
          filteredOutCount: 0,
        };
      }
      throw err;
    }

    try {
      const size = fstatSync(fd).size;
      if (size === 0) {
        return {
          lines: [],
          totalLineCount: 0,
          totalFilteredCount: 0,
          filteredOutCount: 0,
        };
      }

      const limit = n > 0 ? Math.floor(n) : 0;
      const cached = this.terminalTailCache.get(runId);
      if (cached && cached.size === size && cached.limit === limit) {
        return cached.tail;
      }

      this.terminalTailScans += 1;
      const tail: string[] = [];
      let totalLineCount = 0;
      let totalFilteredCount = 0;
      let pending = '';
      let offset = 0;
      const buffer = Buffer.allocUnsafe(Math.min(EVENT_LOG_SCAN_CHUNK_BYTES, size));
      const decoder = new StringDecoder('utf8');

      const recordLine = (line: string): void => {
        if (line.length === 0) return;
        totalLineCount += 1;
        if (isEventsTailNoiseLine(line)) return;
        totalFilteredCount += 1;
        if (limit === 0) return;
        if (tail.length === limit) tail.shift();
        tail.push(line);
      };

      while (offset < size) {
        const length = Math.min(buffer.length, size - offset);
        const bytesRead = readSync(fd, buffer, 0, length, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;

        const text = pending + decoder.write(buffer.subarray(0, bytesRead));
        const parts = text.split('\n');
        pending = parts.pop() ?? '';
        for (const part of parts) {
          recordLine(part);
        }
      }

      const finalText = pending + decoder.end();
      if (finalText.length > 0) {
        recordLine(finalText);
      }

      const result: FilteredEventsTail = {
        lines: tail,
        totalLineCount,
        totalFilteredCount,
        filteredOutCount: totalLineCount - totalFilteredCount,
      };
      this.terminalTailCache.set(runId, { size, limit, tail: result });
      return result;
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Return events.log lines with index >= `sinceLine` plus a fresh
   * cursor (`nextLine` = total line count after the read). The captain
   * passes `nextLine` back as `sinceLine` on the next poll so each
   * call surfaces only new content.
   *
   * Empty + nextLine=0 if the log doesn't exist yet (run hasn't
   * produced output). Stable across polls when no new content has
   * arrived (lines: [], nextLine === sinceLine).
   */
  readEventsSince(runId: string, sinceLine = 0): {
    readonly lines: string[];
    readonly nextLine: number;
  } {
    const path = this.eventsLogPath(runId);
    const start = Math.max(0, sinceLine);
    const cursor = this.eventReadCursors.get(runId);
    if (cursor && cursor.lineCount === start) {
      const incremental = this.readEventsFromCursor(runId, path, cursor);
      if (incremental) return incremental;
    }
    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch (err) {
      if (isEnoent(err)) {
        this.eventReadCursors.delete(runId);
        return { lines: [], nextLine: 0 };
      }
      throw err;
    }
    this.fullEventLogReads += 1;
    const all = content.split('\n').filter((l) => l.length > 0);
    this.eventReadCursors.set(runId, {
      lineCount: all.length,
      byteOffset: Buffer.byteLength(content),
    });
    return { lines: all.slice(start), nextLine: all.length };
  }

  private readEventsFromCursor(
    runId: string,
    path: string,
    cursor: { lineCount: number; byteOffset: number },
  ): { readonly lines: string[]; readonly nextLine: number } | undefined {
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch (err) {
      if (isEnoent(err)) {
        this.eventReadCursors.delete(runId);
        return { lines: [], nextLine: 0 };
      }
      throw err;
    }
    try {
      const size = fstatSync(fd).size;
      if (size < cursor.byteOffset) {
        this.eventReadCursors.delete(runId);
        return undefined;
      }
      if (size === cursor.byteOffset) {
        return { lines: [], nextLine: cursor.lineCount };
      }

      const decoder = new StringDecoder('utf8');
      const buffer = Buffer.allocUnsafe(Math.min(EVENT_LOG_SCAN_CHUNK_BYTES, size - cursor.byteOffset));
      let offset = cursor.byteOffset;
      let text = '';
      while (offset < size) {
        const length = Math.min(buffer.length, size - offset);
        const bytesRead = readSync(fd, buffer, 0, length, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
        text += decoder.write(buffer.subarray(0, bytesRead));
      }
      text += decoder.end();
      const lines = text.split('\n').filter((l) => l.length > 0);
      const nextLine = cursor.lineCount + lines.length;
      this.eventReadCursors.set(runId, { lineCount: nextLine, byteOffset: size });
      return { lines, nextLine };
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Cursor-based read with adapter-noise filtering applied to the
   * returned lines. The cursor (`nextLine`) advances against the *raw*
   * file offset — same as {@link readEventsSince} — so callers paging
   * by line index stay in sync with the on-disk log even when the
   * filter drops every line in a window.
   *
   * Returns the same `{ lines, nextLine }` shape as `readEventsSince`,
   * but `lines` excludes pure adapter receipts (see
   * `events-filter.ts`). Used by `get_run_status`'s long-poll fast-
   * return path so a burst of receipt lines doesn't trip a no-signal
   * wake-up: if every new line in the window would be filtered, the
   * fast-return falls through to the long-poll wait. `events.log` on
   * disk is unchanged; `events_log_path` consumers (tail -F users)
   * still see full chronology.
   */
  readSignalEventsSince(runId: string, sinceLine = 0): {
    readonly lines: string[];
    readonly nextLine: number;
  } {
    const { lines, nextLine } = this.readEventsSince(runId, sinceLine);
    return { lines: filterEventsTailNoise(lines), nextLine };
  }

  /**
   * Total events.log line count for a run. The running-status branch of
   * `get_run_status` needs ONLY this number (its `events_tail` is always
   * empty), and captains typically omit `since_event_line`, so reading
   * from the caller's cursor would re-scan the whole file on every poll.
   * Reading from the store's own cursor instead makes the incremental
   * fast path engage regardless of what the caller passed: the first
   * call per run seeds the cursor with one full read; every later call
   * reads only appended bytes (or nothing, when the size is unchanged).
   * Shrink/ENOENT self-healing matches `readEventsSince`.
   */
  getEventLineCount(runId: string): number {
    const cursorLine = this.eventReadCursors.get(runId)?.lineCount ?? 0;
    return this.readEventsSince(runId, cursorLine).nextLine;
  }

  /**
   * Test seam: counters for the O(file-size) event-log scan paths plus
   * live map sizes, so regression tests can assert the cursor/cache fast
   * paths hold and terminal runs release their cursor entries.
   */
  eventReadDiagnosticsForTest(): {
    readonly fullEventLogReads: number;
    readonly terminalTailScans: number;
    readonly eventReadCursorCount: number;
    readonly terminalTailCacheCount: number;
  } {
    return {
      fullEventLogReads: this.fullEventLogReads,
      terminalTailScans: this.terminalTailScans,
      eventReadCursorCount: this.eventReadCursors.size,
      terminalTailCacheCount: this.terminalTailCache.size,
    };
  }

  /**
   * Path to a run's directory under .crew/runs/.
   */
  runDir(runId: string): string {
    return join(this.runsBasePath, runId);
  }

  /**
   * Permanently delete a run's directory (state.json, events.log, and any
   * residual worktree dir). Used by the run GC once a terminal run ages
   * past the run-dir retention window. Idempotent: a missing dir is a
   * no-op. Does NOT touch the run's `crew-run/*` branch — that lives in
   * the host repo's git, not under the run dir, so history survives.
   */
  deleteRunDir(runId: string): void {
    this.eventReadCursors.delete(runId);
    this.terminalTailCache.delete(runId);
    this.parsedStateCache.delete(runId);
    rmSync(this.runDir(runId), { recursive: true, force: true });
  }

  /**
   * Absolute path to a run's append-only semantic event log.
   */
  eventsLogPath(runId: string): string {
    return join(this.runsBasePath, runId, 'events.log');
  }

  private statePath(runId: string): string {
    return join(this.runsBasePath, runId, 'state.json');
  }

  /**
   * Atomic write via tmp + rename. Prevents partial writes from leaving
   * state.json half-parsed if the process is interrupted mid-flush.
   * Primes the parse cache with the just-written state so the next
   * read() is stat-only instead of a full re-parse.
   */
  private writeAtomic(runId: string, state: RunStateV1): void {
    const path = this.statePath(runId);
    atomicWrite(path, JSON.stringify(state, null, 2));
    try {
      this.parsedStateCache.set(runId, { mtimeMs: statSync(path).mtimeMs, state });
    } catch {
      this.parsedStateCache.delete(runId);
    }
  }
}

/**
 * Resolve the repo root through any symlinks so two paths that point at
 * the same tree (`/Users/.../code/widget` vs `/Volumes/.../widget` via
 * a symlink) agree on a single canonical repoRoot. Falls back to the
 * raw path if realpath fails (e.g., the directory was removed between
 * caller and constructor — vanishingly rare in practice).
 */
function resolveRepoRoot(raw: string): string {
  try {
    return realpathSync(raw);
  } catch {
    return raw;
  }
}
