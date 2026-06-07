import { z } from 'zod';

export const CRITERIA_SCHEMA_VERSION = 1 as const;

export type CriterionType = 'mechanical' | 'behavioral' | 'negative';
export type CriteriaStatus = 'proposed' | 'confirmed';

export interface CriterionV1 {
  readonly id: string;
  readonly title: string;
  readonly type: CriterionType;
  readonly detail?: string;
  readonly subCriteria?: readonly string[];
  readonly signal?: string;
}

export type CriterionInput = Omit<CriterionV1, 'id'>;

export interface CriteriaEditOps {
  readonly add?: readonly CriterionInput[];
  readonly update?: ReadonlyArray<{ readonly id: string } & Partial<CriterionInput>>;
  readonly removeIds?: readonly string[];
  readonly order?: readonly string[];
}

export interface CriteriaEpochSnapshot {
  readonly epoch: number;
  readonly criteria: readonly CriterionV1[];
  readonly supersededAt: string;
  readonly note?: string;
}

export interface ReviewRoundV1 {
  readonly roundId: string;
  readonly createdAt: string;
  readonly reviewerRunIds: readonly string[];
  readonly status?: 'running' | 'complete';
}

export interface NaDecisionV1 {
  readonly criterionId: string;
  readonly decidedAt: string;
  readonly reason: string;
  readonly roundId?: string;
  readonly reviewerRunId?: string;
}

export interface CriteriaSetStateV1 {
  readonly schemaVersion: 1;
  readonly criteriaSetId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly repoRoot: string;
  readonly status: CriteriaStatus;
  readonly epoch: number;
  readonly nextCriterionSeq: number;
  readonly criteria: readonly CriterionV1[];
  readonly implementerRunId?: string;
  readonly history: readonly CriteriaEpochSnapshot[];
  readonly rounds?: readonly ReviewRoundV1[];
  readonly naDecisions?: readonly NaDecisionV1[];
}

const criterionTypeSchema = z.enum(['mechanical', 'behavioral', 'negative']);

const nonEmptyTrimmedString = z.string().trim().min(1);

const criterionPayloadBaseSchema = z.object({
  title: nonEmptyTrimmedString,
  type: criterionTypeSchema,
  detail: nonEmptyTrimmedString.optional(),
  subCriteria: z.array(nonEmptyTrimmedString).min(1).optional(),
  signal: nonEmptyTrimmedString.optional(),
}).strict();

function refineCriterionPayload(
  value: { readonly detail?: string; readonly subCriteria?: readonly string[] },
  ctx: z.RefinementCtx,
): void {
  const hasDetail = value.detail !== undefined;
  const hasSubCriteria = value.subCriteria !== undefined && value.subCriteria.length > 0;
  if (hasDetail === hasSubCriteria) {
    ctx.addIssue({
      code: 'custom',
      message: 'criterion requires exactly one of detail or non-empty subCriteria',
      path: ['detail'],
    });
  }
}

export const criterionInputSchema = criterionPayloadBaseSchema
  .superRefine(refineCriterionPayload) satisfies z.ZodType<CriterionInput>;

export const criterionSchemaV1 = criterionPayloadBaseSchema.extend({
  id: z.string().regex(/^c[1-9][0-9]*$/),
}).strict().superRefine(refineCriterionPayload) satisfies z.ZodType<CriterionV1>;

const criterionUpdateSchema = z.object({
  id: z.string().regex(/^c[1-9][0-9]*$/),
  title: nonEmptyTrimmedString.optional(),
  type: criterionTypeSchema.optional(),
  detail: nonEmptyTrimmedString.optional(),
  subCriteria: z.array(nonEmptyTrimmedString).min(1).optional(),
  signal: nonEmptyTrimmedString.optional(),
}).strict();

export const criteriaEditOpsSchema = z.object({
  add: z.array(criterionInputSchema).optional(),
  update: z.array(criterionUpdateSchema).optional(),
  removeIds: z.array(z.string().regex(/^c[1-9][0-9]*$/)).optional(),
  order: z.array(z.string().regex(/^c[1-9][0-9]*$/)).optional(),
}).strict() satisfies z.ZodType<CriteriaEditOps>;

export const criteriaEpochSnapshotSchema = z.object({
  epoch: z.number().int().min(0),
  criteria: z.array(criterionSchemaV1),
  supersededAt: z.string().min(1),
  note: z.string().min(1).optional(),
}).strict() satisfies z.ZodType<CriteriaEpochSnapshot>;

export const reviewRoundSchemaV1 = z.object({
  roundId: z.string().min(1),
  createdAt: z.string().min(1),
  reviewerRunIds: z.array(z.string().min(1)),
  status: z.enum(['running', 'complete']).optional(),
}).strict() satisfies z.ZodType<ReviewRoundV1>;

export const naDecisionSchemaV1 = z.object({
  criterionId: z.string().regex(/^c[1-9][0-9]*$/),
  decidedAt: z.string().min(1),
  reason: z.string().min(1),
  roundId: z.string().min(1).optional(),
  reviewerRunId: z.string().min(1).optional(),
}).strict() satisfies z.ZodType<NaDecisionV1>;

