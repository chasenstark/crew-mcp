/**
 * compress_context — optional wrapper over the legacy `summarize` step helper.
 *
 * Captain typically calls this after `analyze_output` to produce a terse
 * summary for the next pass. `pass_number` is optional because the captain
 * may not track it; we mint a 1 when absent.
 *
 * The input schema treats `analyzed_output` as `z.unknown()` because the
 * captain's tool-call flow may hand the prior analyze_output result over
 * verbatim, or a partial structure assembled by the captain itself.
 * IngestOutputSchema.parse() inside `summarize()` is the real gate.
 */

import { z } from 'zod';
import type { ActionCatalogEntry } from '../action-server.js';
import type { AgentAdapter } from '../../adapters/types.js';
import type { IngestOutput } from '../steps/ingest.js';
import type { SummarizeOutput } from '../steps/summarize.js';
import { summarize } from '../steps/index.js';
import { IngestOutputSchema } from '../schemas.js';

export const compressContextInputSchema = z.object({
  analyzed_output: z.unknown(),
  pass_number: z.number().optional(),
});

export type CompressContextInput = z.infer<typeof compressContextInputSchema>;

export const COMPRESS_CONTEXT_DESCRIPTION =
  'Condense an analyzed output into a terse summary for the next pass.';

export interface CompressContextContext {
  readonly captain: AgentAdapter;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export function buildCompressContextActionEntry(): ActionCatalogEntry {
  return {
    name: 'compress_context',
    description: COMPRESS_CONTEXT_DESCRIPTION,
    inputSchema: compressContextInputSchema,
  };
}

export async function dispatchCompressContext(
  input: CompressContextInput,
  ctx: CompressContextContext,
): Promise<SummarizeOutput> {
  // IngestOutputSchema.parse() will throw with a clear zod error if the
  // captain handed a malformed object — the captain sees that via the error
  // tool_result path in the scheduler.
  const parsed: IngestOutput = IngestOutputSchema.parse(input.analyzed_output);
  const passNumber = input.pass_number ?? 1;
  return summarize(ctx.captain, parsed, passNumber, ctx.model, { signal: ctx.signal });
}
