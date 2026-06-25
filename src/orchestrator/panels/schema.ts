import { z } from 'zod';

import type { TaskFailure } from '../../adapters/types.js';

export const PANEL_SCHEMA_VERSION = 1 as const;

export interface PanelReviewerTerminalSnapshot {
  readonly status: 'success' | 'partial' | 'error' | 'cancelled' | 'merged' | 'merge_conflict' | 'discarded';
  readonly summary?: string;
  readonly filesChanged: readonly string[];
  readonly completedAt?: string;
  readonly failure?: TaskFailure;
}

export interface PanelReviewerDispatchedRecord {
  readonly runId: string;
  readonly agentId: string;
  readonly dispatched: true;
  readonly dispatchedAt: string;
  readonly dispatchWarnings: readonly string[];
  readonly terminalSnapshot?: PanelReviewerTerminalSnapshot;
}

export interface PanelReviewerFailedRecord {
  readonly runId: null;
  readonly agentId: string;
  readonly dispatched: false;
  readonly error: string;
  readonly dispatchWarnings: readonly string[];
}

export interface PanelReviewerPendingRecord {
  readonly runId: null;
  readonly agentId: string;
  readonly dispatched: false;
  readonly pending: true;
  readonly dispatchWarnings: readonly string[];
}

export type PanelReviewerRecord =
  | PanelReviewerDispatchedRecord
  | PanelReviewerFailedRecord
  | PanelReviewerPendingRecord;

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

const taskFailureSchema = z.object({
  kind: z.enum(['quota_exhausted', 'rate_limited', 'auth', 'transient', 'process', 'unknown']),
  confidence: z.enum(['high', 'low']),
  providerCode: z.string().optional(),
  retryAfterSeconds: z.number().optional(),
  resetAt: z.string().optional(),
  rawSignal: z.string().optional(),
  recommendation: z.enum(['reroute', 'backoff', 'downgrade', 'ask_user']).optional(),
}).strict() satisfies z.ZodType<TaskFailure>;

const dispatchedReviewerSchema = z.object({
  runId: z.string().min(1),
  agentId: z.string().min(1),
  dispatched: z.literal(true),
  dispatchedAt: z.string().min(1),
  dispatchWarnings: z.array(z.string()),
  terminalSnapshot: z.object({
    status: z.enum(['success', 'partial', 'error', 'cancelled', 'merged', 'merge_conflict', 'discarded']),
    summary: z.string().optional(),
    filesChanged: z.array(z.string()),
    completedAt: z.string().min(1).optional(),
    failure: taskFailureSchema.optional(),
  }).strict().optional(),
}).strict();

const failedReviewerSchema = z.object({
  runId: z.null(),
  agentId: z.string().min(1),
  dispatched: z.literal(false),
  pending: z.literal(false).optional(),
  error: z.string(),
  dispatchWarnings: z.array(z.string()),
}).strict();

const pendingReviewerSchema = z.object({
  runId: z.null(),
  agentId: z.string().min(1),
  dispatched: z.literal(false),
  pending: z.literal(true),
  dispatchWarnings: z.array(z.string()),
}).strict();

export const panelReviewerRecordSchema = z.union([
  dispatchedReviewerSchema,
  failedReviewerSchema,
  pendingReviewerSchema,
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
