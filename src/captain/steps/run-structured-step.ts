import type { z } from 'zod';
import type { AgentAdapter } from '../../adapters/types.js';
import { executeWithValidation } from '../../utils/validate.js';

export interface StructuredStepDefinition<TInput, TOutputSchema extends z.ZodType> {
  schema: TOutputSchema;
  buildPrompt: (input: TInput) => string;
}

export interface StructuredStepExecutionOptions {
  model?: string;
  signal?: AbortSignal;
  timeout?: number;
  workingDirectory?: string;
  maxRetries?: number;
}

export async function runStructuredStep<TInput, TOutputSchema extends z.ZodType>(
  captain: AgentAdapter,
  definition: StructuredStepDefinition<TInput, TOutputSchema>,
  input: TInput,
  options?: StructuredStepExecutionOptions,
): Promise<z.infer<TOutputSchema>> {
  return executeWithValidation(
    captain,
    definition.buildPrompt(input),
    definition.schema,
    {
      model: options?.model,
      signal: options?.signal,
      timeout: options?.timeout,
      workingDirectory: options?.workingDirectory,
      maxRetries: options?.maxRetries,
    },
  );
}
