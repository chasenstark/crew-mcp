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
 *   - get_run_status → read() + tailEvents()
 *
 * Schema is versioned (`schemaVersion`) but only V1 exists today. Reader
 * is strict: unknown schema versions throw rather than silently corrupt.
 * `repoRoot` was added in M3.5 — `read()` tolerates legacy records that
 * were written without it (the field is informational, not load-bearing).
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, appendFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { logger } from '../utils/logger.js';

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

export interface CreateRunStateInit {
  readonly runId: string;
  readonly agentId: string;
  readonly worktreePath: string;
  readonly initialPrompt: string;
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

/**
 * Manages `<crewHome>/runs/<runId>/state.json` + `events.log` files.
 * One instance per (host repo, crew serve) pair; thread-safe enough
 * for the in-process v2 usage pattern (single host CLI session =
 * single crew serve process = serial tool calls).
 */
export class RunStateStore {
  private readonly runsBasePath: string;
  private readonly repoRoot: string;

  constructor(options: RunStateStoreOptions) {
    this.runsBasePath = join(options.crewHome, 'runs');
    mkdirSync(this.runsBasePath, { recursive: true });
    this.repoRoot = resolveRepoRoot(options.repoRoot);
  }

  /**
   * Create the initial state.json for a new run. Called at the beginning
   * of every run_agent dispatch — before the adapter is invoked. The run
   * directory is created if it doesn't already exist (the worktree
   * manager may have created it first; either order is fine).
   */
  create(init: CreateRunStateInit): RunStateV1 {
    const now = new Date().toISOString();
    const state: RunStateV1 = {
      schemaVersion: SCHEMA_VERSION,
      runId: init.runId,
      agentId: init.agentId,
      status: 'running',
      startedAt: now,
      worktreePath: init.worktreePath,
      repoRoot: this.repoRoot,
      ...(init.readOnly ? { readOnly: true } : {}),
      prompts: [
        {
          turn: 1,
          prompt: init.initialPrompt,
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
    return state;
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
   * Read the state.json for a run. Returns undefined if the run directory
   * doesn't exist or state.json is missing. Throws on parse errors and
   * unknown schema versions — better to fail loudly than silently corrupt.
   */
  read(runId: string): RunStateV1 | undefined {
    const path = this.statePath(runId);
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, 'utf-8');
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
   * Atomic update: read, transform, write. Throws if the run doesn't
   * exist (callers should `read` first when they want soft-handling).
   */
  update(runId: string, updater: (state: RunStateV1) => RunStateV1): RunStateV1 {
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
   */
  appendPrompt(runId: string, prompt: string): RunStateV1 {
    const now = new Date().toISOString();
    return this.update(runId, (s) => ({
      ...s,
      status: 'running',
      completedAt: undefined,
      prompts: [
        ...s.prompts,
        { turn: s.prompts.length + 1, prompt, startedAt: now },
      ],
    }));
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
  markTerminal(
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
  ): RunStateV1 {
    const now = new Date().toISOString();
    return this.update(runId, (s) => {
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
  }

  markMerged(runId: string, args: { target: string; commitSha: string }): RunStateV1 {
    return this.update(runId, (s) => ({
      ...s,
      status: 'merged',
      completedAt: new Date().toISOString(),
      mergeStatus: { target: args.target, commitSha: args.commitSha },
    }));
  }

  markMergeConflict(
    runId: string,
    args: { target: string; conflicts: readonly string[] },
  ): RunStateV1 {
    return this.update(runId, (s) => ({
      ...s,
      status: 'merge_conflict',
      mergeStatus: { target: args.target, conflicts: args.conflicts },
    }));
  }

  markDiscarded(runId: string): RunStateV1 | undefined {
    const current = this.read(runId);
    if (!current) return undefined;
    return this.update(runId, (s) => ({
      ...s,
      status: 'discarded',
      completedAt: new Date().toISOString(),
    }));
  }

  /**
   * Append a single line to the run's events.log. Used by adapters'
   * onStream hook for live progress. Lines are written atomically (single
   * fs.appendFileSync) but no framing — the host CLI gets raw stdout-style
   * chunks.
   */
  appendEvent(runId: string, line: string): void {
    const path = this.eventsLogPath(runId);
    mkdirSync(dirname(path), { recursive: true });
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
    if (!existsSync(path)) return [];
    const content = readFileSync(path, 'utf-8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    return lines.slice(-n);
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
    if (!existsSync(path)) return { lines: [], nextLine: 0 };
    const content = readFileSync(path, 'utf-8');
    const all = content.split('\n').filter((l) => l.length > 0);
    const start = Math.max(0, sinceLine);
    return { lines: all.slice(start), nextLine: all.length };
  }

  /**
   * Path to a run's directory under .crew/runs/.
   */
  runDir(runId: string): string {
    return join(this.runsBasePath, runId);
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
    const tmp = `${path}.tmp`;
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
