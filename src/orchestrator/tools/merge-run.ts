/**
 * merge_run — merge a run's worktree back into the host's HEAD.
 *
 * The single safety boundary in v2: the host CLI must call this
 * explicitly. crew never auto-merges. By default the server also
 * requires confirmed:true, and the captain skill instructs the host to
 * ask the user for approval before invoking this tool.
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
 *     worktree is preserved. On `conflict`, either resolve conflicts
 *     in the host repo and retry `merge_run`, or `git merge --abort`
 *     and `discard_run` to throw away the run.
 */

import { z } from 'zod';

export const mergeRunInputSchema = z.object({
  run_id: z.string().min(1),
  target_branch: z.string().optional(),
  force: z.boolean().optional(),
  /**
   * Must be true when config confirmBeforeMerge is enabled. Captains
   * may pass it only after explicit affirmative user approval.
   */
  confirmed: z.boolean().optional(),
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
  "Merge a completed run's worktree into the host HEAD after the user chooses to keep it. Input takes run_id plus optional target_branch, force, confirmed, commit_title, and commit_body; when config confirmBeforeMerge is true, confirmed:true is required and must only follow explicit user approval. The merge commit automatically receives a `Crew-Run: <run_id>` trailer. Returns { status: 'merged', commit_sha }, { status: 'conflict', conflicts }, or { status: 'no-changes' }; merged worktrees are cleaned up, while conflict/no-changes worktrees are preserved.";
