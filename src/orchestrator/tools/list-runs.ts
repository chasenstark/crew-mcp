/**
 * list_runs — discover existing run records for the current host repo.
 *
 * The captain uses this as the recovery path after context loss (`/clear`,
 * compaction, host restart) and as the marker-file equivalent for
 * non-blocking completion surfacing. The repo filter is intentionally
 * implicit: a `crew-mcp serve` instance only lists runs that belong to the
 * repo it was started for, with an opt-in for legacy records that predate the
 * `repoRoot` field.
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import type { RunStateV1, RunStatus } from '../run-state.js';

const RUN_STATUS_VALUES = [
  'running',
  'success',
  'partial',
  'error',
  'cancelled',
  'merged',
  'merge_conflict',
  'discarded',
] as const satisfies readonly RunStatus[];

export const DEFAULT_LIST_RUNS_LIMIT = 50;
export const MAX_LIST_RUNS_LIMIT = 500;

export const runStatusSchema = z.enum(RUN_STATUS_VALUES);

export const listRunsInputSchema = z.object({
  status: z.union([runStatusSchema, z.array(runStatusSchema).min(1)]).optional(),
  include_unknown_repo: z.boolean().optional(),
  completedAfter: z
    .string()
    .refine((value) => Number.isFinite(Date.parse(value)), {
      message: 'completedAfter must be a valid ISO timestamp',
    })
    .optional(),
  limit: z.number().int().positive().max(MAX_LIST_RUNS_LIMIT).optional(),
});

export type ListRunsInput = z.infer<typeof listRunsInputSchema>;

export const LIST_RUNS_DESCRIPTION =
  'List persisted crew runs for the current repo, newest-first, to recover running or newly-terminal work after context loss. Input supports status (single or array), include_unknown_repo for legacy records without repoRoot, completedAfter ISO filtering, and limit. Returns run_id, agent_id, status, startedAt, completedAt, worktreePath, and latest summary/error.';

export interface ListRunsEntry {
  readonly run_id: string;
  readonly agent_id: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly worktreePath: string;
  readonly summary?: string;
}

export interface ListRunsOutput {
  readonly runs: readonly ListRunsEntry[];
}

export interface ListRunsContext {
  readonly crewHome: string;
  readonly repoRoot: string;
}

export function listRuns(
  input: ListRunsInput,
  ctx: ListRunsContext,
): ListRunsOutput {
  const runsBasePath = join(ctx.crewHome, 'runs');
  if (!existsSync(runsBasePath)) {
    return { runs: [] };
  }

  const repoRoot = resolveRepoRoot(ctx.repoRoot);
  const statusFilter = normalizeStatusFilter(input.status);
  const includeUnknownRepo = input.include_unknown_repo === true;
  const completedAfter = input.completedAfter;
  const limit = input.limit ?? DEFAULT_LIST_RUNS_LIMIT;

  const states: RunStateV1[] = [];
  for (const entry of readdirSync(runsBasePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const state = readRunState(join(runsBasePath, entry.name, 'state.json'));
    if (!state) continue;
    if (!belongsToRepo(state, repoRoot, includeUnknownRepo)) continue;
    if (statusFilter && !statusFilter.has(state.status)) continue;
    if (completedAfter && (!state.completedAt || state.completedAt <= completedAfter)) continue;
    states.push(state);
  }

  states.sort(compareRunStateNewestFirst);

  return {
    runs: states.slice(0, limit).map((state) => ({
      run_id: state.runId,
      agent_id: state.agentId,
      status: state.status,
      startedAt: state.startedAt,
      ...(state.completedAt ? { completedAt: state.completedAt } : {}),
      worktreePath: state.worktreePath,
      ...summaryField(state),
    })),
  };
}

function normalizeStatusFilter(status: ListRunsInput['status']): Set<RunStatus> | undefined {
  if (!status) return undefined;
  return new Set(Array.isArray(status) ? status : [status]);
}

function belongsToRepo(
  state: RunStateV1,
  repoRoot: string,
  includeUnknownRepo: boolean,
): boolean {
  if (!state.repoRoot) {
    return includeUnknownRepo;
  }
  return resolveRepoRoot(state.repoRoot) === repoRoot;
}

function compareRunStateNewestFirst(a: RunStateV1, b: RunStateV1): number {
  const aTime = a.completedAt ?? a.startedAt;
  const bTime = b.completedAt ?? b.startedAt;
  const timeOrder = bTime.localeCompare(aTime);
  if (timeOrder !== 0) return timeOrder;
  return b.runId.localeCompare(a.runId);
}

function summaryField(state: RunStateV1): { summary?: string } {
  const summary = state.prompts.at(-1)?.summary ?? state.lastError;
  return summary !== undefined ? { summary } : {};
}

function readRunState(path: string): RunStateV1 | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
  if (!isRunStateV1(parsed)) {
    return undefined;
  }
  return parsed;
}

function isRunStateV1(value: unknown): value is RunStateV1 {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RunStateV1>;
  return candidate.schemaVersion === 1
    && typeof candidate.runId === 'string'
    && typeof candidate.agentId === 'string'
    && typeof candidate.status === 'string'
    && (RUN_STATUS_VALUES as readonly string[]).includes(candidate.status)
    && typeof candidate.startedAt === 'string'
    && typeof candidate.worktreePath === 'string'
    && Array.isArray(candidate.prompts)
    && Array.isArray(candidate.filesChanged);
}

function resolveRepoRoot(raw: string): string {
  try {
    return realpathSync(raw);
  } catch {
    return raw;
  }
}
