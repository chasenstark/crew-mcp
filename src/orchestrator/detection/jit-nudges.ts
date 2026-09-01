import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import type { RunStateV1 } from '../run-state.js';
import { runModeFromState } from '../run-mode.js';
import { resolveRunDirTtlMs } from '../run-gc.js';
import type { ClientKind } from '../tools/shared.js';
import { PrWatchStore } from '../../pr-watch/store.js';
import { derivePrWatchWaiterHealth } from '../../pr-watch/waiter-health.js';
import {
  claimPrWatchSurface,
  deliverPrWatchSurface,
  recoverExpiredPrWatchSurfaceClaim,
} from '../../pr-watch/reducer.js';
import {
  isWaitingWaitParams,
  toolJournalPath,
  type ToolJournalRecord,
} from '../../utils/tool-journal.js';
import {
  watchIndexPath,
  type WatchIndexRecord,
} from '../../utils/watch-index.js';

export const ORPHAN_WATCHER_GRACE_MS = 2 * 60 * 1_000;
export const MISSING_WATCHER_GRACE_MS = 2 * 60 * 1_000;
export const UNSURFACED_TERMINAL_GRACE_MS = 2 * 60 * 1_000;
// Covers an unusually long same-day captain session without excavating
// day-old terminals that predate the watch index or no longer need attention.
export const TERMINAL_NUDGE_RECENCY_CEILING_MS = 12 * 60 * 60 * 1_000;
export const LONG_POLL_WINDOW_MS = 60 * 1_000;
export const LONG_POLL_CALL_THRESHOLD = 3;
export const CONFIRMATION_RETRY_MAX_MS = 1_000;
export const RUN_GC_WARNING_MARGIN_DAYS = 3;
export const JIT_NUDGE_MAX_COUNT = 4;
export const JIT_NUDGE_MAX_BYTES = 2 * 1_024;
export const DETECTION_JOURNAL_TAIL_BYTES = 128 * 1_024;
export const DETECTION_WATCH_TAIL_BYTES = 128 * 1_024;
export const PR_WATCH_JIT_TAIL_BYTES = 128 * 1_024;
export const DETECTION_MAX_RUN_STATES = 256;

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_RUN_STATE_BYTES = 512 * 1_024;
const MAX_SINGLE_NUDGE_BYTES = 512;

export interface JitNudgeCurrentCall {
  readonly tsMs: number;
  readonly tool: string;
  readonly runId?: string;
  readonly waitBearing: boolean;
}

export interface ConfirmationAttempt {
  readonly tool: string;
  readonly runId: string;
  readonly confirmed: boolean;
  readonly generation: string;
  readonly attemptedAtMs: number;
  readonly previousRejection?: {
    readonly tool: string;
    readonly runId: string;
    readonly generation: string;
    readonly rejectedAtMs: number;
  };
}

export interface DetectJitNudgesInput {
  readonly crewHome: string;
  readonly repoRoot: string;
  readonly clientKind: ClientKind;
  readonly currentCall: JitNudgeCurrentCall;
  readonly confirmationAttempt?: ConfirmationAttempt;
  readonly nowMs?: number;
}

export interface ClaimedPrWatchJitNudge {
  readonly watchId: string;
  readonly surfaceId: string;
  readonly requestId: string;
  readonly attempt: number;
  readonly warning: string;
}

/**
 * Best-effort, bounded captain-path diagnostics. Every filesystem or parsing
 * failure collapses the whole pass to no warnings so detection can never
 * affect the underlying MCP result.
 */
