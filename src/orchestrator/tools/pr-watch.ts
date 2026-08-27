import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { simpleGit } from 'simple-git';

import {
  PrWatchActionBlockedError,
  prWatchTopologyHash,
  type PrWatchActionController,
} from '../../pr-watch/action-controller.js';
import type { PrWatchController } from '../../pr-watch/controller.js';
import { sha256Canonical } from '../../pr-watch/canonical.js';
import { parsePrWatchId } from '../../pr-watch/id.js';
import { runGitHubReadCommand } from '../../pr-watch/github-provider.js';
import type { ProviderCommandRunner } from '../../pr-watch/provider-runner.js';
import { cancelPrWatch, rearmPrWatch } from '../../pr-watch/reducer.js';
import { PrWatchCorruptStateError, type PrWatchStore } from '../../pr-watch/store.js';
import type { PrWatchEffectKind, PrWatchRearmReason, PrWatchStateV1 } from '../../pr-watch/types.js';
import type { ClientKind, ToolCallReturn, ToolRequestExtra } from './shared.js';

const watchIdSchema = z.string().regex(/^pw-[0-9a-f]{32}$/);
const approvalGoalSchema = z.object({
  pr: z.number().int().positive(),
  mode: z.enum(['github', 'reviewer', 'reviewer_head']),
  reviewer: z.string().min(1).max(100).optional(),
}).strict().superRefine((goal, ctx) => {
  if ((goal.mode === 'github') === (goal.reviewer !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'reviewer is required only for reviewer modes' });
  }
});
const verdictSourceSchema = z.object({
  author: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  marker: z.string().min(1).max(500),
}).strict();

export const startPrWatchInputSchema = z.object({
  resume_watch_id: watchIdSchema.optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).optional(),
  target_pr: z.number().int().positive().optional(),
  scope: z.enum(['single', 'stack']).default('stack'),
  max_prs: z.number().int().min(1).max(100).optional(),
  policy_confirmation: z.object({
    expected_hash: z.string().regex(/^[0-9a-f]{64}$/),
    confirmed: z.literal(true),
  }).strict().optional(),
  approval_goals: z.array(approvalGoalSchema).max(100).optional(),
  verdict_sources: z.array(verdictSourceSchema).max(100).superRefine((sources, ctx) => {
    const pairs = sources.map((source) => `${source.author.toLowerCase()}\0${source.marker}`);
    if (new Set(pairs).size !== pairs.length) {
      ctx.addIssue({ code: 'custom', message: 'verdict sources must be unique' });
    }
  }).optional(),
}).strict().superRefine((input, ctx) => {
  if (input.resume_watch_id !== undefined && input.idempotency_key !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'resume_watch_id and idempotency_key are mutually exclusive' });
  }
});

export const listPrWatchesInputSchema = z.object({
  all_repos: z.boolean().default(false),
  statuses: z.array(z.enum(['active', 'actionable', 'blocked', 'expired', 'terminal', 'cancelled'])).optional(),
  limit: z.number().int().min(1).max(256).optional(),
}).strict();

export const getPrWatchStatusInputSchema = z.object({
  watch_id: watchIdSchema,
}).strict();

export const rearmPrWatchInputSchema = z.object({
  watch_id: watchIdSchema,
  expected_generation: z.number().int().positive(),
  reason: z.enum([
    'disposed_batch',
    'timeout',
    'budget_exhausted',
    'stale_waiter',
    'expired',
    'blocked_resolved',
  ]),
  action_batch_id: z.string().min(1).optional(),
  prior_watcher_action_id: z.string().min(1).optional(),
  confirmed: z.literal(true).optional(),
  extension_days: z.number().int().min(1).max(30).optional(),
  blocking_cause_id: z.string().min(1).optional(),
  blocking_cause_version: z.number().int().positive().optional(),
}).strict();

export const cancelPrWatchInputSchema = z.object({
  watch_id: watchIdSchema,
}).strict();

const effectKindSchema = z.enum([
  'push_single_branch',
  'reply_review_comment',
  'post_pr_comment',
  'resolve_review_thread',
]);

