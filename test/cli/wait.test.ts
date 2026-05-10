import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { main, usage, waitForRunTerminal } from '../../src/cli/wait.js';

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
});
