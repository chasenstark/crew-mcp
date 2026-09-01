import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// A macOS-sandboxed waiter receives EPERM from chmod even on directories it
// can otherwise use. The store's private-mode tighten is hygiene, not
// correctness, so construction must survive it — the waiter's writability
// probe then reports the real denial as a typed exit instead of a crash.
// Mock only chmodSync; every other fs call stays real.
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

const { PrWatchStore } = await import('../../src/pr-watch/store.js');

describe('PrWatchStore under chmod denial', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('still constructs and reads when chmod on its private roots throws', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-pr-watch-store-chmod-'));
    cleanup.push(crewHome);
    const store = new PrWatchStore(crewHome);
    expect(store.exists('pw-0123456789abcdef0123456789abcdef')).toBe(false);
    expect(store.listWatchIds()).toEqual([]);
  });
});
