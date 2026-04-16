import type { AgentAdapter } from '../../adapters/types.js';
import type { z } from 'zod';
import { DispatchOutputSchema } from '../schemas.js';
import { buildDispatchPrompt } from '../prompts.js';
import type { PassSummary } from '../../state/types.js';
import {
  runStructuredStep,
  type StructuredStepExecutionOptions,
} from './run-structured-step.js';

export type DispatchOutput = z.infer<typeof DispatchOutputSchema>;
export interface DispatchStepInput {
  taskDescription: string;
  taskRole: string;
  previousSummaries: PassSummary[];
  passNumber: number;
}

export const dispatchStepDefinition = {
  schema: DispatchOutputSchema,
  buildPrompt: ({ taskDescription, taskRole, previousSummaries, passNumber }: DispatchStepInput) =>
    buildDispatchPrompt(taskDescription, taskRole, previousSummaries, passNumber),
};

export async function dispatch(
  captain: AgentAdapter,
  task: { description: string; role: string },
  previousSummaries: PassSummary[],
  passNumber: number,
  model?: string,
  options?: Omit<StructuredStepExecutionOptions, 'model'>,
): Promise<DispatchOutput> {
  return runStructuredStep(
    captain,
    dispatchStepDefinition,
    {
      taskDescription: task.description,
      taskRole: task.role,
      previousSummaries,
      passNumber,
    },
    {
      ...options,
      model,
    },
  );
}
