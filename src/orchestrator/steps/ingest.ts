import type { AgentAdapter, TaskResult } from '../../adapters/types.js';
import type { z } from 'zod';
import { IngestOutputSchema } from '../schemas.js';
import { buildIngestPrompt } from '../prompts.js';
import { runStructuredStep } from './run-structured-step.js';

export type IngestOutput = z.infer<typeof IngestOutputSchema>;
export interface IngestStepInput {
  taskDescription: string;
  agentResult: TaskResult;
}

export const ingestStepDefinition = {
  schema: IngestOutputSchema,
  buildPrompt: ({ taskDescription, agentResult }: IngestStepInput) =>
    buildIngestPrompt(taskDescription, agentResult),
};

export async function ingest(
  orchestrator: AgentAdapter,
  taskDescription: string,
  agentResult: TaskResult,
  model?: string,
): Promise<IngestOutput> {
  return runStructuredStep(
    orchestrator,
    ingestStepDefinition,
    { taskDescription, agentResult },
    model,
  );
}
