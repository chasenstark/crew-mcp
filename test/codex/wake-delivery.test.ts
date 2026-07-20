import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  decodeRunGenerations,
  encodeRunGenerations,
  runClaimedCodexWake,
} from '../../src/codex/wake-delivery.js';
import { CodexWakeRpcError } from '../../src/codex/app-server-bridge.js';
import { withStateLock } from '../../src/orchestrator/run-state-lock.js';

const THREAD_ID = '019f5d0f-a60c-7d53-9f35-2036d92d71ec';

describe('Codex wake delivery claims', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('allows only one concurrent watcher to deliver a run generation', async () => {
    const crewHome = await makeCrewHome(cleanup, 'run-one', 1, 'success');
    let starts = 0;
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
    const releaseGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const startTurn = async (): Promise<string> => {
      starts += 1;
      if (starts === 1) {
        signalFirstStarted();
        await releaseGate;
      }
      return 'turn-one';
    };
    const options = {
      crewHome,
      threadId: THREAD_ID,
      runIds: ['run-one'],
      runGenerations: [1],
      startTurn,
    };

    const first = runClaimedCodexWake(options);
    await firstStarted;
    const second = runClaimedCodexWake(options);
    releaseFirst();
    const results = await Promise.all([first, second]);

    expect(starts).toBe(1);
    expect(results).toContainEqual({ started: true, result: 'turn-one' });
    expect(results).toContainEqual({ started: false, reason: 'already_claimed' });
  });

  it('suppresses an old terminal watcher after continue_run advances the generation', async () => {
    const crewHome = await makeCrewHome(cleanup, 'run-stale', 2, 'running');
    let starts = 0;

    const result = await runClaimedCodexWake({
      crewHome,
      threadId: THREAD_ID,
      runIds: ['run-stale'],
      runGenerations: [1],
      startTurn: async () => { starts += 1; return 'unexpected'; },
    });

    expect(result).toEqual({ started: false, reason: 'stale_generation' });
    expect(starts).toBe(0);
  });

  it('releases the run-state lock before awaiting turn/start', async () => {
    const crewHome = await makeCrewHome(cleanup, 'run-unlocked', 1, 'success');
    const startEntered = deferred();
    const releaseStart = deferred();
    const lockAcquired = deferred();
    let acquired = false;

    const wake = runClaimedCodexWake({
      crewHome,
      threadId: THREAD_ID,
      runIds: ['run-unlocked'],
      runGenerations: [1],
      startTurn: async () => {
        startEntered.resolve();
        await releaseStart.promise;
        return 'turn-after-unlocked-mutation';
      },
    });

    await startEntered.promise;
    const concurrentMutation = withStateLock({ crewHome, runId: 'run-unlocked' }, async () => {
      acquired = true;
      lockAcquired.resolve();
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        lockAcquired.promise,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 1_000);
        }),
      ]);
      expect(acquired).toBe(true);
    } finally {
      if (timeout) clearTimeout(timeout);
      releaseStart.resolve();
    }

    await expect(concurrentMutation).resolves.toBeUndefined();
    await expect(wake).resolves.toEqual({
      started: true,
      result: 'turn-after-unlocked-mutation',
    });
  });

  it('releases a definitively rejected delivery claim so the idle race can retry', async () => {
    const crewHome = await makeCrewHome(cleanup, 'run-retry', 1, 'success');
    const options = {
      crewHome,
      threadId: THREAD_ID,
      runIds: ['run-retry'],
      runGenerations: [1],
    };

    await expect(runClaimedCodexWake({
      ...options,
      startTurn: async () => { throw new CodexWakeRpcError('turn already active', -32600); },
    })).rejects.toThrow(/turn already active/);

    await expect(runClaimedCodexWake({
      ...options,
      startTurn: async () => 'turn-after-race',
    })).resolves.toEqual({ started: true, result: 'turn-after-race' });
  });

  it('preserves an ambiguous failed-delivery claim to prevent a duplicate turn', async () => {
    const crewHome = await makeCrewHome(cleanup, 'run-timeout', 1, 'success');
    const options = {
      crewHome,
      threadId: THREAD_ID,
      runIds: ['run-timeout'],
      runGenerations: [1],
    };

    await expect(runClaimedCodexWake({
      ...options,
      startTurn: async () => { throw new Error('timed out after possible acceptance'); },
    })).rejects.toThrow(/timed out/);

    await expect(runClaimedCodexWake({
      ...options,
      startTurn: async () => 'duplicate-turn',
    })).resolves.toEqual({ started: false, reason: 'already_claimed' });
  });

  it('round-trips canonical run generation arguments', () => {
    const encoded = encodeRunGenerations([1, 2, 9]);
    expect(decodeRunGenerations(encoded)).toEqual([1, 2, 9]);
    expect(() => decodeRunGenerations('not+base64')).toThrow(/encoding/);
  });
});

async function makeCrewHome(
  cleanup: string[],
  runId: string,
  generations: number,
  status: string,
): Promise<string> {
  const crewHome = await mkdtemp(join(tmpdir(), 'crew-codex-delivery-'));
  cleanup.push(crewHome);
  const runDir = join(crewHome, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(crewHome, 'state-locks'), { recursive: true });
  writeFileSync(join(runDir, 'state.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    status,
    prompts: Array.from({ length: generations }, (_, index) => ({ turn: index + 1 })),
  }));
  return crewHome;
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