export const criteriaSetStateSchemaV1 = z.object({
  schemaVersion: z.literal(CRITERIA_SCHEMA_VERSION),
  criteriaSetId: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  repoRoot: z.string().min(1),
  status: z.enum(['proposed', 'confirmed']),
  epoch: z.number().int().min(0),
  nextCriterionSeq: z.number().int().min(1),
  criteria: z.array(criterionSchemaV1).min(1),
  implementerRunId: z.string().min(1).optional(),
  history: z.array(criteriaEpochSnapshotSchema),
  rounds: z.array(reviewRoundSchemaV1).optional(),
  naDecisions: z.array(naDecisionSchemaV1).optional(),
}).strict() satisfies z.ZodType<CriteriaSetStateV1>;

export function applyCriteriaEditOps(
  state: CriteriaSetStateV1,
  ops: CriteriaEditOps | undefined,
): CriteriaSetStateV1 {
  if (!ops) return state;
  const parsed = criteriaEditOpsSchema.parse(ops);
  validateNoDuplicateIds(parsed.update?.map((item) => item.id), 'update');
  validateNoDuplicateIds(parsed.removeIds, 'removeIds');
  validateNoDuplicateIds(parsed.order, 'order');

  let nextCriterionSeq = state.nextCriterionSeq;
  let criteria = state.criteria.map(cloneCriterion);

  if (parsed.add) {
    const added = parsed.add.map((input) => {
      const criterion: CriterionV1 = {
        id: `c${nextCriterionSeq}`,
        title: input.title,
        type: input.type,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        ...(input.subCriteria !== undefined ? { subCriteria: [...input.subCriteria] } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      };
      nextCriterionSeq += 1;
      return criterion;
    });
    criteria = [...criteria, ...added];
  }

  if (parsed.update) {
    const byId = new Map(criteria.map((criterion, index) => [criterion.id, index]));
    for (const update of parsed.update) {
      const index = byId.get(update.id);
      if (index === undefined) {
        throw new Error(`criteria.invalid: unknown update id ${update.id}`);
      }
      const current = criteria[index];
      const next: CriterionV1 = {
        ...current,
        ...(update.title !== undefined ? { title: update.title } : {}),
        ...(update.type !== undefined ? { type: update.type } : {}),
        ...(update.detail !== undefined ? { detail: update.detail } : {}),
        ...(update.subCriteria !== undefined ? { subCriteria: [...update.subCriteria] } : {}),
        ...(update.signal !== undefined ? { signal: update.signal } : {}),
      };
      criteria[index] = criterionSchemaV1.parse(next);
    }
  }

  if (parsed.removeIds) {
    const ids = new Set(criteria.map((criterion) => criterion.id));
    for (const id of parsed.removeIds) {
      if (!ids.has(id)) {
        throw new Error(`criteria.invalid: unknown remove id ${id}`);
      }
    }
    const remove = new Set(parsed.removeIds);
    criteria = criteria.filter((criterion) => !remove.has(criterion.id));
  }

  if (parsed.order) {
    const byId = new Map(criteria.map((criterion) => [criterion.id, criterion]));
    for (const id of parsed.order) {
      if (!byId.has(id)) {
        throw new Error(`criteria.invalid: unknown order id ${id}`);
      }
    }
    const orderedIds = new Set(parsed.order);
    criteria = [
      ...parsed.order.map((id) => byId.get(id)!),
      ...criteria.filter((criterion) => !orderedIds.has(criterion.id)),
    ];
  }

  if (criteria.length === 0) {
    throw new Error('criteria.invalid: criteria set must contain at least one criterion');
  }

  return criteriaSetStateSchemaV1.parse({
    ...state,
    nextCriterionSeq,
    criteria,
  });
}

export function criteriaValidationWarnings(criteria: readonly CriterionV1[]): readonly string[] {
  const warnings: string[] = [];
  if (criteria.length < 3 || criteria.length > 7) {
    warnings.push(
      `criteria.count_outside_recommended_range: expected 3-7 criteria, got ${criteria.length}`,
    );
  }
  const missingSignals = criteria
    .filter((criterion) => criterion.type === 'mechanical' && criterion.signal === undefined)
    .map((criterion) => criterion.id);
  if (missingSignals.length > 0) {
    warnings.push(
      `criteria.mechanical_missing_signal: ${missingSignals.join(', ')}`,
    );
  }
  return warnings;
}

export function cloneCriteria(criteria: readonly CriterionV1[]): CriterionV1[] {
  return criteria.map(cloneCriterion);
}

function cloneCriterion(criterion: CriterionV1): CriterionV1 {
  return {
    id: criterion.id,
    title: criterion.title,
    type: criterion.type,
    ...(criterion.detail !== undefined ? { detail: criterion.detail } : {}),
    ...(criterion.subCriteria !== undefined ? { subCriteria: [...criterion.subCriteria] } : {}),
    ...(criterion.signal !== undefined ? { signal: criterion.signal } : {}),
  };
}

function validateNoDuplicateIds(
  ids: readonly string[] | undefined,
  field: string,
): void {
  if (!ids) return;
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`criteria.invalid: duplicate ${field} id ${id}`);
    }
    seen.add(id);
  }
}
