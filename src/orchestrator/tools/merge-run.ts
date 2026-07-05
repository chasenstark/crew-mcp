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
 *     run adds nothing the target doesn't already have. If the run lands
 *     on a branch other than the user's original checkout, the success
 *     envelope includes target_branch, original_branch/original_head, and
 *     landed_off_current_branch:true so captains can warn that the commit
 *     landed elsewhere and the original checkout was restored. If the
 *     commit/no-changes result is durable but restoring the original
 *     checkout fails, the envelope still returns the result with
 *     restore_failed:true and restore_warning.
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

import { logger } from '../../utils/logger.js';
import { readConfigFile } from '../../utils/config-store.js';
import { isMergeable, runModeFromState } from '../run-mode.js';
import type { ToolCallReturn, ToolHandlerDeps, MergeEnvelope } from './shared.js';
import {
  checkoutEnvelope,
  errorContent,
  inFlightForRun,
  markdownContent,
  renderMergeMarkdown,
} from './shared.js';
import { assertNoBusyWorktreeBlockers } from './lifecycle-guards.js';

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
  "Merge a completed run worktree into a target branch after user approval. Input: run_id plus optional target_branch, force, confirmed, merge_strategy, commit_title, commit_body. When confirmBeforeMerge is true, confirmed:true must follow explicit approval. Lands linearly: 'squash' creates one commit; 'preserve' keeps individual commits. Returns merged+commit_sha, conflict+conflicts, or no-changes. Off-checkout success adds landed_off_current_branch plus target/original fields; restore failure adds restore_failed+restore_warning but still reports the landed result.";

const MERGE_CONFIRMATION_REQUIRED_MESSAGE =
  'merge_run: requires explicit user confirmation (config: confirmBeforeMerge=true). ' +
  'Ask the user to approve, then call merge_run again with {confirmed: true}. ' +
  'Run this from the captain skill — never auto-pass confirmed:true without an explicit user "yes".';

