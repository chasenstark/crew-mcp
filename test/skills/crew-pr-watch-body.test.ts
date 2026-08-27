import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { HOST_ADAPTERS } from '../../src/install/hosts/index.js';
import { CAPTAIN_CATALOG_TOOLS } from '../../src/install/skill-verify.js';
import {
  renderSkill,
  renderSkillCompanion,
  SKILL_MANIFEST,
  templatePathForHost,
} from '../../src/install/skill-renderer.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(here, '..', '..');
const PR_WATCH_SKILL = SKILL_MANIFEST.find((skill) => skill.id === 'crew:pr-watch');

describe('crew PR-watch skill body', () => {
  it('renders scoped controller commands and stays below the 6 KiB matcher budget', async () => {
    if (!PR_WATCH_SKILL) throw new Error('crew:pr-watch manifest entry missing');
    const spec = HOST_ADAPTERS.codex.skillInstallSpecFor(REPO_ROOT, PR_WATCH_SKILL);
    const args = {
      templatePath: templatePathForHost(REPO_ROOT, 'codex'),
      hostId: 'codex' as const,
      skill: PR_WATCH_SKILL,
      spec,
      tools: CAPTAIN_CATALOG_TOOLS,
      crewWaitCommand: './node_modules/.bin/crew-wait',
      crewPrWatchCommand: './node_modules/.bin/crew-pr-watch',
      crewPrWatchWaitCommand: './node_modules/.bin/crew-pr-watch-wait',
      actionReferencePath: './ACTION.md',
      packageRoot: REPO_ROOT,
    };
    const rendered = await renderSkill(args);
    const companion = await renderSkillCompanion({
      ...args,
      sourceFile: 'crew-pr-watch.action.md',
    });

    expect(Buffer.byteLength(rendered, 'utf-8')).toBeLessThanOrEqual(6 * 1024);
    expect(rendered).toContain('`./node_modules/.bin/crew-pr-watch ack`');
    expect(rendered).toContain('[ACTION.md](./ACTION.md)');
    expect(companion).toContain('`./node_modules/.bin/crew-pr-watch effect');
    expect(`${rendered}\n${companion}`).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
  });
});
