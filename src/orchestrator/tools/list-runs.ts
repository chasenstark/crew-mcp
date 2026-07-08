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

import * as fs from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { runModeFromState } from '../run-mode.js';
import { summarizeInbox, type InboxSummary } from '../captain-inbox/store.js';
import {
  quarantineCorruptRunState,
  type RunStateV1,
  type RunStatus,
} from '../run-state.js';
import type { ToolCallReturn, ToolHandlerDeps } from './shared.js';
import { markdownContent } from './shared.js';

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

export const DEFAULT_LIST_RUNS_LIMIT = 20;
export const MAX_LIST_RUNS_LIMIT = 500;
export const LIST_RUNS_SUMMARY_MAX_CHARS = 400;

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
  'List persisted crew runs for the current repo, newest-first, to recover running or newly-terminal work after context loss. Input supports status (single or array), include_unknown_repo for legacy records without repoRoot, completedAfter ISO filtering, and limit. Returns run_id, agent_id, status, startedAt, completedAt, worktreePath, latest truncated summary/error plus summary_truncated marker, and typed failure when present. Use get_run_status for the rich per-run payload.';

export interface ListRunsEntry {
  readonly run_id: string;
  readonly agent_id: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly worktreePath: string;
  /** Present only for non-default lifecycles (read_only / ephemeral_review). */
  readonly run_mode?: string;
  readonly summary?: string;
  readonly summary_truncated: boolean;
  readonly failure?: RunStateV1['failure'];
}

export interface ListRunsOutput {
  readonly runs: readonly ListRunsEntry[];
  readonly captain_inbox_summary: InboxSummary;
}

export interface ListRunsContext {
  readonly crewHome: string;
  readonly repoRoot: string;
}

export function listRunsToolHandler(
  args: ListRunsInput,
  deps: Pick<ToolHandlerDeps, 'crewHome' | 'projectRoot'>,
): ToolCallReturn {
  const out = listRuns(args, { crewHome: deps.crewHome, repoRoot: deps.projectRoot });
  return markdownContent(renderListRunsMarkdown(out), out);
}

interface ParsedRunStateCacheEntry {
  readonly path: string;
  readonly mtimeMs: number;
  readonly parsed?: RunStateV1;
}

interface ListRunsFs {
  existsSync(path: string): boolean;
  readdirSync(path: string, options: { withFileTypes: true }): fs.Dirent[];
  statSync(path: string): fs.Stats;
  readFileSync(path: string, encoding: 'utf-8'): string;
  realpathSync(path: string): string;
}

const defaultListRunsFs: ListRunsFs = {
  existsSync: fs.existsSync,
  readdirSync: fs.readdirSync,
  statSync: fs.statSync,
  readFileSync: fs.readFileSync,
  realpathSync: fs.realpathSync,
};

let listRunsFs = defaultListRunsFs;

const repoRootRealpathCache = new Map<string, string>();
const parsedRunStateCache = new Map<string, ParsedRunStateCacheEntry>();

