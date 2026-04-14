import type { AgentAdapter } from '../../adapters/types.js';
import type { z } from 'zod';
import { DecomposeOutputSchema } from '../schemas.js';
import { buildDecomposePrompt } from '../prompts.js';
import { executeWithValidation } from '../../utils/validate.js';
import type { WorkflowConfig } from '../../workflow/types.js';

export type DecomposeOutput = z.infer<typeof DecomposeOutputSchema>;

export async function decompose(
  orchestrator: AgentAdapter,
  userRequest: string,
  agents: { name: string; capabilities: string[] }[],
  workflow: WorkflowConfig,
  model?: string,
): Promise<DecomposeOutput> {
  const prompt = buildDecomposePrompt(userRequest, agents, workflow);
  return executeWithValidation(orchestrator, prompt, DecomposeOutputSchema, { model });
}
