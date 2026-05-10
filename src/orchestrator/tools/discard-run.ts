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
  "Mark a run discarded and remove its owned worktree without merging. Use when the user chooses not to keep a run's changes, or to clean up a read-only run's metadata. Input is run_id; the operation is idempotent and returns { run_id, ok: true }.";
