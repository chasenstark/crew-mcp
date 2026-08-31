import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { withStateLock } from '../orchestrator/run-state-lock.js';
import { parsePrWatchId } from '../pr-watch/id.js';
import type { PrWatchStore } from '../pr-watch/store.js';
import { CodexWakeRpcError } from './app-server-bridge.js';

const TERMINAL_STATUSES = new Set(['success', 'partial', 'error', 'cancelled']);

export interface ClaimedCodexWakeOptions<T> {
  readonly crewHome: string;
  readonly threadId: string;
  readonly runIds: readonly string[];
  readonly runGenerations: readonly number[];
  readonly startTurn: () => Promise<T>;
}

export interface ClaimedCodexCheckInWakeOptions<T> extends ClaimedCodexWakeOptions<T> {
  readonly checkInActionId: string;
}

export type ClaimedCodexWakeResult<T> =
  | { readonly started: true; readonly result: T }
  | {
    readonly started: false;
    readonly reason: 'stale_generation' | 'already_claimed';
  };

export interface ClaimedCodexPrWatchWakeOptions<T> {
  readonly store: PrWatchStore;
  readonly threadId: string;
  readonly watchId: string;
  readonly generation: number;
  readonly startTurn: () => Promise<T>;
}

export function encodeRunGenerations(generations: readonly number[]): string {
  return Buffer.from(JSON.stringify(generations), 'utf-8').toString('base64url');
}

export function decodeRunGenerations(encoded: string): readonly number[] {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('invalid Codex wake generation encoding');
  }
  const decoded = Buffer.from(encoded, 'base64url').toString('utf-8');
  if (Buffer.from(decoded, 'utf-8').toString('base64url') !== encoded) {
    throw new Error('invalid Codex wake generation encoding');
  }
  const parsed = JSON.parse(decoded) as unknown;
  if (
    !Array.isArray(parsed)
    || parsed.length === 0
    || parsed.some((generation) => !Number.isSafeInteger(generation) || generation < 1)
  ) {
    throw new Error('invalid Codex wake generations');
  }
  return parsed as number[];
}

/**
 * Revalidate a dispatch generation and claim its synthetic turn while holding
 * every affected run-state lock. This closes both races that a plain
 * thread-idle check cannot: continue_run reusing a run id after terminal, and
 * duplicate crew-wait processes trying to deliver the same event.
 *
 * The durable claim is intentionally at-most-once. If this process crashes in
 * the tiny interval after claiming but before App Server accepts turn/start,
 * next-user-turn recovery is safer than emitting a duplicate synthetic turn.
 */
export async function runClaimedCodexWake<T>(
  options: ClaimedCodexWakeOptions<T>,
): Promise<ClaimedCodexWakeResult<T>> {
  const pairs = normalizedPairs(options.runIds, options.runGenerations);
  const stateLockRoot = join(options.crewHome, 'state-locks');
  mkdirSync(stateLockRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(stateLockRoot, 0o700);

  const claim = await withRunLocks(
    options.crewHome,
    pairs.map((pair) => pair.runId),
    0,
    async () => {
      if (!generationsAreTerminal(options.crewHome, pairs)) {
        return { claimed: false, reason: 'stale_generation' } as const;
      }

      const ownerId = randomUUID();
      const claimPath = wakeClaimPath(options.crewHome, options.threadId, pairs);
      try {
        writeFileSync(claimPath, `${JSON.stringify({ ownerId, threadId: options.threadId, pairs })}\n`, {
          encoding: 'utf-8',
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
          return { claimed: false, reason: 'already_claimed' } as const;
        }
        throw error;
      }

      return { claimed: true, claimPath, ownerId } as const;
    },
  );

  if (!claim.claimed) {
    return { started: false, reason: claim.reason };
  }

  try {
    const result = await options.startTurn();
    return { started: true, result };
  } catch (error) {
    // Release only when App Server definitively rejected turn/start. A
    // timeout or transport failure is ambiguous: the server may already
    // have accepted the turn, so preserving the claim prevents a duplicate
    // synthetic turn at the cost of next-user-turn recovery.
    if (error instanceof CodexWakeRpcError) {
      removeOwnedClaim(claim.claimPath, claim.ownerId);
    }
    throw error;
  }
}

/**
 * Claim one periodic check-in for an exact run generation. Unlike terminal
 * wakes, a check-in is valid while the run is still active; a terminal race
 * after the timer fires is also valid because the captain will read the fresh
 * status before deciding what to do next.
 */
export async function runClaimedCodexCheckInWake<T>(
  options: ClaimedCodexCheckInWakeOptions<T>,
): Promise<ClaimedCodexWakeResult<T>> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(options.checkInActionId)) {
    throw new Error('Invalid Codex check-in action id');
  }
  const pairs = normalizedPairs(options.runIds, options.runGenerations);
  const stateLockRoot = join(options.crewHome, 'state-locks');
  mkdirSync(stateLockRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(stateLockRoot, 0o700);

  const claim = await withRunLocks(
    options.crewHome,
    pairs.map((pair) => pair.runId),
    0,
    async () => {
      if (!generationsMatch(options.crewHome, pairs)) {
        return { claimed: false, reason: 'stale_generation' } as const;
      }

      const ownerId = randomUUID();
      const claimPath = checkInWakeClaimPath(
        options.crewHome,
        options.threadId,
        pairs,
        options.checkInActionId,
      );
      try {
        writeFileSync(
          claimPath,
          `${JSON.stringify({
            ownerId,
            threadId: options.threadId,
            pairs,
            checkInActionId: options.checkInActionId,
          })}\n`,
          { encoding: 'utf-8', flag: 'wx', mode: 0o600 },
        );
      } catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
          return { claimed: false, reason: 'already_claimed' } as const;
        }
        throw error;
      }

      return { claimed: true, claimPath, ownerId } as const;
    },
  );

  if (!claim.claimed) return { started: false, reason: claim.reason };
  try {
    return { started: true, result: await options.startTurn() };
  } catch (error) {
    if (error instanceof CodexWakeRpcError) {
      removeOwnedClaim(claim.claimPath, claim.ownerId);
    }
    throw error;
  }
}

