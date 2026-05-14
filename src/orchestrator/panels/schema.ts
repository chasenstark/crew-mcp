import { z } from 'zod';

export const PANEL_SCHEMA_VERSION = 1 as const;

export interface PanelReviewerDispatchedRecord {
  readonly runId: string;
  readonly agentId: string;
  readonly dispatched: true;
  readonly dispatchedAt: string;
  readonly dispatchWarnings: readonly string[];
}

export interface PanelReviewerFailedRecord {
  readonly runId: null;
  readonly agentId: string;
  readonly dispatched: false;
  readonly error: string;
  readonly dispatchWarnings: readonly string[];
}

export type PanelReviewerRecord =
  | PanelReviewerDispatchedRecord
  | PanelReviewerFailedRecord;

export interface PanelStateV1 {
  readonly schemaVersion: 1;
  readonly panelId: string;
  readonly createdAt: string;
  readonly panelRepoRoot: string;
  readonly implementerRunId?: string;
  readonly implementerWorktreePath?: string;
  readonly implementerSummarySnapshot?: string;
  readonly implementerRepoRoot?: string;
  readonly reviewers: ReadonlyArray<PanelReviewerRecord>;
}

const dispatchedReviewerSchema = z.object({
  runId: z.string().min(1),
  agentId: z.string().min(1),
  dispatched: z.literal(true),
  dispatchedAt: z.string().min(1),
  dispatchWarnings: z.array(z.string()),
}).strict();

const failedReviewerSchema = z.object({
  runId: z.null(),
  agentId: z.string().min(1),
  dispatched: z.literal(false),
  error: z.string(),
  dispatchWarnings: z.array(z.string()),
}).strict();

export const panelReviewerRecordSchema = z.discriminatedUnion('dispatched', [
  dispatchedReviewerSchema,
  failedReviewerSchema,
]);

export const panelStateSchemaV1 = z.object({
  schemaVersion: z.literal(PANEL_SCHEMA_VERSION),
  panelId: z.string().min(1),
  createdAt: z.string().min(1),
  panelRepoRoot: z.string().min(1),
  implementerRunId: z.string().min(1).optional(),
  implementerWorktreePath: z.string().min(1).optional(),
  implementerSummarySnapshot: z.string().optional(),
  implementerRepoRoot: z.string().min(1).optional(),
  reviewers: z.array(panelReviewerRecordSchema),
}).strict() satisfies z.ZodType<PanelStateV1>;
