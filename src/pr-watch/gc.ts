import { realpathSync } from 'node:fs';

import { readConfigFile } from '../utils/config-store.js';
import { PrWatchWorktreeManager } from './action-worktree.js';
import { sha256Canonical } from './canonical.js';
import { cancelPrWatch, createInitialPrWatchState } from './reducer.js';
import { PrWatchStartIndex } from './start-index.js';
import { PrWatchStore } from './store.js';
import type { PrWatchStateV1 } from './types.js';

export const PR_WATCH_DAY_MS = 24 * 60 * 60 * 1000;

export interface PrWatchGcOutcome {
  readonly watchId: string;
  readonly status: PrWatchStateV1['status'];
  readonly ageDays: number;
  readonly reclaimed: boolean;
  readonly reason?: string;
}

export interface PrWatchGcResult {
  readonly watchesReclaimed: number;
  readonly outcomes: readonly PrWatchGcOutcome[];
}

export function resolvePrWatchTtlMs(crewHome: string): number {
  const configured = readConfigFile(crewHome).cleanup.prWatchTtlDays;
  const raw = process.env.CREW_PR_WATCH_TTL_DAYS;
  const days = raw === undefined ? configured : parsePrWatchTtlDays(raw);
  return days < 0 ? Number.POSITIVE_INFINITY : days * PR_WATCH_DAY_MS;
}

