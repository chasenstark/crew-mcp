/**
 * Gemini CLI host adapter tests — JSON shape parity with claude-code,
 * different paths.
 */

import { describe, expect, it } from 'vitest';
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

  it('points at the extension SKILL.md for skill', () => {
    expect(geminiAdapter.skillPath('/home/me')).toBe(
      join('/home/me', '.gemini', 'extensions', 'crew', 'SKILL.md'),
    );
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
