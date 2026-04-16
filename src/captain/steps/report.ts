import type { AgentAdapter } from '../../adapters/types.js';
import { buildReportPrompt } from '../prompts.js';
import type { PassSummary } from '../../state/types.js';

export interface ReportExecutionOptions {
  signal?: AbortSignal;
  timeout?: number;
  workingDirectory?: string;
}

/**
 * Produce a natural-language report summarizing the entire workflow.
 * Unlike other steps this returns free-form text, not validated JSON.
 */
export async function report(
  captain: AgentAdapter,
  summaries: PassSummary[],
  userRequest: string,
  model?: string,
  options?: ReportExecutionOptions,
): Promise<string> {
  const prompt = buildReportPrompt(summaries, userRequest);

  const result = await captain.execute({
    prompt,
    context: {
      workingDirectory: options?.workingDirectory ?? process.cwd(),
    },
    constraints: {
      model,
      signal: options?.signal,
      timeout: options?.timeout,
    },
  });

  if (result.status === 'error') {
    throw new Error(`Report generation failed: ${result.output}`);
  }

  return result.output;
}
