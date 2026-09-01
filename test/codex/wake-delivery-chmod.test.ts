import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// A macOS-sandboxed crew-wait receives EPERM from chmod even on directories
// it can otherwise use. The state-lock permission tighten is hygiene, not
// correctness, so wake delivery must survive it (the claim write is the real
// gate). Mock only chmodSync; every other fs call stays real.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    chmodSync: () => {
      const err = new Error('EPERM: operation not permitted, chmod') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    },
  };
});

const { runClaimedCodexWake, runClaimedCodexCheckInWake } = await import(
  '../../src/codex/wake-delivery.js'
);

const THREAD_ID = '019f5d0f-a60c-7d53-9f35-2036d92d71ec';

describe('Codex wake delivery under chmod denial', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('still claims and starts a terminal wake when chmod on state-locks throws', async () => {
    const crewHome = await makeCrewHome('run-chmod-terminal', 'success');
    const result = await runClaimedCodexWake({
      crewHome,
      threadId: THREAD_ID,
      runIds: ['run-chmod-terminal'],
      runGenerations: [1],
      startTurn: async () => 'turn-started',
    });
    expect(result).toEqual({ started: true, result: 'turn-started' });
  });

  it('still claims and starts a periodic check-in when chmod on state-locks throws', async () => {
    const crewHome = await makeCrewHome('run-chmod-check-in', 'running');
    const result = await runClaimedCodexCheckInWake({
      crewHome,
      threadId: THREAD_ID,
      runIds: ['run-chmod-check-in'],
      runGenerations: [1],
      checkInActionId: 'check-in-1',
      startTurn: async () => 'check-in-started',
    });
    expect(result).toEqual({ started: true, result: 'check-in-started' });
  });

  async function makeCrewHome(runId: string, status: string): Promise<string> {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-wake-chmod-'));
    cleanup.push(crewHome);
    const runDir = join(crewHome, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'state.json'), JSON.stringify({
      runId,
      status,
      prompts: [{ turn: 1 }],
    }));
    return crewHome;
  }
});
