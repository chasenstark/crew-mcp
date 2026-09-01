import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { main, usage } from '../../src/cli/pr-watch-wait.js';

const WATCH_ID = 'pw-0123456789abcdef0123456789abcdef';

describe('crew-pr-watch-wait CLI', () => {
  const cleanup: string[] = [];
  const restores: Array<() => void> = [];

  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('prints usage naming the unwritable exit code', async () => {
    expect(usage()).toContain('CREW_PR_WATCH_WAKE_UNWRITABLE');
  });

  it('still exits 3 for an unknown watch before probing', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-pr-watch-wait-unknown-'));
    cleanup.push(crewHome);
    const stderr = captureStream('stderr', restores);
    expect(await main([
      '--watch', WATCH_ID,
      '--generation', '1',
      '--watcher-action', 'wa-1',
      '--crew-home-base64', Buffer.from(crewHome).toString('base64url'),
    ])).toBe(3);
    expect(stderr()).toContain(`unknown watch ${WATCH_ID}`);
  });

  it('probes lease/claim writability before waiting and exits 4 from an unwritable watch dir', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-pr-watch-wait-denied-'));
    cleanup.push(crewHome);
    const watchDir = join(crewHome, 'pr-watches', WATCH_ID);
    mkdirSync(watchDir, { recursive: true });
    // Simulate the unescalated Codex sandbox: the watch state is readable
    // but the waiter lease and wake claim can never be written.
    chmodSync(watchDir, 0o555);
    restores.push(() => chmodSync(watchDir, 0o755));
    const stdout = captureStream('stdout', restores);
    const stderr = captureStream('stderr', restores);
    expect(await main([
      '--watch', WATCH_ID,
      '--generation', '1',
      '--watcher-action', 'wa-1',
      '--crew-home-base64', Buffer.from(crewHome).toString('base64url'),
    ])).toBe(4);
    expect(stdout()).toContain(
      `CREW_PR_WATCH_WAKE_UNWRITABLE watch_id=${WATCH_ID} path=${watchDir}`,
    );
    expect(stderr()).toContain('escalated permissions');
  });
});

function captureStream(
  name: 'stdout' | 'stderr',
  restores: Array<() => void>,
): () => string {
  const stream = process[name];
  const original = stream.write;
  let captured = '';
  stream.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof stream.write;
  restores.push(() => {
    stream.write = original;
  });
  return () => captured;
}
