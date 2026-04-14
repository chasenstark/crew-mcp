import type { AgentAdapter } from '../../adapters/types.js';
import type { z } from 'zod';
import { JudgeOutputSchema } from '../schemas.js';
import { IngestOutputSchema } from '../schemas.js';
import { buildJudgePrompt } from '../prompts.js';
import { executeWithValidation } from '../../utils/validate.js';
import type { PassSummary } from '../../state/types.js';

export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

export async function judge(
  orchestrator: AgentAdapter,
  ingestResult: z.infer<typeof IngestOutputSchema>,
  previousSummaries: PassSummary[],
  currentPass: number,
  maxPasses: number,
  model?: string,
): Promise<JudgeOutput> {
  const prompt = buildJudgePrompt(ingestResult, previousSummaries, currentPass, maxPasses);
  return executeWithValidation(orchestrator, prompt, JudgeOutputSchema, { model });
}