/** Claim one repeatable PR-watch generation without changing the run-wake byte contract. */
export async function runClaimedCodexPrWatchWake<T>(
  options: ClaimedCodexPrWatchWakeOptions<T>,
): Promise<ClaimedCodexWakeResult<T>> {
  const watchId = parsePrWatchId(options.watchId);
  if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
    throw new Error('Invalid Codex PR-watch generation');
  }
  const claim = await options.store.withWatchLock(watchId, async () => {
    const state = options.store.read(watchId).state;
    if (
      state.generation !== options.generation
      || state.status === 'active'
    ) {
      return { claimed: false, reason: 'stale_generation' } as const;
    }
    const ownerId = randomUUID();
    const digest = createHash('sha256')
      .update(JSON.stringify({
        threadId: options.threadId,
        watchId,
        generation: options.generation,
      }))
      .digest('hex');
    const claimPath = join(options.store.watchDir(watchId), `.codex-wake-${digest}.claim`);
    try {
      writeFileSync(
        claimPath,
        `${JSON.stringify({ ownerId, threadId: options.threadId, watchId, generation: options.generation })}\n`,
        { encoding: 'utf-8', flag: 'wx', mode: 0o600 },
      );
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') {
        return { claimed: false, reason: 'already_claimed' } as const;
      }
      throw error;
    }
    return { claimed: true, claimPath, ownerId } as const;
  });
  if (!claim.claimed) return { started: false, reason: claim.reason };
  try {
    return { started: true, result: await options.startTurn() };
  } catch (error) {
    if (error instanceof CodexWakeRpcError) removeOwnedClaim(claim.claimPath, claim.ownerId);
    throw error;
  }
}

interface RunGenerationPair {
  readonly runId: string;
  readonly generation: number;
}

function normalizedPairs(
  runIds: readonly string[],
  runGenerations: readonly number[],
): readonly RunGenerationPair[] {
  if (runIds.length === 0 || runIds.length !== runGenerations.length) {
    throw new Error('Codex wake generations must match the non-empty run id list');
  }
  const pairs = runIds.map((runId, index) => {
    const generation = runGenerations[index];
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error(`Invalid Codex wake generation for ${runId}`);
    }
    return { runId, generation };
  }).sort((left, right) => left.runId.localeCompare(right.runId));
  if (new Set(pairs.map((pair) => pair.runId)).size !== pairs.length) {
    throw new Error('Codex wake run ids must be unique');
  }
  return pairs;
}

async function withRunLocks<T>(
  crewHome: string,
  runIds: readonly string[],
  index: number,
  operation: () => Promise<T>,
): Promise<T> {
  if (index >= runIds.length) return operation();
  return withStateLock({ crewHome, runId: runIds[index] }, () =>
    withRunLocks(crewHome, runIds, index + 1, operation));
}

function generationsAreTerminal(
  crewHome: string,
  pairs: readonly RunGenerationPair[],
): boolean {
  for (const pair of pairs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        readFileSync(join(crewHome, 'runs', pair.runId, 'state.json'), 'utf-8'),
      );
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const state = parsed as { status?: unknown; prompts?: unknown };
    if (
      typeof state.status !== 'string'
      || !TERMINAL_STATUSES.has(state.status)
      || !Array.isArray(state.prompts)
      || state.prompts.length !== pair.generation
    ) {
      return false;
    }
  }
  return true;
}

function generationsMatch(
  crewHome: string,
  pairs: readonly RunGenerationPair[],
): boolean {
  for (const pair of pairs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        readFileSync(join(crewHome, 'runs', pair.runId, 'state.json'), 'utf-8'),
      );
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const state = parsed as { prompts?: unknown };
    if (!Array.isArray(state.prompts) || state.prompts.length !== pair.generation) {
      return false;
    }
  }
  return true;
}

function wakeClaimPath(
  crewHome: string,
  threadId: string,
  pairs: readonly RunGenerationPair[],
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ threadId, pairs }))
    .digest('hex');
  return join(crewHome, 'runs', pairs[0].runId, `.codex-wake-${digest}.claim`);
}

function checkInWakeClaimPath(
  crewHome: string,
  threadId: string,
  pairs: readonly RunGenerationPair[],
  checkInActionId: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ threadId, pairs, checkInActionId }))
    .digest('hex');
  return join(crewHome, 'runs', pairs[0].runId, `.codex-check-in-${digest}.claim`);
}

function removeOwnedClaim(path: string, ownerId: string): void {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { ownerId?: unknown };
    if (parsed.ownerId === ownerId) unlinkSync(path);
  } catch {
    // Preserve an ambiguous claim: at-most-once delivery is safer than a
    // duplicate wake. Next-user-turn recovery remains available.
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
