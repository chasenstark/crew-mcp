/**
 * merge_run — merge a run's worktree back into the host's HEAD.
 *
 * The single safety boundary in v2: the host CLI must call this
 * explicitly. crew never auto-merges. The captain skill (M3) instructs
 * the host to ask the user for approval before invoking this tool.
 *
 * Behavior:
 *   - Auto-commits any uncommitted changes in the worktree first
 *     ("crew: auto-commit before merge")
 *   - Refuses if the host's working directory has uncommitted changes,
 *     unless force=true
 *   - Always uses --no-ff so the merge is explicit and auditable
 *   - Returns { status: 'merged', commit_sha } on success, or
 *     { status: 'conflict', conflicts: [...] } on conflict (worktree
 *     stays alive for resolution), or { status: 'no-changes' } when
 *     worktree HEAD already matches the target
 */

import { z } from 'zod';

export const mergeRunInputSchema = z.object({
  run_id: z.string().min(1),
  target_branch: z.string().optional(),
  force: z.boolean().optional(),
});

export type MergeRunInput = z.infer<typeof mergeRunInputSchema>;

export const MERGE_RUN_DESCRIPTION =
  "Merge a run's worktree back into the host's HEAD. ALWAYS confirm with the user before calling this — it's the only tool that mutates the user's branch. Optional target_branch defaults to the host's current branch. Pass force=true only when the user has explicitly accepted that the host's uncommitted changes will be left untouched. Returns { status: 'merged' | 'conflict' | 'no-changes' }.";