export async function mergeRunToolHandler(
  args: MergeRunInput,
  deps: Pick<ToolHandlerDeps, 'crewHome' | 'runStateStore' | 'worktreeManager' | 'dispatcher'>,
): Promise<ToolCallReturn> {
  const state = deps.runStateStore.read(args.run_id);
  if (!state) {
    return errorContent(`Unknown run_id "${args.run_id}".`);
  }
  if (state.status === 'running') {
    return errorContent('merge_run: run is currently running; call cancel_run first.');
  }
  const runMode = runModeFromState(state);
  if (!isMergeable(runMode)) {
    if (runMode === 'ephemeral_review') {
      return errorContent(
        `Run "${args.run_id}" is an ephemeral review; it is NEVER mergeable. ` +
        'Its worktree is a disposable snapshot whose changes are discarded — only the ' +
        'reviewer\'s text findings are the output. Use `continue_run` for follow-up ' +
        'questions or `discard_run` to reclaim the worktree.',
      );
    }
    return errorContent(
      `Run "${args.run_id}" was dispatched read-only; nothing to merge. ` +
      'Read-only runs run against the host repo (or a target worktree) without ' +
      'allocating their own branch. Use `discard_run` to drop the run record.',
    );
  }
  if (state.status === 'discarded') {
    return errorContent(
      `Cannot merge run "${args.run_id}" — it was discarded.`,
    );
  }
  if (state.status === 'merged') {
    return errorContent(
      `Run "${args.run_id}" was already merged${
        state.mergeStatus?.commitSha
          ? ` at commit ${state.mergeStatus.commitSha}`
          : ''
      }.`,
    );
  }
  const existingInFlight = inFlightForRun(deps.dispatcher, args.run_id);
  if (existingInFlight) {
    return errorContent(
      `run_in_flight: merge_run refused for "${args.run_id}" because it still has in-flight work ` +
      `(${existingInFlight.toolName}); retry after it finishes or call cancel_run first.`,
    );
  }
  try {
    assertNoBusyWorktreeBlockers({
      targetRun: state,
      runStateStore: deps.runStateStore,
      dispatcher: deps.dispatcher,
      includeHostCheckout: true,
      force: args.force,
    });
  } catch (err) {
    return errorContent(err instanceof Error ? err.message : String(err));
  }
  const confirmationGate = resolveMergeConfirmationGate(deps.crewHome);
  if (confirmationGate.error) {
    return errorContent(confirmationGate.error);
  }
  if (confirmationGate.enabled && args.confirmed !== true) {
    return errorContent(MERGE_CONFIRMATION_REQUIRED_MESSAGE);
  }
  try {
    const result = await deps.worktreeManager.mergeRunWorktree(args.run_id, {
      targetBranch: args.target_branch,
      force: args.force,
      mergeStrategy: args.merge_strategy,
      commitTitle: args.commit_title,
      commitBody: args.commit_body,
      assertCanMutateInsideLock: () => {
        const fresh = deps.runStateStore.read(args.run_id);
        if (!fresh) {
          throw new Error(`Unknown run_id "${args.run_id}".`);
        }
        if (fresh.status === 'running') {
          throw new Error('run_in_flight: merge_run refused because the run is currently running.');
        }
        if (fresh.status === 'discarded') {
          throw new Error(`run_already_discarded: cannot merge run "${args.run_id}" after discard.`);
        }
        if (fresh.status === 'merged') {
          throw new Error(`run_already_merged: run "${args.run_id}" was already merged.`);
        }
      },
      updateStatusInsideLock: async (lockedResult) => {
        if (lockedResult.status === 'merged') {
          await deps.runStateStore.markMerged(args.run_id, {
            target: lockedResult.targetBranch,
            commitSha: lockedResult.commitSha,
          });
        } else if (lockedResult.status === 'conflict') {
          await deps.runStateStore.markMergeConflict(args.run_id, {
            target: lockedResult.targetBranch,
            conflicts: lockedResult.conflicts,
          });
        }
      },
    });
    if (result.status === 'merged') {
      if (deps.runStateStore.read(args.run_id)?.status !== 'merged') {
        await deps.runStateStore.markMerged(args.run_id, {
          target: result.targetBranch,
          commitSha: result.commitSha,
        });
      }
      try {
        const cleanup = await deps.worktreeManager.cleanupByRunId(args.run_id);
        if (!cleanup.success) {
          logger.warn(
            `merge_run ${args.run_id}: worktree cleanup failed after `
            + `successful merge — call discard_run to retry. Error: `
            + cleanup.errors.join('; '),
          );
        }
      } catch (err) {
        logger.warn(
          `merge_run ${args.run_id}: worktree cleanup failed after `
          + `successful merge — call discard_run to retry. Error: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const env: MergeEnvelope = {
        run_id: args.run_id,
        status: 'merged',
        commit_sha: result.commitSha,
        ...checkoutEnvelope(result),
      };
      return markdownContent(renderMergeMarkdown(env), env);
    }
    if (result.status === 'conflict') {
      if (deps.runStateStore.read(args.run_id)?.status !== 'merge_conflict') {
        await deps.runStateStore.markMergeConflict(args.run_id, {
          target: result.targetBranch,
          conflicts: result.conflicts,
        });
      }
      const env: MergeEnvelope = {
        run_id: args.run_id,
        status: 'conflict',
        conflicts: result.conflicts,
      };
      return markdownContent(renderMergeMarkdown(env), env, /* isError */ true);
    }
    const env: MergeEnvelope = {
      run_id: args.run_id,
      status: 'no-changes',
      ...checkoutEnvelope(result),
    };
    return markdownContent(renderMergeMarkdown(env), env);
  } catch (err) {
    return errorContent(
      err instanceof Error ? err.message : `merge_run failed: ${String(err)}`,
    );
  }
}

function resolveMergeConfirmationGate(crewHome: string):
  | { enabled: boolean; error?: undefined }
  | { enabled?: undefined; error: string } {
  if (process.env.CREW_CONFIRM_BEFORE_MERGE === 'off') {
    return { enabled: false };
  }
  return { enabled: readConfigFile(crewHome).confirmBeforeMerge };
}
