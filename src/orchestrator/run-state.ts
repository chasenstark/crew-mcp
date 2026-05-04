/**
 * Per-run state persistence for v2.
 *
 * Each run owns a directory at `.crew/runs/<runId>/` that contains its
 * worktree (managed by WorktreeManager), a `state.json` (managed here),
 * and an append-only `events.log` (also here). Together those three files
 * are the durable record of a run that the host CLI can poll, resume, or
 * merge. The directory survives crew-serve restarts.
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
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  readonly prompts: readonly PromptRecord[];
  readonly filesChanged: readonly string[];
  readonly lastError?: string;
  readonly mergeStatus?: MergeStatus;
}

const SCHEMA_VERSION = 1 as const;

export interface CreateRunStateInit {
  readonly runId: string;
  readonly agentId: string;
  readonly worktreePath: string;
  readonly initialPrompt: string;
}

/**
 * Manages `.crew/runs/<runId>/state.json` + `events.log` files. One
 * instance per project root; thread-safe enough for the in-process v2
 * usage pattern (single host CLI session = single crew serve process =
 * serial tool calls).
 */
export class RunStateStore {
  private readonly runsBasePath: string;

  constructor(projectRoot: string) {
    this.runsBasePath = join(projectRoot, '.crew', 'runs');
    mkdirSync(this.runsBasePath, { recursive: true });
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
    return state;
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
   */
  markTerminal(
    runId: string,
    args: {
      status: 'success' | 'partial' | 'error' | 'cancelled';
      summary: string;
      filesChanged: readonly string[];
      lastError?: string;
    },
  ): RunStateV1 {
    const now = new Date().toISOString();
    return this.update(runId, (s) => {
      const prompts = s.prompts.map((p, i): PromptRecord =>
        i === s.prompts.length - 1
          ? { ...p, completedAt: now, summary: args.summary }
          : p,
      );
      return {
        ...s,
        status: args.status,
        completedAt: now,
        prompts,
        filesChanged: Array.from(new Set([...s.filesChanged, ...args.filesChanged])),
        lastError: args.lastError ?? s.lastError,
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
   * the log doesn't exist. Used by get_run_status.
   */
  tailEvents(runId: string, n = 50): string[] {
    const path = this.eventsLogPath(runId);
    if (!existsSync(path)) return [];
    const content = readFileSync(path, 'utf-8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    return lines.slice(-n);
  }

  /**
   * Path to a run's directory under .crew/runs/.
   */
  runDir(runId: string): string {
    return join(this.runsBasePath, runId);
  }

  private statePath(runId: string): string {
    return join(this.runsBasePath, runId, 'state.json');
  }

  private eventsLogPath(runId: string): string {
    return join(this.runsBasePath, runId, 'events.log');
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
