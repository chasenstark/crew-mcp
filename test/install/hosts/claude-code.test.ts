/**
 * Claude Code host adapter tests — JSON merge/remove idempotency and
 * preservation of unrelated keys.
 */

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { claudeCodeAdapter } from '../../../src/install/hosts/claude-code.js';

const CMD = '/usr/local/bin/node';
const ARGS = ['/abs/path/dist/index.js', 'serve'];

describe('claudeCodeAdapter.skillInstallSpecFor', () => {
  it('produces the v1-canonical path for the umbrella skill', () => {
    const spec = claudeCodeAdapter.skillInstallSpecFor('/home/me', {
      id: 'crew',
      slug: 'crew',
      bodyFile: 'crew-captain.body.md',
      description: 'desc',
    });
    expect(spec.skillPath).toBe(
      join('/home/me', '.claude', 'skills', 'crew', 'SKILL.md'),
    );
    expect(spec.frontmatterName).toBe('crew');
    expect(spec.legacyPathsToRemove).toEqual([]);
  });

  it('produces a sibling-flat path for crew:iterate (hyphenated dir + name)', () => {
    const spec = claudeCodeAdapter.skillInstallSpecFor('/home/me', {
      id: 'crew:iterate',
      slug: 'iterate',
      bodyFile: 'crew-iterate.body.md',
      description: 'desc',
    });
    expect(spec.skillPath).toBe(
      join('/home/me', '.claude', 'skills', 'crew-iterate', 'SKILL.md'),
    );
    expect(spec.frontmatterName).toBe('crew-iterate');
    expect(spec.legacyPathsToRemove).toEqual([]);
  });
});

describe('claudeCodeAdapter project paths', () => {
  it('points project config, permissions, and skills inside the repo', () => {
    const repoRoot = '/repo';
    expect(claudeCodeAdapter.projectConfigPath!(repoRoot)).toBe('/repo/.mcp.json');
    expect(claudeCodeAdapter.projectPermissionsPath!(repoRoot)).toBe(
      '/repo/.claude/settings.json',
    );
    expect(claudeCodeAdapter.projectSkillPath!(repoRoot)).toBe(
      '/repo/.claude/skills/crew/SKILL.md',
    );

    const spec = claudeCodeAdapter.projectSkillInstallSpecFor!(repoRoot, {
      id: 'crew:iterate',
      slug: 'iterate',
      bodyFile: 'crew-iterate.body.md',
      description: 'desc',
    });
    expect(spec.skillPath).toBe('/repo/.claude/skills/crew-iterate/SKILL.md');
    expect(spec.frontmatterName).toBe('crew-iterate');
  });
});

describe('claudeCodeAdapter.mergeMcpBlock', () => {
  it('writes a fresh config when input is empty', () => {
    const out = claudeCodeAdapter.mergeMcpBlock('', CMD, ARGS);
    const parsed = JSON.parse(out) as { mcpServers: { crew: { command: string; args: string[] } } };
    expect(parsed.mcpServers.crew).toEqual({
      command: CMD,
      args: ARGS,
    });
  });

  it('preserves unrelated top-level keys', () => {
    const existing = JSON.stringify({
      preferredModel: 'opus',
      mcpServers: { other: { command: 'foo', args: [] } },
    });
    const out = claudeCodeAdapter.mergeMcpBlock(existing, CMD, ARGS);
    const parsed = JSON.parse(out) as Record<string, unknown> & {
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.preferredModel).toBe('opus');
    expect(parsed.mcpServers.other).toEqual({ command: 'foo', args: [] });
    expect(parsed.mcpServers.crew).toEqual({ command: CMD, args: ARGS });
  });

  it('replaces an existing crew block', () => {
    const existing = JSON.stringify({
      mcpServers: { crew: { command: 'old', args: ['x'] } },
    });
    const out = claudeCodeAdapter.mergeMcpBlock(existing, CMD, ARGS);
    const parsed = JSON.parse(out) as { mcpServers: { crew: { command: string; args: string[] } } };
    expect(parsed.mcpServers.crew).toEqual({ command: CMD, args: ARGS });
  });

  it('is idempotent', () => {
    const first = claudeCodeAdapter.mergeMcpBlock('', CMD, ARGS);
    const second = claudeCodeAdapter.mergeMcpBlock(first, CMD, ARGS);
    expect(second).toBe(first);
  });

  it('throws when input is not valid JSON', () => {
    expect(() => claudeCodeAdapter.mergeMcpBlock('not json', CMD, ARGS)).toThrow(/JSON/);
  });
});

describe('claudeCodeAdapter.removeMcpBlock', () => {
  it('returns input verbatim on empty', () => {
    expect(claudeCodeAdapter.removeMcpBlock('')).toBe('');
  });

  it('returns input verbatim when crew block is absent', () => {
    const existing = JSON.stringify({ preferredModel: 'opus' }) + '\n';
    expect(claudeCodeAdapter.removeMcpBlock(existing)).toBe(existing);
  });

  it('removes the crew block', () => {
    const existing = claudeCodeAdapter.mergeMcpBlock('', CMD, ARGS);
    const out = claudeCodeAdapter.removeMcpBlock(existing);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.mcpServers).toBeUndefined();
  });

  it('preserves other mcpServers entries when removing crew', () => {
    const existing = JSON.stringify({
      mcpServers: {
        crew: { command: CMD, args: ARGS },
        other: { command: 'foo', args: [] },
      },
    });
    const out = claudeCodeAdapter.removeMcpBlock(existing);
    const parsed = JSON.parse(out) as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers.crew).toBeUndefined();
    expect(parsed.mcpServers.other).toEqual({ command: 'foo', args: [] });
  });

  it('is idempotent', () => {
    const existing = claudeCodeAdapter.mergeMcpBlock('', CMD, ARGS);
    const once = claudeCodeAdapter.removeMcpBlock(existing);
    const twice = claudeCodeAdapter.removeMcpBlock(once);
    expect(twice).toBe(once);
  });
});

