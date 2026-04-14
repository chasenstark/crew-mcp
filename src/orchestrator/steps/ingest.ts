import type { AgentAdapter, TaskResult } from '../../adapters/types.js';
import type { z } from 'zod';
import { IngestOutputSchema } from '../schemas.js';
import { buildIngestPrompt } from '../prompts.js';
import { executeWithValidation } from '../../utils/validate.js';

export type IngestOutput = z.infer<typeof IngestOutputSchema>;

export async function ingest(
  orchestrator: AgentAdapter,
  taskDescription: string,
  agentResult: TaskResult,
  model?: string,
): Promise<IngestOutput> {
  const prompt = buildIngestPrompt(taskDescription, agentResult);
  return executeWithValidation(orchestrator, prompt, IngestOutputSchema, { model });
}
