/**
 * continue_run — resume an existing run with new instructions.
 *
 * The worktree stays alive; the same agent (per the run's recorded
 * agent_id) is re-invoked with a fresh prompt against the same working
 * directory. Use this when you want to ask the implementer to fix the
 * issues a reviewer found, or when the user provides a follow-up
 * instruction without wanting to start over.
 *
 * Returns the same async-first envelope shape as run_agent
 * (run_id, worktree_path, status: "running"). Terminal results are
 * surfaced out-of-band via crew-wait watchers (Claude Code), or
 * later get_run_status / list_runs reads.
 */

import { z } from 'zod';

export const continueRunInputSchema = z.object({
  run_id: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().optional(),
  /**
   * Per-call reasoning effort override. Same precedence as run_agent:
   * wins over the user's agents.json default + adapter default.
   * Vocabulary mirrors codex's `model_reasoning_effort` set.
   */
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});

export type ContinueRunInput = z.infer<typeof continueRunInputSchema>;

export const CONTINUE_RUN_DESCRIPTION =
  'Resume a run with a new prompt. Same agent, same worktree. Returns the same envelope as run_agent.';
