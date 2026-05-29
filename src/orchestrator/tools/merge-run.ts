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
 *   - Lands the run linearly — never an empty `--no-ff` wrapper commit.
 *     Two strategies (see `merge_strategy`):
 *       - `squash` (default): collapse the whole run into one ordinary
 *         commit on the target, titled by `commit_title` / `commit_body`
 *         (falls back to `crew run <runId>`). For implement-then-iterate
 *         runs (one feature + review fixups).
 *       - `preserve`: keep the run's individual commits, replayed onto
 *         the target tip — fast-forward when the target hasn't diverged
 *         (exact commits), else cherry-pick the run's commit range
 *         (rewritten onto target). For a deliberate stack of discrete,
 *         standalone commits. `commit_title` / `commit_body` are unused.
 *   - Returns { status: 'merged', commit_sha } on success, or
 *     { status: 'conflict', conflicts: [...] } on conflict (worktree
 *     stays alive for resolution), or { status: 'no-changes' } when the
 *     run adds nothing the target doesn't already have.
 *   - On `merged`, the worktree directory is auto-cleaned best-effort
 *     (the merged commit is permanently in the host's HEAD, so the
 *     worktree has no remaining value). state.json + events.log
 *     persist for archeology. On `conflict` or `no-changes` the
 *     worktree is preserved. On `conflict` the host is left mid-operation
 *     with no `MERGE_HEAD` (`git merge --abort` does NOT apply): for
 *     `squash`, resolve in place (`git add` + `git commit`) or bail with
 *     `git reset --hard HEAD`; for `preserve`, `git cherry-pick --abort`.
 *     Then `discard_run` to throw away the run.
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
   * How to land the run. `squash` (default) collapses it into one
   * commit titled by commit_title/body — for implement-then-iterate
   * runs. `preserve` keeps the run's individual commits linearly
   * (fast-forward, or cherry-pick when the target diverged) — for a
   * deliberate stack of discrete commits; commit_title/body are unused.
   * The captain picks the strategy from the run's `git log`; with
   * confirmBeforeMerge on it surfaces the choice for the user to flip,
   * and when merging without confirmation it applies its own judgment.
   */
  merge_strategy: z.enum(['squash', 'preserve']).optional(),
  /**
   * Conventional-commit-style subject line for the squashed commit
   * (`squash` strategy only). Should describe what the run actually
   * changed (the captain has the prompt + summary + diff context to
   * compose this). Recommended ≤72 chars; not enforced. When omitted,
   * the commit falls back to `crew run <runId>` — strongly suboptimal
   * for human-readable history.
   */
  commit_title: z.string().min(1).max(200).optional(),
  /**
   * Additional paragraphs for the squashed-commit body (`squash` only).
   */
  commit_body: z.string().optional(),
});

export type MergeRunInput = z.infer<typeof mergeRunInputSchema>;

export const MERGE_RUN_DESCRIPTION =
  "Merge a completed run's worktree into the host HEAD after the user chooses to keep it. Input: run_id plus optional target_branch, force, confirmed, merge_strategy, commit_title, commit_body. When confirmBeforeMerge is true, confirmed:true is required and must follow explicit user approval. Lands linearly (never an empty merge-commit): merge_strategy 'squash' (default) collapses the run into one commit titled by commit_title/body; 'preserve' keeps its individual commits. Returns { status: 'merged', commit_sha }, { status: 'conflict', conflicts }, or { status: 'no-changes' }; merged worktrees are cleaned up.";
