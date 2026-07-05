/**
 * Run lifecycle modes — the single source of truth for what a run's mode
 * implies, replacing the overloaded `readOnly` boolean that used to gate
 * four independent concerns (worktree allocation, adapter sandbox, merge
 * eligibility, discard/cleanup behavior).
 *
 *   - `write`            — owns a worktree, mergeable via merge_run. The
 *                          default implementation lifecycle.
 *   - `read_only`        — no owned worktree; runs in place against the
 *                          host repo (or a caller-supplied directory).
 *                          Never mergeable.
 *   - `ephemeral_review` — owns a worktree (like `write`) but is NEVER
 *                          mergeable: a write-capable agent (agy) reviews
 *                          a disposable snapshot, only its TEXT findings
 *                          are kept, and any file changes it made are
 *                          discarded with the worktree (explicit
 *                          discard_run / panel discard / run-GC — it is
 *                          retained after terminal so `continue_run`
 *                          follow-ups work against a FROZEN snapshot).
 *
 * Every internal reader must route through these resolvers — never read
 * the raw persisted `readOnly` field directly. `RunStateV1.readOnly` is a
 * pure legacy shim persisted as `!isMergeable(runMode)` so version-skewed
 * old servers refuse to merge an ephemeral review instead of mistaking it
 * for a mergeable write run.
 */

export type RunMode = 'write' | 'read_only' | 'ephemeral_review';

export const RUN_MODES = ['write', 'read_only', 'ephemeral_review'] as const;

function isRunMode(value: unknown): value is RunMode {
  return typeof value === 'string' && (RUN_MODES as readonly string[]).includes(value);
}

/** Whether this mode allocates (and owns) a per-run worktree. */
export function ownsWorktree(mode: RunMode): boolean {
  return mode !== 'read_only';
}

/** Whether merge_run may land this run. Only plain write runs merge. */
export function isMergeable(mode: RunMode): boolean {
  return mode === 'write';
}

/**
 * The value persisted into the legacy `RunStateV1.readOnly` field for a
 * given mode. `!isMergeable` (not `!ownsWorktree`) is deliberate: an old
 * server that only knows `readOnly` will then refuse to merge an
 * ephemeral review (correct) at the cost of skipping its worktree removal
 * on discard (hygiene only — the run-GC sweep reclaims it).
 */
export function legacyReadOnlyShim(mode: RunMode): boolean {
  return !isMergeable(mode);
}

export type RunModeInputResolution =
  | { readonly ok: true; readonly mode: RunMode }
  | { readonly ok: false; readonly message: string };

/**
 * Resolve the requested mode from run_agent input. `read_only: true`
 * remains legacy sugar for `run_mode: 'read_only'`; when both fields are
 * supplied they must AGREE — a disagreement is rejected loudly instead of
 * silently letting one win (an ambiguous dispatch must not guess between
 * "run in place" and "allocate a disposable worktree").
 */
export function runModeFromInput(input: {
  readonly run_mode?: RunMode;
  readonly read_only?: boolean;
}): RunModeInputResolution {
  const { run_mode: runMode, read_only: readOnly } = input;
  if (runMode !== undefined && readOnly !== undefined) {
    const agree = readOnly === (runMode === 'read_only');
    if (!agree) {
      return {
        ok: false,
        message:
          `run_agent: conflicting mode inputs — run_mode:"${runMode}" with read_only:${readOnly}. `
          + 'read_only is legacy sugar for run_mode:"read_only"; pass run_mode alone '
          + '(or read_only alone) instead of a disagreeing pair.',
      };
    }
  }
  return { ok: true, mode: runMode ?? (readOnly === true ? 'read_only' : 'write') };
}

/**
 * Resolve a persisted run's mode. Legacy records (no `runMode` field)
 * derive from the `readOnly` shim. An unrecognized `runMode` string
 * (written by a newer server) also falls back to the shim — the shim is
 * defined as `!isMergeable`, so an unknown future mode degrades to
 * "read-only-ish, non-mergeable", the fail-safe interpretation.
 */
export function runModeFromState(state: {
  readonly runMode?: string;
  readonly readOnly?: boolean;
}): RunMode {
  if (isRunMode(state.runMode)) return state.runMode;
  return state.readOnly === true ? 'read_only' : 'write';
}
