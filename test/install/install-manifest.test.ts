/**
 * install-manifest tests — round-trip + v1→v2 migration.
 *
 * Each test uses a tmp HOME so multiple runs don't collide. Cleans up
 * after itself so the developer's real ~/.crew is never touched.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  manifestPath,
  readInstallManifest,
  recordInstalledTarget,
  removeInstalledTarget,
  writeInstallManifest,
  type InstalledTarget,
} from '../../src/install/install-manifest.js';

async function withTmpHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'crew-install-manifest-'));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function makeTarget(overrides: Partial<InstalledTarget> = {}): InstalledTarget {
  return {
    configPath: '/home/me/.claude.json',
    skillPath: '/home/me/.claude/skills/crew/SKILL.md',
    skills: {
      crew: '/home/me/.claude/skills/crew/SKILL.md',
      'crew:iterate': '/home/me/.claude/skills/crew-iterate/SKILL.md',
    },
    writtenPaths: [
      '/home/me/.claude/skills/crew/SKILL.md',
      '/home/me/.claude/skills/crew-iterate/SKILL.md',
    ],
    version: '0.3.0',
    installedAt: '2026-05-16T00:00:00.000Z',
    serverCommand: 'node',
    serverArgs: ['/path/dist/index.js', 'serve'],
    crewWaitCommand: '/home/me/bin/crew-wait',
    autoApproved: true,
    ...overrides,
  };
}

describe('install-manifest round-trip', () => {
  it('returns an empty manifest when the file does not exist', async () => {
    await withTmpHome(async (home) => {
      const manifest = await readInstallManifest(home);
      expect(manifest.schemaVersion).toBe(2);
      expect(manifest.targets).toEqual({});
    });
  });

  it('persists a v2 target through write+read', async () => {
    await withTmpHome(async (home) => {
      const entry = makeTarget();
      await recordInstalledTarget(home, 'claude-code', entry);
      const manifest = await readInstallManifest(home);
      expect(manifest.targets['claude-code']).toEqual(entry);
    });
  });

  it('removes a target idempotently', async () => {
    await withTmpHome(async (home) => {
      await recordInstalledTarget(home, 'claude-code', makeTarget());
      await removeInstalledTarget(home, 'claude-code');
      const after = await readInstallManifest(home);
      expect(after.targets['claude-code']).toBeUndefined();
      // Second remove is a no-op.
      await expect(removeInstalledTarget(home, 'claude-code')).resolves.toBeDefined();
    });
  });

  it('writes schemaVersion 2 to disk', async () => {
    await withTmpHome(async (home) => {
      await recordInstalledTarget(home, 'claude-code', makeTarget());
      const raw = await readFile(manifestPath(home), 'utf-8');
      const parsed = JSON.parse(raw) as { schemaVersion: number };
      expect(parsed.schemaVersion).toBe(2);
    });
  });
});

describe('install-manifest v1→v2 migration', () => {
  async function seedV1(home: string, target: Record<string, unknown>): Promise<void> {
    const dir = join(home, '.crew');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'install.json'),
      JSON.stringify({
        schemaVersion: 1,
        targets: { 'claude-code': target },
      }, null, 2),
      'utf-8',
    );
  }

  it('migrates a clean v1 entry: skillPath → skills + writtenPaths', async () => {
    await withTmpHome(async (home) => {
      await seedV1(home, {
        configPath: '/home/me/.claude.json',
        skillPath: '/home/me/.claude/skills/crew/SKILL.md',
        version: '0.2.0',
        installedAt: '2026-05-01T00:00:00.000Z',
        serverCommand: 'node',
        serverArgs: ['index.js'],
      });
      const manifest = await readInstallManifest(home);
      const t = manifest.targets['claude-code']!;
      expect(t.skillPath).toBe('/home/me/.claude/skills/crew/SKILL.md');
      expect(t.skills).toEqual({
        crew: '/home/me/.claude/skills/crew/SKILL.md',
      });
      expect(t.writtenPaths).toEqual([
        '/home/me/.claude/skills/crew/SKILL.md',
      ]);
      expect(t.crewWaitCommand).toBe('crew-wait');
    });
  });

  it('preserves autoApproved when migrating from v1', async () => {
    await withTmpHome(async (home) => {
      await seedV1(home, {
        configPath: '/home/me/.claude.json',
        skillPath: '/home/me/.claude/skills/crew/SKILL.md',
        version: '0.2.0',
        installedAt: '2026-05-01T00:00:00.000Z',
        serverCommand: 'node',
        serverArgs: [],
        autoApproved: true,
      });
      const manifest = await readInstallManifest(home);
      expect(manifest.targets['claude-code']?.autoApproved).toBe(true);
      expect(manifest.targets['claude-code']?.crewWaitCommand).toBe('crew-wait');
    });
  });

  it('tolerates v1 with missing skillPath (empty skills map; empty writtenPaths)', async () => {
    await withTmpHome(async (home) => {
      await seedV1(home, {
        configPath: '/home/me/.claude.json',
        version: '0.2.0',
        installedAt: '2026-05-01T00:00:00.000Z',
        serverCommand: 'node',
        serverArgs: [],
      });
      const manifest = await readInstallManifest(home);
      const t = manifest.targets['claude-code']!;
      expect(t.skills).toEqual({});
      expect(t.writtenPaths).toEqual([]);
    });
  });

  it('throws on a schemaVersion newer than the reader supports', async () => {
    await withTmpHome(async (home) => {
      const dir = join(home, '.crew');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'install.json'),
        JSON.stringify({ schemaVersion: 99, targets: {} }),
        'utf-8',
      );
      await expect(readInstallManifest(home)).rejects.toThrow(/newer than this crew-mcp/);
    });
  });

  it('writes v2 on disk after migrating in memory (forward-only via writeInstallManifest)', async () => {
    await withTmpHome(async (home) => {
      await seedV1(home, {
        configPath: '/home/me/.claude.json',
        skillPath: '/home/me/.claude/skills/crew/SKILL.md',
        version: '0.2.0',
        installedAt: '2026-05-01T00:00:00.000Z',
        serverCommand: 'node',
        serverArgs: [],
      });
      const manifest = await readInstallManifest(home);
      await writeInstallManifest(home, manifest);
      const raw = await readFile(manifestPath(home), 'utf-8');
      const parsed = JSON.parse(raw) as { schemaVersion: number; targets: Record<string, unknown> };
      expect(parsed.schemaVersion).toBe(2);
      const t = parsed.targets['claude-code'] as Record<string, unknown>;
      expect(t.skills).toEqual({
        crew: '/home/me/.claude/skills/crew/SKILL.md',
      });
      expect(t.writtenPaths).toEqual([
        '/home/me/.claude/skills/crew/SKILL.md',
      ]);
    });
  });
});

describe('install-manifest unknown-host rejection (plan §migration-cases)', () => {
  it('rejects a v2 manifest with an unknown host id', async () => {
    await withTmpHome(async (home) => {
      const dir = join(home, '.crew');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'install.json'),
        JSON.stringify({
          schemaVersion: 2,
          targets: {
            'mystery-cli': {
              configPath: '/x',
              skillPath: '/y',
              skills: { crew: '/y' },
              writtenPaths: ['/y'],
              version: '0',
              installedAt: 'now',
              serverCommand: 'node',
              serverArgs: [],
            },
          },
        }),
        'utf-8',
      );
      await expect(readInstallManifest(home)).rejects.toThrow(/unknown host "mystery-cli"/);
    });
  });

  it('rejects a v1 manifest with an unknown host id', async () => {
    await withTmpHome(async (home) => {
      const dir = join(home, '.crew');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'install.json'),
        JSON.stringify({
          schemaVersion: 1,
          targets: {
            'mystery-cli': {
              configPath: '/x',
              skillPath: '/y',
              version: '0',
              installedAt: 'now',
              serverCommand: 'node',
              serverArgs: [],
            },
          },
        }),
        'utf-8',
      );
      await expect(readInstallManifest(home)).rejects.toThrow(/v1.*unknown host "mystery-cli"/);
    });
  });
});

describe('install-manifest top-level extras preservation (plan §migration-cases)', () => {
  it('preserves hand-edited top-level keys through read+write', async () => {
    await withTmpHome(async (home) => {
      const dir = join(home, '.crew');
      await mkdir(dir, { recursive: true });
      const initial = {
        schemaVersion: 2,
        targets: {},
        _userNote: 'this is a hand-edited annotation',
        customTool: { lastChecked: '2026-05-01' },
      };
      await writeFile(join(dir, 'install.json'), JSON.stringify(initial, null, 2), 'utf-8');

      // Round-trip: read, mutate targets, write back.
      const manifest = await readInstallManifest(home);
      expect(manifest._extras).toEqual({
        _userNote: 'this is a hand-edited annotation',
        customTool: { lastChecked: '2026-05-01' },
      });
      await recordInstalledTarget(home, 'claude-code', makeTarget());

      // Read raw JSON — the extras should still be on disk.
      const raw = JSON.parse(await readFile(manifestPath(home), 'utf-8')) as Record<string, unknown>;
      expect(raw._userNote).toBe('this is a hand-edited annotation');
      expect(raw.customTool).toEqual({ lastChecked: '2026-05-01' });
      // Plus our managed keys are still authoritative.
      expect(raw.schemaVersion).toBe(2);
      expect((raw.targets as Record<string, unknown>)['claude-code']).toBeDefined();
    });
  });

  it('does NOT let extras shadow managed keys (writer wins on collision)', async () => {
    await withTmpHome(async (home) => {
      const dir = join(home, '.crew');
      await mkdir(dir, { recursive: true });
      // Pathological: user wrote a bogus `schemaVersion` AS an extra.
      // The writer must overwrite it with the canonical value, not
      // round-trip the bogus one.
      const initial = {
        schemaVersion: 2,
        targets: {},
        // No way for the reader to receive `schemaVersion` as an
        // extra because it's filtered into the known set; this test
        // documents the writer's collision behavior. Inject a fake
        // _extras blob via recordInstalledTarget's internal path:
      };
      await writeFile(join(dir, 'install.json'), JSON.stringify(initial, null, 2), 'utf-8');
      // Manually craft a manifest with extras that include a colliding key.
      await writeInstallManifest(home, {
        schemaVersion: 2,
        targets: {},
        _extras: { schemaVersion: 999, targets: { hacked: true } as unknown as never },
      });
      const raw = JSON.parse(await readFile(manifestPath(home), 'utf-8')) as Record<string, unknown>;
      expect(raw.schemaVersion).toBe(2);
      expect(raw.targets).toEqual({});
    });
  });
});

describe('install-manifest v2 read defensiveness', () => {
  it('synthesizes skills["crew"] from a hand-edited skillPath if skills is missing', async () => {
    await withTmpHome(async (home) => {
      const dir = join(home, '.crew');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'install.json'),
        JSON.stringify({
          schemaVersion: 2,
          targets: {
            'claude-code': {
              configPath: '/home/me/.claude.json',
              skillPath: '/home/me/.claude/skills/crew/SKILL.md',
              version: '0.3.0',
              installedAt: 'now',
              serverCommand: 'node',
              serverArgs: [],
            },
          },
        }),
        'utf-8',
      );
      const manifest = await readInstallManifest(home);
      const t = manifest.targets['claude-code']!;
      expect(t.skills.crew).toBe('/home/me/.claude/skills/crew/SKILL.md');
      // writtenPaths fallback seeds from skills values.
      expect(t.writtenPaths).toContain('/home/me/.claude/skills/crew/SKILL.md');
    });
  });
});
