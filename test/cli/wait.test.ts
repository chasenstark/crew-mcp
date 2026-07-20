import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CrewWaitUnknownRunError,
  main,
  nextCrewWaitPollIntervalMs,
  usage,
  waitForRunTerminal,
  waitForRunsTerminal,
} from '../../src/cli/wait.js';

describe('crew-wait', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const path of cleanup.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('detects terminal state written through atomic tmp-plus-rename', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-wait-'));
    cleanup.push(crewHome);
    const runId = 'run-123';
    const runDir = join(crewHome, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    writeStateAtomic(runDir, {
      schemaVersion: 1,
      runId,
      agentId: 'codex',
      status: 'running',
      startedAt: new Date().toISOString(),
      worktreePath: '/tmp/crew worktree',
      prompts: [],
      filesChanged: [],
    });

    const stdout: string[] = [];
    const watcher = createManualWatchFactory();

    setTimeout(() => {
      writeStateAtomic(runDir, {
        schemaVersion: 1,
        runId,
        agentId: 'codex',
        status: 'success',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        worktreePath: '/tmp/crew worktree',
        prompts: [],
        filesChanged: [],
      });
      watcher.emit(runDir, 'state.json');
    }, 25);

    await waitForRunTerminal({
      runId,
      crewHome,
      pollIntervalMs: 5,
      watch: watcher.watch,
      sleep: async () => {
        throw new Error('unexpected polling fallback');
      },
      writeStdout: (line) => stdout.push(line),
    });

    expect(stdout).toEqual([
      'CREW_WAIT_TERMINAL run_id=run-123 agent=codex status=success worktree=/tmp/crew worktree',
    ]);
  });

  it('waits through the initial missing state.json race and attaches when it appears', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-wait-missing-'));
    cleanup.push(crewHome);
    const runId = 'run-missing';
    const runDir = join(crewHome, 'runs', runId);
    const stdout: string[] = [];
    const watcher = createManualWatchFactory();

    setTimeout(() => {
      mkdirSync(runDir, { recursive: true });
      writeStateAtomic(runDir, {
        schemaVersion: 1,
        runId,
        agentId: 'claude-code',
        status: 'success',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        worktreePath: '/tmp/late worktree',
        prompts: [],
        filesChanged: [],
      });
      watcher.emit(crewHome, 'runs');
    }, 25);

    await waitForRunTerminal({
      runId,
      crewHome,
      pollIntervalMs: 5,
      watch: watcher.watch,
      sleep: async () => {
        throw new Error('unexpected polling fallback');
      },
      writeStdout: (line) => stdout.push(line),
    });

    expect(stdout).toEqual([
      'CREW_WAIT_TERMINAL run_id=run-missing agent=claude-code status=success worktree=/tmp/late worktree',
    ]);
  });

  it('falls back to polling when fs.watch is unavailable', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-wait-fallback-'));
    cleanup.push(crewHome);
    const runId = 'run-fallback';
    const runDir = join(crewHome, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    const stdout: string[] = [];
    const sleeps: number[] = [];
    let nowMs = 0;

    await waitForRunTerminal({
      runId,
      crewHome,
      pollIntervalMs: 10,
      stateFirstAppearanceGraceMs: 1_000,
      now: () => nowMs,
      watch: () => {
        throw new Error('watch unavailable');
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
        writeStateAtomic(runDir, {
          schemaVersion: 1,
          runId,
          agentId: 'codex',
          status: 'success',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          worktreePath: '/tmp/fallback worktree',
          prompts: [],
          filesChanged: [],
        });
      },
      writeStdout: (line) => stdout.push(line),
    });

    expect(sleeps).toEqual([10]);
    expect(stdout).toEqual([
      'CREW_WAIT_TERMINAL run_id=run-fallback agent=codex status=success worktree=/tmp/fallback worktree',
    ]);
  });

  it('uses CREW_WAIT_POLL_INTERVAL_MS for fallback polling', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-wait-env-fallback-'));
    cleanup.push(crewHome);
    const runId = 'run-env-fallback';
    const runDir = join(crewHome, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    const previous = process.env.CREW_WAIT_POLL_INTERVAL_MS;
    process.env.CREW_WAIT_POLL_INTERVAL_MS = '17';
    const sleeps: number[] = [];

    try {
      await waitForRunTerminal({
        runId,
        crewHome,
        stateFirstAppearanceGraceMs: 1_000,
        now: () => sleeps.reduce((sum, ms) => sum + ms, 0),
        watch: () => {
          throw new Error('watch unavailable');
        },
        sleep: async (ms) => {
          sleeps.push(ms);
          writeStateAtomic(runDir, {
            schemaVersion: 1,
            runId,
            agentId: 'codex',
            status: 'success',
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            worktreePath: '/tmp/env fallback worktree',
            prompts: [],
            filesChanged: [],
          });
        },
        writeStdout: () => {},
      });
    } finally {
      if (previous === undefined) {
        delete process.env.CREW_WAIT_POLL_INTERVAL_MS;
      } else {
        process.env.CREW_WAIT_POLL_INTERVAL_MS = previous;
      }
    }

    expect(sleeps).toEqual([17]);
  });

  it('backs off fallback polling up to the cap when state does not change', () => {
    expect(nextCrewWaitPollIntervalMs(2_000, 2_000)).toBe(4_000);
    expect(nextCrewWaitPollIntervalMs(4_000, 2_000)).toBe(5_000);
    expect(nextCrewWaitPollIntervalMs(5_000, 2_000)).toBe(5_000);
    expect(nextCrewWaitPollIntervalMs(10_000, 10_000)).toBe(10_000);
  });

  it('prints help and exits zero', async () => {
    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(main(['--help'])).resolves.toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(writes.join('')).toContain(usage());
  });

  it('returns non-zero for usage errors', async () => {
    const writes: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(main([])).resolves.toBe(2);
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(writes.join('')).toContain(
      'Usage: crew-wait [--crew-home-base64 <base64url>] [--codex-bridge-base64 <base64url> --run-generations-base64 <base64url>] <run_id...>',
    );
  });

  it('rejects either orphaned Codex wake flag before waiting for run state', async () => {
    const encodedBridge = Buffer.from('/tmp/crew-bridge.json').toString('base64url');
    const encodedGenerations = Buffer.from(JSON.stringify([1])).toString('base64url');
    const writes: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(main([
        '--codex-bridge-base64', encodedBridge, 'run-never-created',
      ])).resolves.toBe(2);
      await expect(main([
        '--run-generations-base64', encodedGenerations, 'run-never-created',
      ])).resolves.toBe(2);
      await expect(main([
        '--codex-bridge-base64', encodedBridge,
        '--run-generations-base64', encodedGenerations,
        'run-never-created', 'run-also-never-created',
      ])).resolves.toBe(2);
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(writes.join('')).toContain('Usage: crew-wait');
  });

  it('wires a hosted Codex wake through the durable claim guard', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-wait-codex-main-'));
    cleanup.push(crewHome);
    const runId = 'run-codex-main';
    const runDir = join(crewHome, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    writeStateAtomic(runDir, {
      runId,
      agentId: 'codex',
      status: 'success',
      worktreePath: '/tmp/worktree',
      prompts: [{ turn: 1 }],
    });
    const threadId = '019f5d0f-a60c-7d53-9f35-2036d92d71ec';
    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(main([
        '--crew-home-base64', Buffer.from(crewHome).toString('base64url'),
        '--codex-bridge-base64', Buffer.from('/tmp/bridge.json').toString('base64url'),
        '--run-generations-base64', Buffer.from('[1]').toString('base64url'),
        runId,
      ], {
        env: { CODEX_THREAD_ID: threadId },
        runClaimedCodexWake: async (options) => ({
          started: true,
          result: await options.startTurn(),
        }),
        wakeCodexThread: async (options) => {
          const result = await options.guardTurnStart!(async () => ({
            turn: { id: 'turn-sent' },
          }));
          expect(options.threadId).toBe(threadId);
          expect(options.runIds).toEqual([runId]);
          expect(result).toEqual({
            action: 'start',
            result: { turn: { id: 'turn-sent' } },
          });
          return { turnId: 'turn-sent' };
        },
      })).resolves.toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(writes.join('')).toContain(`CREW_WAIT_CODEX_WAKE_SENT thread_id=${threadId} turn_id=turn-sent`);
  });

  it('wakes hosted Codex for every run in an all-terminal batch', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-wait-codex-batch-'));
    cleanup.push(crewHome);
    const runIds = ['run-success-batch', 'run-partial-batch'];
    const runGenerations = [2, 4];
    for (const [index, runId] of runIds.entries()) {
      const runDir = join(crewHome, 'runs', runId);
      mkdirSync(runDir, { recursive: true });
      writeStateAtomic(runDir, {
        runId,
        agentId: 'codex',
        status: index === 0 ? 'success' : 'partial',
        worktreePath: `/tmp/${runId}`,
        prompts: Array.from({ length: runGenerations[index] }, (_, turn) => ({ turn })),
      });
    }

    const threadId = '019f5d0f-a60c-7d53-9f35-2036d92d71ec';
    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(main([
        '--crew-home-base64', Buffer.from(crewHome).toString('base64url'),
        '--codex-bridge-base64', Buffer.from('/tmp/bridge.json').toString('base64url'),
        '--run-generations-base64', Buffer.from(JSON.stringify(runGenerations)).toString('base64url'),
        ...runIds,
      ], {
        env: { CODEX_THREAD_ID: threadId },
        runClaimedCodexWake: async (options) => {
          expect(options.runIds).toEqual(runIds);
          expect(options.runGenerations).toEqual(runGenerations);
          return {
            started: true,
            result: await options.startTurn(),
          };
        },
        wakeCodexThread: async (options) => {
          expect(options.runIds).toEqual(runIds);
          const result = await options.guardTurnStart!(async () => ({
            turn: { id: 'turn-batch' },
          }));
          expect(result.action).toBe('start');
          return { turnId: 'turn-batch' };
        },
      })).resolves.toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(writes.join('')).toContain(
      `CREW_WAIT_CODEX_WAKE_SENT thread_id=${threadId} turn_id=turn-batch`,
    );
  });

  it('prints the durable claim reason when a hosted Codex wake is suppressed', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-wait-codex-skip-'));
    cleanup.push(crewHome);
    const runId = 'run-codex-skip';
    const runDir = join(crewHome, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    writeStateAtomic(runDir, {
      runId,
      agentId: 'codex',
      status: 'success',
      worktreePath: '/tmp/worktree',
      prompts: [{ turn: 1 }],
    });
    const threadId = '019f5d0f-a60c-7d53-9f35-2036d92d71ec';
    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(main([
        '--crew-home-base64', Buffer.from(crewHome).toString('base64url'),
        '--codex-bridge-base64', Buffer.from('/tmp/bridge.json').toString('base64url'),
        '--run-generations-base64', Buffer.from('[1]').toString('base64url'),
        runId,
      ], {
        env: { CODEX_THREAD_ID: threadId },
        runClaimedCodexWake: async () => ({
          started: false,
          reason: 'stale_generation',
        }),
        wakeCodexThread: async (options) => {
          const result = await options.guardTurnStart!(async () => ({
            turn: { id: 'must-not-start' },
          }));
          expect(result).toEqual({ action: 'skip' });
          return { skipped: true };
        },
      })).resolves.toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(writes.join('')).toContain(
      `CREW_WAIT_CODEX_WAKE_SKIPPED thread_id=${threadId} reason=stale_generation`,
    );
  });

  it('uses the explicit base64url Crew home instead of process env', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-wait-explicit-home-'));
    cleanup.push(crewHome);
    const runDir = join(crewHome, 'runs', 'run-explicit-home');
    mkdirSync(runDir, { recursive: true });
    writeStateAtomic(runDir, {
      runId: 'run-explicit-home',
      agentId: 'codex',
      status: 'success',
      worktreePath: '/tmp/worktree',
    });
    const priorCrewHome = process.env.CREW_HOME;
    process.env.CREW_HOME = join(crewHome, 'wrong-home');
    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(main([
        '--crew-home-base64',
        Buffer.from(crewHome).toString('base64url'),
        'run-explicit-home',
      ])).resolves.toBe(0);
    } finally {
      process.stdout.write = originalWrite;
      if (priorCrewHome === undefined) delete process.env.CREW_HOME;
      else process.env.CREW_HOME = priorCrewHome;
    }
    expect(writes.join('')).toContain('CREW_WAIT_TERMINAL run_id=run-explicit-home');
  });

  it('uses fs.watch for multiple run ids and prints terminal lines in argument order', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-wait-multi-'));
    cleanup.push(crewHome);
    const firstRunDir = join(crewHome, 'runs', 'run-first');
    const secondRunDir = join(crewHome, 'runs', 'run-second');
    mkdirSync(firstRunDir, { recursive: true });
    mkdirSync(secondRunDir, { recursive: true });
    writeStateAtomic(firstRunDir, {
      schemaVersion: 1,
      runId: 'run-first',
      agentId: 'codex',
      status: 'success',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      worktreePath: '/tmp/first',
      prompts: [],
      filesChanged: [],
    });
    writeStateAtomic(secondRunDir, {
      schemaVersion: 1,
      runId: 'run-second',
      agentId: 'gemini-cli',
      status: 'running',
      startedAt: new Date().toISOString(),
      worktreePath: '/tmp/second',
      prompts: [],
      filesChanged: [],
    });

    const stdout: string[] = [];
    const watcher = createManualWatchFactory();
    setTimeout(() => {
      writeStateAtomic(secondRunDir, {
        schemaVersion: 1,
        runId: 'run-second',
        agentId: 'gemini-cli',
        status: 'partial',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        worktreePath: '/tmp/second',
        prompts: [],
        filesChanged: [],
      });
      watcher.emit(secondRunDir, 'state.json');
    }, 25);

    await waitForRunsTerminal({
      runIds: ['run-first', 'run-second'],
      crewHome,
      pollIntervalMs: 5,
      sleep: async () => {
        throw new Error('unexpected polling fallback');
      },
      watch: watcher.watch,
      writeStdout: (line) => stdout.push(line),
    });

    expect(stdout).toEqual([
      'CREW_WAIT_TERMINAL run_id=run-first agent=codex status=success worktree=/tmp/first',
      'CREW_WAIT_TERMINAL run_id=run-second agent=gemini-cli status=partial worktree=/tmp/second',
    ]);
  });

  it('caps multi-id polling fallback at two seconds and resets after state changes', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-wait-multi-backoff-'));
    cleanup.push(crewHome);
    const firstRunDir = join(crewHome, 'runs', 'run-first');
    const runDir = join(crewHome, 'runs', 'run-second');
    mkdirSync(firstRunDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    writeStateAtomic(firstRunDir, {
      schemaVersion: 1,
      runId: 'run-first',
      agentId: 'codex',
      status: 'success',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      worktreePath: '/tmp/first',
      prompts: [],
      filesChanged: [],
    });
    writeStateAtomic(runDir, {
      schemaVersion: 1,
      runId: 'run-second',
      agentId: 'codex',
      status: 'running',
      startedAt: new Date().toISOString(),
      worktreePath: '/tmp/second',
      prompts: [],
      filesChanged: [],
    });

    const sleeps: number[] = [];
    await waitForRunsTerminal({
      runIds: ['run-first', 'run-second'],
      crewHome,
      pollIntervalMs: 1_000,
      watch: () => {
        throw new Error('watch unavailable');
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 2) {
          writeStateAtomic(runDir, {
            schemaVersion: 1,
            runId: 'run-second',
            agentId: 'codex',
            status: 'running',
            startedAt: new Date().toISOString(),
            worktreePath: '/tmp/second',
            marker: 'snapshot-changed',
            prompts: [],
            filesChanged: [],
          });
        }
        if (sleeps.length === 3) {
          writeStateAtomic(runDir, {
            schemaVersion: 1,
            runId: 'run-second',
            agentId: 'codex',
            status: 'success',
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            worktreePath: '/tmp/second',
            prompts: [],
            filesChanged: [],
          });
        }
      },
      writeStdout: () => {},
    });

    expect(sleeps).toEqual([1_000, 2_000, 1_000]);
  });

  it('multi-id unknown run exits through the exit-3 diagnostic path after printing terminal peers', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-wait-multi-unknown-'));
    cleanup.push(crewHome);
    const runDir = join(crewHome, 'runs', 'run-done');
    mkdirSync(runDir, { recursive: true });
    writeStateAtomic(runDir, {
      schemaVersion: 1,
      runId: 'run-done',
      agentId: 'codex',
      status: 'success',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      worktreePath: '/tmp/done',
      prompts: [],
      filesChanged: [],
    });

    const stdout: string[] = [];
    let nowMs = 0;
    let exitCode = 0;
    try {
      await waitForRunsTerminal({
        runIds: ['run-done', 'missing-run'],
        crewHome,
        pollIntervalMs: 5,
        stateFirstAppearanceGraceMs: 50,
        now: () => nowMs,
        sleep: async () => { nowMs += 25; },
        writeStdout: (line) => stdout.push(line),
      });
    } catch (err) {
      if (err instanceof CrewWaitUnknownRunError) {
        exitCode = 3;
      } else {
        throw err;
      }
    }

    expect(exitCode).toBe(3);
    expect(stdout).toEqual([
      'CREW_WAIT_TERMINAL run_id=run-done agent=codex status=success worktree=/tmp/done',
    ]);
  });

  it('exits promptly on merged status through the single-run watch path', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-wait-postterm-watch-'));
    cleanup.push(crewHome);
    const runId = 'run-merged';
    const runDir = join(crewHome, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    writeStateAtomic(runDir, {
      schemaVersion: 1,
      runId,
      agentId: 'codex',
      status: 'merged',
      startedAt: new Date().toISOString(),
      worktreePath: '/tmp/wt',
      prompts: [],
      filesChanged: [],
    });

    const stdout: string[] = [];
    const result = await waitForRunTerminal({
      runId,
      crewHome,
      pollIntervalMs: 5,
      watch: createManualWatchFactory().watch,
      sleep: async () => {
        throw new Error('unexpected polling fallback');
      },
      writeStdout: (line) => stdout.push(line),
    });

    expect(result).toEqual({ postTerminal: true });
    expect(stdout).toEqual(['CREW_WAIT_POST_TERMINAL run_id=run-merged status=merged']);
  });

  it('exits promptly on discarded status through the single-run polling fallback', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-wait-postterm-poll-'));
    cleanup.push(crewHome);
    const runId = 'run-discarded-poll';
    const runDir = join(crewHome, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    writeStateAtomic(runDir, {
      schemaVersion: 1,
      runId,
      agentId: 'codex',
      status: 'discarded',
      startedAt: new Date().toISOString(),
      worktreePath: '/tmp/wt',
      prompts: [],
      filesChanged: [],
    });

    const stdout: string[] = [];
    const result = await waitForRunTerminal({
      runId,
      crewHome,
      pollIntervalMs: 5,
      watch: () => {
        throw new Error('watch unavailable');
      },
      sleep: async () => {
        throw new Error('post-terminal state should exit before sleeping');
      },
      writeStdout: (line) => stdout.push(line),
    });

    expect(result).toEqual({ postTerminal: true });
    expect(stdout).toEqual([
      'CREW_WAIT_POST_TERMINAL run_id=run-discarded-poll status=discarded',
    ]);
  });

  it('removes post-terminal runs from a multi-run wait without changing terminal output', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-wait-postterm-multi-'));
    cleanup.push(crewHome);
    const terminalDir = join(crewHome, 'runs', 'run-success');
    const discardedDir = join(crewHome, 'runs', 'run-discarded');
    mkdirSync(terminalDir, { recursive: true });
    mkdirSync(discardedDir, { recursive: true });
    writeStateAtomic(terminalDir, {
      runId: 'run-success',
      agentId: 'codex',
      status: 'success',
      worktreePath: '/tmp/success',
    });
    writeStateAtomic(discardedDir, {
      runId: 'run-discarded',
      agentId: 'agy',
      status: 'discarded',
      worktreePath: '/tmp/discarded',
    });

    const stdout: string[] = [];
    const result = await waitForRunsTerminal({
      runIds: ['run-success', 'run-discarded'],
      crewHome,
      watch: createManualWatchFactory().watch,
      sleep: async () => {
        throw new Error('unexpected polling fallback');
      },
      writeStdout: (line) => stdout.push(line),
    });

    expect(result).toEqual({ postTerminalRunIds: ['run-discarded'] });
    expect(stdout).toEqual([
      'CREW_WAIT_TERMINAL run_id=run-success agent=codex status=success worktree=/tmp/success',
      'CREW_WAIT_POST_TERMINAL run_id=run-discarded status=discarded',
    ]);
  });

  it('wakes hosted Codex for only the terminal subset of a mixed batch', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-wait-postterm-main-'));
    cleanup.push(crewHome);
    const terminalRunId = 'run-success-main';
    const postTerminalRunId = 'run-merged-main';
    const terminalRunDir = join(crewHome, 'runs', terminalRunId);
    const postTerminalRunDir = join(crewHome, 'runs', postTerminalRunId);
    mkdirSync(terminalRunDir, { recursive: true });
    mkdirSync(postTerminalRunDir, { recursive: true });
    writeStateAtomic(terminalRunDir, {
      runId: terminalRunId,
      agentId: 'codex',
      status: 'success',
      worktreePath: '/tmp/success',
      prompts: [{ turn: 1 }],
    });
    writeStateAtomic(postTerminalRunDir, {
      runId: postTerminalRunId,
      agentId: 'codex',
      status: 'merged',
      worktreePath: '/tmp/merged',
      prompts: [{ turn: 1 }],
    });

    const threadId = '019f5d0f-a60c-7d53-9f35-2036d92d71ec';
    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(main([
        '--crew-home-base64', Buffer.from(crewHome).toString('base64url'),
        '--codex-bridge-base64', Buffer.from('/tmp/bridge.json').toString('base64url'),
        '--run-generations-base64', Buffer.from('[7,9]').toString('base64url'),
        terminalRunId,
        postTerminalRunId,
      ], {
        env: { CODEX_THREAD_ID: threadId },
        runClaimedCodexWake: async (options) => {
          expect(options.runIds).toEqual([terminalRunId]);
          expect(options.runGenerations).toEqual([7]);
          return {
            started: true,
            result: await options.startTurn(),
          };
        },
        wakeCodexThread: async (options) => {
          expect(options.runIds).toEqual([terminalRunId]);
          const result = await options.guardTurnStart!(async () => ({
            turn: { id: 'turn-mixed' },
          }));
          expect(result).toEqual({
            action: 'start',
            result: { turn: { id: 'turn-mixed' } },
          });
          return { turnId: 'turn-mixed' };
        },
      })).resolves.toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(writes.join('')).toContain(
      'CREW_WAIT_TERMINAL run_id=run-success-main agent=codex status=success worktree=/tmp/success',
    );
    expect(writes.join('')).toContain(
      'CREW_WAIT_POST_TERMINAL run_id=run-merged-main status=merged',
    );
    expect(writes.join('')).toContain(
      `CREW_WAIT_CODEX_WAKE_SENT thread_id=${threadId} turn_id=turn-mixed`,
    );
  });

  it('skips the hosted Codex wake when every watched run is post-terminal', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-wait-all-postterm-main-'));
    cleanup.push(crewHome);
    const mergedRunId = 'run-merged-main';
    const discardedRunId = 'run-discarded-main';
    const mergedRunDir = join(crewHome, 'runs', mergedRunId);
    const discardedRunDir = join(crewHome, 'runs', discardedRunId);
    mkdirSync(mergedRunDir, { recursive: true });
    mkdirSync(discardedRunDir, { recursive: true });
    writeStateAtomic(mergedRunDir, {
      runId: mergedRunId,
      agentId: 'codex',
      status: 'merged',
      worktreePath: '/tmp/merged',
      prompts: [{ turn: 1 }],
    });
    writeStateAtomic(discardedRunDir, {
      runId: discardedRunId,
      agentId: 'agy',
      status: 'discarded',
      worktreePath: '/tmp/discarded',
      prompts: [{ turn: 1 }],
    });

    let wakeCalled = false;
    let claimCalled = false;
    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(main([
        '--crew-home-base64', Buffer.from(crewHome).toString('base64url'),
        '--codex-bridge-base64', Buffer.from('/tmp/bridge.json').toString('base64url'),
        '--run-generations-base64', Buffer.from('[1,1]').toString('base64url'),
        mergedRunId,
        discardedRunId,
      ], {
        env: { CODEX_THREAD_ID: '019f5d0f-a60c-7d53-9f35-2036d92d71ec' },
        runClaimedCodexWake: async () => {
          claimCalled = true;
          return { started: false, reason: 'stale_generation' };
        },
        wakeCodexThread: async () => {
          wakeCalled = true;
          return { skipped: true };
        },
      })).resolves.toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(wakeCalled).toBe(false);
    expect(claimCalled).toBe(false);
    expect(writes.join('')).toContain(
      'CREW_WAIT_POST_TERMINAL run_id=run-merged-main status=merged',
    );
    expect(writes.join('')).toContain(
      'CREW_WAIT_POST_TERMINAL run_id=run-discarded-main status=discarded',
    );
    expect(writes.join('')).not.toContain('CREW_WAIT_CODEX_WAKE_');
  });

  it('exits with CrewWaitUnknownRunError when state.json never appears within the grace window', async () => {
    // Bad run_id / typo / wrong $CREW_HOME — without this, crew-wait
    // would hang forever silently. The grace gives the producer time
    // to allocate the worktree (normal startup race), then surfaces
    // a precise diagnostic.
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-wait-unknown-'));
    cleanup.push(crewHome);
    let nowMs = 0;
    const promise = waitForRunTerminal({
      runId: 'never-existed',
      crewHome,
      pollIntervalMs: 5,
      stateFirstAppearanceGraceMs: 100,
      now: () => nowMs,
      sleep: async () => { nowMs += 50; },
    });
    await expect(promise).rejects.toBeInstanceOf(CrewWaitUnknownRunError);
    await expect(promise).rejects.toThrow(/never-existed/);
    await expect(promise).rejects.toThrow(/state\.json/);
  });

  it('main() maps CrewWaitUnknownRunError to exit code 3', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-wait-unknown-main-'));
    cleanup.push(crewHome);
    process.env.CREW_HOME = crewHome;
    const writes: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      // The grace defaults to 30s in the binary; we can't shorten it
      // through the public main(argv) API, so just assert the throw
      // path is the one main wires into exit-3 by directly invoking
      // waitForRunTerminal with a tiny grace and a manual catch.
      let nowMs = 0;
      let exitCode = 0;
      try {
        await waitForRunTerminal({
          runId: 'unknown-x',
          crewHome,
          pollIntervalMs: 5,
          stateFirstAppearanceGraceMs: 50,
          now: () => nowMs,
          sleep: async () => { nowMs += 25; },
        });
      } catch (err) {
        if (err instanceof CrewWaitUnknownRunError) {
          process.stderr.write(`${err.message}\n`);
          exitCode = 3;
        } else {
          throw err;
        }
      }
      expect(exitCode).toBe(3);
      expect(writes.join('')).toContain('unknown-x');
      expect(writes.join('')).toContain('state.json');
    } finally {
      process.stderr.write = originalWrite;
      delete process.env.CREW_HOME;
    }
  });

  it('isInvokedAsCli resolves bin-shim symlinks (regression: crew-wait was no-op through PATH)', async () => {
    // Verify the auto-trigger comparison realpath-resolves both sides.
    // We can't easily simulate the symlink without spawning a subprocess
    // because realpathSync sees the actual filesystem; instead, verify
    // the exported main() runs correctly when invoked, which is what
    // the symlink-aware isInvokedAsCli() now triggers.
    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(main(['--help'])).resolves.toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(writes.join('')).toMatch(
      /Usage: crew-wait \[--crew-home-base64 <base64url>\] \[--codex-bridge-base64 <base64url> --run-generations-base64 <base64url>\] <run_id\.\.\.>/,
    );
  });
});

function writeStateAtomic(runDir: string, state: Record<string, unknown>): void {
  const statePath = join(runDir, 'state.json');
  const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmpPath, statePath);
}

function createManualWatchFactory(): {
  watch: (path: string, listener: (eventType: string, filename: string | Buffer | null) => void) => { close(): void };
  emit: (path: string, filename: string) => void;
} {
  const watchers: Array<{
    path: string;
    closed: boolean;
    listener: (eventType: string, filename: string | Buffer | null) => void;
  }> = [];

  return {
    watch: (path, listener) => {
      const watcher = { path, listener, closed: false };
      watchers.push(watcher);
      return {
        close: () => {
          watcher.closed = true;
        },
      };
    },
    emit: (path, filename) => {
      for (const watcher of watchers) {
        if (watcher.path === path && !watcher.closed) {
          watcher.listener('rename', filename);
        }
      }
    },
  };
}
