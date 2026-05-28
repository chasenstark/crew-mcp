/**
 * Gemini CLI host adapter tests — JSON shape parity with claude-code,
 * different paths.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { geminiAdapter } from '../../../src/install/hosts/gemini.js';

const CMD = '/usr/local/bin/node';
const ARGS = ['/abs/path/dist/index.js', 'serve'];

describe('geminiAdapter paths', () => {
  it('points at ~/.gemini/settings.json for config', () => {
    expect(geminiAdapter.configPath('/home/me')).toBe(
      join('/home/me', '.gemini', 'settings.json'),
    );
  });

  it('points at ~/.gemini/skills/crew/SKILL.md for the umbrella skill', () => {
    // Phase 0 outcome (crew-iterate-skill plan): Gemini relocates from
    // the broken ~/.gemini/extensions/crew/ path (which never loaded)
    // to sibling-flat ~/.gemini/skills/<dir>/.
    expect(geminiAdapter.skillPath('/home/me')).toBe(
      join('/home/me', '.gemini', 'skills', 'crew', 'SKILL.md'),
    );
  });
});

describe('geminiAdapter.skillInstallSpecFor', () => {
  it('produces a sibling-flat user-skills path for the umbrella', () => {
    const spec = geminiAdapter.skillInstallSpecFor('/home/me', {
      id: 'crew',
      slug: 'crew',
      bodyFile: 'crew-captain.body.md',
      description: 'desc',
    });
    expect(spec.skillPath).toBe(
      join('/home/me', '.gemini', 'skills', 'crew', 'SKILL.md'),
    );
    expect(spec.frontmatterName).toBe('crew');
    expect(spec.legacyPathsToRemove).toEqual([
      join('/home/me', '.gemini', 'extensions', 'crew', 'SKILL.md'),
    ]);
  });

  it('produces a sibling-flat user-skills path for crew:iterate', () => {
    const spec = geminiAdapter.skillInstallSpecFor('/home/me', {
      id: 'crew:iterate',
      slug: 'iterate',
      bodyFile: 'crew-iterate.body.md',
      description: 'desc',
    });
    expect(spec.skillPath).toBe(
      join('/home/me', '.gemini', 'skills', 'crew-iterate', 'SKILL.md'),
    );
    expect(spec.frontmatterName).toBe('crew-iterate');
    expect(spec.legacyPathsToRemove).toEqual([
      join('/home/me', '.gemini', 'extensions', 'crew-iterate', 'SKILL.md'),
    ]);
  });
});

describe('geminiAdapter.skillInstallSpecFor — shared ~/.agents/skills/ dedupe', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'crew-gemini-shared-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const iterateSkill = {
    id: 'crew:iterate',
    slug: 'iterate',
    bodyFile: 'crew-iterate.body.md',
    description: 'desc',
  };

  function seedSharedSkill(dir: string): string {
    const sharedPath = join(home, '.agents', 'skills', dir, 'SKILL.md');
    mkdirSync(join(home, '.agents', 'skills', dir), { recursive: true });
    writeFileSync(sharedPath, '---\nname: ' + dir + '\n---\nbody\n', 'utf-8');
    return sharedPath;
  }

  it('skips the per-host copy and points at the shared path when it exists', () => {
    const sharedPath = seedSharedSkill('crew-iterate');
    const spec = geminiAdapter.skillInstallSpecFor(home, iterateSkill);
    expect(spec.skip).toBe(true);
    expect(spec.skillPath).toBe(sharedPath);
    // Removes the deprecated extensions path AND the stale per-host copy.
    expect(spec.legacyPathsToRemove).toEqual([
      join(home, '.gemini', 'extensions', 'crew-iterate', 'SKILL.md'),
      join(home, '.gemini', 'skills', 'crew-iterate', 'SKILL.md'),
    ]);
  });

  it('writes the per-host copy when the shared path is absent', () => {
    const spec = geminiAdapter.skillInstallSpecFor(home, iterateSkill);
    expect(spec.skip).toBeUndefined();
    expect(spec.skillPath).toBe(
      join(home, '.gemini', 'skills', 'crew-iterate', 'SKILL.md'),
    );
    expect(spec.legacyPathsToRemove).toEqual([
      join(home, '.gemini', 'extensions', 'crew-iterate', 'SKILL.md'),
    ]);
  });
});

describe('geminiAdapter.mergeMcpBlock', () => {
  it('writes a fresh config when input is empty', () => {
    const out = geminiAdapter.mergeMcpBlock('', CMD, ARGS);
    const parsed = JSON.parse(out) as { mcpServers: { crew: { command: string; args: string[] } } };
    expect(parsed.mcpServers.crew).toEqual({ command: CMD, args: ARGS });
  });

  it('preserves unrelated top-level keys', () => {
    const existing = JSON.stringify({ theme: 'dark' });
    const out = geminiAdapter.mergeMcpBlock(existing, CMD, ARGS);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.theme).toBe('dark');
    expect((parsed.mcpServers as Record<string, unknown>).crew).toBeDefined();
  });

  it('is idempotent', () => {
    const first = geminiAdapter.mergeMcpBlock('', CMD, ARGS);
    expect(geminiAdapter.mergeMcpBlock(first, CMD, ARGS)).toBe(first);
  });
});

describe('geminiAdapter.removeMcpBlock', () => {
  it('removes the crew block', () => {
    const existing = geminiAdapter.mergeMcpBlock('', CMD, ARGS);
    const out = geminiAdapter.removeMcpBlock(existing);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.mcpServers).toBeUndefined();
  });

  it('is idempotent', () => {
    const out = geminiAdapter.removeMcpBlock(geminiAdapter.mergeMcpBlock('', CMD, ARGS));
    expect(geminiAdapter.removeMcpBlock(out)).toBe(out);
  });
});

describe('geminiAdapter.writeAutoApproval / clearAutoApproval', () => {
  it('does NOT define permissionsPath (Gemini stores trust in the same file)', () => {
    expect(geminiAdapter.permissionsPath).toBeUndefined();
  });

  it('sets mcpServers.crew.trust = true', () => {
    const merged = geminiAdapter.mergeMcpBlock('', CMD, ARGS);
    const out = geminiAdapter.writeAutoApproval!(merged, ['run_agent']);
    const parsed = JSON.parse(out) as {
      mcpServers: { crew: { command: string; args: string[]; trust: boolean } };
    };
    expect(parsed.mcpServers.crew.trust).toBe(true);
    // Server config preserved.
    expect(parsed.mcpServers.crew.command).toBe(CMD);
    expect(parsed.mcpServers.crew.args).toEqual(ARGS);
  });

  it('preserves unrelated mcpServers entries', () => {
    const existing = JSON.stringify({
      mcpServers: {
        other: { command: 'foo', args: [] },
        crew: { command: CMD, args: ARGS },
      },
    });
    const out = geminiAdapter.writeAutoApproval!(existing, ['run_agent']);
    const parsed = JSON.parse(out) as {
      mcpServers: Record<string, { trust?: boolean; command: string }>;
    };
    expect(parsed.mcpServers.other.trust).toBeUndefined();
    expect(parsed.mcpServers.crew.trust).toBe(true);
  });

  it('is idempotent', () => {
    const merged = geminiAdapter.mergeMcpBlock('', CMD, ARGS);
    const once = geminiAdapter.writeAutoApproval!(merged, ['run_agent']);
    const twice = geminiAdapter.writeAutoApproval!(once, ['run_agent']);
    expect(twice).toBe(once);
  });

  it('clearAutoApproval removes the trust field', () => {
    const merged = geminiAdapter.mergeMcpBlock('', CMD, ARGS);
    const trusted = geminiAdapter.writeAutoApproval!(merged, ['run_agent']);
    const cleared = geminiAdapter.clearAutoApproval!(trusted);
    const parsed = JSON.parse(cleared) as {
      mcpServers: { crew: { command: string; args: string[]; trust?: boolean } };
    };
    expect(parsed.mcpServers.crew.trust).toBeUndefined();
    // Server config preserved.
    expect(parsed.mcpServers.crew.command).toBe(CMD);
  });

  it('clearAutoApproval is a no-op when trust is absent', () => {
    const merged = geminiAdapter.mergeMcpBlock('', CMD, ARGS);
    expect(geminiAdapter.clearAutoApproval!(merged)).toBe(merged);
  });

  it('clearAutoApproval is a no-op on empty file', () => {
    expect(geminiAdapter.clearAutoApproval!('')).toBe('');
  });
});
