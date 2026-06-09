import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  absolutizeProjectTarget,
  projectManifestPath,
  readProjectInstallManifest,
  recordProjectInstalledTarget,
  relativizeProjectTarget,
  removeProjectInstalledTarget,
  writeProjectInstallManifest,
  type ProjectInstalledTarget,
} from '../../src/install/project-install-manifest.js';

async function withTmpRepo<T>(fn: (repoRoot: string) => Promise<T>): Promise<T> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'crew-project-manifest-'));
  try {
    return await fn(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

function makeProjectTarget(repoRoot: string): ProjectInstalledTarget {
  return {
    configPath: join(repoRoot, '.codex', 'config.toml'),
    skillPath: join(repoRoot, '.codex', 'skills', 'crew', 'SKILL.md'),
    skills: {
      crew: join(repoRoot, '.codex', 'skills', 'crew', 'SKILL.md'),
      'crew:iterate': join(repoRoot, '.codex', 'skills', 'crew-iterate', 'SKILL.md'),
    },
    writtenPaths: [
      join(repoRoot, '.codex', 'config.toml'),
      join(repoRoot, '.codex', 'skills', 'crew', 'SKILL.md'),
      join(repoRoot, '.codex', 'skills', 'crew-iterate', 'SKILL.md'),
    ],
    version: '0.2.0-dev',
    installedAt: '2026-06-07T00:00:00.000Z',
    serverCommand: './node_modules/.bin/crew-mcp',
    serverArgs: ['serve'],
    crewWaitCommand: './node_modules/.bin/crew-wait',
    autoApproved: true,
  };
}

describe('project install manifest', () => {
  it('returns an empty project manifest when absent', async () => {
    await withTmpRepo(async (repoRoot) => {
      const manifest = await readProjectInstallManifest(repoRoot);
      expect(manifest).toEqual({
        schemaVersion: 1,
        scope: 'project',
        targets: {},
      });
    });
  });

  it('stores paths repo-relative and resolves them back to absolute paths', async () => {
    await withTmpRepo(async (repoRoot) => {
      const relative = relativizeProjectTarget(repoRoot, makeProjectTarget(repoRoot));
      await recordProjectInstalledTarget(repoRoot, 'codex', relative);

      const raw = JSON.parse(await readFile(projectManifestPath(repoRoot), 'utf-8')) as {
        targets: Record<string, { configPath: string; writtenPaths: string[] }>;
      };
      expect(raw.targets.codex.configPath).toBe('.codex/config.toml');
      expect(raw.targets.codex.writtenPaths).toContain('.codex/config.toml');
      expect(JSON.stringify(raw.targets.codex)).toContain('./node_modules/.bin/crew-wait');
      expect(JSON.stringify(raw)).not.toContain(repoRoot);

      const read = await readProjectInstallManifest(repoRoot);
      const absolute = absolutizeProjectTarget(repoRoot, read.targets.codex!);
      expect(absolute.configPath).toBe(
        join(repoRoot, '.codex', 'config.toml'),
      );
      expect(absolute.crewWaitCommand).toBe('./node_modules/.bin/crew-wait');
    });
  });

  it('removes a target idempotently', async () => {
    await withTmpRepo(async (repoRoot) => {
      await recordProjectInstalledTarget(
        repoRoot,
        'codex',
        relativizeProjectTarget(repoRoot, makeProjectTarget(repoRoot)),
      );
      await removeProjectInstalledTarget(repoRoot, 'codex');
      expect((await readProjectInstallManifest(repoRoot)).targets.codex).toBeUndefined();
      await expect(removeProjectInstalledTarget(repoRoot, 'codex')).resolves.toBeDefined();
    });
  });

  it('preserves unknown top-level extras through writes', async () => {
    await withTmpRepo(async (repoRoot) => {
      await mkdir(join(repoRoot, '.crew'), { recursive: true });
      await writeFile(
        projectManifestPath(repoRoot),
        JSON.stringify({
          schemaVersion: 1,
          scope: 'project',
          targets: {},
          note: 'keep me',
        }, null, 2),
        'utf-8',
      );

      const manifest = await readProjectInstallManifest(repoRoot);
      await writeProjectInstallManifest(repoRoot, manifest);
      const raw = JSON.parse(await readFile(projectManifestPath(repoRoot), 'utf-8')) as {
        note?: string;
      };
      expect(raw.note).toBe('keep me');
    });
  });

  it('rejects unknown project target ids', async () => {
    await withTmpRepo(async (repoRoot) => {
      await mkdir(join(repoRoot, '.crew'), { recursive: true });
      await writeFile(
        projectManifestPath(repoRoot),
        JSON.stringify({
          schemaVersion: 1,
          scope: 'project',
          targets: {
            cursor: {
              configPath: '.cursor/mcp.json',
              skillPath: '',
              skills: {},
              writtenPaths: [],
            },
          },
        }),
        'utf-8',
      );

      await expect(readProjectInstallManifest(repoRoot)).rejects.toThrow(/unknown host "cursor"/);
    });
  });
});
