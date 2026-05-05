/**
 * merge_run — merge a run's worktree back into the host's HEAD.
 *
 * The single safety boundary in v2: the host CLI must call this
 * explicitly. crew never auto-merges. The captain skill (M3) instructs
 * the host to ask the user for approval before invoking this tool.
 *
 * Behavior:
 *   - Auto-commits any uncommitted changes in the worktree first
 *     (using `commit_title` if supplied, else "crew: auto-commit
 *     before merge").
 *   - Refuses if the host's working directory has uncommitted changes,
 *     unless force=true.
 *   - Always uses --no-ff so the merge is explicit and auditable.
 *   - Merge commit message: `commit_title` (subject) +
 *     `commit_body` (optional paragraph) + a `Crew-Run: <run_id>`
 *     trailer. Falls back to `Merge crew run <runId>` only when
 *     no commit_title is provided — captains should provide one.
 *   - Returns { status: 'merged', commit_sha } on success, or
 *     { status: 'conflict', conflicts: [...] } on conflict (worktree
 *     stays alive for resolution), or { status: 'no-changes' } when
 *     worktree HEAD already matches the target.
 *   - On `merged`, the worktree directory is auto-cleaned best-effort
 *     (the merged commit is permanently in the host's HEAD, so the
 *     worktree has no remaining value). state.json + events.log
 *     persist for archeology. On `conflict` or `no-changes` the
 *     worktree is preserved — the captain can resolve, retry, or
 *     iterate via continue_run, then explicitly discard_run.
 */

import { z } from 'zod';

export const mergeRunInputSchema = z.object({
  run_id: z.string().min(1),
  target_branch: z.string().optional(),
  force: z.boolean().optional(),
  /**
   * Conventional-commit-style subject line for the merge commit.
   * Should describe what the run actually changed (the captain
   * has the prompt + summary + diff context to compose this).
   * Recommended ≤72 chars; not enforced. When omitted, the merge
   * commit falls back to `Merge crew run <runId>` — strongly
   * suboptimal for human-readable history.
   */
  commit_title: z.string().min(1).max(200).optional(),
  /**
   * Additional paragraphs for the merge-commit body. The
   * `Crew-Run: <run_id>` trailer is appended automatically; do
   * not include it manually.
   */
  commit_body: z.string().optional(),
});

export type MergeRunInput = z.infer<typeof mergeRunInputSchema>;

export const MERGE_RUN_DESCRIPTION =
  "Merge a run's worktree back into the host's HEAD. ALWAYS confirm with the user before calling this — it's the only tool that mutates the user's branch. **Pass `commit_title`** (and optionally `commit_body`) describing what the run changed; the merge commit uses these as its subject + body, with a `Crew-Run: <run_id>` trailer auto-appended. Omitting commit_title falls back to a generic 'Merge crew run <id>' message — fine for throwaway runs, bad for any history a human will read. Optional target_branch defaults to the host's current branch. Pass force=true only when the user has explicitly accepted that the host's uncommitted changes will be left untouched. On `merged` status the worktree is auto-cleaned (no follow-up discard_run needed); on `conflict` or `no-changes` the worktree is preserved for resolution or iteration. Returns { status: 'merged' | 'conflict' | 'no-changes' }.";
