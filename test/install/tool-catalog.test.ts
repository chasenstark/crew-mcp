/**
 * Parity test: the static install tool catalog must match the live MCP
 * surface registered in `crew-mcp serve`. Drift here is the single most
 * likely source of skill ↔ MCP mismatches at install time, so we catch
 * it at build time instead of runtime.
 *
 * The check connects an in-memory `Client` to a fresh `buildCrewMcpServer`
 * (no subprocess) and asserts listTools() returns exactly the names the
 * static catalog declares.
 */

import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildCrewMcpServer } from '../../src/cli/commands/serve.js';
import { CATALOG_TOOLS } from '../../src/install/tool-catalog.js';
import { GET_RUN_STATUS_DESCRIPTION } from '../../src/orchestrator/tools/get-run-status.js';

describe('install/tool-catalog ↔ crew serve parity', () => {
  it('listTools() returns exactly the tools declared in CATALOG_TOOLS', async () => {
    const { server } = buildCrewMcpServer();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'parity-test', version: '0.0.0' });
    await client.connect(clientTransport);

    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      const expected = CATALOG_TOOLS.map((t) => t.name).sort();
      expect(names).toEqual(expected);
    } finally {
      await client.close();
    }
  });

  it('uses the on-demand get_run_status description from the tool source', () => {
    const catalogEntry = CATALOG_TOOLS.find((tool) => tool.name === 'get_run_status');
    expect(catalogEntry?.description).toBe(GET_RUN_STATUS_DESCRIPTION);
    expect(catalogEntry?.description).toContain('Read a run\'s current status by run_id');
    expect(catalogEntry?.description).toContain('wait_for_change_ms / wait_for_terminal_only');
    expect(catalogEntry?.description).toContain('timed_out');
    expect(catalogEntry?.description).not.toContain('the captain confirms the dispatch');
    expect(catalogEntry?.description).not.toContain('Always poll after run_agent / continue_run');
    expect(catalogEntry?.description).not.toContain('Always pass wait_for_change_ms: 30000');
  });

  it('keeps installed tool descriptions concise', () => {
    for (const tool of CATALOG_TOOLS) {
      expect(tool.description.length, `${tool.name} description length`).toBeLessThanOrEqual(650);
    }
  });
});
