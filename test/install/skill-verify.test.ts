import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { HOST_ADAPTERS } from '../../src/install/hosts/index.js';
import type { InstalledTarget } from '../../src/install/install-manifest.js';
import {
  CAPTAIN_CATALOG_TOOLS,
  computeSkillStaleness,
  verifyCanonicalSkillContent,
} from '../../src/install/skill-verify.js';
import {
  renderSkill,
  renderSkillCompanion,
  SKILL_MANIFEST,
  templatePathForHost,
} from '../../src/install/skill-renderer.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(here, '..', '..');

describe('shared canonical skill verification', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('reports equal content as fresh and byte drift as stale with a fix command', async () => {
    const home = mkdtempSync(join(tmpdir(), 'crew-skill-verify-'));
    cleanup.push(home);
    const skills: Record<string, string> = {};
    const skillFiles: Record<string, readonly string[]> = {};
    for (const skill of SKILL_MANIFEST) {
      const spec = HOST_ADAPTERS.codex.skillInstallSpecFor(home, skill);
      skills[skill.id] = spec.skillPath;
      mkdirSync(dirname(spec.skillPath), { recursive: true });
      writeFileSync(spec.skillPath, await renderSkill({
        templatePath: templatePathForHost(REPO_ROOT, 'codex'),
        hostId: 'codex',
        skill,
        spec,
        tools: CAPTAIN_CATALOG_TOOLS,
        crewWaitCommand: 'crew-wait',
        packageRoot: REPO_ROOT,
      }), 'utf-8');
      const companionPaths: string[] = [];
      for (const companion of skill.companions ?? []) {
        const companionPath = join(dirname(spec.skillPath), companion.outputFile);
        writeFileSync(companionPath, await renderSkillCompanion({
          templatePath: templatePathForHost(REPO_ROOT, 'codex'),
          hostId: 'codex',
          skill,
          spec,
          sourceFile: companion.sourceFile,
          tools: CAPTAIN_CATALOG_TOOLS,
          crewWaitCommand: 'crew-wait',
          packageRoot: REPO_ROOT,
        }), 'utf-8');
        companionPaths.push(companionPath);
      }
      skillFiles[skill.id] = [spec.skillPath, ...companionPaths];
    }
    const entry = installedTarget(home, skills, skillFiles);
    await expect(verifyCanonicalSkillContent({
      targetId: 'codex',
      entry,
      installRoot: home,
      packageRoot: REPO_ROOT,
      scope: 'global',
    })).resolves.toEqual([]);
    await expect(computeSkillStaleness({
      targetId: 'codex',
      entry,
      installRoot: home,
      packageRoot: REPO_ROOT,
      scope: 'global',
    })).resolves.toMatchObject({
      stale: false,
      fixCommand: 'crew-mcp install -t codex',
    });

    writeFileSync(skills.crew, 'old installed skill\n', 'utf-8');
    const stale = await computeSkillStaleness({
      targetId: 'codex',
      entry,
      installRoot: home,
      packageRoot: REPO_ROOT,
      scope: 'global',
    });
    expect(stale.stale).toBe(true);
    expect(stale.issues).toContain(`skill content stale: ${skills.crew}`);
  });
});

function installedTarget(
  home: string,
  skills: Record<string, string>,
  skillFiles: Record<string, readonly string[]>,
): InstalledTarget {
  return {
    configPath: join(home, '.codex', 'config.toml'),
    skillPath: skills.crew,
    skills,
    skillFiles,
    writtenPaths: Object.values(skillFiles).flat(),
    version: '0.7.0',
    installedAt: new Date().toISOString(),
    serverCommand: 'crew-mcp',
    serverArgs: ['serve'],
    crewWaitCommand: 'crew-wait',
  };
}
