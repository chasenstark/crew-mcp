import type { AgentAdapter } from '../../adapters/types.js';
import type { z } from 'zod';
import { DispatchOutputSchema } from '../schemas.js';
import { buildDispatchPrompt } from '../prompts.js';
import { executeWithValidation } from '../../utils/validate.js';
import type { PassSummary } from '../../state/types.js';

export type DispatchOutput = z.infer<typeof DispatchOutputSchema>;

export async function dispatch(
  orchestrator: AgentAdapter,
  task: { description: string; role: string },
  previousSummaries: PassSummary[],
  passNumber: number,
): Promise<DispatchOutput> {
  const prompt = buildDispatchPrompt(
    task.description,
    task.role,
    previousSummaries,
    passNumber,
  );
  return executeWithValidation(orchestrator, prompt, DispatchOutputSchema);
}