export function listRuns(
  input: ListRunsInput,
  ctx: ListRunsContext,
): ListRunsOutput {
  const runsBasePath = join(ctx.crewHome, 'runs');
  const captainInboxSummary = summarizeInbox({ crewHome: ctx.crewHome, repoRoot: ctx.repoRoot });
  if (!listRunsFs.existsSync(runsBasePath)) {
    return { runs: [], captain_inbox_summary: captainInboxSummary };
  }

  const repoRoot = resolveRepoRoot(ctx.repoRoot);
  const statusFilter = normalizeStatusFilter(input.status);
  const includeUnknownRepo = input.include_unknown_repo === true;
  const completedAfter = input.completedAfter;
  const limit = input.limit ?? DEFAULT_LIST_RUNS_LIMIT;

  const states: RunStateV1[] = [];
  let entries: fs.Dirent[];
  try {
    entries = listRunsFs.readdirSync(runsBasePath, { withFileTypes: true });
  } catch {
    return { runs: [], captain_inbox_summary: captainInboxSummary };
  }
  const seenRunIds = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    seenRunIds.add(entry.name);
    const state = readRunState(entry.name, join(runsBasePath, entry.name, 'state.json'), {
      repoRoot,
    });
    if (!state) continue;
    if (!belongsToRepo(state, repoRoot, includeUnknownRepo)) continue;
    if (statusFilter && !statusFilter.has(state.status)) continue;
    if (completedAfter && (!state.completedAt || state.completedAt <= completedAfter)) continue;
    states.push(state);
  }
  pruneMissingRunStateCacheEntries(runsBasePath, seenRunIds);

  states.sort(compareRunStateNewestFirst);

  return {
    captain_inbox_summary: captainInboxSummary,
    runs: states.slice(0, limit).map((state) => ({
      run_id: state.runId,
      agent_id: state.agentId,
      status: state.status,
      startedAt: state.startedAt,
      ...(state.completedAt ? { completedAt: state.completedAt } : {}),
      worktreePath: state.worktreePath,
      ...(runModeFromState(state) !== 'write'
        ? { run_mode: runModeFromState(state) }
        : {}),
      ...summaryField(state),
      ...(state.failure !== undefined ? { failure: state.failure } : {}),
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

function summaryField(state: RunStateV1): { summary?: string; summary_truncated: boolean } {
  const summary = state.prompts.at(-1)?.summary ?? state.lastError;
  if (summary === undefined) return { summary_truncated: false };
  const truncated = truncateSummary(summary);
  return {
    summary: truncated.text,
    summary_truncated: truncated.truncated,
  };
}

function truncateSummary(summary: string): { text: string; truncated: boolean } {
  if (summary.length <= LIST_RUNS_SUMMARY_MAX_CHARS) {
    return { text: summary, truncated: false };
  }
  const suffix = '...';
  const maxBodyChars = LIST_RUNS_SUMMARY_MAX_CHARS - suffix.length;
  return {
    text: `${Array.from(summary).slice(0, maxBodyChars).join('').trimEnd()}${suffix}`,
    truncated: true,
  };
}

function renderListRunsMarkdown(out: ListRunsOutput): string {
  const inbox = out.captain_inbox_summary;
  const lines = [
    `Runs: ${out.runs.length}. Inbox: ${inbox.total_unread} unread / ${inbox.total_in_inbox} total.`,
  ];
  if (out.runs.length === 0) {
    lines.push('No runs found for this repo.');
    return lines.join('\n');
  }
  for (const run of out.runs) {
    const completed = run.completedAt ? ` completed=${run.completedAt}` : '';
    const mode = run.run_mode ? ` mode=${run.run_mode}` : '';
    const summary = run.summary ? ` - ${compactLine(run.summary)}` : '';
    const truncation = run.summary_truncated ? ' (summary truncated; use get_run_status)' : '';
    lines.push(
      `- ${run.run_id} [${run.status}] agent=${run.agent_id}${mode} started=${run.startedAt}${completed}${truncation}${summary}`,
    );
  }
  return lines.join('\n');
}

function compactLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function readRunState(
  runId: string,
  path: string,
  options: { readonly repoRoot: string },
): RunStateV1 | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = listRunsFs.statSync(path).mtimeMs;
  } catch {
    parsedRunStateCache.delete(runId);
    return undefined;
  }

  const cached = parsedRunStateCache.get(runId);
  if (cached && cached.path === path && cached.mtimeMs === mtimeMs) {
    return cached.parsed;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(listRunsFs.readFileSync(path, 'utf-8'));
  } catch (err) {
    const quarantined = quarantineCorruptRunState({
      runId,
      statePath: path,
      repoRoot: options.repoRoot,
      reason: err instanceof Error ? err.message : String(err),
    });
    parsedRunStateCache.set(runId, {
      path,
      mtimeMs: listRunsFs.statSync(path).mtimeMs,
      parsed: quarantined,
    });
    return quarantined;
  }
  if (!isRunStateV1(parsed)) {
    parsedRunStateCache.set(runId, { path, mtimeMs });
    return undefined;
  }
  parsedRunStateCache.set(runId, { path, mtimeMs, parsed });
  return parsed;
}

function pruneMissingRunStateCacheEntries(runsBasePath: string, seenRunIds: Set<string>): void {
  const expectedPathPrefix = `${runsBasePath}/`;
  for (const [runId, entry] of parsedRunStateCache) {
    if (entry.path.startsWith(expectedPathPrefix) && !seenRunIds.has(runId)) {
      parsedRunStateCache.delete(runId);
    }
  }
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
  const cached = repoRootRealpathCache.get(raw);
  if (cached !== undefined) {
    return cached;
  }

  let resolved: string;
  try {
    resolved = listRunsFs.realpathSync(raw);
  } catch {
    resolved = raw;
  }
  repoRootRealpathCache.set(raw, resolved);
  return resolved;
}

export function clearListRunsCachesForTest(): void {
  repoRootRealpathCache.clear();
  parsedRunStateCache.clear();
}

export function setListRunsFsForTest(overrides: Partial<ListRunsFs>): () => void {
  listRunsFs = { ...defaultListRunsFs, ...overrides };
  return () => {
    listRunsFs = defaultListRunsFs;
  };
}
