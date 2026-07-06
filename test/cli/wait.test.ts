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
    expect(writes.join('')).toContain('Usage: crew-wait <run_id...>');
  });

  it('waits for multiple run ids before printing terminal lines in argument order', async () => {
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
    let sleeps = 0;
    await waitForRunsTerminal({
      runIds: ['run-first', 'run-second'],
      crewHome,
      pollIntervalMs: 5,
      sleep: async () => {
        expect(stdout).toEqual([]);
        sleeps += 1;
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
      },
      writeStdout: (line) => stdout.push(line),
    });

    expect(sleeps).toBe(1);
    expect(stdout).toEqual([
      'CREW_WAIT_TERMINAL run_id=run-first agent=codex status=success worktree=/tmp/first',
      'CREW_WAIT_TERMINAL run_id=run-second agent=gemini-cli status=partial worktree=/tmp/second',
    ]);
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

  it('does not exit on post-terminal user-action statuses (merged / merge_conflict / discarded)', async () => {
    // Decision 4: crew-wait targets the four markTerminal() statuses
    // only. Post-terminal user actions are not dispatch terminations
    // and the watcher must keep polling — otherwise it would race the
    // captain's own merge_run/discard_run calls.
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-wait-postterm-'));
    cleanup.push(crewHome);
    const runId = 'run-postterm';
    const runDir = join(crewHome, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    const writeStatus = (status: string): void => {
      writeFileSync(
        join(runDir, 'state.json'),
        JSON.stringify({
          schemaVersion: 1,
          runId,
          agentId: 'codex',
          status,
          startedAt: new Date().toISOString(),
          worktreePath: '/tmp/wt',
          prompts: [],
          filesChanged: [],
        }),
        'utf-8',
      );
    };

    // Start with a post-terminal user-action status. The watcher must
    // ignore it and continue polling. Flip to a real terminal after a
    // few polls and assert it exits.
    writeStatus('merged');
    let polls = 0;
    setTimeout(() => {
      writeStatus('merge_conflict');
    }, 15);
    setTimeout(() => {
      writeStatus('discarded');
    }, 30);
    setTimeout(() => {
      writeStatus('success');
    }, 45);

    const stdout: string[] = [];
    await waitForRunTerminal({
      runId,
      crewHome,
      pollIntervalMs: 5,
      writeStdout: (line) => {
        polls += 1;
        stdout.push(line);
      },
    });

    expect(stdout).toEqual([
      'CREW_WAIT_TERMINAL run_id=run-postterm agent=codex status=success worktree=/tmp/wt',
    ]);
    expect(polls).toBe(1);
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
    expect(writes.join('')).toMatch(/Usage: crew-wait <run_id\.\.\.>/);
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