export function detectJitNudges(input: DetectJitNudgesInput): string[] {
  try {
    const nowMs = input.nowMs ?? Date.now();
    const runDirTtlMs = resolveRunDirTtlMs(input.crewHome);
    const runGcWarningThresholdMs = Number.isFinite(runDirTtlMs)
      ? Math.max(0, runDirTtlMs - RUN_GC_WARNING_MARGIN_DAYS * DAY_MS)
      : Number.POSITIVE_INFINITY;
    const journal = readJsonlTail(
      toolJournalPath(input.crewHome),
      DETECTION_JOURNAL_TAIL_BYTES,
      isToolJournalRecord,
    );
    const watch = readJsonlTail(
      watchIndexPath(input.crewHome),
      DETECTION_WATCH_TAIL_BYTES,
      isWatchIndexRecord,
    );
    const states = readBoundedRunStates({
      crewHome: input.crewHome,
      repoRoot: input.repoRoot,
      prioritizedRunIds: [
        ...(input.currentCall.runId ? [input.currentCall.runId] : []),
        ...journal.slice().reverse().flatMap((record) => record.run_id ? [record.run_id] : []),
        ...watch.slice().reverse().map((record) => record.run_id),
      ],
    });
    const observations = [
      ...journal.map(journalObservation),
      input.currentCall,
    ];
    const warnings: string[] = [];

    for (const state of states) {
      const generationStartMs = currentGenerationStartMs(state);
      const terminalMs = currentTerminalMs(state);
      const terminalAgeMs = terminalMs === undefined ? undefined : nowMs - terminalMs;
      if (
        (input.clientKind === 'claude-code' || input.clientKind === 'codex')
        && terminalAgeMs !== undefined
        && terminalAgeMs >= ORPHAN_WATCHER_GRACE_MS
        && terminalAgeMs <= TERMINAL_NUDGE_RECENCY_CEILING_MS
        && isUnresolvedTerminal(state.status)
        && runModeFromState(state) === 'write'
        && !watch.some((record) => (
          record.run_id === state.runId
          && parseTimestamp(record.ts) >= generationStartMs
        ))
      ) {
        warnings.push(
          `orphan_recovery: run "${state.runId}" became terminal without a watcher claim; recover it now with get_run_status({run_id:"${state.runId}"}).`,
        );
      }

      // A Codex captain can only be woken by a live crew-wait watcher, so a
      // running run whose current generation has no watcher `start` record is
      // silently orphaned — a skipped launch or a sandboxed watcher that
      // could not append. Nudge while the run is still in flight, when
      // re-arming the watcher still delivers the terminal wake.
      if (
        input.clientKind === 'codex'
        && state.status === 'running'
        && nowMs - generationStartMs >= MISSING_WATCHER_GRACE_MS
        && nowMs - generationStartMs <= TERMINAL_NUDGE_RECENCY_CEILING_MS
        && !watch.some((record) => (
          record.run_id === state.runId
          && parseTimestamp(record.ts) >= generationStartMs
        ))
      ) {
        warnings.push(
          `missing_watcher: running run "${state.runId}" has no crew-wait watcher for its current generation; call get_run_status({run_id:"${state.runId}"}) and launch the returned required_next_action spawn recipe (escalated) now, or completion cannot wake this thread.`,
        );
      }

      if (
        terminalMs !== undefined
        && terminalAgeMs !== undefined
        && terminalAgeMs >= UNSURFACED_TERMINAL_GRACE_MS
        && terminalAgeMs <= TERMINAL_NUDGE_RECENCY_CEILING_MS
        && isUnresolvedTerminal(state.status)
      ) {
        const surfaced = observations.some((record) => (
          record.tool === 'get_run_status'
          && record.runId === state.runId
          && record.tsMs >= terminalMs
        ));
        const otherCallsArrived = observations.some((record) => (
          record.tsMs >= terminalMs
          && !(record.tool === 'get_run_status' && record.runId === state.runId)
        ));
        if (!surfaced && otherCallsArrived) {
          warnings.push(
            `unsurfaced_terminal: run "${state.runId}" finished but has not been read; call get_run_status and resolve its result.`,
          );
        }
      }

      if (state.status === 'running') {
        const waitCalls = observations.filter((record) => (
          record.tool === 'get_run_status'
          && record.runId === state.runId
          && record.waitBearing
          && record.tsMs >= generationStartMs
          && nowMs - record.tsMs <= LONG_POLL_WINDOW_MS
          && record.tsMs <= nowMs
        ));
        if (waitCalls.length >= LONG_POLL_CALL_THRESHOLD) {
          warnings.push(
            `long_poll_loop: run "${state.runId}" received ${waitCalls.length} wait-bearing status calls within 60s; stop long-polling and use the watcher or a next-turn snapshot.`,
          );
        }
      }

      if (
        state.status === 'success'
        && runModeFromState(state) === 'write'
        && terminalMs !== undefined
        && Number.isFinite(runDirTtlMs)
        && nowMs - terminalMs >= runGcWarningThresholdMs
      ) {
        const retentionDays = formatRetentionDays(runDirTtlMs / DAY_MS);
        warnings.push(
          `unmerged_run_gc_risk: successful write run "${state.runId}" is nearing the ${retentionDays}-day run retention limit; merge or discard it before GC can reclaim unmerged work.`,
        );
      }
    }

    const confirmationLatency = impossibleConfirmationLatency(input.confirmationAttempt);
    if (confirmationLatency !== undefined && input.confirmationAttempt) {
      warnings.push(
        `impossible_confirmation_latency: ${input.confirmationAttempt.tool} for run "${input.confirmationAttempt.runId}" retried with confirmed:true after ${confirmationLatency}ms; obtain real user consent before retrying.`,
      );
    }

    const unknownRunExits = new Map<string, number>();
    for (const record of watch) {
      if (record.event !== 'terminal_observed' || record.exit_outcome !== 3) continue;
      unknownRunExits.set(record.run_id, (unknownRunExits.get(record.run_id) ?? 0) + 1);
    }
    for (const [runId, count] of unknownRunExits) {
      if (count < 2) continue;
      warnings.push(
        `watcher_unknown_run_respawn: crew-wait exited 3 for run "${runId}" ${count} times; stop respawning it and verify the stale or mistyped run id.`,
      );
    }

    warnings.push(...readPrWatchRecoveryWarnings({
      crewHome: input.crewHome,
      repoRoot: input.repoRoot,
      nowMs,
    }));

    return capWarnings(warnings);
  } catch {
    return [];
  }
}

