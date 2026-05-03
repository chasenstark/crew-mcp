import { describe, expect, it } from 'vitest';
import {
  toCodexConfigOverrides,
  toClaudeMcpConfigJson,
  toGeminiMcpSettings,
  resolveCaptainConverter,
  type ToolCatalog,
} from '../../src/orchestrator/mcp-registration.js';

// The 3-server fixture is forward-looking regression coverage for M5's real
// multi-server catalog. M3 production ships ONE server entry (the `crew`
// namespace proxy). Locking the three converters against a richer fixture
// keeps drift impossible when the M5 catalog expands.
const threeServerCatalog: ToolCatalog = {
  mcpServers: [
    { name: 'alpha', command: '/bin/a', args: ['--verbose'] },
    { name: 'bravo', command: '/bin/b', cwd: '/tmp/b' },
    {
      name: 'charlie',
      command: '/bin/c',
      env: { LOG_LEVEL: 'debug', PORT: '4000' },
    },
  ],
};

describe('toCodexConfigOverrides', () => {
  it('returns [] for an empty catalog', () => {
    expect(toCodexConfigOverrides({})).toEqual([]);
  });

  it('returns [] when mcpServers is an empty array', () => {
    expect(toCodexConfigOverrides({ mcpServers: [] })).toEqual([]);
  });

  it('emits -c pairs for a single server with only a command', () => {
    const catalog: ToolCatalog = {
      mcpServers: [{ name: 'crewtest', command: '/usr/local/bin/crew-mcp' }],
    };
    expect(toCodexConfigOverrides(catalog)).toEqual([
      '-c',
      'mcp_servers.crewtest.command="/usr/local/bin/crew-mcp"',
    ]);
  });

  it('serializes args as a TOML string array', () => {
    const catalog: ToolCatalog = {
      mcpServers: [
        {
          name: 'crewtest',
          command: '/usr/local/bin/crew-mcp',
          args: ['--verbose', '--port', '4000'],
        },
      ],
    };
    expect(toCodexConfigOverrides(catalog)).toEqual([
      '-c',
      'mcp_servers.crewtest.command="/usr/local/bin/crew-mcp"',
      '-c',
      'mcp_servers.crewtest.args=["--verbose", "--port", "4000"]',
    ]);
  });

  it('serializes cwd and env entries', () => {
    const catalog: ToolCatalog = {
      mcpServers: [
        {
          name: 'crewtest',
          command: '/usr/local/bin/crew-mcp',
          cwd: '/tmp/crew',
          env: { LOG_LEVEL: 'debug', CREW_TOKEN: 'secret' },
        },
      ],
    };
    expect(toCodexConfigOverrides(catalog)).toEqual([
      '-c',
      'mcp_servers.crewtest.command="/usr/local/bin/crew-mcp"',
      '-c',
      'mcp_servers.crewtest.cwd="/tmp/crew"',
      '-c',
      'mcp_servers.crewtest.env.LOG_LEVEL="debug"',
      '-c',
      'mcp_servers.crewtest.env.CREW_TOKEN="secret"',
    ]);
  });

  it('escapes backslashes and double quotes in values', () => {
    const catalog: ToolCatalog = {
      mcpServers: [
        {
          name: 'weird',
          command: 'C:\\Tools\\crew-mcp "wrapper".exe',
        },
      ],
    };
    expect(toCodexConfigOverrides(catalog)).toEqual([
      '-c',
      'mcp_servers.weird.command="C:\\\\Tools\\\\crew-mcp \\"wrapper\\".exe"',
    ]);
  });

  it('emits a contiguous -c block per server', () => {
    const catalog: ToolCatalog = {
      mcpServers: [
        { name: 'a', command: '/bin/a' },
        { name: 'b', command: '/bin/b' },
      ],
    };
    const result = toCodexConfigOverrides(catalog);
    expect(result).toEqual([
      '-c',
      'mcp_servers.a.command="/bin/a"',
      '-c',
      'mcp_servers.b.command="/bin/b"',
    ]);
  });
});

describe('toClaudeMcpConfigJson', () => {
  it('returns undefined for an empty catalog so the adapter omits --mcp-config', () => {
    // Recent claude-code CLI versions reject empty MCP configs as invalid
    // schema, so the flag must be absent (not `'{}'`) when there are no
    // servers. See adapter types.ts for the contract.
    expect(toClaudeMcpConfigJson({})).toBeUndefined();
    expect(toClaudeMcpConfigJson({ mcpServers: [] })).toBeUndefined();
  });

  it('serializes a single server with only command', () => {
    const json = toClaudeMcpConfigJson({
      mcpServers: [{ name: 'crew', command: '/bin/crew-mcp' }],
    });
    expect(json).toBeDefined();
    expect(JSON.parse(json!)).toEqual({
      mcpServers: { crew: { command: '/bin/crew-mcp' } },
    });
  });

  it('serializes args / cwd / env per server', () => {
    const json = toClaudeMcpConfigJson(threeServerCatalog);
    expect(json).toBeDefined();
    const parsed = JSON.parse(json!);
    expect(parsed.mcpServers.alpha).toEqual({ command: '/bin/a', args: ['--verbose'] });
    expect(parsed.mcpServers.bravo).toEqual({ command: '/bin/b', cwd: '/tmp/b' });
    expect(parsed.mcpServers.charlie).toEqual({
      command: '/bin/c',
      env: { LOG_LEVEL: 'debug', PORT: '4000' },
    });
  });

  it('omits empty args arrays', () => {
    const json = toClaudeMcpConfigJson({
      mcpServers: [{ name: 'x', command: '/bin/x', args: [] }],
    });
    expect(json).toBeDefined();
    expect(JSON.parse(json!).mcpServers.x).toEqual({ command: '/bin/x' });
  });
});

