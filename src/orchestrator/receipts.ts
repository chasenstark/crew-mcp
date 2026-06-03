/**
 * Structured run receipts.
 *
 * Alongside the internal `state.json` (mutable bookkeeping: prompts, event
 * cursors, serverPid, etc.) every run also gets two stable, external-facing
 * artifacts written into its run-dir whenever it reaches a terminal state:
 *
 *   - `run.json`    — a versioned, machine-readable receipt (timing, status,
 *                     files changed, error, merge disposition). Intended for
 *                     CI gating, replay, and handoff to external tooling that
 *                     should NOT have to parse the internal state schema.
 *   - `summary.md`  — a human-readable digest ending with the agent's own
 *                     final output, for quick eyeballing of what a run did.
 *
 * Both are derived purely from `RunStateV1` and rewritten on every terminal
 * transition (run finished, merged, discarded, conflicted) so their `status`
 * always reflects the run's final disposition. Writing is best-effort: a
 * receipt is an additive convenience, never load-bearing, so a write failure
 * is logged but never propagated into the run's terminal transition.
 *
 * A future error-taxonomy enum (see `docs/plans/active/competitive-analysis-mco-cao.md` §5.6)
 * will add an `error_kind` field here; today `run.json` carries the raw
 * `error` message and the semantic `status` only.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWrite } from '../utils/atomic-write.js';
import { logBestEffortFailure } from '../utils/best-effort.js';
import { logger } from '../utils/logger.js';
import type { RunStateV1, RunStatus } from './run-state.js';

export const RUN_RECEIPT_FILENAME = 'run.json';
export const RUN_SUMMARY_FILENAME = 'summary.md';

const RECEIPT_SCHEMA_VERSION = 1 as const;

/**
 * Stable, documented shape of `run.json`. Additive-only: new optional fields
 * may appear, but existing fields keep their meaning across versions so
 * external consumers can rely on them. Bump `schemaVersion` only on a
 * breaking change.
 */
export interface RunReceiptV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly agentId: string;
  readonly status: RunStatus;
  /** True iff the run was dispatched `read_only` (no owned worktree). */
  readonly readOnly: boolean;
  /** ISO timestamp the run was first created. */
  readonly startedAt: string;
  /** ISO timestamp the run reached its terminal state, if known. */
  readonly completedAt: string | null;
  /** Wall-clock run duration in ms (completedAt − startedAt), if computable. */
  readonly durationMs: number | null;
  /** Number of turns (initial dispatch + each continue_run). */
  readonly turns: number;
  readonly filesChanged: readonly string[];
  readonly worktreePath: string;
  readonly repoRoot: string | null;
  /** Merge disposition once a run is merged or conflicts; null otherwise. */
  readonly merge:
    | { readonly target: string; readonly commitSha?: string; readonly conflicts?: readonly string[] }
    | null;
  /** Raw terminal error message, if the run failed. */
  readonly error: string | null;
  readonly warnings: readonly string[];
}

/** Epoch-ms of a parseable ISO timestamp, or undefined. */
function epochMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Project a run's state into the external receipt shape. */
export function buildRunReceipt(state: RunStateV1): RunReceiptV1 {
  const lastPrompt = state.prompts[state.prompts.length - 1];
  const completedAt = state.completedAt ?? lastPrompt?.completedAt ?? null;
  const startMs = epochMs(state.startedAt);
  const endMs = epochMs(completedAt ?? undefined);
  // Clamp to 0: clock skew or an out-of-order timestamp must never render a
  // negative duration (e.g. "-1m -3s") in summary.md.
  const durationMs =
    startMs !== undefined && endMs !== undefined ? Math.max(0, endMs - startMs) : null;

  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    runId: state.runId,
    agentId: state.agentId,
    status: state.status,
    readOnly: state.readOnly ?? false,
    startedAt: state.startedAt,
    completedAt,
    durationMs,
    turns: state.prompts.length,
    filesChanged: state.filesChanged,
    worktreePath: state.worktreePath,
    repoRoot: state.repoRoot ?? null,
    merge: state.mergeStatus
      ? {
          target: state.mergeStatus.target,
          ...(state.mergeStatus.commitSha ? { commitSha: state.mergeStatus.commitSha } : {}),
          ...(state.mergeStatus.conflicts ? { conflicts: state.mergeStatus.conflicts } : {}),
        }
      : null,
    error: state.lastError ?? null,
    warnings: state.warnings ?? [],
  };
}

/** Format a ms duration as a compact human string (e.g. "1m 12s", "840ms"). */
function formatDuration(ms: number | null): string {
  if (ms === null) return 'unknown';
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

/** Render the human-readable `summary.md` for a run. */
export function renderRunSummaryMarkdown(state: RunStateV1): string {
  const receipt = buildRunReceipt(state);
  const lastPrompt = state.prompts[state.prompts.length - 1];
  const lines: string[] = [];

  lines.push(`# Run ${receipt.runId}`, '');
  lines.push(`- **Agent:** ${receipt.agentId}`);
  lines.push(`- **Status:** ${receipt.status}`);
  if (receipt.readOnly) lines.push('- **Mode:** read-only');
  lines.push(`- **Started:** ${receipt.startedAt}`);
  lines.push(`- **Completed:** ${receipt.completedAt ?? 'n/a'}`);
  lines.push(`- **Duration:** ${formatDuration(receipt.durationMs)}`);
  lines.push(`- **Turns:** ${receipt.turns}`);
  if (receipt.repoRoot) lines.push(`- **Repo:** ${receipt.repoRoot}`);
  if (receipt.merge) {
    const commit = receipt.merge.commitSha ? ` (${receipt.merge.commitSha})` : '';
    lines.push(`- **Merged into:** ${receipt.merge.target}${commit}`);
    if (receipt.merge.conflicts && receipt.merge.conflicts.length > 0) {
      lines.push(`- **Conflicts:** ${receipt.merge.conflicts.join(', ')}`);
    }
  }

  if (receipt.filesChanged.length > 0) {
    lines.push('', '## Files changed', '');
    for (const file of receipt.filesChanged) lines.push(`- ${file}`);
  }

  if (receipt.warnings.length > 0) {
    lines.push('', '## Warnings', '');
    for (const warning of receipt.warnings) lines.push(`- ${warning}`);
  }

  if (receipt.error) {
    lines.push('', '## Error', '', '```', receipt.error, '```');
  }

  const output = lastPrompt?.summary?.trim();
  if (output) {
    lines.push('', '## Output', '', output);
  }

  return lines.join('\n') + '\n';
}

/**
 * Write `run.json` + `summary.md` into a run's directory. Best-effort: any
 * failure is logged at warn level and swallowed so receipt I/O can never
 * break a run's terminal transition. The run-dir is created if missing.
 */
export function writeRunReceipt(runDir: string, state: RunStateV1): void {
  try {
    mkdirSync(runDir, { recursive: true });
    const receipt = buildRunReceipt(state);
    atomicWrite(join(runDir, RUN_RECEIPT_FILENAME), JSON.stringify(receipt, null, 2) + '\n');
    atomicWrite(join(runDir, RUN_SUMMARY_FILENAME), renderRunSummaryMarkdown(state));
  } catch (err) {
    logBestEffortFailure('run-receipt.write', err);
    logger.warn('Failed to write run receipt', { runId: state.runId, runDir, err });
  }
}
