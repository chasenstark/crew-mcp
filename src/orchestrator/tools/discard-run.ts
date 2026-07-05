/**
 * discard_run — abandon a run's worktree without merging.
 *
 * Idempotent: calling on an unknown or already-discarded run returns
 * ok without erroring. The worktree is removed; state.json is updated
 * with status='discarded' and kept around so get_run_status can still
 * report. Use when the user decides the run isn't useful (e.g., the
 * implementation went the wrong direction and they want to start over).
 */

import { z } from 'zod';

import { ownsWorktree, runModeFromState } from '../run-mode.js';
import type { DiscardEnvelope, ToolCallReturn, ToolHandlerDeps } from './shared.js';
import {
  errorContent,
  inFlightForRun,
  markdownContent,
  renderDiscardMarkdown,
} from './shared.js';
import { assertNoBusyWorktreeBlockers } from './lifecycle-guards.js';

export const discardRunInputSchema = z.object({
  run_id: z.string().min(1),
});

export type DiscardRunInput = z.infer<typeof discardRunInputSchema>;

export const DISCARD_RUN_DESCRIPTION =
  "Mark a run discarded and remove its owned worktree without merging. Use when the user chooses not to keep a run's changes, or to clean up a read-only run's metadata. Input is run_id; the operation is idempotent and returns { run_id, ok: true }.";

export async function discardRunToolHandler(
  args: DiscardRunInput,
  deps: Pick<ToolHandlerDeps, 'runStateStore' | 'worktreeManager' | 'dispatcher'>,
): Promise<ToolCallReturn> {
  const state = deps.runStateStore.read(args.run_id);
  if (state?.status === 'running') {
    return errorContent('discard_run: run is currently running; call cancel_run first.');
  }
  const existingInFlight = inFlightForRun(deps.dispatcher, args.run_id);
  if (existingInFlight) {
    return errorContent(
      `run_in_flight: discard_run refused for "${args.run_id}" because it still has in-flight work ` +
      `(${existingInFlight.toolName}); retry after it finishes or call cancel_run first.`,
    );
  }
  const cleanupErrors: string[] = [];
  try {
    if (state) {
      assertNoBusyWorktreeBlockers({
        targetRun: state,
        runStateStore: deps.runStateStore,
        dispatcher: deps.dispatcher,
      });
      await deps.worktreeManager.withRunWorktreeLock(args.run_id, async () => {
        const fresh = deps.runStateStore.read(args.run_id);
        if (!fresh) return;
        if (fresh.status !== 'discarded') {
          await deps.runStateStore.markDiscarded(args.run_id);
        }
        // Worktree removal for every mode that OWNS one (write and
        // ephemeral_review — discarding an ephemeral review is what actually
        // throws its disposable snapshot away); read_only runs have no
        // worktree, so discard is metadata-only.
        if (ownsWorktree(runModeFromState(fresh))) {
          try {
            const cleanup = await deps.worktreeManager.cleanupByRunId(args.run_id, {
              lockAlreadyHeld: true,
            });
            if (!cleanup.success) {
              cleanupErrors.push(...cleanup.errors);
            }
          } catch (err) {
            cleanupErrors.push(err instanceof Error ? err.message : String(err));
          }
        }
      });
    }
  } catch (err) {
    return errorContent(
      err instanceof Error ? err.message : `discard_run failed: ${String(err)}`,
    );
  }
  const env: DiscardEnvelope = {
    run_id: args.run_id,
    ok: true,
    ...(cleanupErrors.length > 0
      ? { cleanup_failed: true as const, cleanup_errors: cleanupErrors }
      : {}),
  };
  return markdownContent(renderDiscardMarkdown(env), env);
}
