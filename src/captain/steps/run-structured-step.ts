import type { z } from 'zod';
import type { AgentAdapter } from '../../adapters/types.js';
import { executeWithValidation } from '../../utils/validate.js';

export interface StructuredStepDefinition<TInput, TOutputSchema extends z.ZodType> {
  schema: TOutputSchema;
  buildPrompt: (input: TInput) => string;
}

export async function runStructuredStep<TInput, TOutputSchema extends z.ZodType>(
  captain: AgentAdapter,
  definition: StructuredStepDefinition<TInput, TOutputSchema>,
  input: TInput,
  model?: string,
): Promise<z.infer<TOutputSchema>> {
  return executeWithValidation(
    captain,
    definition.buildPrompt(input),
    definition.schema,
    { model },
  );
}