function readPrWatchRecoveryWarnings(args: {
  readonly crewHome: string;
  readonly repoRoot: string;
  readonly nowMs: number;
}): string[] {
  if (!existsSync(join(args.crewHome, 'pr-watches'))) return [];
  const store = new PrWatchStore(args.crewHome);
  const expectedRepo = existsSync(args.repoRoot) ? realpathSync(args.repoRoot) : resolve(args.repoRoot);
  const warnings: string[] = [];
  for (const watchId of store.listWatchIds().slice(0, DETECTION_MAX_RUN_STATES)) {
    let bounded;
    try {
      bounded = store.readBoundedTail(watchId, PR_WATCH_JIT_TAIL_BYTES);
    } catch {
      continue;
    }
    if (bounded.status === 'cache_lag') {
      if (
        bounded.cachedState !== undefined
        && resolve(bounded.cachedState.repoRoot) === expectedRepo
      ) {
        warnings.push(
          `pr_watch_cache_lag: watch "${watchId}" exceeds the bounded JIT ledger read; no lifecycle remedy was claimed. Restart its waiter/controller to repair the cache, then inspect with get_pr_watch_status.`,
        );
      }
      continue;
    }
    const state = bounded.read.state;
    if (resolve(state.repoRoot) !== expectedRepo) continue;
    if (state.status === 'actionable') {
      warnings.push(
        `pr_watch_actionable: watch "${watchId}" has action batch "${state.batch.actionBatchId}" awaiting disposition; call get_pr_watch_status before acting.`,
      );
    } else if (state.status === 'active') {
      const waiterHealth = derivePrWatchWaiterHealth(state.waiter, new Date(args.nowMs));
      if (!waiterHealth.recoverable) continue;
      const rearmReason = waiterHealth.rearmReason ?? 'stale_waiter';
      warnings.push(
        `pr_watch_waiter_recovery: watch "${watchId}" has no live waiter (${waiterHealth.reason}); `
        + `call rearm_pr_watch({watch_id:"${watchId}",expected_generation:${state.generation},`
        + `reason:"${rearmReason}",prior_watcher_action_id:"${state.waiter.watcherActionId}"}) `
        + 'and launch the returned required_next_action once.',
      );
    }
  }
  return warnings;
}

