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
});
