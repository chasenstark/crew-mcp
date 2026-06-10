import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { z } from 'zod';

import {
  CRITERIA_SCHEMA_VERSION,
  criteriaSetStateSchemaV1,
  criterionInputSchema,
  criteriaValidationWarnings,
  type CriteriaSetStateV1,
  type CriterionV1,
} from '../criteria/schema.js';
import { CRITERIA_DISPLAY_HINT, renderCriteriaBlock } from '../criteria/render.js';
import {
  criteriaDir,
  ensureCriteriaRoot,
  writeCriteriaStateAtomic,
} from '../criteria/store.js';
import type { ToolCallReturn, ToolHandlerDeps } from './shared.js';
import { errorContent, jsonContent } from './shared.js';

export const createCriteriaInputSchema = z.object({
  criteria: z.array(criterionInputSchema).min(1),
}).strict();

export type CreateCriteriaInput = z.infer<typeof createCriteriaInputSchema>;

export const CREATE_CRITERIA_DESCRIPTION =
  'Create a proposed acceptance-criteria set for this repo. Criteria get stable ids and render as a user-reviewable markdown table (rendered_block) that you must reprint verbatim in chat — the user cannot see collapsed tool results. confirm_criteria must approve the set before dispatch can use criteria_set_id enforcement.';

export interface CreateCriteriaOutput {
  readonly criteria_set_id: string;
  readonly status: 'proposed';
  readonly epoch: number;
  readonly warnings?: readonly string[];
  readonly rendered_block: string;
  readonly display_hint: string;
}

export interface CreateCriteriaContext {
  readonly crewHome: string;
  readonly repoRoot: string;
  readonly now?: () => string;
  readonly makeCriteriaSetId?: () => string;
}

export function createCriteriaToolHandler(
  args: CreateCriteriaInput,
  deps: Pick<ToolHandlerDeps, 'crewHome' | 'runStateStore'>,
): ToolCallReturn {
  try {
    const out = createCriteriaHandler(args, {
      crewHome: deps.crewHome,
      repoRoot: deps.runStateStore.repoRoot,
    });
    return jsonContent(out);
  } catch (err) {
    return errorContent(err instanceof Error ? err.message : String(err));
  }
}

export function createCriteriaHandler(
  args: unknown,
  ctx: CreateCriteriaContext,
): CreateCriteriaOutput {
  const input = parseInput(args);
  const criteriaSetId = ctx.makeCriteriaSetId?.() ?? `criteria-${randomUUID()}`;
  const now = ctx.now?.() ?? new Date().toISOString();
  const criteria: CriterionV1[] = input.criteria.map((criterion, index) => ({
    id: `c${index + 1}`,
    title: criterion.title,
    type: criterion.type,
    ...(criterion.detail !== undefined ? { detail: criterion.detail } : {}),
    ...(criterion.subCriteria !== undefined ? { subCriteria: [...criterion.subCriteria] } : {}),
    ...(criterion.signal !== undefined ? { signal: criterion.signal } : {}),
  }));
  const state = criteriaSetStateSchemaV1.parse({
    schemaVersion: CRITERIA_SCHEMA_VERSION,
    criteriaSetId,
    createdAt: now,
    updatedAt: now,
    repoRoot: ctx.repoRoot,
    status: 'proposed',
    epoch: 0,
    nextCriterionSeq: criteria.length + 1,
    criteria,
    history: [],
  } satisfies CriteriaSetStateV1);
  ensureCriteriaRoot(ctx.crewHome);
  const targetDir = criteriaDir(ctx.crewHome, criteriaSetId);
  mkdirSync(targetDir, { recursive: true });
  writeCriteriaStateAtomic(targetDir, state);
  const warnings = criteriaValidationWarnings(state.criteria);
  return {
    criteria_set_id: state.criteriaSetId,
    status: 'proposed',
    epoch: state.epoch,
    ...(warnings.length > 0 ? { warnings } : {}),
    rendered_block: renderCriteriaBlock(state, { audience: 'user' }),
    display_hint: CRITERIA_DISPLAY_HINT,
  };
}

function parseInput(args: unknown): CreateCriteriaInput {
  try {
    return createCriteriaInputSchema.parse(args);
  } catch (err) {
    throw new Error(`criteria.invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
}
