/**
 * Claude Code host adapter tests — JSON merge/remove idempotency and
 * preservation of unrelated keys.
 */

import { describe, expect, it } from 'vitest';

import { claudeCodeAdapter } from '../../../src/install/hosts/claude-code.js';

const CMD = '/usr/local/bin/node';
const ARGS = ['/abs/path/dist/index.js', 'serve'];

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