/**
 * Claim one repo-scoped blocker/expiry remedy for JIT delivery. The claim is
 * durable before its warning is added to an MCP response, so concurrent host
 * calls cannot surface the same remedy. An abandoned claim becomes eligible
 * again only after its lease has expired and that failed attempt is recorded.
 */
export async function claimPrWatchJitNudge(args: {
  readonly crewHome: string;
  readonly repoRoot: string;
  readonly now?: Date;
  readonly requestId?: string;
  readonly leaseMs?: number;
  readonly maxWarningBytes?: number;
  readonly maxTailBytes?: number;
}): Promise<ClaimedPrWatchJitNudge | undefined> {
  try {
    if (!existsSync(join(args.crewHome, 'pr-watches'))) return undefined;
    const store = new PrWatchStore(args.crewHome);
    const expectedRepo = existsSync(args.repoRoot) ? realpathSync(args.repoRoot) : resolve(args.repoRoot);
    const now = args.now ?? new Date();
    const requestId = args.requestId ?? randomUUID();
    const leaseMs = args.leaseMs ?? 60_000;
    const maxTailBytes = args.maxTailBytes ?? PR_WATCH_JIT_TAIL_BYTES;
    for (const watchId of store.listWatchIds().slice(0, DETECTION_MAX_RUN_STATES)) {
      let bounded;
      try {
        bounded = store.readBoundedTail(watchId, maxTailBytes);
      } catch {
        continue;
      }
      if (bounded.status === 'cache_lag') continue;
      const initial = bounded.read.state;
      if (resolve(initial.repoRoot) !== expectedRepo) continue;
      const candidate = currentRemedySurface(initial);
      if (!candidate) continue;
      const warning = remedyWarning(initial);
      if (
        args.maxWarningBytes !== undefined
        && Buffer.byteLength(warning, 'utf-8') > args.maxWarningBytes
      ) continue;
      try {
        const mutation = await store.mutateBoundedTail(watchId, maxTailBytes, (state) => {
          const current = currentRemedySurface(state);
          if (!current || current.surfaceId !== candidate.surfaceId) {
            throw new Error('pr_watch.surface_not_claimable');
          }
          let next = state;
          if (
            current.state === 'claimed'
            && current.claimedByRequestId !== undefined
            && current.claimLeaseExpiresAt !== undefined
            && Date.parse(current.claimLeaseExpiresAt) <= now.getTime()
          ) {
            next = recoverExpiredPrWatchSurfaceClaim(next, {
              surfaceId: current.surfaceId,
              requestId: current.claimedByRequestId,
              attempt: current.latestClaimAttempt,
              now,
            }).state;
          }
          return claimPrWatchSurface(next, {
            surfaceId: current.surfaceId,
            requestId,
            leaseMs,
            now,
          });
        });
        if (mutation.status === 'cache_lag') continue;
        const surface = currentRemedySurface(mutation.read.state);
        if (
          !surface
          || surface.surfaceId !== candidate.surfaceId
          || surface.claimedByRequestId !== requestId
        ) continue;
        return {
          watchId,
          surfaceId: surface.surfaceId,
          requestId,
          attempt: surface.latestClaimAttempt,
          warning,
        };
      } catch {
        // Another call may have claimed, delivered, or closed this surface.
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Mark a response-constructed JIT remedy as durably delivered. */
export async function auditPrWatchJitNudge(args: {
  readonly crewHome: string;
  readonly claim: ClaimedPrWatchJitNudge;
  readonly now?: Date;
}): Promise<void> {
  const store = new PrWatchStore(args.crewHome);
  await store.mutate(args.claim.watchId, (state) => deliverPrWatchSurface(state, {
    surfaceId: args.claim.surfaceId,
    requestId: args.claim.requestId,
    attempt: args.claim.attempt,
    via: 'jit',
    now: args.now ?? new Date(),
  }));
}

function currentRemedySurface(state: ReturnType<PrWatchStore['read']>['state']) {
  if (state.status === 'blocked') {
    return state.blockerSurfaces.find((entry) => (
      entry.surfaceId === state.currentBlockerSurfaceId && entry.closedAt === undefined
    ));
  }
  if (state.status === 'expired') {
    return state.expirySurfaces.find((entry) => (
      entry.surfaceId === state.currentExpirySurfaceId && entry.closedAt === undefined
    ));
  }
  return undefined;
}

function remedyWarning(state: ReturnType<PrWatchStore['read']>['state']): string {
  if (state.status === 'blocked') {
    return `pr_watch_blocked_remedy: watch "${state.watchId}" is blocked by ${state.blocker.kind}; read get_pr_watch_status for its typed remedy.`;
  }
  if (state.status === 'expired') {
    return `pr_watch_expiry_remedy: watch "${state.watchId}" expired with suspended ${state.suspendedState.status} state; read get_pr_watch_status to extend or cancel.`;
  }
  throw new Error('pr_watch.no_remedy_surface');
}

/** Read the stable generation identity used by the in-process consent map. */
export function readRunGeneration(crewHome: string, runId: string): string | undefined {
  try {
    const state = readRunState(join(crewHome, 'runs', runId, 'state.json'));
    return state ? generationIdentity(state) : undefined;
  } catch {
    return undefined;
  }
}

export function isConfirmationRequiredResult(result: {
  readonly isError?: boolean;
  readonly content: readonly { readonly text: string }[];
}): boolean {
  if (result.isError !== true) return false;
  const text = result.content.map((item) => item.text).join('\n');
  return text.includes('confirmation_required')
    || text.includes('force_requires_confirmed')
    || text.includes('requires explicit user confirmation');
}

function impossibleConfirmationLatency(
  attempt: ConfirmationAttempt | undefined,
): number | undefined {
  const previous = attempt?.previousRejection;
  if (!attempt?.confirmed || !previous) return undefined;
  if (
    previous.tool !== attempt.tool
    || previous.runId !== attempt.runId
    || previous.generation !== attempt.generation
  ) return undefined;
  const latency = attempt.attemptedAtMs - previous.rejectedAtMs;
  return latency >= 0 && latency < CONFIRMATION_RETRY_MAX_MS ? latency : undefined;
}

function currentGenerationStartMs(state: RunStateV1): number {
  const latest = state.prompts.at(-1)?.startedAt ?? state.startedAt;
  return parseTimestamp(latest);
}

function currentTerminalMs(state: RunStateV1): number | undefined {
  if (state.status === 'running' || !state.completedAt) return undefined;
  const completedMs = parseTimestamp(state.completedAt);
  return completedMs >= currentGenerationStartMs(state) ? completedMs : undefined;
}

function generationIdentity(state: RunStateV1): string {
  return `${state.prompts.length}:${state.prompts.at(-1)?.startedAt ?? state.startedAt}`;
}

function isUnresolvedTerminal(status: RunStateV1['status']): boolean {
  return status === 'success'
    || status === 'partial'
    || status === 'error'
    || status === 'cancelled'
    || status === 'merge_conflict';
}

function journalObservation(record: ToolJournalRecord): JitNudgeCurrentCall {
  return {
    tsMs: parseTimestamp(record.ts),
    tool: record.tool,
    ...(record.run_id ? { runId: record.run_id } : {}),
    waitBearing: isWaitingWaitParams(record.wait_params),
  };
}

function formatRetentionDays(days: number): string {
  if (Number.isInteger(days)) return String(days);
  return days.toFixed(2).replace(/\.?0+$/, '');
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid timestamp: ${value}`);
  return parsed;
}

function readBoundedRunStates(args: {
  readonly crewHome: string;
  readonly repoRoot: string;
  readonly prioritizedRunIds: readonly string[];
}): RunStateV1[] {
  const runsPath = join(args.crewHome, 'runs');
  let directoryRunIds: string[] = [];
  try {
    directoryRunIds = readdirSync(runsPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  const runIds = [...new Set([...args.prioritizedRunIds, ...directoryRunIds])]
    .slice(0, DETECTION_MAX_RUN_STATES);
  const expectedRepo = resolve(args.repoRoot);
  return runIds.flatMap((runId) => {
    const state = readRunState(join(runsPath, runId, 'state.json'));
    if (!state) return [];
    if (state.repoRoot && resolve(state.repoRoot) !== expectedRepo) return [];
    return [state];
  });
}

function readRunState(path: string): RunStateV1 | undefined {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
  if (size > MAX_RUN_STATE_BYTES) throw new Error(`Run state exceeds detection cap: ${path}`);
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as RunStateV1;
  if (
    !parsed
    || parsed.schemaVersion !== 1
    || typeof parsed.runId !== 'string'
    || typeof parsed.status !== 'string'
    || !Array.isArray(parsed.prompts)
  ) throw new Error(`Invalid run state: ${path}`);
  return parsed;
}

function readJsonlTail<T>(
  path: string,
  maxBytes: number,
  validate: (value: unknown) => value is T,
): T[] {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.allocUnsafe(size - start);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, start + offset);
      if (count === 0) break;
      offset += count;
    }
    let raw = buffer.subarray(0, offset).toString('utf-8');
    if (start > 0) {
      const firstNewline = raw.indexOf('\n');
      raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : '';
    }
    const lines = raw.split('\n').filter((line) => line.length > 0);
    return lines.map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (!validate(parsed)) throw new Error(`Invalid JSONL record in ${path}`);
      return parsed;
    });
  } finally {
    closeSync(fd);
  }
}

function isToolJournalRecord(value: unknown): value is ToolJournalRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<ToolJournalRecord>;
  return typeof record.ts === 'string'
    && typeof record.tool === 'string'
    && typeof record.isError === 'boolean'
    && typeof record.duration_ms === 'number'
    && typeof record.clientKind === 'string'
    && typeof record.captainServeInstance === 'string'
    && !!record.args_digest
    && typeof record.args_digest === 'object';
}

function isWatchIndexRecord(value: unknown): value is WatchIndexRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<WatchIndexRecord>;
  const common = typeof record.ts === 'string'
    && Number.isFinite(Date.parse(record.ts))
    && typeof record.run_id === 'string'
    && typeof record.watcher_pid === 'number'
    && typeof record.watcher_instance === 'string';
  if (!common) return false;
  if (record.event === 'start') return true;
  return record.event === 'terminal_observed'
    && typeof record.status === 'string'
    && (record.exit_outcome === 0 || record.exit_outcome === 3)
    && (record.terminal_at === undefined
      || (typeof record.terminal_at === 'string'
        && Number.isFinite(Date.parse(record.terminal_at))));
}

function capWarnings(warnings: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const warning of warnings) {
    if (seen.has(warning)) continue;
    seen.add(warning);
    const bounded = truncateUtf8(warning, MAX_SINGLE_NUDGE_BYTES);
    const warningBytes = Buffer.byteLength(bounded, 'utf-8');
    if (out.length >= JIT_NUDGE_MAX_COUNT || bytes + warningBytes > JIT_NUDGE_MAX_BYTES) break;
    out.push(bounded);
    bytes += warningBytes;
  }
  return out;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf-8') <= maxBytes) return value;
  const suffix = '...';
  const budget = maxBytes - Buffer.byteLength(suffix, 'utf-8');
  let out = '';
  for (const character of value) {
    if (Buffer.byteLength(out + character, 'utf-8') > budget) break;
    out += character;
  }
  return out + suffix;
}

function isEnoent(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
