/**
 * plan_tasks — optional wrapper over the legacy `decompose` step helper.
 *
 * Captains reaching for structured multi-task planning get a consistent
 * tool-call interface; the actual work is still done by `decompose()`,
 * which is kept alive through M3 (see the M3-3 intro note) and retires
 * in M4 if the captain can reason about tasks inline.
 */

import { z } from 'zod';
import type { ActionCatalogEntry } from '../action-server.js';
import type { AgentAdapter } from '../../adapters/types.js';
import type { WorkflowConfig } from '../../workflow/types.js';
import type { DecomposeOutput } from '../steps/decompose.js';
import { decompose } from '../steps/index.js';

export const planTasksInputSchema = z.object({
  user_request: z.string().min(1),
  hints: z.array(z.string()).optional(),
});

export type PlanTasksInput = z.infer<typeof planTasksInputSchema>;

export const PLAN_TASKS_DESCRIPTION =
  'Decompose the user request into structured tasks (id, role, dependencies, scope).';

export interface PlanTasksContext {
  readonly captain: AgentAdapter;
  readonly workflow: WorkflowConfig;
  readonly agents: readonly { name: string; capabilities: readonly string[] }[];
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export function buildPlanTasksActionEntry(): ActionCatalogEntry {
  return {
    name: 'plan_tasks',
    description: PLAN_TASKS_DESCRIPTION,
    inputSchema: planTasksInputSchema,
  };
}

export async function dispatchPlanTasks(
  input: PlanTasksInput,
  ctx: PlanTasksContext,
): Promise<DecomposeOutput> {
  const hintedRequest = buildHintedRequest(input);
  const agents = ctx.agents.map((a) => ({
    name: a.name,
    capabilities: [...a.capabilities],
  }));
  return decompose(
    ctx.captain,
    hintedRequest,
    agents,
    ctx.workflow,
    ctx.model,
    { signal: ctx.signal },
  );
}

function buildHintedRequest(input: PlanTasksInput): string {
  if (!input.hints || input.hints.length === 0) return input.user_request;
  const bullets = input.hints.map((h) => `- ${h}`).join('\n');
  return `${input.user_request}\n\nPlanner hints:\n${bullets}`;
}
