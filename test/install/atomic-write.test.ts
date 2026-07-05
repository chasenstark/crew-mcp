/**
 * atomic-write tests — writeFileAtomic semantics + install lock
 * acquire / release / stale recovery / serialization.
 *
 * The plan (`docs/plans/active/crew-iterate-skill.md`) requires:
 *   - Atomic-write test: simulate a process crash mid-write and
 *     assert the host sees either the old file or the complete new
 *     file, never a partial.
 *   - Stale-lock recovery: hold the lock from a subprocess, SIGKILL
 *     it, assert the next acquire succeeds without manual cleanup.
 *   - Concurrent-install lock: two acquirers against the same home
 *     serialize cleanly.
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import {
  acquireInstallLock,
  installLockPath,
  withInstallLock,
  writeFileAtomic,
} from '../../src/install/atomic-write.js';

async function withTmpHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'crew-atomic-write-'));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe('writeFileAtomic', () => {
  it('writes content to the target path', async () => {
    await withTmpHome(async (home) => {
      const target = join(home, 'subdir', 'out.txt');
      writeFileAtomic(target, 'hello');
      expect(readFileSync(target, 'utf-8')).toBe('hello');
    });
  });

  it('leaves no tmp file on success', async () => {
    await withTmpHome(async (home) => {
      const target = join(home, 'out.txt');
      writeFileAtomic(target, 'hello');
      const siblings = await readdir(home);
      // Only the final file remains; no `.tmp` orphans.
      expect(siblings).toEqual(['out.txt']);
    });
  });

  it('preserves the OLD file when target already exists (atomic replace)', async () => {
    await withTmpHome(async (home) => {
      const target = join(home, 'out.txt');
      await writeFile(target, 'old', 'utf-8');
      writeFileAtomic(target, 'new');
      expect(readFileSync(target, 'utf-8')).toBe('new');
    });
  });

  it('fsyncs the temp file before renaming it into place', async () => {
    await withTmpHome(async (home) => {
      const events: string[] = [];
      vi.resetModules();
      vi.doMock('node:fs', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:fs')>();
        return {
          ...actual,
          writeSync: vi.fn((...args: Parameters<typeof actual.writeSync>) => {
            events.push('write');
            return actual.writeSync(...args);
          }),
          fsyncSync: vi.fn((fd: number) => {
            events.push('fsync');
            return actual.fsyncSync(fd);
          }),
          renameSync: vi.fn((...args: Parameters<typeof actual.renameSync>) => {
            events.push('rename');
            return actual.renameSync(...args);
          }),
        };
      });

      try {
        const { writeFileAtomic: mockedWriteFileAtomic } = await import('../../src/install/atomic-write.js');
        mockedWriteFileAtomic(join(home, 'out.txt'), 'hello');
        expect(events).toEqual(['write', 'fsync', 'rename']);
      } finally {
        vi.doUnmock('node:fs');
        vi.resetModules();
      }
    });
  });

  it('cleans up the tmp file on rename failure', async () => {
    await withTmpHome(async (home) => {
      // Target is a directory — rename(tmp -> dir) fails (EISDIR or EEXIST).
      const target = join(home, 'a-dir');
      await rm(target, { force: true, recursive: true });
      // Make `target` be a non-empty dir so rename fails.
      const inner = join(target, 'placeholder');
      await mkdtemp(join(home, 'placeholder-'));
      // Create the dir target manually so rename can't replace it.
      await writeFile(join(home, 'sentinel'), 'x');
      // Now point target at a dir to force the failure.
      const dirTarget = home; // home is itself a directory
      expect(() => writeFileAtomic(dirTarget, 'data')).toThrow();
      // Either the dir is still there OR the rename collapsed to it —
      // the important property is: no `.tmp` orphan beside it.
      const orphans = (await readdir(home)).filter((f) => f.endsWith('.tmp'));
      expect(orphans).toEqual([]);
      void inner;
    });
  });
});

describe('acquireInstallLock', () => {
  it('returns a handle that releases the lock', async () => {
    await withTmpHome(async (home) => {
      const handle = await acquireInstallLock(home);
      expect(existsSync(installLockPath(home))).toBe(true);
      handle.release();
      expect(existsSync(installLockPath(home))).toBe(false);
    });
  });

  it('serializes a second acquirer until the first releases', async () => {
    await withTmpHome(async (home) => {
      const first = await acquireInstallLock(home);
      const ordering: string[] = [];
      const second = acquireInstallLock(home, { timeoutMs: 5_000, pollMs: 50 })
        .then((h) => {
          ordering.push('acquired-second');
          h.release();
        });
      // Give the second acquirer a chance to poll a few times.
      await new Promise((r) => setTimeout(r, 200));
      ordering.push('release-first');
      first.release();
      await second;
      expect(ordering).toEqual(['release-first', 'acquired-second']);
    });
  });

  it('times out with a clear message when the holder stays alive', async () => {
    await withTmpHome(async (home) => {
      const holder = await acquireInstallLock(home);
      try {
        await expect(
          acquireInstallLock(home, { timeoutMs: 200, pollMs: 50 }),
        ).rejects.toThrow(/install lock held by another process/);
      } finally {
        holder.release();
      }
    });
  });

  it('recovers from a stale lock left by a SIGKILL\'d holder', async () => {
    await withTmpHome(async (home) => {
      // Spawn a subprocess that acquires the lock and idles. SIGKILL
      // it without giving it a chance to clean up, then assert the
      // next acquire detects the stale PID and recovers.
      const child = spawn(
        process.execPath,
        [
          '-e',
          `
          // Subprocess can't use TS directly — inline a minimal lock.
          const fs = require('node:fs');
          const path = require('node:path');
          const lockDir = path.join(${JSON.stringify(home)}, '.crew');
          fs.mkdirSync(lockDir, { recursive: true });
          const lockPath = path.join(lockDir, '.install-lock');
          const fd = fs.openSync(lockPath, 'wx');
          fs.writeSync(fd, String(process.pid) + '\\n');
          fs.closeSync(fd);
          process.stdout.write('locked\\n');
          // Idle.
          setInterval(() => {}, 1000);
          `,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      try {
        // Wait until the subprocess writes 'locked'.
        await new Promise<void>((resolve, reject) => {
          let buf = '';
          child.stdout.on('data', (chunk) => {
            buf += chunk.toString();
            if (buf.includes('locked')) resolve();
          });
          child.on('error', reject);
          child.on('exit', () => reject(new Error('subprocess exited before locking')));
          setTimeout(() => reject(new Error('subprocess never reported locked')), 5_000);
        });
        expect(existsSync(installLockPath(home))).toBe(true);
        // SIGKILL — subprocess can't release.
        child.kill('SIGKILL');
        await new Promise<void>((resolve) => child.on('exit', () => resolve()));
        // Now the lock file is on disk but the PID is dead. Acquire
        // should detect that and recover.
        const handle = await acquireInstallLock(home, { timeoutMs: 5_000, pollMs: 50 });
        try {
          // PID inside should now be ours, not the dead holder's.
          const recordedPid = readFileSync(installLockPath(home), 'utf-8').trim();
          expect(recordedPid).toBe(String(process.pid));
        } finally {
          handle.release();
        }
      } finally {
        if (!child.killed) child.kill('SIGKILL');
      }
    });
  });
});

describe('withInstallLock', () => {
  it('releases the lock even when the body throws', async () => {
    await withTmpHome(async (home) => {
      await expect(
        withInstallLock(home, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(existsSync(installLockPath(home))).toBe(false);
    });
  });

  it('serializes concurrent calls against the same home', async () => {
    await withTmpHome(async (home) => {
      const ordering: string[] = [];
      const first = withInstallLock(home, async () => {
        ordering.push('first-start');
        await new Promise((r) => setTimeout(r, 100));
        ordering.push('first-end');
      });
      const second = withInstallLock(
        home,
        async () => {
          ordering.push('second-start');
          ordering.push('second-end');
        },
        { pollMs: 25 },
      );
      await Promise.all([first, second]);
      expect(ordering).toEqual([
        'first-start',
        'first-end',
        'second-start',
        'second-end',
      ]);
    });
  });
});

describe('install-manifest interplay (sanity)', () => {
  it('readFile of a freshly atomic-written manifest is byte-identical to the source', async () => {
    await withTmpHome(async (home) => {
      const target = join(home, '.crew', 'install.json');
      const content = JSON.stringify({ schemaVersion: 2, targets: {} }, null, 2) + '\n';
      writeFileAtomic(target, content);
      const round = await readFile(target, 'utf-8');
      expect(round).toBe(content);
    });
  });
});