describe('toGeminiMcpSettings', () => {
  it('returns empty settings + empty allowedServerNames for an empty catalog', () => {
    const out = toGeminiMcpSettings({});
    expect(out.settingsJson.mcpServers).toEqual({});
    expect(out.allowedServerNames).toEqual([]);
  });

  it('produces settings.json mcpServers + deterministic allowedServerNames', () => {
    const out = toGeminiMcpSettings(threeServerCatalog);
    expect(Object.keys(out.settingsJson.mcpServers).sort()).toEqual([
      'alpha',
      'bravo',
      'charlie',
    ]);
    // Sorted alphabetically regardless of catalog order.
    expect(out.allowedServerNames).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('preserves args / cwd / env round-trip', () => {
    const out = toGeminiMcpSettings(threeServerCatalog);
    expect(out.settingsJson.mcpServers.alpha).toEqual({
      command: '/bin/a',
      args: ['--verbose'],
    });
    expect(out.settingsJson.mcpServers.bravo).toEqual({
      command: '/bin/b',
      cwd: '/tmp/b',
    });
    expect(out.settingsJson.mcpServers.charlie).toEqual({
      command: '/bin/c',
      env: { LOG_LEVEL: 'debug', PORT: '4000' },
    });
  });

  it('allowedServerNames is sorted deterministically even when catalog order changes', () => {
    const a = toGeminiMcpSettings({
      mcpServers: [
        { name: 'zebra', command: '/z' },
        { name: 'aardvark', command: '/a' },
      ],
    });
    const b = toGeminiMcpSettings({
      mcpServers: [
        { name: 'aardvark', command: '/a' },
        { name: 'zebra', command: '/z' },
      ],
    });
    expect(a.allowedServerNames).toEqual(['aardvark', 'zebra']);
    expect(b.allowedServerNames).toEqual(['aardvark', 'zebra']);
  });
});

describe('three-way converter parity', () => {
  it('every server appears exactly once in each projection', () => {
    const codexArgv = toCodexConfigOverrides(threeServerCatalog);
    const claudeJson = JSON.parse(toClaudeMcpConfigJson(threeServerCatalog)!);
    const geminiSettings = toGeminiMcpSettings(threeServerCatalog);

    for (const server of threeServerCatalog.mcpServers!) {
      // Codex: each server name appears as the mcp_servers.<name>.command key
      const codexMatches = codexArgv.filter((entry) =>
        entry.startsWith(`mcp_servers.${server.name}.command=`),
      );
      expect(codexMatches.length).toBe(1);

      expect(claudeJson.mcpServers[server.name]).toBeDefined();
      expect(geminiSettings.settingsJson.mcpServers[server.name]).toBeDefined();
      expect(geminiSettings.allowedServerNames).toContain(server.name);
    }
  });

  it('drift invariant: adding a 4th server propagates to all three converters identically', () => {
    const extended: ToolCatalog = {
      mcpServers: [
        ...(threeServerCatalog.mcpServers!),
        { name: 'delta', command: '/bin/d' },
      ],
    };

    // Codex
    const codexArgv = toCodexConfigOverrides(extended);
    expect(codexArgv.some((a) => a === 'mcp_servers.delta.command="/bin/d"')).toBe(true);

    // Claude
    const claudeJson = JSON.parse(toClaudeMcpConfigJson(extended)!);
    expect(claudeJson.mcpServers.delta).toEqual({ command: '/bin/d' });

    // Gemini
    const geminiSettings = toGeminiMcpSettings(extended);
    expect(geminiSettings.settingsJson.mcpServers.delta).toEqual({ command: '/bin/d' });
    expect(geminiSettings.allowedServerNames).toContain('delta');
  });

  it('resolveCaptainConverter returns the matching payload for each captain', () => {
    const claude = resolveCaptainConverter('claude-code', threeServerCatalog);
    expect(claude?.kind).toBe('claude-code');
    if (claude?.kind === 'claude-code') {
      expect(claude.inlineConfigJson).toBeDefined();
      const parsed = JSON.parse(claude.inlineConfigJson!);
      expect(Object.keys(parsed.mcpServers)).toContain('alpha');
    }

    const gemini = resolveCaptainConverter('gemini-cli', threeServerCatalog);
    expect(gemini?.kind).toBe('gemini-cli');
    if (gemini?.kind === 'gemini-cli') {
      expect(gemini.allowedServerNames).toEqual(['alpha', 'bravo', 'charlie']);
    }

    const codex = resolveCaptainConverter('codex', threeServerCatalog);
    expect(codex?.kind).toBe('codex');
    if (codex?.kind === 'codex') {
      expect(codex.configOverrideArgv.some((a) => a.startsWith('mcp_servers.alpha'))).toBe(true);
    }

    expect(resolveCaptainConverter('generic', threeServerCatalog)).toBeUndefined();
    expect(resolveCaptainConverter('openai-compatible', threeServerCatalog)).toBeUndefined();
  });

  it('drift invariant: removing a server propagates uniformly', () => {
    const reduced: ToolCatalog = {
      mcpServers: threeServerCatalog.mcpServers!.filter((s) => s.name !== 'bravo'),
    };
    const codex = toCodexConfigOverrides(reduced);
    expect(codex.some((e) => e.includes('mcp_servers.bravo'))).toBe(false);

    const claude = JSON.parse(toClaudeMcpConfigJson(reduced)!);
    expect(claude.mcpServers.bravo).toBeUndefined();

    const gemini = toGeminiMcpSettings(reduced);
    expect(gemini.settingsJson.mcpServers.bravo).toBeUndefined();
    expect(gemini.allowedServerNames).not.toContain('bravo');
  });
});
