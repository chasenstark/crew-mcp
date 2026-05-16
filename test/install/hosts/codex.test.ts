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

describe('codexAdapter.skillPath (Finding 5)', () => {
  it('points at ~/.codex/skills/crew/SKILL.md (NOT ~/.codex/prompts/crew.md)', () => {
    const home = '/users/test';
    expect(codexAdapter.skillPath(home)).toBe('/users/test/.codex/skills/crew/SKILL.md');
    // Regression guard: the v0.2.0-dev path Codex never discovered.
    expect(codexAdapter.skillPath(home)).not.toBe('/users/test/.codex/prompts/crew.md');
  });
});

describe('codexAdapter.skillInstallSpecFor', () => {
  it('produces the v1-canonical path for the umbrella skill', () => {
    const spec = codexAdapter.skillInstallSpecFor('/home/me', {
      id: 'crew',
      slug: 'crew',
      bodyFile: 'crew-captain.body.md',
      description: 'desc',
    });
    expect(spec.skillPath).toBe('/home/me/.codex/skills/crew/SKILL.md');
    expect(spec.frontmatterName).toBe('crew');
    expect(spec.legacyPathsToRemove).toEqual([]);
  });

  it('produces a sibling-flat path for crew:iterate', () => {
    const spec = codexAdapter.skillInstallSpecFor('/home/me', {
      id: 'crew:iterate',
      slug: 'iterate',
      bodyFile: 'crew-iterate.body.md',
      description: 'desc',
    });
    expect(spec.skillPath).toBe('/home/me/.codex/skills/crew-iterate/SKILL.md');
    expect(spec.frontmatterName).toBe('crew-iterate');
    expect(spec.legacyPathsToRemove).toEqual([]);
  });
});

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

describe('codexAdapter.writeAutoApproval / clearAutoApproval', () => {
  const TOOLS = ['list_agents', 'run_agent', 'merge_run'];

  it('appends one tools block per tool with approval_mode = "approve"', () => {
    const config = '[mcp_servers.crew]\ncommand = "x"\nargs = []\n';
    const out = codexAdapter.writeAutoApproval!(config, TOOLS);
    expect(out).toContain('[mcp_servers.crew]');
    expect(out).toContain('[mcp_servers.crew.tools.list_agents]\napproval_mode = "approve"');
    expect(out).toContain('[mcp_servers.crew.tools.run_agent]\napproval_mode = "approve"');
    expect(out).toContain('[mcp_servers.crew.tools.merge_run]\napproval_mode = "approve"');
  });

  it('places tools blocks immediately after the parent crew block', () => {
    const config =
      '[mcp_servers.other]\nfoo = "bar"\n\n' +
      '[mcp_servers.crew]\ncommand = "x"\nargs = []\n\n' +
      '[mcp_servers.notion]\nurl = "x"\n';
    const out = codexAdapter.writeAutoApproval!(config, ['run_agent']);
    const crewIdx = out.indexOf('[mcp_servers.crew]');
    const toolsIdx = out.indexOf('[mcp_servers.crew.tools.run_agent]');
    const notionIdx = out.indexOf('[mcp_servers.notion]');
    expect(crewIdx).toBeGreaterThanOrEqual(0);
    expect(toolsIdx).toBeGreaterThan(crewIdx);
    expect(notionIdx).toBeGreaterThan(toolsIdx);
  });

  it('overwrites pre-existing per-tool approval state (Finding 9 + auto-approve interaction)', () => {
    // Codex auto-creates [mcp_servers.crew.tools.X] with approval_mode =
    // "approve" or "prompt" when the user clicks "approve_for_session"
    // or "decline" in the TUI. crew-mcp install (with auto-approve) is
    // the explicit "always allow" consent — strip and rewrite. We
    // happen to write the same value codex's session-state does,
    // `"approve"`, but the test asserts there's no DUPLICATE block.
    const config =
      '[mcp_servers.crew]\ncommand = "x"\nargs = []\n\n' +
      '[mcp_servers.crew.tools.list_agents]\napproval_mode = "prompt"\n';
    const out = codexAdapter.writeAutoApproval!(config, ['list_agents', 'run_agent']);
    expect(out.match(/\[mcp_servers\.crew\.tools\.list_agents\]/g)).toHaveLength(1);
    expect(out).toContain('[mcp_servers.crew.tools.list_agents]\napproval_mode = "approve"');
    expect(out).toContain('[mcp_servers.crew.tools.run_agent]\napproval_mode = "approve"');
    expect(out).not.toContain('approval_mode = "prompt"');
  });

  it('is idempotent — writing twice produces the same output', () => {
    const config = '[mcp_servers.crew]\ncommand = "x"\nargs = []\n';
    const once = codexAdapter.writeAutoApproval!(config, TOOLS);
    const twice = codexAdapter.writeAutoApproval!(once, TOOLS);
    expect(twice).toBe(once);
  });

  it('preserves unrelated sections and comments', () => {
    const config =
      '# top-level comment\n' +
      '[mcp_servers.linear]\nurl = "x"\n\n' +
      '[mcp_servers.crew]\ncommand = "x"\nargs = []\n';
    const out = codexAdapter.writeAutoApproval!(config, ['run_agent']);
    expect(out).toContain('# top-level comment');
    expect(out).toContain('[mcp_servers.linear]');
  });

  it('clearAutoApproval removes all crew tools blocks but preserves the parent', () => {
    const config =
      '[mcp_servers.crew]\ncommand = "x"\nargs = []\n\n' +
      '[mcp_servers.crew.tools.list_agents]\napproval_mode = "approve"\n\n' +
      '[mcp_servers.crew.tools.run_agent]\napproval_mode = "approve"\n';
    const out = codexAdapter.clearAutoApproval!(config);
    expect(out).toContain('[mcp_servers.crew]');
    expect(out).not.toContain('[mcp_servers.crew.tools.');
  });

  it('clearAutoApproval is idempotent — running on cleared config is a no-op', () => {
    const config = '[mcp_servers.crew]\ncommand = "x"\nargs = []\n';
    expect(codexAdapter.clearAutoApproval!(config)).toBe(config);
  });

  it('clearAutoApproval preserves sister namespaces (codex.* but not crew.*)', () => {
    const config =
      '[mcp_servers.crew]\ncommand = "x"\nargs = []\n\n' +
      '[mcp_servers.crew.tools.run_agent]\napproval_mode = "approve"\n\n' +
      '[mcp_servers.linear.tools.list_issues]\napproval_mode = "approve"\n';
    const out = codexAdapter.clearAutoApproval!(config);
    expect(out).not.toContain('[mcp_servers.crew.tools.');
    expect(out).toContain('[mcp_servers.linear.tools.list_issues]');
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
