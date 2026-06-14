import { z } from 'zod';

import {
  applyCriteriaEditOps,
  criteriaEditOpsSchema,
  type CriteriaSetStateV1,
} from '../criteria/schema.js';
import { CRITERIA_DISPLAY_HINT, renderCriteriaBlock, renderCriteriaToolText } from '../criteria/render.js';
import { withCriteriaLock } from '../criteria/lock.js';
import {
  criteriaDir,
  ensureCriteriaRoot,
  readCriteriaState,
  writeCriteriaStateAtomic,
} from '../criteria/store.js';
import type { ToolCallReturn, ToolHandlerDeps } from './shared.js';
import { errorContent, markdownContent } from './shared.js';

export const confirmCriteriaInputSchema = z.object({
  criteria_set_id: z.string().min(1),
  ops: criteriaEditOpsSchema.optional(),
}).strict();

export type ConfirmCriteriaInput = z.infer<typeof confirmCriteriaInputSchema>;

export const CONFIRM_CRITERIA_DESCRIPTION =
  'Confirm a proposed criteria set, optionally applying id-based edits first. The tool result text is ready-to-reprint markdown: display hint, blank line, then the GFM table. Dispatch tools refuse criteria_set_id until the set is confirmed; repeated confirm with no edits is a no-op.';

export interface ConfirmCriteriaOutput {
  readonly criteria_set_id: string;
  readonly status: 'confirmed';
  readonly epoch: number;
  readonly rendered_block: string;
  readonly display_hint: string;
}

export interface ConfirmCriteriaContext {
  readonly crewHome: string;
  readonly now?: () => string;
}

export async function confirmCriteriaToolHandler(
  args: ConfirmCriteriaInput,
  deps: Pick<ToolHandlerDeps, 'crewHome'>,
): Promise<ToolCallReturn> {
  try {
    const out = await confirmCriteriaHandler(args, {
      crewHome: deps.crewHome,
    });
    return markdownContent(renderCriteriaToolText(out), out);
  } catch (err) {
    return errorContent(err instanceof Error ? err.message : String(err));
  }
}

export async function confirmCriteriaHandler(
  args: unknown,
  ctx: ConfirmCriteriaContext,
): Promise<ConfirmCriteriaOutput> {
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
      const hasOps = input.ops !== undefined && Object.keys(input.ops).length > 0;
      if (current.status === 'confirmed' && !hasOps) {
        return outputFor(current);
      }
      const now = ctx.now?.() ?? new Date().toISOString();
      const edited = applyCriteriaEditOps(current, input.ops);
      const next: CriteriaSetStateV1 = {
        ...edited,
        status: 'confirmed',
        updatedAt: now,
      };
      writeCriteriaStateAtomic(targetDir, next);
      return outputFor(next);
    },
  );
}

function outputFor(state: CriteriaSetStateV1): ConfirmCriteriaOutput {
  return {
    criteria_set_id: state.criteriaSetId,
    status: 'confirmed',
    epoch: state.epoch,
    rendered_block: renderCriteriaBlock(state, { audience: 'user' }),
    display_hint: CRITERIA_DISPLAY_HINT,
  };
}

function parseInput(args: unknown): ConfirmCriteriaInput {
  try {
    return confirmCriteriaInputSchema.parse(args);
  } catch (err) {
    throw new Error(`criteria.invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
}
