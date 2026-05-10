/**
 * cancel_run — abort an in-flight dispatch.
 *
 * Looks up the in-flight tool-call by `run_id`, signals the dispatcher's
 * AbortController, and lets the existing `run:cancelled` lifecycle
 * listener mark the run terminal with status='cancelled'. The underlying
 * adapter subprocess receives SIGTERM via the AbortSignal threaded into
 * `Task.constraints.signal`; adapters that respect the signal (all
 * first-party ones do, via execa's `cancelSignal`) terminate promptly.
 *
 * Idempotent in the practical sense: calling on a run_id that's not
 * in-flight (already terminal, never started, unknown) returns
 * `ok: false` with a `reason`, not an error. The captain can call this
 * after polling get_run_status returns `running` and the user wants to
 * abort.
 *
 * Returns: `{ run_id, ok, reason? }`. Does NOT remove the worktree —
 * cancellation is a "stop work" signal, not "discard everything." Use
 * `discard_run` after if cleanup is wanted.
 */

import { z } from 'zod';

export const cancelRunInputSchema = z.object({
  run_id: z.string().min(1),
});

export type CancelRunInput = z.infer<typeof cancelRunInputSchema>;

export const CANCEL_RUN_DESCRIPTION =
  'Abort an in-flight run by run_id when the user wants active work stopped. Successful cancellation marks the run status "cancelled" and preserves the worktree for inspection or later discard. Returns { run_id, ok, reason? }, with ok:false for unknown or already-terminal runs.';
