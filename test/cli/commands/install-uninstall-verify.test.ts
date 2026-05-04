/**
 * Integration tests for install / verify / uninstall.
 *
 * Each test gets a fresh tmpdir as $HOME and exercises the real
 * commands against it: skill files written, host configs merged,
 * manifest updated, then verify checks parity, uninstall reverses.
 *
 * Uses a stub `resolveCrewBinary` so tests don't depend on
 * process.argv[1] (which under vitest points at vitest itself).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { installCommand } from '../../../src/cli/commands/install.js';
import { uninstallCommand } from '../../../src/cli/commands/uninstall.js';
import { verifyCommand } from '../../../src/cli/commands/verify.js';
import { HOST_ADAPTERS } from '../../../src/install/hosts/index.js';
import { manifestPath } from '../../../src/install/install-manifest.js';

const STUB_BIN = {
  command: '/usr/local/bin/node',
  args: ['/abs/path/dist/index.js', 'serve'] as const,
};

describe('install / verify / uninstall — happy path', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'crew-install-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('install --target codex writes skill + config + manifest', async () => {
    const result = await installCommand({
      target: 'codex',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    });
    expect(result.installed).toEqual(['codex']);
    expect(result.skipped).toEqual([]);

    const adapter = HOST_ADAPTERS.codex;

    // Skill file written and contains body content
    const skill = readFileSync(adapter.skillPath(home), 'utf-8');
    expect(skill).toContain('## Crew — orchestration playbook');
    expect(skill).toContain('mcp__crew__run_agent');

    // Config file merged
    const config = readFileSync(adapter.configPath(home), 'utf-8');
    expect(config).toContain('[mcp_servers.crew]');
    expect(config).toContain(`command = "${STUB_BIN.command}"`);

    // Manifest written
    const manifest = JSON.parse(readFileSync(manifestPath(home), 'utf-8')) as {
      schemaVersion: number;
      targets: Record<string, { configPath: string; skillPath: string; version: string }>;
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.targets.codex).toBeDefined();
    expect(manifest.targets.codex.configPath).toBe(adapter.configPath(home));
    expect(manifest.targets.codex.skillPath).toBe(adapter.skillPath(home));
    expect(manifest.targets.codex.version).toMatch(/0\.2\.0/);
  });

  it('install --target all installs every host (with forceWithoutBinary)', async () => {
    const result = await installCommand({
      target: 'all',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    });
    expect(new Set(result.installed)).toEqual(
      new Set(['claude-code', 'codex', 'gemini']),
    );
    for (const id of ['claude-code', 'codex', 'gemini'] as const) {
      const adapter = HOST_ADAPTERS[id];
      expect(existsSync(adapter.skillPath(home))).toBe(true);
      expect(existsSync(adapter.configPath(home))).toBe(true);
    }
  });

  it('seeds <crewHome>/agents.json on first install with adapter defaults', async () => {
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-install-prefs-'));
    try {
      await installCommand({
        target: 'codex',
        home,
        crewHome,
        skipRunningCheck: true,
        forceWithoutBinary: true,
        resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
      });
      const prefsPath = join(crewHome, 'agents.json');
      expect(existsSync(prefsPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(prefsPath, 'utf-8'));
      // Every built-in adapter is seeded so users see all options when
      // they open the file.
      expect(parsed['claude-code']).toBeDefined();
      expect(parsed.codex).toBeDefined();
      expect(parsed['gemini-cli']).toBeDefined();
      expect(parsed.codex.effort).toBe('medium');
      // Comment field present for first-time users.
      expect(parsed._readme).toBeDefined();
    } finally {
      rmSync(crewHome, { recursive: true, force: true });
    }
  });

  it('does NOT overwrite an existing agents.json on subsequent installs', async () => {
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-install-prefs-'));
    try {
      // Pre-existing user customization.
      mkdirSync(crewHome, { recursive: true });
      writeFileSync(
        join(crewHome, 'agents.json'),
        JSON.stringify({ codex: { strengths: ['user-edit'] } }, null, 2),
        'utf-8',
      );
      await installCommand({
        target: 'codex',
        home,
        crewHome,
        skipRunningCheck: true,
        forceWithoutBinary: true,
        resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
      });
      const parsed = JSON.parse(readFileSync(join(crewHome, 'agents.json'), 'utf-8'));
      expect(parsed.codex.strengths).toEqual(['user-edit']);
      // Other adapters NOT injected — install respects the user file shape.
      expect(parsed['claude-code']).toBeUndefined();
    } finally {
      rmSync(crewHome, { recursive: true, force: true });
    }
  });

  it('install is idempotent — running twice yields the same end state', async () => {
    const args = {
      target: 'codex',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    };
    await installCommand(args);
    const skill1 = readFileSync(HOST_ADAPTERS.codex.skillPath(home), 'utf-8');
    const config1 = readFileSync(HOST_ADAPTERS.codex.configPath(home), 'utf-8');

    await installCommand(args);
    const skill2 = readFileSync(HOST_ADAPTERS.codex.skillPath(home), 'utf-8');
    const config2 = readFileSync(HOST_ADAPTERS.codex.configPath(home), 'utf-8');

    expect(skill2).toBe(skill1);
    expect(config2).toBe(config1);
  });

  it('install preserves unrelated keys in claude-code config', async () => {
    const adapter = HOST_ADAPTERS['claude-code'];
    // Pre-existing config with other keys
    const preExisting = JSON.stringify({
      preferredModel: 'opus',
      mcpServers: { other: { command: 'foo', args: [] } },
    });
    writeFileSync(adapter.configPath(home), preExisting, 'utf-8');

    await installCommand({
      target: 'claude-code',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    });

    const after = JSON.parse(readFileSync(adapter.configPath(home), 'utf-8')) as Record<
      string,
      unknown
    > & { mcpServers: Record<string, unknown> };
    expect(after.preferredModel).toBe('opus');
    expect(after.mcpServers.other).toEqual({ command: 'foo', args: [] });
    expect(after.mcpServers.crew).toBeDefined();
  });

  it('verify reports ok after a clean install', async () => {
    await installCommand({
      target: 'codex',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    });
    const report = await verifyCommand({ home });
    expect(report.ok).toBe(true);
    expect(report.targets).toHaveLength(1);
    expect(report.targets[0].host).toBe('codex');
    expect(report.targets[0].issues).toEqual([]);
  });

  it('verify with no installed targets returns ok + a note', async () => {
    const report = await verifyCommand({ home });
    expect(report.ok).toBe(true);
    expect(report.note).toContain('No installed targets');
    expect(report.targets).toEqual([]);
  });

  it('verify reports drift when skill file is missing', async () => {
    await installCommand({
      target: 'codex',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    });
    rmSync(HOST_ADAPTERS.codex.skillPath(home));

    const report = await verifyCommand({ home });
    expect(report.ok).toBe(false);
    expect(report.targets[0].issues.some((i) => i.includes('skill file missing'))).toBe(true);
  });

  it('verify reports drift when skill is missing a tool reference', async () => {
    await installCommand({
      target: 'codex',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    });
    const skillPath = HOST_ADAPTERS.codex.skillPath(home);
    const original = readFileSync(skillPath, 'utf-8');
    const corrupted = original.replace(/mcp__crew__merge_run/g, 'NUKED');
    writeFileSync(skillPath, corrupted, 'utf-8');

    const report = await verifyCommand({ home });
    expect(report.ok).toBe(false);
    const issues = report.targets[0].issues.join('\n');
    expect(issues).toMatch(/missing tool references.*merge_run/);
  });

  it('verify reports drift when host config has crew block removed', async () => {
    await installCommand({
      target: 'codex',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    });
    const configPath = HOST_ADAPTERS.codex.configPath(home);
    writeFileSync(configPath, '# emptied\n', 'utf-8');

    const report = await verifyCommand({ home });
    expect(report.ok).toBe(false);
    expect(
      report.targets[0].issues.some((i) => i.includes('crew MCP block')),
    ).toBe(true);
  });

  it('uninstall reverses install (skill + config block + manifest)', async () => {
    const adapter = HOST_ADAPTERS.codex;
    await installCommand({
      target: 'codex',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    });
    expect(existsSync(adapter.skillPath(home))).toBe(true);

    const result = await uninstallCommand({ target: 'codex', home });
    expect(result.removed).toEqual(['codex']);
    expect(result.skipped).toEqual([]);

    expect(existsSync(adapter.skillPath(home))).toBe(false);
    const config = readFileSync(adapter.configPath(home), 'utf-8');
    expect(config).not.toContain('[mcp_servers.crew]');

    const manifest = JSON.parse(readFileSync(manifestPath(home), 'utf-8')) as {
      targets: Record<string, unknown>;
    };
    expect(manifest.targets.codex).toBeUndefined();
  });

  it('uninstall is idempotent — repeated calls are no-ops', async () => {
    await installCommand({
      target: 'codex',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    });
    const first = await uninstallCommand({ target: 'codex', home });
    const second = await uninstallCommand({ target: 'codex', home });
    expect(first.removed).toEqual(['codex']);
    expect(second.removed).toEqual(['codex']);
    // No crashes, manifest still has codex deleted
    const manifest = JSON.parse(readFileSync(manifestPath(home), 'utf-8')) as {
      targets: Record<string, unknown>;
    };
    expect(manifest.targets.codex).toBeUndefined();
  });

  it('uninstall reads skillPath from manifest, cleaning up legacy v0.2.0-dev paths (Finding 5)', async () => {
    const adapter = HOST_ADAPTERS.codex;
    const currentSkillPath = adapter.skillPath(home);
    const legacySkillPath = join(home, '.codex', 'prompts', 'crew.md');

    // Simulate a v0.2.0-dev install: skill at the OLD path, manifest
    // captured the OLD path, no skill at the new adapter path.
    await installCommand({
      target: 'codex',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    });
    // Move the just-installed skill file to the legacy location and
    // rewrite the manifest entry to match — this is what a v0.2.0-dev
    // install left behind on disk.
    const skillContent = readFileSync(currentSkillPath, 'utf-8');
    rmSync(currentSkillPath, { force: true });
    mkdirSync(dirname(legacySkillPath), { recursive: true });
    writeFileSync(legacySkillPath, skillContent, 'utf-8');
    const manifest = JSON.parse(readFileSync(manifestPath(home), 'utf-8')) as {
      schemaVersion: 1;
      targets: Record<string, { configPath: string; skillPath: string; version: string; installedAt: string; serverCommand: string; serverArgs: string[] }>;
    };
    manifest.targets.codex.skillPath = legacySkillPath;
    writeFileSync(manifestPath(home), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    expect(existsSync(legacySkillPath)).toBe(true);
    expect(existsSync(currentSkillPath)).toBe(false);

    // Uninstall must clean up the legacy path even though the current
    // adapter.skillPath() returns the new path.
    const result = await uninstallCommand({ target: 'codex', home });
    expect(result.removed).toEqual(['codex']);
    expect(existsSync(legacySkillPath)).toBe(false);
  });

  it('install (default) writes auto-approval for Codex (per-tool blocks)', async () => {
    await installCommand({
      target: 'codex',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    });
    const config = readFileSync(HOST_ADAPTERS.codex.configPath(home), 'utf-8');
    // All 6 catalog tools get pre-approval blocks.
    for (const tool of ['list_agents', 'run_agent', 'continue_run', 'merge_run', 'discard_run', 'get_run_status']) {
      expect(config).toContain(`[mcp_servers.crew.tools.${tool}]\napproval_mode = "always"`);
    }
    // Manifest records that auto-approval was applied.
    const manifest = JSON.parse(readFileSync(manifestPath(home), 'utf-8')) as {
      targets: Record<string, { autoApproved?: boolean }>;
    };
    expect(manifest.targets.codex.autoApproved).toBe(true);
  });

  it('install --no-auto-approve skips writing per-tool blocks (Codex)', async () => {
    await installCommand({
      target: 'codex',
      home,
      autoApprove: false,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    });
    const config = readFileSync(HOST_ADAPTERS.codex.configPath(home), 'utf-8');
    expect(config).toContain('[mcp_servers.crew]'); // parent still installed
    expect(config).not.toContain('[mcp_servers.crew.tools.');
    const manifest = JSON.parse(readFileSync(manifestPath(home), 'utf-8')) as {
      targets: Record<string, { autoApproved?: boolean }>;
    };
    expect(manifest.targets.codex.autoApproved).toBe(false);
  });

  it('install --no-auto-approve clears prior auto-approval (post-install state matches flag)', async () => {
    // First install with auto-approve (default).
    await installCommand({
      target: 'codex',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    });
    expect(readFileSync(HOST_ADAPTERS.codex.configPath(home), 'utf-8')).toContain(
      '[mcp_servers.crew.tools.run_agent]',
    );
    // Re-install with --no-auto-approve.
    await installCommand({
      target: 'codex',
      home,
      autoApprove: false,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    });
    const config = readFileSync(HOST_ADAPTERS.codex.configPath(home), 'utf-8');
    expect(config).not.toContain('[mcp_servers.crew.tools.');
  });

  it('install (default) writes mcp__crew__* to permissions.allow (Claude Code)', async () => {
    const adapter = HOST_ADAPTERS['claude-code'];
    await installCommand({
      target: 'claude-code',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    });
    const permissions = JSON.parse(readFileSync(adapter.permissionsPath!(home), 'utf-8')) as {
      permissions: { allow: string[] };
    };
    expect(permissions.permissions.allow).toContain('mcp__crew__*');
  });

  it('install (default) sets trust:true on Gemini', async () => {
    const adapter = HOST_ADAPTERS.gemini;
    await installCommand({
      target: 'gemini',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    });
    const config = JSON.parse(readFileSync(adapter.configPath(home), 'utf-8')) as {
      mcpServers: { crew: { trust?: boolean } };
    };
    expect(config.mcpServers.crew.trust).toBe(true);
  });

  it('uninstall clears auto-approval (Codex tool blocks gone)', async () => {
    await installCommand({
      target: 'codex',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    });
    await uninstallCommand({ target: 'codex', home });
    if (existsSync(HOST_ADAPTERS.codex.configPath(home))) {
      const config = readFileSync(HOST_ADAPTERS.codex.configPath(home), 'utf-8');
      expect(config).not.toContain('[mcp_servers.crew.tools.');
      expect(config).not.toContain('[mcp_servers.crew]');
    }
  });

  it('uninstall clears mcp__crew__* from Claude Code permissions.allow', async () => {
    const adapter = HOST_ADAPTERS['claude-code'];
    // Pre-populate the permissions file with the user's own entries.
    const permissionsPath = adapter.permissionsPath!(home);
    mkdirSync(dirname(permissionsPath), { recursive: true });
    writeFileSync(
      permissionsPath,
      JSON.stringify({ permissions: { allow: ['Bash(git:*)', 'Read'] } }),
      'utf-8',
    );

    await installCommand({
      target: 'claude-code',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    });
    await uninstallCommand({ target: 'claude-code', home });

    const permissions = JSON.parse(readFileSync(permissionsPath, 'utf-8')) as {
      permissions: { allow: string[] };
    };
    expect(permissions.permissions.allow).toEqual(['Bash(git:*)', 'Read']);
    expect(permissions.permissions.allow).not.toContain('mcp__crew__*');
  });

  it('uninstall preserves unrelated mcpServers entries (claude-code)', async () => {
    const adapter = HOST_ADAPTERS['claude-code'];
    const preExisting = JSON.stringify({
      mcpServers: { other: { command: 'foo', args: [] } },
    });
    writeFileSync(adapter.configPath(home), preExisting, 'utf-8');

    await installCommand({
      target: 'claude-code',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    });
    await uninstallCommand({ target: 'claude-code', home });

    const after = JSON.parse(readFileSync(adapter.configPath(home), 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(after.mcpServers.other).toEqual({ command: 'foo', args: [] });
    expect(after.mcpServers.crew).toBeUndefined();
  });

  it('install without --target dispatches to the interactive selector (TTY path)', async () => {
    let receivedHosts: ReadonlyArray<{ id: string; installed: boolean }> = [];
    const result = await installCommand({
      // target omitted → interactive fallback
      home,
      skipRunningCheck: true,
      isInteractive: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
      selectTargets: async (hosts) => {
        receivedHosts = hosts;
        // Stub: pick claude-code regardless of detection.
        return ['claude-code'];
      },
    });
    expect(result.installed).toEqual(['claude-code']);
    // Selector saw all 3 registered hosts with detection results.
    expect(receivedHosts.map((h) => h.id).sort()).toEqual(['claude-code', 'codex', 'gemini']);
    // The forced install path should still write even if the host wasn't on PATH.
    expect(existsSync(HOST_ADAPTERS['claude-code'].skillPath(home))).toBe(true);
  });

  it('install without --target in non-interactive mode does NOT call the selector', async () => {
    // Non-interactive (CI/pipe) → auto-install detected hosts without
    // prompting. The selector must not be invoked. Whether any hosts
    // are detected depends on the test environment's PATH, which we
    // don't control here — assert only on the no-prompt invariant.
    let selectorCalled = false;
    await installCommand({
      home,
      skipRunningCheck: true,
      isInteractive: false,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
      selectTargets: async () => {
        selectorCalled = true;
        return [];
      },
    });
    expect(selectorCalled).toBe(false);
  });

  it('install without --target and selector returning [] exits cleanly (cancel)', async () => {
    const result = await installCommand({
      home,
      skipRunningCheck: true,
      isInteractive: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
      selectTargets: async () => [],
    });
    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});

describe('resolveTargets', () => {
  it('parses comma-separated targets', async () => {
    const home = mkdtempSync(join(tmpdir(), 'crew-install-'));
    try {
      const result = await installCommand({
        target: 'codex,gemini',
        home,
        skipRunningCheck: true,
        forceWithoutBinary: true,
        resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
      });
      expect(new Set(result.installed)).toEqual(new Set(['codex', 'gemini']));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('throws on unknown target ids', async () => {
    await expect(
      installCommand({
        target: 'no-such-host',
        home: '/tmp',
        forceWithoutBinary: true,
        resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
      }),
    ).rejects.toThrow(/unknown target/);
  });
});
