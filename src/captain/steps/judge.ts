import type { AgentAdapter } from '../../adapters/types.js';
import type { z } from 'zod';
import { JudgeOutputSchema } from '../schemas.js';
import { IngestOutputSchema } from '../schemas.js';
import { buildJudgePrompt } from '../prompts.js';
import type { PassSummary } from '../../state/types.js';
import { runStructuredStep } from './run-structured-step.js';

export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;
export interface JudgeStepInput {
  ingestResult: z.infer<typeof IngestOutputSchema>;
  previousSummaries: PassSummary[];
  currentPass: number;
  maxPasses: number;
}

export const judgeStepDefinition = {
  schema: JudgeOutputSchema,
  buildPrompt: ({ ingestResult, previousSummaries, currentPass, maxPasses }: JudgeStepInput) =>
    buildJudgePrompt(ingestResult, previousSummaries, currentPass, maxPasses),
};

export async function judge(
  captain: AgentAdapter,
  ingestResult: z.infer<typeof IngestOutputSchema>,
  previousSummaries: PassSummary[],
  currentPass: number,
  maxPasses: number,
  model?: string,
): Promise<JudgeOutput> {
  return runStructuredStep(
    captain,
    judgeStepDefinition,
    { ingestResult, previousSummaries, currentPass, maxPasses },
    model,
  );
}
