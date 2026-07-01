/**
 * Antigravity CLI (agy) host adapter tests.
 *
 * agy is a PROJECT-SCOPE-ONLY host: its MCP config loads solely from
 * <repo>/.agents/mcp_config.json (JSON, mcpServers.crew — same block
 * shape as Claude Code / Gemini). The global-only interface methods
 * throw because agy has no global MCP config.
 */

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { agyAdapter } from '../../../src/install/hosts/agy.js';

const CMD = '/usr/local/bin/node';
const ARGS = ['/abs/path/dist/index.js', 'serve'];
const REPO = '/repo/root';

describe('agyAdapter identity + project paths', () => {
  it('has id agy', () => {
    expect(agyAdapter.id).toBe('agy');
  });

  it('points project MCP config at <repo>/.agents/mcp_config.json', () => {
    expect(agyAdapter.projectConfigPath!(REPO)).toBe(
      join(REPO, '.agents', 'mcp_config.json'),
    );
  });

  it('points the umbrella project skill at <repo>/.agents/skills/crew/SKILL.md', () => {
    expect(agyAdapter.projectSkillPath!(REPO)).toBe(
      join(REPO, '.agents', 'skills', 'crew', 'SKILL.md'),
    );
  });
});

describe('agyAdapter is project-scope only', () => {
  it('throws for the global configPath', () => {
    expect(() => agyAdapter.configPath('/home/me')).toThrow(/project-scoped/i);
  });

  it('throws for the global skillPath', () => {
    expect(() => agyAdapter.skillPath('/home/me')).toThrow(/project-scoped/i);
  });

  it('throws for the global skillInstallSpecFor', () => {
    expect(() =>
      agyAdapter.skillInstallSpecFor('/home/me', {
        id: 'crew',
        slug: 'crew',
        bodyFile: 'crew-captain.body.md',
        description: 'desc',
      }),
    ).toThrow(/project-scoped/i);
  });

  it('does NOT define config-level auto-approval (agy uses --dangerously-skip-permissions)', () => {
    // agy's mcp_config has no `trust` key; auto-approval is a launch
    // flag, so the adapter opts out of the config auto-approve flow.
    expect(agyAdapter.writeAutoApproval).toBeUndefined();
    expect(agyAdapter.clearAutoApproval).toBeUndefined();
    expect(agyAdapter.permissionsPath).toBeUndefined();
    expect(agyAdapter.projectPermissionsPath).toBeUndefined();
  });

  it('surfaces the --dangerously-skip-permissions launch note on project install', () => {
    const notes = agyAdapter.projectInstallNotes!(REPO);
    expect(notes.join('\n')).toMatch(/--dangerously-skip-permissions/);
    expect(notes.join('\n')).toContain(join(REPO, '.agents'));
  });
});

describe('agyAdapter.projectSkillInstallSpecFor', () => {
  it('produces a sibling-flat project-skills path for the umbrella', () => {
    const spec = agyAdapter.projectSkillInstallSpecFor!(REPO, {
      id: 'crew',
      slug: 'crew',
      bodyFile: 'crew-captain.body.md',
      description: 'desc',
    });
    expect(spec.skillPath).toBe(join(REPO, '.agents', 'skills', 'crew', 'SKILL.md'));
    expect(spec.frontmatterName).toBe('crew');
    expect(spec.legacyPathsToRemove).toEqual([]);
    expect(spec.skip).toBeUndefined();
  });

  it('produces a sibling-flat project-skills path for crew:iterate', () => {
    const spec = agyAdapter.projectSkillInstallSpecFor!(REPO, {
      id: 'crew:iterate',
      slug: 'iterate',
      bodyFile: 'crew-iterate.body.md',
      description: 'desc',
    });
    expect(spec.skillPath).toBe(join(REPO, '.agents', 'skills', 'crew-iterate', 'SKILL.md'));
    expect(spec.frontmatterName).toBe('crew-iterate');
    expect(spec.legacyPathsToRemove).toEqual([]);
  });
});

describe('agyAdapter.mergeMcpBlock', () => {
  it('writes a fresh config when input is empty', () => {
    const out = agyAdapter.mergeMcpBlock('', CMD, ARGS);
    const parsed = JSON.parse(out) as { mcpServers: { crew: { command: string; args: string[] } } };
    expect(parsed.mcpServers.crew).toEqual({ command: CMD, args: ARGS });
  });

  it('preserves unrelated top-level keys and mcpServers entries', () => {
    const existing = JSON.stringify({
      someSetting: 'x',
      mcpServers: { other: { command: 'foo', args: [] } },
    });
    const out = agyAdapter.mergeMcpBlock(existing, CMD, ARGS);
    const parsed = JSON.parse(out) as {
      someSetting: string;
      mcpServers: Record<string, { command: string }>;
    };
    expect(parsed.someSetting).toBe('x');
    expect(parsed.mcpServers.other.command).toBe('foo');
    expect(parsed.mcpServers.crew.command).toBe(CMD);
  });

  it('is idempotent', () => {
    const first = agyAdapter.mergeMcpBlock('', CMD, ARGS);
    expect(agyAdapter.mergeMcpBlock(first, CMD, ARGS)).toBe(first);
  });

  it('throws on non-JSON config', () => {
    expect(() => agyAdapter.mergeMcpBlock('not json{', CMD, ARGS)).toThrow(/parse agy config/i);
  });
});

describe('agyAdapter.removeMcpBlock / hasMcpBlock', () => {
  it('removes the crew block and drops an emptied mcpServers', () => {
    const existing = agyAdapter.mergeMcpBlock('', CMD, ARGS);
    expect(agyAdapter.hasMcpBlock(existing)).toBe(true);
    const out = agyAdapter.removeMcpBlock(existing);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.mcpServers).toBeUndefined();
    expect(agyAdapter.hasMcpBlock(out)).toBe(false);
  });

  it('preserves sibling mcpServers entries when removing crew', () => {
    const existing = JSON.stringify({
      mcpServers: { other: { command: 'foo', args: [] }, crew: { command: CMD, args: ARGS } },
    });
    const out = agyAdapter.removeMcpBlock(existing);
    const parsed = JSON.parse(out) as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers.crew).toBeUndefined();
    expect(parsed.mcpServers.other).toBeDefined();
  });

  it('is idempotent and a no-op on empty input', () => {
    const out = agyAdapter.removeMcpBlock(agyAdapter.mergeMcpBlock('', CMD, ARGS));
    expect(agyAdapter.removeMcpBlock(out)).toBe(out);
    expect(agyAdapter.removeMcpBlock('')).toBe('');
    expect(agyAdapter.hasMcpBlock('')).toBe(false);
  });
});
