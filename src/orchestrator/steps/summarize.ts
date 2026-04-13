import type { AgentAdapter } from '../../adapters/types.js';
import type { z } from 'zod';
import { SummarizeOutputSchema } from '../schemas.js';
import { IngestOutputSchema } from '../schemas.js';
import { buildSummarizePrompt } from '../prompts.js';
import { executeWithValidation } from '../../utils/validate.js';

export type SummarizeOutput = z.infer<typeof SummarizeOutputSchema>;

export async function summarize(
  orchestrator: AgentAdapter,
  ingestResult: z.infer<typeof IngestOutputSchema>,
  passNumber: number,
): Promise<SummarizeOutput> {
  const prompt = buildSummarizePrompt(ingestResult, passNumber);
  return executeWithValidation(orchestrator, prompt, SummarizeOutputSchema);
}