export const authorizePrWatchActionsInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('grant'),
    watch_id: watchIdSchema,
    expected_generation: z.number().int().positive(),
    expected_policy_hash: z.string().regex(/^[0-9a-f]{64}$/),
    expected_topology_hash: z.string().regex(/^[0-9a-f]{64}$/),
    effect_kinds: z.array(effectKindSchema).min(1).max(4),
    max_action_rounds: z.number().int().positive(),
    max_actionable_wakes: z.number().int().positive(),
    expires_at: z.string().datetime().optional(),
    confirmed: z.literal(true),
  }).strict(),
  z.object({
    action: z.literal('revoke'),
    watch_id: watchIdSchema,
    reason: z.string().trim().min(1).max(500).optional(),
  }).strict(),
]);
export const authorizePrWatchActionsMcpInputSchema = z.object({
  action: z.enum(['grant', 'revoke']),
  watch_id: watchIdSchema,
  expected_generation: z.number().int().positive().optional(),
  expected_policy_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  expected_topology_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  effect_kinds: z.array(effectKindSchema).min(1).max(4).optional(),
  max_action_rounds: z.number().int().positive().optional(),
  max_actionable_wakes: z.number().int().positive().optional(),
  expires_at: z.string().datetime().optional(),
  confirmed: z.literal(true).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

export const START_PR_WATCH_DESCRIPTION =
  'Start or resume one durable, monitor-only GitHub PR/linear-stack watch. Performs bounded provider preflight, persists typed blockers, and returns one trusted background waiter action on supported Claude Code or Codex hosts. It never comments, pushes, merges, closes, or approves.';
export const LIST_PR_WATCHES_DESCRIPTION =
  'List durable PR watches for the current repository, or all repositories when all_repos is true. This is a pure authoritative ledger read and never polls providers, launches a waiter, delivers a wake, or changes generation.';
export const GET_PR_WATCH_STATUS_DESCRIPTION =
  'Read one durable PR-watch snapshot immediately by server-issued watch_id. Reports generation, batch, evidence gaps, blocker/expiry remedy, budgets, waiter, and history summary. Strictly read-only: status never polls, rearms, launches, or acknowledges.';
export const REARM_PR_WATCH_DESCRIPTION =
  'Explicitly compare-and-set a PR watch after a disposed batch, timed-out/stale waiter, budget handoff, confirmed expiry extension, or freshly revalidated blocker. Required durable identities must match. Returns the exact persisted receipt and at most one next waiter action.';
export const CANCEL_PR_WATCH_DESCRIPTION =
  'Stop a durable PR watch without deleting its history or changing GitHub, git, reviews, checks, branches, or pull requests. Cancellation is idempotent for an already-cancelled watch and does not authorize any other lifecycle action.';
export const AUTHORIZE_PR_WATCH_ACTIONS_DESCRIPTION =
  'Grant or revoke bounded PR-watch action authority. A grant requires explicit confirmation, exact policy/topology hashes, current remote heads, effect kinds, and budgets; it creates or validates a dedicated worktree lease but performs no remote effect. Default is deny.';

export interface PrWatchToolContext {
  readonly store: PrWatchStore;
  readonly controller: PrWatchController;
  readonly actionController: PrWatchActionController;
  readonly runner: ProviderCommandRunner;
  readonly projectRoot: string;
  readonly crewHome: string;
  readonly getClientKind: () => ClientKind;
  readonly getCrewWaitCommand: (extra?: ToolRequestExtra) => string | undefined;
  readonly getPrWatchWaitCommand: (extra?: ToolRequestExtra) => string | undefined;
}

export type StartPrWatchInput = z.infer<typeof startPrWatchInputSchema>;
export type RearmPrWatchInput = z.infer<typeof rearmPrWatchInputSchema>;

export async function startPrWatchToolHandler(
  input: StartPrWatchInput,
  extra: ToolRequestExtra,
  context: PrWatchToolContext,
): Promise<ToolCallReturn> {
  const clientKind = context.getClientKind();
  if (clientKind !== 'claude-code' && clientKind !== 'codex') {
    return envelope({
      ok: false,
      error: 'unsupported_host_waiter',
      message: 'PR-watch background survival is supported only for Claude Code and current Codex hosts.',
    }, true);
  }
  const waitCommand = context.getPrWatchWaitCommand(extra);
  if (!waitCommand) {
    return envelope({ ok: false, error: 'unsupported_host_waiter', message: 'No trusted PR-watch waiter command is installed.' }, true);
  }
  const repository = input.repository ?? await resolveRepository(context.projectRoot);
  const anchorPrNumber = input.target_pr
    ?? await resolveCurrentBranchPr(context.projectRoot, repository, context.runner, extra.signal);
  const approvalGoals = input.approval_goals?.map((goal) => ({
    ...goal,
    ...(goal.reviewer ? { reviewer: goal.reviewer.toLowerCase() } : {}),
  }));
  const approval = {
    mode: 'github' as const,
    ...(approvalGoals ? { goals: approvalGoals } : {}),
  };
  const verdictSources = input.verdict_sources?.map((source) => ({
    author: source.author.toLowerCase(),
    marker: source.marker,
  }));
  const started = await context.controller.start({
    repoRoot: context.projectRoot,
    repository,
    anchorPrNumber,
    idempotencyKey: input.idempotency_key ?? randomUUID(),
    approval,
    scope: input.scope,
    ...(input.max_prs !== undefined ? { maxPrs: input.max_prs } : {}),
    ...(verdictSources !== undefined ? { verdictSources } : {}),
    ...(input.policy_confirmation ? { policyConfirmationHash: input.policy_confirmation.expected_hash } : {}),
    ...(input.resume_watch_id ? { resumeWatchId: input.resume_watch_id } : {}),
    ...(extra.signal ? { signal: extra.signal } : {}),
  });
  return envelope(renderWatchResult(started.state, context, waitCommand, clientKind));
}

export function listPrWatchesToolHandler(
  input: z.infer<typeof listPrWatchesInputSchema>,
  context: PrWatchToolContext,
): ToolCallReturn {
  const statuses = input.statuses ? new Set(input.statuses) : undefined;
  const projectRoot = realpathSync(context.projectRoot);
  const watches: Array<Record<string, unknown>> = [];
  for (const watchId of context.store.listWatchIds()) {
    try {
      const state = context.store.read(watchId).state;
      if (!input.all_repos && state.repoRoot !== projectRoot) continue;
      if (statuses && !statuses.has(state.status)) continue;
      watches.push({
        watch_id: state.watchId,
        repository: state.repository,
        anchor_pr: state.anchorPrNumber,
        watched_pr_count: Object.keys(state.expectedHeads).length,
        status: state.status,
        generation: state.generation,
        summary: listWatchSummary(state),
        pending_remedy: hasPendingRemedy(state),
        created_at: state.createdAt,
        updated_at: state.updatedAt,
        ...(state.watchExpiresAt ? { watch_expires_at: state.watchExpiresAt } : {}),
      });
    } catch (error) {
      const corrupt = corruptStatusPayload(context.store, watchId, error);
      if (!input.all_repos && corrupt.repo_root !== undefined && corrupt.repo_root !== projectRoot) continue;
      if (statuses && !statuses.has('blocked')) continue;
      watches.push({
        ...corrupt,
        summary: 'Authoritative PR-watch state is corrupt; restart or cancel is required.',
        ...(corrupt.repo_root === undefined ? { repo_scope_unknown: true } : {}),
      });
    }
  }
  watches.sort((left, right) => {
    const byUpdated = String(right.updated_at ?? '').localeCompare(String(left.updated_at ?? ''));
    return byUpdated || String(left.watch_id).localeCompare(String(right.watch_id));
  });
  const limited = input.limit === undefined ? watches : watches.slice(0, input.limit);
  return envelope({ watches: limited, count: limited.length, total_count: watches.length });
}

export function getPrWatchStatusToolHandler(
  input: z.infer<typeof getPrWatchStatusInputSchema>,
  context: PrWatchToolContext,
): ToolCallReturn {
  const watchId = parsePrWatchId(input.watch_id);
  try {
    return envelope(statusPayload(context.store.read(watchId).state));
  } catch (error) {
    if (!(error instanceof PrWatchCorruptStateError)) throw error;
    return envelope(corruptStatusPayload(context.store, watchId, error));
  }
}

export async function rearmPrWatchToolHandler(
  input: RearmPrWatchInput,
  extra: ToolRequestExtra,
  context: PrWatchToolContext,
): Promise<ToolCallReturn> {
  const watchId = parsePrWatchId(input.watch_id);
  const receiptKey = sha256Canonical(input);
  let state: PrWatchStateV1;
  let receipt;
  if (input.reason === 'blocked_resolved') {
    if (!input.blocking_cause_id || input.blocking_cause_version === undefined) {
      throw new Error('pr_watch.blocking_cause_identity_required');
    }
    const result = await context.controller.revalidateBlocked(watchId, {
      expectedGeneration: input.expected_generation,
      blockerCauseId: input.blocking_cause_id,
      blockerVersion: input.blocking_cause_version,
      receiptKey,
      ...(extra.signal ? { signal: extra.signal } : {}),
    });
    state = result.state;
    receipt = result.receipt;
  } else {
    const committed = await context.store.mutate(watchId, (current) => rearmPrWatch(current, {
      reason: input.reason as PrWatchRearmReason,
      expectedGeneration: input.expected_generation,
      receiptKey,
      ...(input.action_batch_id ? { actionBatchId: input.action_batch_id } : {}),
      ...(input.prior_watcher_action_id ? { priorWatcherActionId: input.prior_watcher_action_id } : {}),
      ...(input.blocking_cause_id ? { blockerCauseId: input.blocking_cause_id } : {}),
      ...(input.blocking_cause_version !== undefined ? { blockerVersion: input.blocking_cause_version } : {}),
      ...(input.confirmed ? { confirmed: true } : {}),
      ...(input.extension_days !== undefined ? { extendDays: input.extension_days } : {}),
    }));
    state = committed.state;
    receipt = state.receipts[receiptKey];
  }
  if (!receipt) throw new Error('pr_watch.rearm_receipt_missing');
  const clientKind = context.getClientKind();
  const waitCommand = context.getPrWatchWaitCommand(extra);
  return envelope({
    ...statusPayload(state),
    receipt,
    ...(state.status === 'active' && waitCommand && (clientKind === 'claude-code' || clientKind === 'codex')
      ? { required_next_action: requiredAction(state, context, waitCommand, clientKind) }
      : {}),
  });
}

export async function cancelPrWatchToolHandler(
  input: z.infer<typeof cancelPrWatchInputSchema>,
  context: PrWatchToolContext,
): Promise<ToolCallReturn> {
  const watchId = parsePrWatchId(input.watch_id);
  const current = context.store.read(watchId).state;
  const state = current.status === 'cancelled'
    ? current
    : (await context.store.mutate(watchId, (value) => cancelPrWatch(value))).state;
  return envelope(statusPayload(state));
}

export async function authorizePrWatchActionsToolHandler(
  rawInput: Record<string, unknown>,
  extra: ToolRequestExtra,
  context: PrWatchToolContext,
): Promise<ToolCallReturn> {
  const input = authorizePrWatchActionsInputSchema.parse(rawInput);
  const watchId = parsePrWatchId(input.watch_id);
  if (input.action === 'revoke') {
    const state = await context.actionController.revoke(watchId, input.reason ?? 'user_revoked');
    return envelope(statusPayload(state));
  }
  try {
    const result = await context.actionController.authorize({
      watchId,
      expectedGeneration: input.expected_generation,
      expectedPolicyHash: input.expected_policy_hash,
      expectedTopologyHash: input.expected_topology_hash,
      effectKinds: input.effect_kinds as readonly PrWatchEffectKind[],
      maxActionRounds: input.max_action_rounds,
      maxActionableWakes: input.max_actionable_wakes,
      ...(input.expires_at !== undefined ? { expiresAt: input.expires_at } : {}),
      confirmed: true,
      ...(extra.signal ? { signal: extra.signal } : {}),
    });
    return envelope({ ...statusPayload(result.state), grant: result.grant });
  } catch (error) {
    if (!(error instanceof PrWatchActionBlockedError)) throw error;
    return envelope({ ...statusPayload(error.state), authorization_blocked: true });
  }
}

function renderWatchResult(
  state: PrWatchStateV1,
  context: PrWatchToolContext,
  waitCommand: string,
  clientKind: 'claude-code' | 'codex',
): Record<string, unknown> {
  return {
    ...statusPayload(state),
    ...(state.status === 'active'
      ? { required_next_action: requiredAction(state, context, waitCommand, clientKind) }
      : {}),
  };
}

function statusPayload(state: PrWatchStateV1): Record<string, unknown> {
  return {
    watch_id: state.watchId,
    repository: state.repository,
    anchor_pr: state.anchorPrNumber,
    status: state.status,
    generation: state.generation,
    observation_mode: state.observationMode,
    effective_policy_hash: state.effectiveConfig.policyHash,
    topology_hash: prWatchTopologyHash(state),
    expected_heads: state.expectedHeads,
    actionable_wake_budget: state.actionableWakeBudget,
    action_round_budget: state.actionRoundBudget,
    ...(state.watchExpiresAt ? { watch_expires_at: state.watchExpiresAt } : {}),
    ...(state.status === 'active' ? { waiter: state.waiter } : {}),
    ...(state.status === 'actionable' ? { action_batch: state.batch } : {}),
    ...(state.status === 'blocked' ? {
      blocker: state.blocker,
      blocker_surface: state.blockerSurfaces.find((surface) => surface.surfaceId === state.currentBlockerSurfaceId),
    } : {}),
    ...(state.status === 'expired' ? {
      expired_at: state.expiredAt,
      suspended_state: state.suspendedState,
      expiry_surface: state.expirySurfaces.find((surface) => surface.surfaceId === state.currentExpirySurfaceId),
    } : {}),
    ...(state.status === 'terminal' ? {
      outcome: state.outcome,
      terminal_at: state.terminalAt,
      terminal_fingerprint: state.terminalFingerprint,
    } : {}),
    ...(state.status === 'cancelled' ? { cancelled_at: state.cancelledAt } : {}),
    last_observation: state.lastObservation ?? null,
    pending_events: Object.values(state.events).filter((event) => event.disposition === undefined),
    action_grant: state.actionGrant ?? null,
    prepared_worktree_lease: state.preparedWorktreeLease ?? null,
    worktree_lease: state.worktreeLease ?? null,
  };
}

function hasPendingRemedy(state: PrWatchStateV1): boolean {
  if (state.status === 'actionable') return true;
  if (state.status === 'blocked') {
    const surface = state.blockerSurfaces.find((entry) => (
      entry.surfaceId === state.currentBlockerSurfaceId
    ));
    return surface?.state === 'pending' || surface?.state === 'claimed';
  }
  if (state.status === 'expired') {
    const surface = state.expirySurfaces.find((entry) => (
      entry.surfaceId === state.currentExpirySurfaceId
    ));
    return surface?.state === 'pending' || surface?.state === 'claimed';
  }
  return false;
}

function listWatchSummary(state: PrWatchStateV1): string {
  switch (state.status) {
    case 'active':
      return `${Object.keys(state.expectedHeads).length} PR(s) under ${state.observationMode} observation.`;
    case 'actionable':
      return `${state.batch.eventIds.length} event(s) await disposition.`;
    case 'blocked':
      return state.blocker.message;
    case 'expired':
      return `Watch expired while ${state.suspendedState.status}; extension or cancellation is required.`;
    case 'terminal':
      return `Terminal outcome: ${state.outcome}.`;
    case 'cancelled':
      return 'Watch cancelled.';
  }
}

function corruptStatusPayload(
  store: PrWatchStore,
  watchId: string,
  error: unknown,
): Record<string, unknown> {
  const cached = store.readCachedIdentity(watchId);
  const sequence = error instanceof PrWatchCorruptStateError ? error.sequence : undefined;
  const ledgerPath = join(store.watchDir(watchId), 'events.jsonl');
  const causeId = sha256Canonical({
    watchId,
    kind: 'corrupt_state',
    subject: ledgerPath,
    firstObservedSequence: sequence ?? 1,
  });
  return {
    watch_id: watchId,
    ...(cached ? {
      repository: cached.repository,
      anchor_pr: cached.anchorPrNumber,
      repo_root: cached.repoRoot,
      last_cached_generation: cached.generation,
      updated_at: cached.updatedAt,
    } : {}),
    status: 'blocked',
    observation_mode: 'terminal_only',
    pending_remedy: true,
    blocker: {
      causeId,
      version: sequence ?? 1,
      kind: 'corrupt_state',
      class: 'restart_required',
      message: errorMessage(error),
      evidence: {
        ledgerPath,
        ...(sequence !== undefined ? { sequence } : {}),
      },
      allowedConsumingReasons: [],
    },
    remedy: {
      type: 'restart_required',
      allowed_actions: ['cancel_pr_watch', 'start_pr_watch'],
      note: 'The authoritative ledger is corrupt; no cached lifecycle state was trusted.',
    },
  };
}

function requiredAction(
  state: Extract<PrWatchStateV1, { readonly status: 'active' }>,
  context: PrWatchToolContext,
  waitCommand: string,
  clientKind: 'claude-code' | 'codex',
): Record<string, unknown> {
  const command = `${waitCommand} --crew-home-base64 ${Buffer.from(context.crewHome).toString('base64url')}`
    + ` --watch ${state.watchId} --generation ${state.generation}`
    + ` --watcher-action ${state.waiter.watcherActionId}`;
  const mechanism = clientKind === 'claude-code'
    ? 'background_shell'
    : command.includes('--codex-queue-thread ')
      ? 'codex_queue'
      : 'codex_app_server';
  return {
    type: 'spawn_pr_watch_watcher',
    mechanism,
    command,
    ...(clientKind === 'codex' ? { command_json: JSON.stringify(command) } : {}),
    working_directory: context.projectRoot,
    watch_id: state.watchId,
    generation: state.generation,
    watcher_action_id: state.waiter.watcherActionId,
    observation_mode: state.observationMode,
    run_in_background: true,
    consequence_if_skipped: 'The durable watch remains recoverable, but it will not poll or wake this thread.',
  };
}

async function resolveRepository(projectRoot: string): Promise<string> {
  const remotes = await simpleGit(projectRoot).getRemotes(true);
  const origin = remotes.find((remote) => remote.name === 'origin') ?? remotes[0];
  const url = origin?.refs.fetch;
  const match = url?.match(/(?:[:/])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (!match) throw new Error('pr_watch.repository_resolution_failed');
  return `${match[1]}/${match[2]}`;
}

async function resolveCurrentBranchPr(
  projectRoot: string,
  repository: string,
  runner: ProviderCommandRunner,
  signal?: AbortSignal,
): Promise<number> {
  const branch = (await simpleGit(projectRoot).revparse(['--abbrev-ref', 'HEAD'])).trim();
  if (!branch || branch === 'HEAD') throw new Error('pr_watch.detached_head_requires_target_pr');
  const [owner, name] = repository.split('/');
  const document = `query CrewPrWatchCurrentBranch($owner: String!, $name: String!, $branch: String!) {
    repository(owner: $owner, name: $name) {
      pullRequests(first: 2, states: OPEN, headRefName: $branch) { nodes { number } }
    }
  }`;
  const result = await runGitHubReadCommand({
    kind: 'graphql',
    hostname: 'github.com',
    document,
    variables: { owner, name, branch },
  }, { runner, signal });
  const parsed = JSON.parse(result.stdout) as {
    data?: { repository?: { pullRequests?: { nodes?: Array<{ number?: unknown }> } } };
  };
  const numbers = parsed.data?.repository?.pullRequests?.nodes
    ?.map((node) => node.number)
    .filter((value): value is number => Number.isSafeInteger(value)) ?? [];
  if (numbers.length === 0) throw new Error('pr_watch.no_pr');
  if (numbers.length > 1) throw new Error('pr_watch.ambiguous_branch_pr');
  return numbers[0];
}

function envelope(payload: Record<string, unknown>, isError = false): ToolCallReturn {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
