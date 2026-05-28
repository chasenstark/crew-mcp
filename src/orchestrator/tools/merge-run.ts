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
 *   - Squash-merges the run into a single ordinary commit on the target
 *     (no empty `--no-ff` wrapper commit).
 *   - Commit message: `commit_title` (subject) + `commit_body`
 *     (optional paragraph). Falls back to `crew run <runId>` only when
 *     no commit_title is provided — captains should provide one.
 *   - Returns { status: 'merged', commit_sha } on success, or
 *     { status: 'conflict', conflicts: [...] } on conflict (worktree
 *     stays alive for resolution), or { status: 'no-changes' } when
 *     worktree HEAD already matches the target.
 *   - On `merged`, the worktree directory is auto-cleaned best-effort
 *     (the merged commit is permanently in the host's HEAD, so the
 *     worktree has no remaining value). state.json + events.log
 *     persist for archeology. On `conflict` or `no-changes` the
 *     worktree is preserved. On `conflict`, the host has conflict
 *     markers staged but no `MERGE_HEAD` (squash merge), so `git merge
 *     --abort` does NOT apply — resolve in place (`git add` + `git
 *     commit` lands the squashed commit) or bail with `git reset --hard
 *     HEAD` and `discard_run` to throw away the run.
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
   * Conventional-commit-style subject line for the squashed commit.
   * Should describe what the run actually changed (the captain
   * has the prompt + summary + diff context to compose this).
   * Recommended ≤72 chars; not enforced. When omitted, the commit
   * falls back to `crew run <runId>` — strongly suboptimal for
   * human-readable history.
   */
  commit_title: z.string().min(1).max(200).optional(),
  /**
   * Additional paragraphs for the squashed-commit body.
   */
  commit_body: z.string().optional(),
});

export type MergeRunInput = z.infer<typeof mergeRunInputSchema>;

export const MERGE_RUN_DESCRIPTION =
  "Merge a completed run's worktree into the host HEAD after the user chooses to keep it. Input takes run_id plus optional target_branch, force, confirmed, commit_title, and commit_body; when config confirmBeforeMerge is true, confirmed:true is required and must only follow explicit user approval. The run is squash-merged into a single ordinary commit (no empty merge-commit wrapper). Returns { status: 'merged', commit_sha }, { status: 'conflict', conflicts }, or { status: 'no-changes' }; merged worktrees are cleaned up, while conflict/no-changes worktrees are preserved.";