export async function gcPrWatches(args: {
  readonly crewHome: string;
  readonly repoRoot?: string;
  readonly allRepos?: boolean;
  readonly ttlMs: number;
  readonly dryRun?: boolean;
  readonly now?: number;
}): Promise<PrWatchGcResult> {
  const store = new PrWatchStore(args.crewHome);
  const startIndex = new PrWatchStartIndex(args.crewHome);
  const now = args.now ?? Date.now();
  const selectedRepo = args.allRepos || args.repoRoot === undefined
    ? undefined
    : realpathSync(args.repoRoot);
  const outcomes: PrWatchGcOutcome[] = [];

  // A crash after start-key preparation but before watch creation still owns
  // one reserved ID. Once that preparation ages past retention, complete the
  // same ID as cancelled before ordinary closed-watch GC reclaims it. This
  // preserves the prepared -> committed -> reclaimed proof chain instead of
  // silently deleting or reallocating the reservation.
  if (Number.isFinite(args.ttlMs)) {
    for (const startKeyDigest of startIndex.listStartKeyDigests()) {
      let prepared;
      try {
        prepared = startIndex.read(startKeyDigest);
      } catch {
        continue;
      }
      if (
        prepared?.status !== 'prepared'
        || prepared.initialization === undefined
        || (selectedRepo !== undefined && prepared.repoRoot !== selectedRepo)
        || now - Date.parse(prepared.preparedAt) < args.ttlMs
      ) continue;
      if (args.dryRun) {
        if (store.exists(prepared.watchId)) continue;
        outcomes.push({
          watchId: prepared.watchId,
          status: 'cancelled',
          ageDays: Math.floor((now - Date.parse(prepared.preparedAt)) / PR_WATCH_DAY_MS),
          reclaimed: true,
          reason: 'aged_prepared_start',
        });
        continue;
      }
      await startIndex.withLock(startKeyDigest, async () => {
        const current = startIndex.read(startKeyDigest);
        if (
          current?.status !== 'prepared'
          || current.initialization === undefined
          || (selectedRepo !== undefined && current.repoRoot !== selectedRepo)
          || now - Date.parse(current.preparedAt) < args.ttlMs
        ) return;
        await store.withWatchLock(current.watchId, async () => {
          if (!store.exists(current.watchId)) {
            const initialized = createInitialPrWatchState({
              watchId: current.watchId,
              initialization: current.initialization!,
              reverseStartKeyDigest: startKeyDigest,
              now: new Date(current.preparedAt),
            });
            const cancelled = cancelPrWatch(initialized, new Date(current.preparedAt)).state;
            await store.create(
              cancelled,
              sha256Canonical({ kind: 'aged_prepared_start_gc', startKeyDigest }),
            );
          } else {
            const existing = store.read(current.watchId).state;
            if (
              existing.reverseStartKeyDigest !== startKeyDigest
              || existing.repoRoot !== current.repoRoot
              || existing.repository !== current.initialization.repository
              || existing.anchorPrNumber !== current.initialization.anchorPrNumber
            ) {
              throw new Error('pr_watch.aged_prepared_start_mismatch');
            }
          }
          startIndex.markCommittedLocked(startKeyDigest, current.watchId, new Date(now));
        });
      });
    }
  }

  for (const watchId of store.listWatchIds()) {
    let state: PrWatchStateV1;
    try {
      state = store.read(watchId).state;
    } catch (error) {
      outcomes.push({
        watchId,
        status: 'blocked',
        ageDays: 0,
        reclaimed: false,
        reason: `corrupt: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (selectedRepo !== undefined && state.repoRoot !== selectedRepo) continue;
    if (state.status !== 'terminal' && state.status !== 'cancelled') {
      outcomes.push({
        watchId,
        status: state.status,
        ageDays: 0,
        reclaimed: false,
        reason: 'nonterminal',
      });
      continue;
    }
    const closedAt = state.status === 'terminal' ? state.terminalAt : state.cancelledAt;
    const ageMs = Math.max(0, now - Date.parse(closedAt));
    const ageDays = Math.floor(ageMs / PR_WATCH_DAY_MS);
    if (!Number.isFinite(args.ttlMs) || ageMs < args.ttlMs) {
      outcomes.push({ watchId, status: state.status, ageDays, reclaimed: false, reason: 'retained' });
      continue;
    }
    if (args.dryRun) {
      outcomes.push({ watchId, status: state.status, ageDays, reclaimed: true });
      continue;
    }

    const predicate = (current: PrWatchStateV1): boolean => {
      if (current.status !== 'terminal' && current.status !== 'cancelled') return false;
      const currentClosedAt = current.status === 'terminal' ? current.terminalAt : current.cancelledAt;
      return now - Date.parse(currentClosedAt) >= args.ttlMs;
    };
    try {
      if (state.worktreeLease !== undefined || state.preparedWorktreeLease !== undefined) {
        const manager = new PrWatchWorktreeManager(args.crewHome, state.repoRoot);
        await manager.withHostMutationExclusion(async (signal) => store.withWatchLock(
          watchId,
          async () => {
            if (!store.exists(watchId)) return;
            const current = store.read(watchId).state;
            if (!predicate(current)) return;
            await manager.removeLeaseInsideHostLock(current, signal);
          },
        ));
      }
      let reclaimed = false;
      if (state.reverseStartKeyDigest !== undefined) {
        reclaimed = await startIndex.withLock(state.reverseStartKeyDigest, async () => {
          const index = startIndex.read(state.reverseStartKeyDigest!);
          if (
            !index
            || index.watchId !== watchId
            || (index.status !== 'committed' && index.status !== 'reclaimed')
          ) {
            throw new Error('pr_watch.gc_start_index_mismatch');
          }
          return store.withWatchLock(watchId, async () => {
            if (!store.exists(watchId)) {
              if (index.status === 'reclaimed') {
                startIndex.removeReclaimedLocked(state.reverseStartKeyDigest!, watchId);
                return true;
              }
              throw new Error('pr_watch.gc_committed_watch_missing');
            }
            if (!predicate(store.read(watchId).state)) return false;
            startIndex.markReclaimedLocked(state.reverseStartKeyDigest!, watchId, new Date(now));
            const removed = store.removeClosedWatchLocked(watchId, predicate);
            if (removed) startIndex.removeReclaimedLocked(state.reverseStartKeyDigest!, watchId);
            return removed;
          });
        });
      } else {
        reclaimed = await store.removeClosedWatch(watchId, predicate);
      }
      outcomes.push({ watchId, status: state.status, ageDays, reclaimed });
    } catch (error) {
      outcomes.push({
        watchId,
        status: state.status,
        ageDays,
        reclaimed: false,
        reason: `cleanup_failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return {
    watchesReclaimed: outcomes.filter((outcome) => outcome.reclaimed).length,
    outcomes,
  };
}

function parsePrWatchTtlDays(raw: string): number {
  if (!/^(?:-1|0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`CREW_PR_WATCH_TTL_DAYS must be an integer >= -1 (got "${raw}")`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`CREW_PR_WATCH_TTL_DAYS must be a safe integer (got "${raw}")`);
  }
  return value;
}
