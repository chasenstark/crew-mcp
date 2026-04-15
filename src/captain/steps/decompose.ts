import type { AgentAdapter } from '../../adapters/types.js';
import type { z } from 'zod';
import { DecomposeOutputSchema } from '../schemas.js';
import { buildDecomposePrompt } from '../prompts.js';
import type { WorkflowConfig } from '../../workflow/types.js';
import { runStructuredStep } from './run-structured-step.js';

export type DecomposeOutput = z.infer<typeof DecomposeOutputSchema>;
export interface DecomposeStepInput {
  userRequest: string;
  agents: { name: string; capabilities: string[] }[];
  workflow: WorkflowConfig;
}

export const decomposeStepDefinition = {
  schema: DecomposeOutputSchema,
  buildPrompt: ({ userRequest, agents, workflow }: DecomposeStepInput) =>
    buildDecomposePrompt(userRequest, agents, workflow),
};

export async function decompose(
  captain: AgentAdapter,
  userRequest: string,
  agents: { name: string; capabilities: string[] }[],
  workflow: WorkflowConfig,
  model?: string,
): Promise<DecomposeOutput> {
  return runStructuredStep(
    captain,
    decomposeStepDefinition,
    { userRequest, agents, workflow },
    model,
  );
}
