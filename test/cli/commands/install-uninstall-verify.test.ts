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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { installCommand } from '../../../src/cli/commands/install.js';
import { uninstallCommand } from '../../../src/cli/commands/uninstall.js';
import { verifyCommand } from '../../../src/cli/commands/verify.js';
import { HOST_ADAPTERS } from '../../../src/install/hosts/index.js';
import { manifestPath } from '../../../src/install/install-manifest.js';
import { projectManifestPath } from '../../../src/install/project-install-manifest.js';
import { CATALOG_TOOLS } from '../../../src/install/tool-catalog.js';
import { logger } from '../../../src/utils/logger.js';

const STUB_BIN = {
  command: '/usr/local/bin/node',
  args: ['/abs/path/dist/index.js', 'serve'] as const,
};
const STUB_CREW_WAIT = '/usr/local/bin/crew-wait';
const CLAUDE_CREW_WAIT_ON_PATH = {
  isCrewWaitOnPath: () => true,
  resolveCrewWaitBinary: () => STUB_CREW_WAIT,
};

describe('install / verify / uninstall — happy path', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'crew-install-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('install --target codex writes skill + config + manifest', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const result = await installCommand({
      target: 'codex',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
      ...CLAUDE_CREW_WAIT_ON_PATH,
    });
    expect(result.installed).toEqual(['codex']);
    expect(result.skipped).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      'Run `crew-mcp agents add` to register additional models (Ollama, LM Studio, OpenAI-compatible endpoints).',
    );

    const adapter = HOST_ADAPTERS.codex;

    // Skill file written and contains body content
    const skill = readFileSync(adapter.skillPath(home), 'utf-8');
    expect(skill).toContain('## Crew — orchestration playbook');
    expect(skill).toContain('mcp__crew__run_agent');

    // crew:iterate sub-skill also written (Phase 2 of crew-iterate-skill plan)
    const iteratePath = adapter.skillInstallSpecFor(home, {
      id: 'crew:iterate',
      slug: 'iterate',
      bodyFile: 'crew-iterate.body.md',
      description: '',
    }).skillPath;
    expect(existsSync(iteratePath)).toBe(true);
    const iterateSkill = readFileSync(iteratePath, 'utf-8');
    expect(iterateSkill).toContain('acceptance criteria');
    expect(iterateSkill).toContain('Step 0');
    expect(iterateSkill).toContain('mcp__crew__run_agent');

    // Config file merged
    const config = readFileSync(adapter.configPath(home), 'utf-8');
    expect(config).toContain('[mcp_servers.crew]');
    expect(config).toContain(`command = "${STUB_BIN.command}"`);

    // Manifest written (v2 schema; multi-skill `skills` map).
    const manifest = JSON.parse(readFileSync(manifestPath(home), 'utf-8')) as {
      schemaVersion: number;
      targets: Record<string, {
        configPath: string;
        skillPath: string;
        skills: Record<string, string>;
        writtenPaths: string[];
        version: string;
        crewWaitCommand: string;
      }>;
    };
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.targets.codex).toBeDefined();
    expect(manifest.targets.codex.configPath).toBe(adapter.configPath(home));
    expect(manifest.targets.codex.skillPath).toBe(adapter.skillPath(home));
    expect(manifest.targets.codex.skills.crew).toBe(adapter.skillPath(home));
    expect(manifest.targets.codex.skills['crew:iterate']).toMatch(/crew-iterate\/SKILL\.md$/);
    expect(manifest.targets.codex.writtenPaths).toContain(adapter.skillPath(home));
    expect(manifest.targets.codex.version).toMatch(/0\.2\.0/);
    expect(manifest.targets.codex.crewWaitCommand).toBe('crew-wait');
  });

  it('install --target all installs every host (with forceWithoutBinary)', async () => {
    const result = await installCommand({
      target: 'all',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
      ...CLAUDE_CREW_WAIT_ON_PATH,
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
      expect(parsed.codex.useWhen).toBe(
        'Prefer for well-scoped implementation and long unattended loops — fast at churning through mechanical changes.',
      );
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
      expect(parsed.codex.useWhen).toBeUndefined();
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
      ...CLAUDE_CREW_WAIT_ON_PATH,
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
      ...CLAUDE_CREW_WAIT_ON_PATH,
    });
    const report = await verifyCommand({ home });
    expect(report.ok).toBe(true);
    expect(report.targets).toHaveLength(1);
    expect(report.targets[0].host).toBe('codex');
    expect(report.targets[0].issues).toEqual([]);
  });

  it('verify checks Claude Code crew-wait allowlist against the stored command', async () => {
    const adapter = HOST_ADAPTERS['claude-code'];
    await installCommand({
      target: 'claude-code',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
      isCrewWaitOnPath: () => false,
      resolveCrewWaitBinary: () => STUB_CREW_WAIT,
    });
    const clean = await verifyCommand({ home });
    expect(clean.ok).toBe(true);

    const permissionsPath = adapter.permissionsPath!(home);
    const permissions = readFileSync(permissionsPath, 'utf-8')
      .replace(`Bash(${STUB_CREW_WAIT}:*)`, 'Bash(crew-wait:*)');
    writeFileSync(permissionsPath, permissions, 'utf-8');

    const drift = await verifyCommand({ home });
    expect(drift.ok).toBe(false);
    expect(drift.targets[0].issues).toContain(
      `Claude Code permissions missing Bash(${STUB_CREW_WAIT}:*) allowlist`,
    );
  });

  it('verify reports state-locks/ writable when the crew home allows probes', async () => {
    const report = await verifyCommand({ home });
    const probe = report.probes.find((item) => item.name === 'state-locks-writable');

    expect(report.ok).toBe(true);
    expect(probe).toMatchObject({
      status: 'ok',
      message: expect.stringContaining('state-locks/'),
    });
    expect(existsSync(join(home, '.crew', 'state-locks'))).toBe(true);
  });

  it('verify reports panels/ writable when the crew home allows probes', async () => {
    const report = await verifyCommand({ home });
    const probe = report.probes.find((item) => item.name === 'panels-writable');

    expect(report.ok).toBe(true);
    expect(probe).toMatchObject({
      status: 'ok',
      message: expect.stringContaining('panels/'),
    });
    expect(existsSync(join(home, '.crew', 'panels'))).toBe(true);
  });

  it('verify reports a clear state-locks/ error when the crew home is unwritable', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }

    const crewHome = join(home, '.crew');
    mkdirSync(crewHome, { recursive: true });
    chmodSync(crewHome, 0o500);

    try {
      const report = await verifyCommand({ home });
      const probe = report.probes.find((item) => item.name === 'state-locks-writable');

      expect(report.ok).toBe(false);
      expect(probe?.status).toBe('error');
      expect(probe?.message).toContain('state-locks/');
      expect(probe?.message).toContain(join(crewHome, 'state-locks'));
      expect(probe?.message).toMatch(/EACCES|EPERM/);
      expect(probe?.message).toContain('Fix permissions');
    } finally {
      chmodSync(crewHome, 0o700);
    }
  });

  it('verify reports a clear panels/ error when the panels dir is unwritable', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }

    const crewHome = join(home, '.crew');
    const panelsDir = join(crewHome, 'panels');
    mkdirSync(panelsDir, { recursive: true });
    chmodSync(panelsDir, 0o500);

    try {
      const report = await verifyCommand({ home });
      const probe = report.probes.find((item) => item.name === 'panels-writable');

      expect(report.ok).toBe(false);
      expect(probe?.status).toBe('error');
      expect(probe?.message).toContain('panels/');
      expect(probe?.message).toContain(panelsDir);
      expect(probe?.message).toMatch(/EACCES|EPERM/);
      expect(probe?.message).toContain('Fix permissions');
    } finally {
      chmodSync(panelsDir, 0o700);
    }
  });

  it('verify validates peer_messages caps and pipeline under default caps', async () => {
    const report = await verifyCommand({ home, env: {} });
    const probe = report.probes.find((item) => item.name === 'peer-messages-caps-pipeline');

    expect(report.ok).toBe(true);
    expect(probe).toEqual({
      name: 'peer-messages-caps-pipeline',
      status: 'ok',
      message: 'peer_messages caps and pipeline validate',
    });
  });

  it('verify warns but does not fail when peer_messages cap overrides are invalid', async () => {
    const report = await verifyCommand({
      home,
      env: {
        CREW_PEER_MESSAGES_PREPEND_CAP_CHARS: String(256 * 1024),
      },
    });
    const probe = report.probes.find((item) => item.name === 'peer-messages-caps-pipeline');

    expect(report.ok).toBe(true);
    expect(probe).toEqual({
      name: 'peer-messages-caps-pipeline',
      status: 'warn',
      message: 'peer_messages.cap_overrides_invalid: aggregate',
    });
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
      ...CLAUDE_CREW_WAIT_ON_PATH,
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
      ...CLAUDE_CREW_WAIT_ON_PATH,
    });
    // Verify unions tool references across ALL installed skill files
    // (per crew-iterate-skill plan §verify parity). Corrupt every
    // skill that was written so the union is genuinely missing the
    // reference.
    const manifest = JSON.parse(readFileSync(manifestPath(home), 'utf-8')) as {
      targets: Record<string, { skills?: Record<string, string>; skillPath: string }>;
    };
    const codexTarget = manifest.targets.codex;
    const allSkillPaths = codexTarget.skills
      ? Object.values(codexTarget.skills)
      : [codexTarget.skillPath];
    for (const skillPath of allSkillPaths) {
      const original = readFileSync(skillPath, 'utf-8');
      const corrupted = original.replace(/mcp__crew__merge_run/g, 'NUKED');
      writeFileSync(skillPath, corrupted, 'utf-8');
    }

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
      ...CLAUDE_CREW_WAIT_ON_PATH,
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
      ...CLAUDE_CREW_WAIT_ON_PATH,
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
      expect(config).toContain(`[mcp_servers.crew.tools.${tool}]\napproval_mode = "approve"`);
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
      ...CLAUDE_CREW_WAIT_ON_PATH,
    });
    const permissions = JSON.parse(readFileSync(adapter.permissionsPath!(home), 'utf-8')) as {
      permissions: { allow: string[] };
    };
    expect(permissions.permissions.allow).toContain('mcp__crew__*');
    expect(permissions.permissions.allow).toContain('Bash(crew-wait:*)');
  });

  it('install adds the PATH crew-wait Bash allowlist for Claude Code', async () => {
    const adapter = HOST_ADAPTERS['claude-code'];
    await installCommand({
      target: 'claude-code',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
      isCrewWaitOnPath: () => true,
      resolveCrewWaitBinary: () => {
        throw new Error('absolute resolver should not run when PATH check passes');
      },
    });

    const permissions = JSON.parse(readFileSync(adapter.permissionsPath!(home), 'utf-8')) as {
      permissions: { allow: string[] };
    };
    expect(permissions.permissions.allow).toContain('Bash(crew-wait:*)');
  });

  it('install falls back to an absolute crew-wait Bash allowlist for Claude Code', async () => {
    const adapter = HOST_ADAPTERS['claude-code'];
    await installCommand({
      target: 'claude-code',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
      isCrewWaitOnPath: () => false,
      resolveCrewWaitBinary: () => STUB_CREW_WAIT,
    });

    const permissions = JSON.parse(readFileSync(adapter.permissionsPath!(home), 'utf-8')) as {
      permissions: { allow: string[] };
    };
    expect(permissions.permissions.allow).toContain(`Bash(${STUB_CREW_WAIT}:*)`);
    expect(permissions.permissions.allow).not.toContain('Bash(crew-wait:*)');
    const manifest = JSON.parse(readFileSync(manifestPath(home), 'utf-8')) as {
      targets: Record<string, { crewWaitCommand: string }>;
    };
    expect(manifest.targets['claude-code'].crewWaitCommand).toBe(STUB_CREW_WAIT);
  });

  it('install is idempotent for the Claude Code crew-wait Bash allowlist', async () => {
    const adapter = HOST_ADAPTERS['claude-code'];
    const args = {
      target: 'claude-code',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
      ...CLAUDE_CREW_WAIT_ON_PATH,
    };
    await installCommand(args);
    await installCommand(args);

    const permissions = JSON.parse(readFileSync(adapter.permissionsPath!(home), 'utf-8')) as {
      permissions: { allow: string[] };
    };
    expect(permissions.permissions.allow.filter((entry) => entry === 'Bash(crew-wait:*)')).toHaveLength(1);
  });

  it('install (default) sets trust:true on Gemini', async () => {
    const adapter = HOST_ADAPTERS.gemini;
    await installCommand({
      target: 'gemini',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
      ...CLAUDE_CREW_WAIT_ON_PATH,
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
      ...CLAUDE_CREW_WAIT_ON_PATH,
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
      ...CLAUDE_CREW_WAIT_ON_PATH,
    });
    await uninstallCommand({ target: 'claude-code', home });

    const permissions = JSON.parse(readFileSync(permissionsPath, 'utf-8')) as {
      permissions: { allow: string[] };
    };
    expect(permissions.permissions.allow).toEqual(['Bash(git:*)', 'Read']);
    expect(permissions.permissions.allow).not.toContain('mcp__crew__*');
    expect(permissions.permissions.allow).not.toContain('Bash(crew-wait:*)');
  });

  it('uninstall clears absolute crew-wait allowlist entries from Claude Code', async () => {
    const adapter = HOST_ADAPTERS['claude-code'];
    const permissionsPath = adapter.permissionsPath!(home);
    mkdirSync(dirname(permissionsPath), { recursive: true });
    writeFileSync(
      permissionsPath,
      JSON.stringify({ permissions: { allow: ['Read'] } }),
      'utf-8',
    );

    await installCommand({
      target: 'claude-code',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
      isCrewWaitOnPath: () => false,
      resolveCrewWaitBinary: () => STUB_CREW_WAIT,
    });
    await uninstallCommand({ target: 'claude-code', home });

    const permissions = JSON.parse(readFileSync(permissionsPath, 'utf-8')) as {
      permissions: { allow: string[] };
    };
    expect(permissions.permissions.allow).toContain('Read');
    expect(permissions.permissions.allow).not.toContain(`Bash(${STUB_CREW_WAIT}:*)`);
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
      ...CLAUDE_CREW_WAIT_ON_PATH,
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
      ...CLAUDE_CREW_WAIT_ON_PATH,
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

  it('preflight refuses to overwrite a non-crew-owned SKILL.md', async () => {
    // Plan §"Atomicity & locking requirements" preflight collision
    // check: if a target SKILL.md exists at the install destination
    // AND wasn't recorded as crew-owned in the manifest, refuse.
    const adapter = HOST_ADAPTERS.codex;
    const skillPath = adapter.skillPath(home);
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, '# user-authored skill file, not ours\n', 'utf-8');

    const result = await installCommand({
      target: 'codex',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    });
    expect(result.installed).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/refusing to overwrite/);
    // User's file is untouched.
    expect(readFileSync(skillPath, 'utf-8')).toBe('# user-authored skill file, not ours\n');
  });

  it('after a successful install, no .crew-staging-* or .crew-backup-* files remain', async () => {
    // Hygiene check for the two-phase commit (plan §"Per-host migration"
    // steps 4-5): renderAndWriteSkills must clean up both the staging
    // sibling files (after rename in Phase 2) and any backup files
    // (after Phase 2 success).
    const args = {
      target: 'codex',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    };
    await installCommand(args);

    // Reinstall — this exercises the backup-existing-then-rename path.
    await installCommand(args);

    // Walk both crew-skill directories and assert no leftover artifacts.
    const skillRoots = [
      join(home, '.codex', 'skills', 'crew'),
      join(home, '.codex', 'skills', 'crew-iterate'),
    ];
    for (const root of skillRoots) {
      const entries = readdirSync(root);
      const leftovers = entries.filter((f) =>
        f.includes('.crew-staging-') || f.includes('.crew-backup-'),
      );
      expect(leftovers).toEqual([]);
    }
  });

  it('Phase 1 render failure leaves no skill files written and no staging leftovers', async () => {
    // Point install at a packageRoot whose skills/ directory is
    // missing crew-iterate.body.md. Phase 1 will render the umbrella
    // skill OK, write it to a staging sibling, then fail trying to
    // load the iterate body. Phase 2 must NOT have run (nothing on
    // final destinations) and the staging files must be cleaned up.
    const pkgRoot = mkdtempSync(join(tmpdir(), 'crew-pkg-partial-'));
    try {
      // Copy targets/ verbatim — they don't depend on the bodies.
      const srcTargets = join(process.cwd(), 'skills', 'targets');
      const dstTargets = join(pkgRoot, 'skills', 'targets');
      mkdirSync(dstTargets, { recursive: true });
      for (const f of readdirSync(srcTargets)) {
        writeFileSync(
          join(dstTargets, f),
          readFileSync(join(srcTargets, f), 'utf-8'),
          'utf-8',
        );
      }
      // Only the umbrella body — iterate body is intentionally absent.
      writeFileSync(
        join(pkgRoot, 'skills', 'crew-captain.body.md'),
        '## Crew umbrella\n\n{{TOOL_LIST}}\n',
        'utf-8',
      );

      const result = await installCommand({
        target: 'codex',
        home,
        packageRoot: pkgRoot,
        skipRunningCheck: true,
        forceWithoutBinary: true,
        resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
      });
      expect(result.installed).toEqual([]);
      expect(result.skipped).toHaveLength(1);

      // Final destinations untouched (Phase 2 never ran).
      const adapter = HOST_ADAPTERS.codex;
      expect(existsSync(adapter.skillPath(home))).toBe(false);
      const iteratePath = join(home, '.codex', 'skills', 'crew-iterate', 'SKILL.md');
      expect(existsSync(iteratePath)).toBe(false);

      // Staging hygiene: no leftover .crew-staging-* siblings anywhere
      // under the host's skills dir.
      const crewSkillDir = join(home, '.codex', 'skills', 'crew');
      const iterateSkillDir = join(home, '.codex', 'skills', 'crew-iterate');
      for (const dir of [crewSkillDir, iterateSkillDir]) {
        if (!existsSync(dir)) continue;
        const leftovers = readdirSync(dir).filter((f) => f.includes('.crew-staging-'));
        expect(leftovers).toEqual([]);
      }
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  it('Phase 1 render failure preserves prior install content (no half-overwrite)', async () => {
    // Full install with the real package root → both skills land.
    await installCommand({
      target: 'codex',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    });
    const adapter = HOST_ADAPTERS.codex;
    const umbrellaBefore = readFileSync(adapter.skillPath(home), 'utf-8');
    const iteratePath = join(home, '.codex', 'skills', 'crew-iterate', 'SKILL.md');
    const iterateBefore = readFileSync(iteratePath, 'utf-8');

    // Re-install against a broken packageRoot (missing iterate body).
    const pkgRoot = mkdtempSync(join(tmpdir(), 'crew-pkg-partial-'));
    try {
      const srcTargets = join(process.cwd(), 'skills', 'targets');
      const dstTargets = join(pkgRoot, 'skills', 'targets');
      mkdirSync(dstTargets, { recursive: true });
      for (const f of readdirSync(srcTargets)) {
        writeFileSync(
          join(dstTargets, f),
          readFileSync(join(srcTargets, f), 'utf-8'),
          'utf-8',
        );
      }
      // Umbrella present, iterate absent — render of iterate will throw.
      writeFileSync(
        join(pkgRoot, 'skills', 'crew-captain.body.md'),
        '## Different umbrella content\n\n{{TOOL_LIST}}\n',
        'utf-8',
      );

      const result = await installCommand({
        target: 'codex',
        home,
        packageRoot: pkgRoot,
        skipRunningCheck: true,
        forceWithoutBinary: true,
        resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
      });
      expect(result.installed).toEqual([]);

      // Prior files MUST remain — the failed install must not have
      // replaced the umbrella with the new (different) content.
      expect(readFileSync(adapter.skillPath(home), 'utf-8')).toBe(umbrellaBefore);
      expect(readFileSync(iteratePath, 'utf-8')).toBe(iterateBefore);
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  it('preflight allows re-install over a crew-owned SKILL.md (idempotency preserved)', async () => {
    // After a successful install, the SKILL.md is in writtenPaths;
    // re-running install MUST NOT trip the preflight.
    const args = {
      target: 'codex',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
    };
    await installCommand(args);
    const result = await installCommand(args);
    expect(result.installed).toEqual(['codex']);
    expect(result.skipped).toEqual([]);
  });
});

describe('project-scope install / verify / uninstall', () => {
  let home: string;
  let repoRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'crew-project-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'crew-project-repo-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function repoFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        const rel = abs.slice(repoRoot.length + 1);
        if (entry.isDirectory()) {
          walk(abs);
        } else {
          out.push(rel);
        }
      }
    };
    walk(repoRoot);
    return out.sort();
  }

  async function installProjectAll(): Promise<void> {
    const result = await installCommand({
      scope: 'project',
      target: 'claude-code,codex',
      home,
      repoRoot,
      skipRunningCheck: true,
    });
    expect(result.installed).toEqual(['claude-code', 'codex']);
    expect(result.skipped).toEqual([]);
  }

  it('install --scope project writes portable Claude and Codex project files only', async () => {
    await installProjectAll();

    expect(repoFiles()).toEqual([
      '.claude/settings.json',
      '.claude/skills/crew-iterate/SKILL.md',
      '.claude/skills/crew/SKILL.md',
      '.codex/config.toml',
      '.codex/skills/crew-iterate/SKILL.md',
      '.codex/skills/crew/SKILL.md',
      '.crew/install.project.json',
      '.mcp.json',
    ]);
    expect(existsSync(manifestPath(home))).toBe(false);
    expect(existsSync(join(home, '.crew', 'agents.json'))).toBe(false);

    const claudeConfig = JSON.parse(readFileSync(join(repoRoot, '.mcp.json'), 'utf-8')) as {
      mcpServers: { crew: { command: string; args: string[] } };
    };
    expect(claudeConfig.mcpServers.crew).toEqual({
      command: './node_modules/.bin/crew-mcp',
      args: ['serve'],
    });

    const codexConfig = readFileSync(join(repoRoot, '.codex', 'config.toml'), 'utf-8');
    expect(codexConfig).toContain('command = "./node_modules/.bin/crew-mcp"');
    for (const tool of CATALOG_TOOLS) {
      expect(codexConfig).toContain(
        `[mcp_servers.crew.tools.${tool.name}]\napproval_mode = "approve"`,
      );
    }

    const permissions = JSON.parse(readFileSync(join(repoRoot, '.claude', 'settings.json'), 'utf-8')) as {
      permissions: { allow: string[] };
    };
    expect(permissions.permissions.allow).toContain('mcp__crew__*');
    expect(permissions.permissions.allow).toContain('Bash(./node_modules/.bin/crew-wait:*)');

    const manifest = JSON.parse(readFileSync(projectManifestPath(repoRoot), 'utf-8')) as {
      scope: string;
      targets: Record<string, {
        configPath: string;
        writtenPaths: string[];
        serverCommand: string;
        serverArgs: string[];
        crewWaitCommand: string;
      }>;
    };
    expect(manifest.scope).toBe('project');
    expect(manifest.targets['claude-code'].crewWaitCommand).toBe('./node_modules/.bin/crew-wait');
    expect(manifest.targets.codex.configPath).toBe('.codex/config.toml');
    expect(manifest.targets.codex.serverCommand).toBe('./node_modules/.bin/crew-mcp');
    expect(manifest.targets.codex.serverArgs).toEqual(['serve']);
    expect(manifest.targets.codex.crewWaitCommand).toBe('./node_modules/.bin/crew-wait');
    expect(JSON.stringify(manifest)).not.toContain(repoRoot);
    expect(JSON.stringify(manifest)).not.toContain(home);
    expect(JSON.stringify(manifest)).not.toContain('dist/index.js');
  });

  it('project --target all and omitted non-interactive target skip host binary detection', async () => {
    const claudeDetect = vi.spyOn(HOST_ADAPTERS['claude-code'], 'detectInstalled')
      .mockRejectedValue(new Error('should not detect claude'));
    const codexDetect = vi.spyOn(HOST_ADAPTERS.codex, 'detectInstalled')
      .mockRejectedValue(new Error('should not detect codex'));
    const geminiDetect = vi.spyOn(HOST_ADAPTERS.gemini, 'detectInstalled')
      .mockRejectedValue(new Error('should not detect gemini'));

    const allResult = await installCommand({
      scope: 'project',
      target: 'all',
      home,
      repoRoot,
      skipRunningCheck: true,
    });
    expect(allResult.installed).toEqual(['claude-code', 'codex']);

    rmSync(repoRoot, { recursive: true, force: true });
    repoRoot = mkdtempSync(join(tmpdir(), 'crew-project-repo-'));
    const omittedResult = await installCommand({
      scope: 'project',
      home,
      repoRoot,
      skipRunningCheck: true,
      isInteractive: false,
    });
    expect(omittedResult.installed).toEqual(['claude-code', 'codex']);
    expect(claudeDetect).not.toHaveBeenCalled();
    expect(codexDetect).not.toHaveBeenCalled();
    expect(geminiDetect).not.toHaveBeenCalled();
  });

  it('project omitted TTY target offers all project-capable hosts to the selector', async () => {
    let receivedIds: string[] = [];
    const result = await installCommand({
      scope: 'project',
      home,
      repoRoot,
      skipRunningCheck: true,
      isInteractive: true,
      selectTargets: async (hosts) => {
        receivedIds = hosts.map((host) => host.id);
        expect(hosts.every((host) => host.installed)).toBe(true);
        return ['codex'];
      },
    });

    expect(receivedIds).toEqual(['claude-code', 'codex']);
    expect(result.installed).toEqual(['codex']);
  });

  it('verify --scope project passes after install and warns for missing Codex trust', async () => {
    await installProjectAll();
    const report = await verifyCommand({ scope: 'project', home, repoRoot });
    expect(report.ok).toBe(true);
    expect(report.targets.map((target) => target.host).sort()).toEqual(['claude-code', 'codex']);
    expect(report.targets.every((target) => target.issues.length === 0)).toBe(true);
    expect(report.probes).toContainEqual({
      name: 'codex-project-trust',
      status: 'warn',
      message: expect.stringContaining('Codex project trust missing'),
    });
  });

  it('verify --scope project reports drift for corrupted skills and removed MCP blocks', async () => {
    await installProjectAll();
    for (const skillPath of [
      join(repoRoot, '.codex', 'skills', 'crew', 'SKILL.md'),
      join(repoRoot, '.codex', 'skills', 'crew-iterate', 'SKILL.md'),
    ]) {
      const original = readFileSync(skillPath, 'utf-8');
      writeFileSync(skillPath, original.replace(/mcp__crew__merge_run/g, 'NUKED'), 'utf-8');
    }

    const skillReport = await verifyCommand({
      scope: 'project',
      target: 'codex',
      home,
      repoRoot,
    });
    expect(skillReport.ok).toBe(false);
    expect(skillReport.targets[0].issues.join('\n')).toMatch(/missing tool references.*merge_run/);

    await installCommand({
      scope: 'project',
      target: 'codex',
      home,
      repoRoot,
      skipRunningCheck: true,
    });
    writeFileSync(join(repoRoot, '.codex', 'config.toml'), '# crew removed\n', 'utf-8');
    const configReport = await verifyCommand({
      scope: 'project',
      target: 'codex',
      home,
      repoRoot,
    });
    expect(configReport.ok).toBe(false);
    expect(configReport.targets[0].issues.join('\n')).toContain('crew MCP block');
  });

  it('verify --scope project checks Claude Code crew-wait allowlist against the stored command', async () => {
    await installProjectAll();
    const permissionsPath = join(repoRoot, '.claude', 'settings.json');
    const permissions = readFileSync(permissionsPath, 'utf-8')
      .replace(
        'Bash(./node_modules/.bin/crew-wait:*)',
        'Bash(crew-wait:*)',
      );
    writeFileSync(permissionsPath, permissions, 'utf-8');

    const report = await verifyCommand({
      scope: 'project',
      target: 'claude-code',
      home,
      repoRoot,
    });
    expect(report.ok).toBe(false);
    expect(report.targets[0].issues).toContain(
      'Claude Code permissions missing Bash(./node_modules/.bin/crew-wait:*) allowlist',
    );
  });

  it('verify --scope project fails non-portable committed commands', async () => {
    await installProjectAll();
    const configPath = join(repoRoot, '.codex', 'config.toml');
    const config = readFileSync(configPath, 'utf-8')
      .replace(
        'command = "./node_modules/.bin/crew-mcp"\nargs = ["serve"]',
        `command = "/usr/local/bin/node"\nargs = ["${repoRoot}/dist/index.js", "serve"]`,
      );
    writeFileSync(configPath, config, 'utf-8');

    const report = await verifyCommand({
      scope: 'project',
      target: 'codex',
      home,
      repoRoot,
    });
    expect(report.ok).toBe(false);
    expect(report.targets[0].issues.join('\n')).toContain('not portable');
    expect(report.targets[0].issues.join('\n')).toContain('repo-absolute path');
  });

  it('uninstall --scope project removes crew-owned files and preserves unrelated config', async () => {
    writeFileSync(
      join(repoRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'other', args: [] } } }, null, 2),
      'utf-8',
    );
    mkdirSync(join(repoRoot, '.claude'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Read'] } }, null, 2),
      'utf-8',
    );
    mkdirSync(join(repoRoot, '.codex'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.codex', 'config.toml'),
      '[mcp_servers.other]\ncommand = "other"\nargs = []\n',
      'utf-8',
    );

    await installProjectAll();
    const result = await uninstallCommand({
      scope: 'project',
      target: 'claude-code,codex',
      home,
      repoRoot,
    });
    expect(result.removed).toEqual(['claude-code', 'codex']);

    expect(existsSync(join(repoRoot, '.claude', 'skills', 'crew', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(repoRoot, '.codex', 'skills', 'crew', 'SKILL.md'))).toBe(false);
    const claudeConfig = JSON.parse(readFileSync(join(repoRoot, '.mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(claudeConfig.mcpServers.other).toEqual({ command: 'other', args: [] });
    expect(claudeConfig.mcpServers.crew).toBeUndefined();
    const permissions = JSON.parse(readFileSync(join(repoRoot, '.claude', 'settings.json'), 'utf-8')) as {
      permissions: { allow: string[] };
    };
    expect(permissions.permissions.allow).toEqual(['Read']);
    const codexConfig = readFileSync(join(repoRoot, '.codex', 'config.toml'), 'utf-8');
    expect(codexConfig).toContain('[mcp_servers.other]');
    expect(codexConfig).not.toContain('[mcp_servers.crew');

    const manifest = JSON.parse(readFileSync(projectManifestPath(repoRoot), 'utf-8')) as {
      targets: Record<string, unknown>;
    };
    expect(manifest.targets.codex).toBeUndefined();
    expect(manifest.targets['claude-code']).toBeUndefined();
  });

  it('uninstall --scope project works best-effort without a manifest', async () => {
    await installProjectAll();
    rmSync(projectManifestPath(repoRoot), { force: true });

    const result = await uninstallCommand({
      scope: 'project',
      target: 'codex',
      home,
      repoRoot,
    });
    expect(result.removed).toEqual(['codex']);
    expect(existsSync(join(repoRoot, '.codex', 'skills', 'crew', 'SKILL.md'))).toBe(false);
    expect(readFileSync(join(repoRoot, '.codex', 'config.toml'), 'utf-8')).not.toContain(
      '[mcp_servers.crew',
    );
  });

  it('rejects invalid project scope and unsupported project targets clearly', async () => {
    await expect(
      installCommand({
        scope: 'workspace',
        target: 'codex',
        home,
        repoRoot,
      }),
    ).rejects.toThrow(/Invalid --scope/);

    await expect(
      installCommand({
        scope: 'project',
        target: 'gemini',
        home,
        repoRoot,
      }),
    ).rejects.toThrow(/does not support project scope/);
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

describe('Gemini shared ~/.agents/skills/ dedupe', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'crew-shared-skills-'));
    // Replicate the real machine layout: Claude Code's skills dir is a
    // symlink to the shared ~/.agents/skills/ dir that Gemini ALSO
    // scans natively. Installing Claude therefore populates the shared
    // dir, which Gemini then discovers.
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
    mkdirSync(join(home, '.claude'), { recursive: true });
    symlinkSync(join(home, '.agents', 'skills'), join(home, '.claude', 'skills'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function installClaudeThenGemini(): Promise<void> {
    await installCommand({
      target: 'claude-code',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
      ...CLAUDE_CREW_WAIT_ON_PATH,
    });
    await installCommand({
      target: 'gemini',
      home,
      skipRunningCheck: true,
      forceWithoutBinary: true,
      resolveCrewBinary: () => ({ ...STUB_BIN, args: [...STUB_BIN.args] }),
      ...CLAUDE_CREW_WAIT_ON_PATH,
    });
  }

  it('skips the per-host Gemini copy and records sharedSkills instead', async () => {
    await installClaudeThenGemini();

    // No per-host copy written under ~/.gemini/skills/.
    expect(existsSync(join(home, '.gemini', 'skills', 'crew', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(home, '.gemini', 'skills', 'crew-iterate', 'SKILL.md'))).toBe(false);

    const manifest = JSON.parse(readFileSync(manifestPath(home), 'utf-8')) as {
      targets: Record<string, {
        skills: Record<string, string>;
        sharedSkills?: Record<string, string>;
        writtenPaths: string[];
      }>;
    };
    const gemini = manifest.targets.gemini;
    // The skill is recorded as shared (loaded from the ~/.agents/ dir),
    // not as a crew-written per-host file.
    expect(gemini.sharedSkills?.crew).toBe(
      join(home, '.agents', 'skills', 'crew', 'SKILL.md'),
    );
    expect(gemini.sharedSkills?.['crew:iterate']).toBe(
      join(home, '.agents', 'skills', 'crew-iterate', 'SKILL.md'),
    );
    expect(gemini.skills.crew).toBeUndefined();
    // Shared paths are NOT in writtenPaths — Gemini doesn't own them.
    for (const p of gemini.writtenPaths) {
      expect(p.includes(join('.agents', 'skills'))).toBe(false);
    }
  });

  it('removes a stale per-host Gemini duplicate left by an earlier install', async () => {
    // Simulate a prior Gemini-only install that wrote a per-host copy
    // before the shared dir existed.
    const staleDir = join(home, '.gemini', 'skills', 'crew-iterate');
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, 'SKILL.md'), 'stale\n', 'utf-8');

    await installClaudeThenGemini();

    expect(existsSync(join(staleDir, 'SKILL.md'))).toBe(false);
    // The now-empty per-host dir is pruned too — no leftover clutter.
    expect(existsSync(staleDir)).toBe(false);
  });

  it('verify passes for Gemini using the shared skill copies', async () => {
    await installClaudeThenGemini();
    const report = await verifyCommand({ home });
    const gemini = report.targets.find((t) => t.host === 'gemini');
    expect(gemini).toBeDefined();
    expect(gemini!.issues).toEqual([]);
  });

  it('uninstalling Gemini does NOT remove the shared skill Claude owns', async () => {
    await installClaudeThenGemini();
    const sharedIterate = join(home, '.agents', 'skills', 'crew-iterate', 'SKILL.md');
    expect(existsSync(sharedIterate)).toBe(true);

    const result = await uninstallCommand({ target: 'gemini', home });
    expect(result.removed).toEqual(['gemini']);
    // Claude's shared copy survives — another host owns it.
    expect(existsSync(sharedIterate)).toBe(true);

    // Claude still verifies clean.
    const report = await verifyCommand({ home });
    const claude = report.targets.find((t) => t.host === 'claude-code');
    expect(claude!.issues).toEqual([]);
  });
});
