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

export const discardRunInputSchema = z.object({
  run_id: z.string().min(1),
});

export type DiscardRunInput = z.infer<typeof discardRunInputSchema>;

export const DISCARD_RUN_DESCRIPTION =
  "Abandon a run's worktree without merging. Idempotent. Use when the user decides the run isn't worth keeping. Returns { run_id, ok: true }.";
