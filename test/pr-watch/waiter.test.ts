import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { sha256Canonical } from '../../src/pr-watch/canonical.js';
import { makePrWatchId, makePrWatchTransactionId } from '../../src/pr-watch/id.js';
import { createInitialPrWatchState, transitionToBlocked } from '../../src/pr-watch/reducer.js';
import { PrWatchStore } from '../../src/pr-watch/store.js';
import { waitForPrWatch } from '../../src/pr-watch/waiter.js';
import type { PrWatchController } from '../../src/pr-watch/controller.js';

describe('PR-watch waiter wake delivery', () => {
  it('does not mark a remedy delivered when the wake transport skips turn start', async () => {
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-pr-watch-waiter-'));
    try {
      const store = new PrWatchStore(crewHome);
      const watchId = makePrWatchId();
      const initial = createInitialPrWatchState({
        watchId,
        initialization: {
          repository: 'example/repo',
          anchorPrNumber: 42,
          repoRoot: '/tmp/example',
          effectiveConfig: {
            maxPrs: 50,
            maxActionableWakes: 20,
            maxActionRounds: 5,
            maxWatchAgeDays: -1,
            policyHash: sha256Canonical({ mode: 'github_rules' }),
          },
          expectedHeads: { '42': 'abc123' },
        },
      });
      await store.create(initial, makePrWatchTransactionId());
      const controller = {
        pollOnce: async () => {
          const blocked = await store.mutate(watchId, (state) => transitionToBlocked(state, {
            blocker: {
              causeId: 'provider-auth',
              version: 1,
              kind: 'provider_auth',
              class: 'revalidate',
              message: 'authenticate gh',
              evidence: {},
              allowedConsumingReasons: ['blocked_resolved'],
            },
          }));
          return { state: blocked.state, queried: true };
        },
      } as PrWatchController;
      await waitForPrWatch({
        store,
        controller,
        watchId,
        generation: initial.generation,
        watcherActionId: initial.waiter.watcherActionId,
        pollIntervalMs: 1,
        leaseMs: 60_000,
        wake: async () => ({ started: false }),
      });
      const state = store.read(watchId).state;
      if (state.status !== 'blocked') throw new Error('expected blocked state');
      const surface = state.blockerSurfaces.find(
        (candidate) => candidate.surfaceId === state.currentBlockerSurfaceId,
      );
      expect(surface?.state).toBe('claimed');
      expect(surface?.deliveredAt).toBeUndefined();
    } finally {
      rmSync(crewHome, { recursive: true, force: true });
    }
  });

  it('does not mark a remedy delivered when no wake transport is configured', async () => {
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-pr-watch-waiter-'));
    try {
      const store = new PrWatchStore(crewHome);
      const watchId = makePrWatchId();
      const initial = createInitialPrWatchState({
        watchId,
        initialization: {
          repository: 'example/repo',
          anchorPrNumber: 42,
          repoRoot: '/tmp/example',
          effectiveConfig: {
            maxPrs: 50,
            maxActionableWakes: 20,
            maxActionRounds: 5,
            maxWatchAgeDays: -1,
            policyHash: sha256Canonical({ mode: 'github_rules' }),
          },
          expectedHeads: { '42': 'abc123' },
        },
      });
      await store.create(initial, makePrWatchTransactionId());
      const controller = {
        pollOnce: async () => {
          const blocked = await store.mutate(watchId, (state) => transitionToBlocked(state, {
            blocker: {
              causeId: 'provider-auth',
              version: 1,
              kind: 'provider_auth',
              class: 'revalidate',
              message: 'authenticate gh',
              evidence: {},
              allowedConsumingReasons: ['blocked_resolved'],
            },
          }));
          return { state: blocked.state, queried: true };
        },
      } as PrWatchController;
      await waitForPrWatch({
        store,
        controller,
        watchId,
        generation: initial.generation,
        watcherActionId: initial.waiter.watcherActionId,
        pollIntervalMs: 1,
        leaseMs: 60_000,
      });
      const state = store.read(watchId).state;
      if (state.status !== 'blocked') throw new Error('expected blocked state');
      const surface = state.blockerSurfaces.find(
        (candidate) => candidate.surfaceId === state.currentBlockerSurfaceId,
      );
      expect(surface?.state).toBe('claimed');
      expect(surface?.deliveredAt).toBeUndefined();
    } finally {
      rmSync(crewHome, { recursive: true, force: true });
    }
  });
});
