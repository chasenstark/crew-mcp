import type { AgentAdapter } from '../../adapters/types.js';
import type { z } from 'zod';
import { SummarizeOutputSchema } from '../schemas.js';
import { IngestOutputSchema } from '../schemas.js';
import { buildSummarizePrompt } from '../prompts.js';
import { runStructuredStep } from './run-structured-step.js';

export type SummarizeOutput = z.infer<typeof SummarizeOutputSchema>;
export interface SummarizeStepInput {
  ingestResult: z.infer<typeof IngestOutputSchema>;
  passNumber: number;
}

export const summarizeStepDefinition = {
  schema: SummarizeOutputSchema,
  buildPrompt: ({ ingestResult, passNumber }: SummarizeStepInput) =>
    buildSummarizePrompt(ingestResult, passNumber),
};

export async function summarize(
  captain: AgentAdapter,
  ingestResult: z.infer<typeof IngestOutputSchema>,
  passNumber: number,
  model?: string,
): Promise<SummarizeOutput> {
  return runStructuredStep(
    captain,
    summarizeStepDefinition,
    { ingestResult, passNumber },
    model,
  );
}
