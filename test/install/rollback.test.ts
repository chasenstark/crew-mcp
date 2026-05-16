/**
 * Phase 2 rollback test — exercises the mid-loop swap-failure path
 * inside `renderAndWriteSkills` that can't be triggered by Phase 1
 * render failures alone.
 *
 * Mocks `node:fs.renameSync` so the SECOND skill's swap call throws
 * synthetically. The expected sequence in a re-install over an
 * existing two-skill install (one host, both skills present) is:
 *
 *   1. rename crew.final         → crew.backup            (Phase 2)
 *   2. rename crew.staging       → crew.final             (Phase 2)
 *   3. rename crew-iterate.final → crew-iterate.backup    (Phase 2)
 *   4. rename crew-iterate.staging → crew-iterate.final   ← FAIL
 *   5. (inner restore)  rename crew-iterate.backup → crew-iterate.final
 *   6. (outer rollback) rename crew.backup         → crew.final
 *
 * After the failure cascade, both skills must hold their pre-install
 * content byte-for-byte and no `.crew-staging-*` / `.crew-backup-*`
 * artifacts may remain.
 *
 * Mock state is module-level so the hoisted `vi.mock` factory can
 * reach it. `failOnCall = -1` disables synthetic failures (used for
 * the seed install at the start of each test).
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let failOnCall = -1;
let callCount = 0;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (src: import('node:fs').PathLike, dst: import('node:fs').PathLike) => {
      callCount++;
      if (callCount === failOnCall) {
        throw new Error('synthetic Phase 2 swap failure');
      }
      return actual.renameSync(src, dst);
    },
  };
});

// Imports below run AFTER vi.mock hoists, so install.ts picks up the
// wrapped renameSync.
import { installCommand } from '../../src/cli/commands/install.js';
import { HOST_ADAPTERS } from '../../src/install/hosts/index.js';

const STUB_BIN = {
  command: '/usr/local/bin/node',
  args: ['/abs/path/dist/index.js', 'serve'] as const,
};

describe('renderAndWriteSkills — Phase 2 rollback', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'crew-rollback-'));
    failOnCall = -1;
    callCount = 0;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    failOnCall = -1;
  });

  it('restores prior content for BOTH skills on a swap failure mid-loop', async () => {
    const args = {
      target: 'codex' as const,
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    };

    // Seed install — both skills land with their canonical content.
    failOnCall = -1;
    await installCommand(args);
    const adapter = HOST_ADAPTERS.codex;
    const umbrellaPath = adapter.skillPath(home);
    const iteratePath = join(home, '.codex', 'skills', 'crew-iterate', 'SKILL.md');
    expect(existsSync(umbrellaPath)).toBe(true);
    expect(existsSync(iteratePath)).toBe(true);
    const umbrellaBefore = readFileSync(umbrellaPath, 'utf-8');
    const iterateBefore = readFileSync(iteratePath, 'utf-8');

    // Arm the synthetic failure for the 4th renameSync call of the
    // next install run (= the swap of skill 1 / crew-iterate).
    callCount = 0;
    failOnCall = 4;

    const result = await installCommand(args);
    expect(result.installed).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/synthetic Phase 2 swap failure/);

    // Both skills' prior content restored: the inner catch put
    // crew-iterate back from its backup; the outer ledger walked
    // crew's completed swap back from its backup.
    expect(readFileSync(umbrellaPath, 'utf-8')).toBe(umbrellaBefore);
    expect(readFileSync(iteratePath, 'utf-8')).toBe(iterateBefore);

    // No leftover staging / backup siblings.
    for (const finalPath of [umbrellaPath, iteratePath]) {
      const dir = dirname(finalPath);
      const leftovers = readdirSync(dir).filter(
        (f) => f.includes('.crew-staging-') || f.includes('.crew-backup-'),
      );
      expect(leftovers).toEqual([]);
    }
  });
});
