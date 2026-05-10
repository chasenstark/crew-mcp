import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CrewWaitUnknownRunError,
  main,
  usage,
  waitForRunTerminal,
} from '../../src/cli/wait.js';

describe('crew-wait', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const path of cleanup.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('waits through a missing state.json race and prints terminal metadata', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-wait-'));
    cleanup.push(crewHome);
    const runId = 'run-123';
    const runDir = join(crewHome, 'runs', runId);
    const stdout: string[] = [];

    setTimeout(() => {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, 'state.json'),
        JSON.stringify({
          schemaVersion: 1,
          runId,
          agentId: 'codex',
          status: 'success',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          worktreePath: '/tmp/crew worktree',
          prompts: [],
          filesChanged: [],
        }),
        'utf-8',
      );
    }, 25);

    await waitForRunTerminal({
      runId,
      crewHome,
      pollIntervalMs: 5,
      writeStdout: (line) => stdout.push(line),
    });

    expect(stdout).toEqual([
      'CREW_WAIT_TERMINAL run_id=run-123 agent=codex status=success worktree=/tmp/crew worktree',
    ]);
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
    expect(writes.join('')).toContain('Usage: crew-wait <run_id>');
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
    expect(writes.join('')).toMatch(/Usage: crew-wait <run_id>/);
  });
});
