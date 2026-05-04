/**
 * Codex host adapter tests — focuses on TOML block merge/remove
 * idempotency and edge cases. The hand-rolled section finder is the
 * brittle bit; these tests cover:
 *
 *   - Empty config → block becomes the entire file
 *   - Config with only the crew block → replaced in place
 *   - Config with the crew block in the middle → only that block changes
 *   - Config with crew block at end → block replaced, no trailing junk
 *   - Idempotency: merge twice, remove twice
 *   - Comments preserved (we never touch unrelated content)
 */

import { describe, expect, it } from 'vitest';

import { codexAdapter, _internals } from '../../../src/install/hosts/codex.js';

const CMD = '/usr/local/bin/node';
const ARGS = ['/abs/path/dist/index.js', 'serve'];

describe('codexAdapter.mergeMcpBlock', () => {
  it('writes the block as the entire file when input is empty', () => {
    const out = codexAdapter.mergeMcpBlock('', CMD, ARGS);
    expect(out).toBe(
      '[mcp_servers.crew]\n' +
        `command = "${CMD}"\n` +
        `args = ["${ARGS[0]}", "${ARGS[1]}"]\n`,
    );
  });

  it('appends with separator when no crew block exists', () => {
    const existing = '[mcp_servers.other]\ncommand = "thing"\nargs = []\n';
    const out = codexAdapter.mergeMcpBlock(existing, CMD, ARGS);
    expect(out).toContain(existing.replace(/\n$/, ''));
    expect(out).toContain('[mcp_servers.crew]');
    // No leading whitespace inside the new block
    expect(out).toMatch(/\n\n\[mcp_servers\.crew\]/);
  });

  it('replaces an existing crew block in place', () => {
    const existing =
      '[mcp_servers.crew]\n' +
      'command = "old"\n' +
      'args = []\n';
    const out = codexAdapter.mergeMcpBlock(existing, CMD, ARGS);
    expect(out).toContain(`command = "${CMD}"`);
    expect(out).not.toContain('command = "old"');
  });

  it('replaces an existing crew block when followed by another section', () => {
    const existing =
      '[mcp_servers.crew]\n' +
      'command = "old"\n' +
      'args = []\n' +
      '\n' +
      '[mcp_servers.other]\n' +
      'command = "thing"\n' +
      'args = []\n';
    const out = codexAdapter.mergeMcpBlock(existing, CMD, ARGS);
    expect(out).toContain(`command = "${CMD}"`);
    expect(out).not.toContain('command = "old"');
    // Other section preserved
    expect(out).toContain('[mcp_servers.other]');
    expect(out).toContain('command = "thing"');
  });

  it('is idempotent (running twice produces same output)', () => {
    const first = codexAdapter.mergeMcpBlock('', CMD, ARGS);
    const second = codexAdapter.mergeMcpBlock(first, CMD, ARGS);
    expect(second).toBe(first);
  });

  it('preserves preamble comments and unrelated tables', () => {
    const existing =
      '# my codex config\n' +
      '\n' +
      '[other_section]\n' +
      'foo = "bar"\n' +
      '\n' +
      '[mcp_servers.thing]\n' +
      'command = "thing"\n';
    const out = codexAdapter.mergeMcpBlock(existing, CMD, ARGS);
    expect(out).toContain('# my codex config');
    expect(out).toContain('[other_section]');
    expect(out).toContain('foo = "bar"');
    expect(out).toContain('[mcp_servers.thing]');
    expect(out).toContain('[mcp_servers.crew]');
  });

  it('escapes paths that contain backslashes (Windows paths)', () => {
    const winPath = 'C:\\Users\\me\\dist\\index.js';
    const out = codexAdapter.mergeMcpBlock('', CMD, [winPath, 'serve']);
    expect(out).toContain('"C:\\\\Users\\\\me\\\\dist\\\\index.js"');
  });
});

