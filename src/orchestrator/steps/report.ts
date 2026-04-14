import type { AgentAdapter } from '../../adapters/types.js';
import { buildReportPrompt } from '../prompts.js';
import type { PassSummary } from '../../state/types.js';

/**
 * Produce a natural-language report summarizing the entire workflow.
 * Unlike other steps this returns free-form text, not validated JSON.
 */
export async function report(
  orchestrator: AgentAdapter,
  summaries: PassSummary[],
  userRequest: string,
  model?: string,
): Promise<string> {
  const prompt = buildReportPrompt(summaries, userRequest);

  const result = await orchestrator.execute({
    prompt,
    context: {
      workingDirectory: process.cwd(),
    },
    constraints: {
      model,
    },
  });

  if (result.status === 'error') {
    throw new Error(`Report generation failed: ${result.output}`);
  }

  return result.output;
}
