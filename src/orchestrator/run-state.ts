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

import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  chmodSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { logger } from '../utils/logger.js';
import { filterEventsTailNoise } from './events-filter.js';
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

export interface PromptRecord {
  readonly turn: number;
  readonly prompt: string;
  readonly peer_messages_input?: readonly PeerMessageRendered[];
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
   * True iff this run was dispatched with `read_only: true` — no
   * worktree was allocated, `worktreePath` is informational (the
   * agent's CWD, not a worktree we own), `merge_run` refuses, and
   * `discard_run` is metadata-only. Sticky on `continue_run`.
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
  readonly prompts: readonly PromptRecord[];
  readonly filesChanged: readonly string[];
  readonly lastError?: string;
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
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PROMPT_STORAGE_CAP_CHARS;
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

export interface CreateRunStateInit {
  readonly runId: string;
  readonly agentId: string;
  readonly worktreePath: string;
  readonly initialPrompt: string;
  readonly initialPeerMessagesInput?: readonly PeerMessageInput[];
  /**
   * Whether this run was dispatched with `read_only: true`. Persisted
   * so `continue_run` can read the bit back and stay sticky, and so
   * `merge_run` / `discard_run` can branch on it without consulting
   * the dispatcher.
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
      const composedPrompt = pipelineResult.rendered + init.initialPrompt;
      if (composedPrompt.length > this.caps.composedPromptCap) {
        throw new Error(
          `peer_messages.composed_prompt_too_large: ${composedPrompt.length} ` +
          `> ${this.caps.composedPromptCap}`,
        );
      }

      const state: RunStateV1 = {
        schemaVersion: SCHEMA_VERSION,
        runId: init.runId,
        agentId: init.agentId,
        status: 'running',
        startedAt: now,
        worktreePath: init.worktreePath,
        repoRoot: this.repoRoot,
        serverPid: process.pid,
        ...(init.readOnly ? { readOnly: true } : {}),
        prompts: [
          {
            turn: 1,
            prompt: truncatePromptForStorage(init.initialPrompt),
            ...(renderedMessages.length > 0 ? { peer_messages_input: [...renderedMessages] } : {}),
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
      logger.debug('Failed to write tail.command helper', { runId, tailPath, err });
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
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch (err) {
      if (isEnoent(err)) return undefined;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Failed to parse run state for ${runId} at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
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
    return parsed as RunStateV1;
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
      const composedPrompt = pipelineResult.rendered + options.userPrompt;
      if (composedPrompt.length > this.caps.composedPromptCap) {
        throw new Error(
          `peer_messages.composed_prompt_too_large: ${composedPrompt.length} ` +
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
        serverPid: process.pid,
        prompts: [
          ...s.prompts,
          {
            turn: turnNumber,
            prompt: truncatePromptForStorage(options.userPrompt),
            ...(renderedMessages.length > 0 ? { peer_messages_input: [...renderedMessages] } : {}),
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
        lastError: args.lastError ?? s.lastError,
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
    writeRunReceipt(this.runDir(runId), next);
    return next;
  }

  async markMerged(
    runId: string,
    args: { target: string; commitSha: string },
  ): Promise<RunStateV1> {
    const next = await this.update(runId, (s) => ({
      ...s,
      status: 'merged',
      completedAt: new Date().toISOString(),
      mergeStatus: { target: args.target, commitSha: args.commitSha },
    }));
    writeRunReceipt(this.runDir(runId), next);
    return next;
  }

  async markMergeConflict(
    runId: string,
    args: { target: string; conflicts: readonly string[] },
  ): Promise<RunStateV1> {
    const next = await this.update(runId, (s) => ({
      ...s,
      status: 'merge_conflict',
      // Stamp the disposition time like markMerged/markDiscarded so conflict
      // receipts don't carry the prior agent-completion time (or null).
      completedAt: new Date().toISOString(),
      mergeStatus: { target: args.target, conflicts: args.conflicts },
    }));
    writeRunReceipt(this.runDir(runId), next);
    return next;
  }

  async markDiscarded(runId: string): Promise<RunStateV1 | undefined> {
    return withStateLock({ crewHome: this.crewHome, runId }, async () => {
      const current = this.read(runId);
      if (!current) return undefined;
      const next = this.updateLocked(runId, (s) => ({
        ...s,
        status: 'discarded',
        completedAt: new Date().toISOString(),
      }));
      writeRunReceipt(this.runDir(runId), next);
      return next;
    });
  }

  /**
   * Append a single line to the run's events.log. Used by adapters'
   * onStream hook for live progress. Lines are written atomically (single
   * fs.appendFileSync) but no framing — the host CLI gets raw stdout-style
   * chunks.
   */
  appendEvent(runId: string, line: string): void {
    const path = this.eventsLogPath(runId);
    appendFileSync(path, line.endsWith('\n') ? line : `${line}\n`, 'utf-8');
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
        const filtered = filterEventsTailNoise([line]);
        if (filtered.length === 0) return;
        totalFilteredCount += 1;
        if (limit === 0) return;
        if (tail.length === limit) tail.shift();
        tail.push(filtered[0]);
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

      return {
        lines: tail,
        totalLineCount,
        totalFilteredCount,
        filteredOutCount: totalLineCount - totalFilteredCount,
      };
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
    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch (err) {
      if (isEnoent(err)) return { lines: [], nextLine: 0 };
      throw err;
    }
    const all = content.split('\n').filter((l) => l.length > 0);
    const start = Math.max(0, sinceLine);
    return { lines: all.slice(start), nextLine: all.length };
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
   */
  private writeAtomic(runId: string, state: RunStateV1): void {
    const path = this.statePath(runId);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    renameSync(tmp, path);
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