describe('codexAdapter.removeMcpBlock', () => {
  it('returns the input unchanged when no crew block exists', () => {
    const existing = '[mcp_servers.other]\ncommand = "thing"\nargs = []\n';
    expect(codexAdapter.removeMcpBlock(existing)).toBe(existing);
  });

  it('removes the crew block when it is alone', () => {
    const existing = codexAdapter.mergeMcpBlock('', CMD, ARGS);
    expect(codexAdapter.removeMcpBlock(existing)).toBe('');
  });

  it('removes the crew block when followed by another section', () => {
    const existing =
      '[mcp_servers.crew]\n' +
      `command = "${CMD}"\n` +
      'args = []\n' +
      '\n' +
      '[mcp_servers.other]\n' +
      'command = "thing"\n';
    const out = codexAdapter.removeMcpBlock(existing);
    expect(out).not.toContain('[mcp_servers.crew]');
    expect(out).toContain('[mcp_servers.other]');
    expect(out).toContain('command = "thing"');
  });

  it('is idempotent', () => {
    const existing = codexAdapter.mergeMcpBlock('', CMD, ARGS);
    const once = codexAdapter.removeMcpBlock(existing);
    const twice = codexAdapter.removeMcpBlock(once);
    expect(twice).toBe(once);
  });

  it('squeezes triple-newlines that result from mid-file removal', () => {
    const existing =
      '[a]\n' +
      'foo = 1\n' +
      '\n' +
      '[mcp_servers.crew]\n' +
      `command = "${CMD}"\n` +
      'args = []\n' +
      '\n' +
      '[b]\n' +
      'bar = 2\n';
    const out = codexAdapter.removeMcpBlock(existing);
    expect(out).not.toMatch(/\n{3,}/);
    expect(out).toContain('[a]');
    expect(out).toContain('[b]');
  });
});

describe('codexAdapter.hasMcpBlock', () => {
  it('returns false on empty config', () => {
    expect(codexAdapter.hasMcpBlock('')).toBe(false);
  });

  it('returns false when only other sections exist', () => {
    expect(
      codexAdapter.hasMcpBlock('[mcp_servers.other]\ncommand = "thing"\n'),
    ).toBe(false);
  });

  it('returns true when crew block is present', () => {
    expect(
      codexAdapter.hasMcpBlock(codexAdapter.mergeMcpBlock('', CMD, ARGS)),
    ).toBe(true);
  });
});