describe('claudeCodeAdapter.hasMcpBlock', () => {
  it('returns false on empty', () => {
    expect(claudeCodeAdapter.hasMcpBlock('')).toBe(false);
  });

  it('returns false when crew block is absent', () => {
    expect(claudeCodeAdapter.hasMcpBlock('{}')).toBe(false);
    expect(
      claudeCodeAdapter.hasMcpBlock(JSON.stringify({ mcpServers: { other: {} } })),
    ).toBe(false);
  });

  it('returns true when crew block is present', () => {
    expect(
      claudeCodeAdapter.hasMcpBlock(claudeCodeAdapter.mergeMcpBlock('', CMD, ARGS)),
    ).toBe(true);
  });

  it('returns false on invalid JSON (defensive)', () => {
    expect(claudeCodeAdapter.hasMcpBlock('not json')).toBe(false);
  });
});

describe('claudeCodeAdapter.permissionsPath', () => {
  it('returns ~/.claude/settings.json (NOT ~/.claude.json)', () => {
    const home = '/users/test';
    expect(claudeCodeAdapter.permissionsPath!(home)).toBe('/users/test/.claude/settings.json');
    // Regression guard: settings.json is a separate file from the MCP config.
    expect(claudeCodeAdapter.permissionsPath!(home)).not.toBe(claudeCodeAdapter.configPath(home));
  });
});

describe('claudeCodeAdapter.writeAutoApproval / clearAutoApproval', () => {
  // tools array is ignored for Claude Code (single wildcard covers all).
  const TOOLS = ['list_agents', 'run_agent'];

  it('appends mcp__crew__* to permissions.allow on an empty file', () => {
    const out = claudeCodeAdapter.writeAutoApproval!('', TOOLS);
    const parsed = JSON.parse(out) as { permissions: { allow: string[] } };
    expect(parsed.permissions.allow).toEqual(['mcp__crew__*']);
  });

  it('preserves existing permissions.allow entries', () => {
    const existing = JSON.stringify({
      permissions: {
        allow: ['Bash(git:*)', 'Read', 'mcp__ide__*'],
        deny: ['Bash(rm -rf /*)'],
      },
      env: { CLAUDE_CODE_EXPERIMENTAL: '1' },
    });
    const out = claudeCodeAdapter.writeAutoApproval!(existing, TOOLS);
    const parsed = JSON.parse(out) as {
      permissions: { allow: string[]; deny: string[] };
      env: Record<string, string>;
    };
    expect(parsed.permissions.allow).toEqual([
      'Bash(git:*)',
      'Read',
      'mcp__ide__*',
      'mcp__crew__*',
    ]);
    expect(parsed.permissions.deny).toEqual(['Bash(rm -rf /*)']);
    expect(parsed.env.CLAUDE_CODE_EXPERIMENTAL).toBe('1');
  });

  it('is idempotent — writing twice does not duplicate the wildcard', () => {
    const existing = JSON.stringify({ permissions: { allow: ['mcp__crew__*'] } });
    const out = claudeCodeAdapter.writeAutoApproval!(existing, TOOLS);
    const parsed = JSON.parse(out) as { permissions: { allow: string[] } };
    expect(parsed.permissions.allow).toEqual(['mcp__crew__*']);
  });

  it('clearAutoApproval removes only mcp__crew__* and preserves siblings', () => {
    const existing = JSON.stringify({
      permissions: {
        allow: ['Bash(git:*)', 'mcp__crew__*', 'mcp__ide__*'],
      },
    });
    const out = claudeCodeAdapter.clearAutoApproval!(existing);
    const parsed = JSON.parse(out) as { permissions: { allow: string[] } };
    expect(parsed.permissions.allow).toEqual(['Bash(git:*)', 'mcp__ide__*']);
  });

  it('clearAutoApproval removes the allow array entirely when crew was the only entry', () => {
    const existing = JSON.stringify({
      permissions: { allow: ['mcp__crew__*'] },
    });
    const out = claudeCodeAdapter.clearAutoApproval!(existing);
    const parsed = JSON.parse(out) as { permissions?: { allow?: unknown } };
    expect(parsed.permissions?.allow).toBeUndefined();
  });

  it('clearAutoApproval is a no-op when crew wildcard is absent', () => {
    const existing = JSON.stringify({ permissions: { allow: ['Read'] } }) + '\n';
    expect(claudeCodeAdapter.clearAutoApproval!(existing)).toBe(existing);
  });

  it('clearAutoApproval is a no-op on an empty file', () => {
    expect(claudeCodeAdapter.clearAutoApproval!('')).toBe('');
  });
});
