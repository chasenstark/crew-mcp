import { describe, expect, it } from 'vitest';
import { toCodexConfigOverrides, type ToolCatalog } from '../../src/captain/mcp-registration.js';

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