describe('codexAdapter.removeMcpBlock — namespace sub-blocks (Finding 9)', () => {
  it('removes Codex auto-created [mcp_servers.crew.tools.*] sub-blocks', () => {
    // Real-world repro from the v0.2 smoke: Codex creates approval-mode
    // sub-blocks under our namespace when the user grants per-tool
    // approvals. Uninstall has to clean those up too, otherwise Codex
    // refuses to load on next launch ("invalid transport in
    // mcp_servers.crew") because the sub-blocks reference a parent
    // section we removed.
    const existing =
      'model = "gpt-5.5"\n' +
      '\n' +
      '[mcp_servers.crew]\n' +
      `command = "${CMD}"\n` +
      `args = ["${ARGS[0]}", "${ARGS[1]}"]\n` +
      '\n' +
      '[mcp_servers.crew.tools.list_agents]\n' +
      'approval_mode = "approve"\n' +
      '\n' +
      '[mcp_servers.crew.tools.run_agent]\n' +
      'approval_mode = "approve"\n' +
      '\n' +
      '[mcp_servers.crew.tools.get_run_status]\n' +
      'approval_mode = "approve"\n';
    const out = codexAdapter.removeMcpBlock(existing);
    expect(out).not.toContain('[mcp_servers.crew]');
    expect(out).not.toContain('[mcp_servers.crew.tools.list_agents]');
    expect(out).not.toContain('[mcp_servers.crew.tools.run_agent]');
    expect(out).not.toContain('[mcp_servers.crew.tools.get_run_status]');
    expect(out).toContain('model = "gpt-5.5"');
  });

  it('removes only crew-namespace blocks; preserves other mcp_servers entries', () => {
    const existing =
      '[mcp_servers.crew]\n' +
      `command = "${CMD}"\n` +
      'args = []\n' +
      '\n' +
      '[mcp_servers.crew.tools.list_agents]\n' +
      'approval_mode = "approve"\n' +
      '\n' +
      '[mcp_servers.linear]\n' +
      'url = "https://mcp.linear.app/mcp"\n' +
      '\n' +
      '[mcp_servers.figma]\n' +
      'url = "https://mcp.figma.com/mcp"\n';
    const out = codexAdapter.removeMcpBlock(existing);
    expect(out).not.toContain('[mcp_servers.crew]');
    expect(out).not.toContain('[mcp_servers.crew.tools.');
    // Sister namespaces (linear, figma) preserved verbatim.
    expect(out).toContain('[mcp_servers.linear]');
    expect(out).toContain('[mcp_servers.figma]');
  });

  it('removes orphaned [mcp_servers.crew.tools.*] when the parent block was already gone', () => {
    // Replicates the exact failure mode the user hit: parent
    // [mcp_servers.crew] removed by an earlier uninstall, but the
    // sub-blocks left behind are now causing Codex to error.
    const existing =
      'model = "gpt-5.5"\n' +
      '\n' +
      '[mcp_servers.crew.tools.list_agents]\n' +
      'approval_mode = "approve"\n' +
      '\n' +
      '[mcp_servers.crew.tools.run_agent]\n' +
      'approval_mode = "approve"\n';
    const out = codexAdapter.removeMcpBlock(existing);
    expect(out).not.toContain('[mcp_servers.crew');
    expect(out).toContain('model = "gpt-5.5"');
  });

  it('does not match sibling namespaces like [mcp_servers.crew_extension]', () => {
    // Conservative: only remove blocks whose header is exactly
    // [mcp_servers.crew] or [mcp_servers.crew.<...>].
    const existing =
      '[mcp_servers.crew_extension]\n' +
      'url = "..."\n';
    expect(codexAdapter.removeMcpBlock(existing)).toBe(existing);
  });

  it('idempotent across the Finding 9 scenario', () => {
    const existing =
      '[mcp_servers.crew]\n' +
      `command = "${CMD}"\n` +
      'args = []\n' +
      '\n' +
      '[mcp_servers.crew.tools.run_agent]\n' +
      'approval_mode = "approve"\n';
    const once = codexAdapter.removeMcpBlock(existing);
    const twice = codexAdapter.removeMcpBlock(once);
    expect(twice).toBe(once);
  });
});

describe('codexAdapter.mergeMcpBlock — preserves user per-tool approval sub-blocks', () => {
  it('replaces only [mcp_servers.crew] and leaves [mcp_servers.crew.tools.*] alone', () => {
    // Re-installing should NOT erase the user's approval-mode prefs
    // — those are user-set, not crew-set. Only mergeMcpBlock's narrow
    // [mcp_servers.crew] matcher applies; the broader namespace
    // matcher is uninstall-only.
    const existing =
      '[mcp_servers.crew]\n' +
      'command = "old"\n' +
      'args = []\n' +
      '\n' +
      '[mcp_servers.crew.tools.run_agent]\n' +
      'approval_mode = "approve"\n';
    const out = codexAdapter.mergeMcpBlock(existing, CMD, ARGS);
    expect(out).toContain(`command = "${CMD}"`);
    expect(out).toContain('[mcp_servers.crew.tools.run_agent]');
    expect(out).toContain('approval_mode = "approve"');
  });
});

describe('codex internals', () => {
  it('locateCrewBlock spans through trailing newlines up to next section', () => {
    const raw =
      '[mcp_servers.crew]\n' +
      'command = "x"\n' +
      'args = []\n' +
      '\n' +
      '[next]\n';
    const span = _internals.locateCrewBlock(raw);
    expect(span).not.toBeNull();
    expect(raw.slice(span!.start, span!.end)).toBe(
      '[mcp_servers.crew]\ncommand = "x"\nargs = []\n\n',
    );
  });

  it('tomlString escapes quotes and backslashes', () => {
    expect(_internals.tomlString('a"b')).toBe('"a\\"b"');
    expect(_internals.tomlString('a\\b')).toBe('"a\\\\b"');
  });
});
