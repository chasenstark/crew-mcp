import { z } from 'zod';

import type { CriteriaSetStateV1 } from '../criteria/schema.js';
import { renderCriteriaBlock } from '../criteria/render.js';
import {
  criteriaDir,
  readCriteriaState,
} from '../criteria/store.js';
import type { ToolCallReturn, ToolHandlerDeps } from './shared.js';
import { errorContent, jsonContent } from './shared.js';

export const getCriteriaInputSchema = z.object({
  criteria_set_id: z.string().min(1),
}).strict();

export type GetCriteriaInput = z.infer<typeof getCriteriaInputSchema>;

export const GET_CRITERIA_DESCRIPTION =
  'Read a persisted criteria set by id, including repo/status/epoch/history and a user-rendered block. Returns criteria.unknown when the id is not present in this crew home.';

export interface GetCriteriaOutput {
  readonly criteria_set_id: string;
  readonly state: CriteriaSetStateV1;
  readonly rendered_block: string;
}

export interface GetCriteriaContext {
  readonly crewHome: string;
}

export function getCriteriaToolHandler(
  args: GetCriteriaInput,
  deps: Pick<ToolHandlerDeps, 'crewHome'>,
): ToolCallReturn {
  try {
    const out = getCriteriaHandler(args, {
      crewHome: deps.crewHome,
    });
    return jsonContent(out);
  } catch (err) {
    return errorContent(err instanceof Error ? err.message : String(err));
  }
}

export function getCriteriaHandler(
  args: unknown,
  ctx: GetCriteriaContext,
): GetCriteriaOutput {
  const input = getCriteriaInputSchema.parse(args);
  const state = readCriteriaState(criteriaDir(ctx.crewHome, input.criteria_set_id));
  if (!state) {
    throw new Error(`criteria.unknown: ${input.criteria_set_id}`);
  }
  return {
    criteria_set_id: state.criteriaSetId,
    state,
    rendered_block: renderCriteriaBlock(state, { audience: 'user' }),
  };
}
