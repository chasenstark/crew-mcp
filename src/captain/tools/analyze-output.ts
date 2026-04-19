/**
 * analyze_output — optional wrapper over the legacy `ingest` step helper.
 *
 * Synthesizes a minimal TaskResult from the tool input (the agent output
 * string + file list) so the existing helper's signature isn't disturbed.
 * Captains that already reason about agent output inline can skip this
 * wrapper entirely; `plan_tasks` + `run_agent` + `finish` is the trivial
 * path.
 */

import { z } from 'zod';
import type { ActionCatalogEntry } from '../action-server.js';
import type { AgentAdapter, TaskResult } from '../../adapters/types.js';
import type { IngestOutput } from '../steps/ingest.js';
import { ingest } from '../steps/index.js';

export const analyzeOutputInputSchema = z.object({
  task_description: z.string().min(1),
  agent_output: z.string(),
  files_modified: z.array(z.string()).optional(),
});

export type AnalyzeOutputInput = z.infer<typeof analyzeOutputInputSchema>;

export const ANALYZE_OUTPUT_DESCRIPTION =
  'Summarize an agent result into a structured assessment (decisions, concerns, review findings).';

export interface AnalyzeOutputContext {
  readonly captain: AgentAdapter;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export function buildAnalyzeOutputActionEntry(): ActionCatalogEntry {
  return {
    name: 'analyze_output',
    description: ANALYZE_OUTPUT_DESCRIPTION,
    inputSchema: analyzeOutputInputSchema,
  };
}

export async function dispatchAnalyzeOutput(
  input: AnalyzeOutputInput,
  ctx: AnalyzeOutputContext,
): Promise<IngestOutput> {
  const syntheticTaskResult: TaskResult = {
    output: input.agent_output,
    filesModified: input.files_modified ? [...input.files_modified] : [],
    status: 'success',
    metadata: {},
  };
  return ingest(ctx.captain, input.task_description, syntheticTaskResult, ctx.model, {
    signal: ctx.signal,
  });
}
