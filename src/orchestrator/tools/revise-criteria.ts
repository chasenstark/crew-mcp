import { z } from 'zod';

import {
  applyCriteriaEditOps,
  cloneCriteria,
  criteriaEditOpsSchema,
  type CriteriaSetStateV1,
} from '../criteria/schema.js';
import { renderCriteriaBlock } from '../criteria/render.js';
import { withCriteriaLock } from '../criteria/lock.js';
import {
  criteriaDir,
  ensureCriteriaRoot,
  readCriteriaState,
  writeCriteriaStateAtomic,
} from '../criteria/store.js';
import type { ToolCallReturn, ToolHandlerDeps } from './shared.js';
import { errorContent, jsonContent } from './shared.js';

export const reviseCriteriaInputSchema = z.object({
  criteria_set_id: z.string().min(1),
  ops: criteriaEditOpsSchema,
  note: z.string().min(1).optional(),
}).strict();

export type ReviseCriteriaInput = z.infer<typeof reviseCriteriaInputSchema>;

export const REVISE_CRITERIA_DESCRIPTION =
  'Revise a criteria set with id-based edits. This snapshots the prior epoch, bumps epoch, returns the set to proposed, and clears Phase-2 review state until confirm_criteria reconfirms it.';

export interface ReviseCriteriaOutput {
  readonly criteria_set_id: string;
  readonly status: 'proposed';
  readonly epoch: number;
  readonly rendered_block: string;
}

export interface ReviseCriteriaContext {
  readonly crewHome: string;
  readonly now?: () => string;
}

export async function reviseCriteriaToolHandler(
  args: ReviseCriteriaInput,
  deps: Pick<ToolHandlerDeps, 'crewHome'>,
): Promise<ToolCallReturn> {
  try {
    const out = await reviseCriteriaHandler(args, {
      crewHome: deps.crewHome,
    });
    return jsonContent(out);
  } catch (err) {
    return errorContent(err instanceof Error ? err.message : String(err));
  }
}

export async function reviseCriteriaHandler(
  args: unknown,
  ctx: ReviseCriteriaContext,
): Promise<ReviseCriteriaOutput> {
  const input = parseInput(args);
  ensureCriteriaRoot(ctx.crewHome);
  return withCriteriaLock(
    { crewHome: ctx.crewHome, criteriaSetId: input.criteria_set_id },
    async () => {
      const targetDir = criteriaDir(ctx.crewHome, input.criteria_set_id);
      const current = readCriteriaState(targetDir);
      if (!current) {
        throw new Error(`criteria.unknown: ${input.criteria_set_id}`);
      }
      const now = ctx.now?.() ?? new Date().toISOString();
      const base: CriteriaSetStateV1 = {
        schemaVersion: current.schemaVersion,
        criteriaSetId: current.criteriaSetId,
        createdAt: current.createdAt,
        updatedAt: now,
        repoRoot: current.repoRoot,
        status: 'proposed',
        epoch: current.epoch + 1,
        nextCriterionSeq: current.nextCriterionSeq,
        criteria: cloneCriteria(current.criteria),
        ...(current.implementerRunId !== undefined
          ? { implementerRunId: current.implementerRunId }
          : {}),
        history: [
          ...current.history,
          {
            epoch: current.epoch,
            criteria: cloneCriteria(current.criteria),
            supersededAt: now,
            ...(input.note !== undefined ? { note: input.note } : {}),
          },
        ],
      };
      const next = applyCriteriaEditOps(base, input.ops);
      writeCriteriaStateAtomic(targetDir, next);
      return {
        criteria_set_id: next.criteriaSetId,
        status: 'proposed',
        epoch: next.epoch,
        rendered_block: renderCriteriaBlock(next, { audience: 'user' }),
      };
    },
  );
}

function parseInput(args: unknown): ReviseCriteriaInput {
  try {
    return reviseCriteriaInputSchema.parse(args);
  } catch (err) {
    throw new Error(`criteria.invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
}
