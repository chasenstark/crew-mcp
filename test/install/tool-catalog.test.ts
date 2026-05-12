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

import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildCrewMcpServer } from '../../src/cli/commands/serve.js';
import { CATALOG_TOOLS } from '../../src/install/tool-catalog.js';
import { CONTINUE_RUN_DESCRIPTION } from '../../src/orchestrator/tools/continue-run.js';
import { GET_RUN_STATUS_DESCRIPTION } from '../../src/orchestrator/tools/get-run-status.js';
import { RUN_AGENT_DESCRIPTION } from '../../src/orchestrator/tools/run-agent.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('install/tool-catalog ↔ crew serve parity', () => {
  it('listTools() returns exactly the tools declared in CATALOG_TOOLS', async () => {
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-tool-catalog-home-'));
    const { server } = buildCrewMcpServer({ crewHome });
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
      rmSync(crewHome, { recursive: true, force: true });
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

  // Drift guard: the captain-default framing in GET_RUN_STATUS_DESCRIPTION
  // is load-bearing — its absence let captains treat `wait_for_terminal_only`
  // as a neutral "advanced in-turn wait" and block dispatch turns for
  // minutes (regression of d49bf6a). These strings stay in the description.
  it('get_run_status description names the captain default and warns against long-poll', () => {
    expect(GET_RUN_STATUS_DESCRIPTION).toContain('snapshot');
    expect(GET_RUN_STATUS_DESCRIPTION).toContain('crew-wait');
    expect(GET_RUN_STATUS_DESCRIPTION).toContain('opt-in');
    expect(GET_RUN_STATUS_DESCRIPTION).toContain('not a long-poll');
    // The neutral framing that masked the failure mode must not return.
    expect(GET_RUN_STATUS_DESCRIPTION).not.toContain('advanced in-turn waits');
    expect(GET_RUN_STATUS_DESCRIPTION).not.toContain('advanced/legacy');
  });

  // Drift guard: run_agent / continue_run tool descriptions are the last
  // thing a captain reads before choosing the next action after dispatch.
  // They MUST point at the watcher, not at get_run_status, and they MUST
  // explicitly prohibit long-polling the turn open.
  it('run_agent / continue_run descriptions point at the watcher and forbid long-polling', () => {
    for (const [name, description] of [
      ['run_agent', RUN_AGENT_DESCRIPTION],
      ['continue_run', CONTINUE_RUN_DESCRIPTION],
    ] as const) {
      expect(description, `${name}: names crew-wait`).toContain('crew-wait');
      expect(description, `${name}: forbids long-polling`).toMatch(/Do not block the turn long-polling/);
      // The old framing that re-centered get_run_status as the next op
      // must not come back.
      expect(description, `${name}: no terminal-results-later leak`).not.toContain(
        'read terminal results later with get_run_status',
      );
    }
  });

  // The product-invariant rule that the captain stays chat-available must
  // ship with the package, not live only in any one machine's auto-memory.
  // The skill body must explicitly name `wait_for_terminal_only` as the
  // anti-pattern; otherwise fresh installs re-derive the failure mode.
  it('skill body explicitly prohibits wait_for_terminal_only after dispatch', async () => {
    const body = await readFile(
      resolve(REPO_ROOT, 'skills', 'crew-captain.body.md'),
      'utf-8',
    );
    expect(body).toMatch(/wait_for_terminal_only/);
    expect(body).toMatch(/Don't block the turn with `get_run_status`/);
    // Make sure the prohibition lives inside the Dispatch lifecycle
    // section so captains hit it before they read the tool list.
    const lifecycleStart = body.indexOf('## Dispatch lifecycle');
    const lifecycleEnd = body.indexOf('## The tools');
    expect(lifecycleStart, 'Dispatch lifecycle section exists').toBeGreaterThan(-1);
    expect(lifecycleEnd, 'tool list section exists').toBeGreaterThan(lifecycleStart);
    const lifecycle = body.slice(lifecycleStart, lifecycleEnd);
    expect(lifecycle).toMatch(/wait_for_terminal_only/);
  });

  it('keeps installed tool descriptions concise', () => {
    for (const tool of CATALOG_TOOLS) {
      expect(tool.description.length, `${tool.name} description length`).toBeLessThanOrEqual(650);
    }
  });
});
