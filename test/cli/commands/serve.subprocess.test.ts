/**
 * Subprocess smoke test for `crew-mcp serve`.
 *
 * Spawns the built `dist/index.js serve` as a real child process and drives
 * it via the SDK's StdioClientTransport. This proves the production
 * stdio-framing path works end-to-end — the in-process serve.test.ts can't
 * exercise that since it uses InMemoryTransport.
 *
 * Skipped automatically if `dist/index.js` doesn't exist; the developer
 * runs `npm run build` first or CI builds before testing.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { CATALOG_TOOLS } from '../../../src/install/tool-catalog.js';
import { captainSkillTools } from '../../../src/install/skill-renderer.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const distPath = join(here, '..', '..', '..', 'dist', 'index.js');
const hasBuild = existsSync(distPath);

describe.skipIf(!hasBuild)('crew-mcp serve — subprocess wire protocol', () => {
  it('initializes + listTools over real stdio framing', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath, // node
      args: [distPath, 'serve'],
    });
    const client = new Client({ name: 'crew-subprocess-test', version: '0.0.0' });
    try {
      await client.connect(transport);
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      // Derived from the catalog (captain modes only) rather than a
      // hand-copied list: this test proves the built dist speaks stdio
      // framing and serves the current captain surface; name-level parity
      // against explicit lists lives in serve.test.ts and
      // tool-catalog.test.ts. A mismatch here usually means dist/ is stale
      // relative to src/ — rebuild before publishing.
      const expected = captainSkillTools(CATALOG_TOOLS)
        .map((t) => t.name)
        .sort();
      expect(names).toEqual(expected);
    } finally {
      await client.close();
    }
  });
});
