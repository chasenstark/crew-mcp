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
import { captainSkillTools } from '../../src/install/skill-renderer.js';
import { CONTINUE_RUN_DESCRIPTION } from '../../src/orchestrator/tools/continue-run.js';
import { GET_RUN_STATUS_DESCRIPTION } from '../../src/orchestrator/tools/get-run-status.js';
import { RUN_AGENT_DESCRIPTION } from '../../src/orchestrator/tools/run-agent.js';
import { RUN_PANEL_DESCRIPTION } from '../../src/orchestrator/tools/run-panel.js';
import {
  AUTHORIZE_PR_WATCH_ACTIONS_DESCRIPTION,
  CANCEL_PR_WATCH_DESCRIPTION,
  GET_PR_WATCH_STATUS_DESCRIPTION,
  LIST_PR_WATCHES_DESCRIPTION,
  REARM_PR_WATCH_DESCRIPTION,
  START_PR_WATCH_DESCRIPTION,
} from '../../src/orchestrator/tools/pr-watch.js';
import { PR_WATCH_SKILL_DESCRIPTION } from '../../src/install/skill-renderer.js';
import * as toolsIndex from '../../src/orchestrator/tools/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('install/tool-catalog ↔ crew serve parity', () => {
  it('keeps PR-watch descriptions within their frozen UTF-8 budgets', () => {
    const descriptions = [
      START_PR_WATCH_DESCRIPTION,
      LIST_PR_WATCHES_DESCRIPTION,
      GET_PR_WATCH_STATUS_DESCRIPTION,
      REARM_PR_WATCH_DESCRIPTION,
      CANCEL_PR_WATCH_DESCRIPTION,
      AUTHORIZE_PR_WATCH_ACTIONS_DESCRIPTION,
    ];
    expect(Buffer.byteLength(descriptions.join(''), 'utf-8')).toBeLessThanOrEqual(5 * 1024);
    expect(Buffer.byteLength(PR_WATCH_SKILL_DESCRIPTION, 'utf-8')).toBeLessThanOrEqual(768);
  });

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
      const expected = captainSkillTools(CATALOG_TOOLS).map((t) => t.name).sort();
      expect(names).toEqual(expected);
      expect(CATALOG_TOOLS).toHaveLength(26);
      expect(names).toHaveLength(25);
      expect(names).toContain('list_models');
      expect(names).not.toContain('send_message');
      expect(names).toEqual(expect.arrayContaining([
        'start_pr_watch',
        'list_pr_watches',
        'get_pr_watch_status',
        'rearm_pr_watch',
        'cancel_pr_watch',
        'authorize_pr_watch_actions',
      ]));

      const propertiesFor = (name: string): Record<string, unknown> => {
        const schema = result.tools.find((tool) => tool.name === name)?.inputSchema as {
          properties?: Record<string, unknown>;
        } | undefined;
        return schema?.properties ?? {};
      };
      expect(Object.keys(propertiesFor('run_agent'))).toEqual(expect.arrayContaining([
        'ban_override',
        'same_host_ok',
        'dispatch_anyway',
        'goal',
      ]));
      expect(Object.keys(propertiesFor('continue_run'))).toEqual(expect.arrayContaining([
        'ban_override',
        'same_host_ok',
        'cap_override',
        'dispatch_anyway',
        'goal_policy',
        'goal',
      ]));
      expect(Object.keys(propertiesFor('run_panel'))).toEqual(expect.arrayContaining([
        'ban_override',
        'dispatch_anyway',
      ]));
      expect(Object.keys(propertiesFor('get_run_status'))).toContain('user_requested_wait');
      expect(Object.keys(propertiesFor('discard_run'))).toContain('confirmed');
      expect(Object.keys(propertiesFor('merge_run'))).toEqual(expect.arrayContaining([
        'confirmed',
        'force',
        'commit_title',
      ]));

      const overrideLikeFields = new Set(result.tools.flatMap((tool) =>
        Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})
          .filter((field) => field.includes('override') || field.endsWith('_ok') || field === 'confirmed')),
      );
      expect([...overrideLikeFields].sort()).toEqual([
        'ban_override',
        'cap_override',
        'confirmed',
        'same_host_ok',
      ]);
    } finally {
      await client.close();
      rmSync(crewHome, { recursive: true, force: true });
    }
  });

  it('declares send_message as a worker-only catalog tool', () => {
    const entry = CATALOG_TOOLS.find((tool) => tool.name === 'send_message');
    expect(entry).toBeDefined();
    expect(entry?.mode).toBe('worker');
    expect(captainSkillTools(CATALOG_TOOLS).map((tool) => tool.name)).not.toContain('send_message');
  });

  it('accepts only the new wait and dispatch preflight fields on strict schemas', () => {
    expect(toolsIndex.runAgentInputSchema.safeParse({
      agent_id: 'codex',
      prompt: 'work',
      dispatch_anyway: true,
    }).success).toBe(true);
    expect(toolsIndex.continueRunInputSchema.safeParse({
      run_id: 'run-1',
      prompt: 'continue',
      dispatch_anyway: true,
    }).success).toBe(true);
    expect(toolsIndex.runPanelInputSchema.safeParse({
      dispatch_anyway: true,
      reviewers: [{
        agent_id: 'codex',
        prompt: 'review',
        dispatch_anyway: true,
      }],
    }).success).toBe(true);
    expect(toolsIndex.getRunStatusInputSchema.safeParse({
      run_id: 'run-1',
      user_requested_wait: true,
    }).success).toBe(true);

    expect(toolsIndex.runAgentInputSchema.safeParse({
      agent_id: 'codex',
      prompt: 'work',
      unknown_override: true,
    }).success).toBe(false);
    expect(toolsIndex.runPanelInputSchema.safeParse({
      reviewers: [{ agent_id: 'codex', prompt: 'review', unknown_override: true }],
    }).success).toBe(false);
  });

  it('declares captain inbox tools as captain catalog tools', () => {
    for (const toolName of ['check_captain_inbox', 'acknowledge_messages']) {
      const entry = CATALOG_TOOLS.find((tool) => tool.name === toolName);
      expect(entry).toBeDefined();
      expect(entry?.mode).toBe('captain');
      expect(captainSkillTools(CATALOG_TOOLS).map((tool) => tool.name)).toContain(toolName);
    }
  });

  it('declares panel tools in both the catalog and tools/index barrel', () => {
    const catalogNames = CATALOG_TOOLS.map((tool) => tool.name);
    for (const toolName of ['run_panel', 'get_panel_status', 'aggregate_panel']) {
      expect(catalogNames).toContain(toolName);
    }
    expect(toolsIndex.runPanelInputSchema).toBeDefined();
    expect(toolsIndex.runPanelHandler).toBeDefined();
    expect(toolsIndex.getPanelStatusInputSchema).toBeDefined();
    expect(toolsIndex.getPanelStatusHandler).toBeDefined();
    expect(toolsIndex.aggregatePanelInputSchema).toBeDefined();
    expect(toolsIndex.aggregatePanelHandler).toBeDefined();
    expect(toolsIndex.checkCaptainInboxInputSchema).toBeDefined();
    expect(toolsIndex.checkCaptainInboxToolHandler).toBeDefined();
    expect(toolsIndex.acknowledgeMessagesInputSchema).toBeDefined();
    expect(toolsIndex.acknowledgeMessagesToolHandler).toBeDefined();
  });

  it('declares model discovery in both the catalog and tools/index barrel', () => {
    const entry = CATALOG_TOOLS.find((tool) => tool.name === 'list_models');
    expect(entry?.mode).not.toBe('worker');
    expect(toolsIndex.listModelsInputSchema).toBeDefined();
    expect(toolsIndex.listModelsToolHandler).toBeDefined();
  });

  it('uses the on-demand get_run_status description from the tool source', () => {
    const catalogEntry = CATALOG_TOOLS.find((tool) => tool.name === 'get_run_status');
    expect(catalogEntry?.description).toBe(GET_RUN_STATUS_DESCRIPTION);
    expect(catalogEntry?.description).toContain('Read run status by run_id');
    expect(catalogEntry?.description).toContain('user_requested_wait:true');
    expect(catalogEntry?.description).toContain('timed_out');
    expect(catalogEntry?.description).not.toContain('the captain confirms the dispatch');
    expect(catalogEntry?.description).not.toContain('Always poll after run_agent / continue_run');
    expect(catalogEntry?.description).not.toContain('Always pass wait_for_change_ms: 30000');
  });

  // Drift guard: the captain-default framing in GET_RUN_STATUS_DESCRIPTION
  // is load-bearing — its absence let captains treat `wait_for_terminal_only`
  // as a neutral "advanced in-turn wait" and block dispatch turns for
  // minutes (regression of d49bf6a). These strings stay in the description.
  it('get_run_status description names the enforced wait claim and criteria warning', () => {
    expect(GET_RUN_STATUS_DESCRIPTION).toContain('snapshot');
    expect(GET_RUN_STATUS_DESCRIPTION).toContain('crew-wait');
    expect(GET_RUN_STATUS_DESCRIPTION).toContain('user_requested_wait:true');
    expect(GET_RUN_STATUS_DESCRIPTION).toContain('Criteria-linked waits warn');
    expect(GET_RUN_STATUS_DESCRIPTION).toContain('commits');
    // The neutral framing that masked the failure mode must not return.
    expect(GET_RUN_STATUS_DESCRIPTION).not.toContain('advanced in-turn waits');
    expect(GET_RUN_STATUS_DESCRIPTION).not.toContain('advanced/legacy');
  });

  // Drift guard: run_agent / continue_run tool descriptions are the last
  // thing a captain reads before choosing the next action after dispatch.
  // They MUST point at the watcher, not at get_run_status, and they MUST
  // explicitly prohibit long-polling the turn open.
  it('run_agent / continue_run descriptions point at the watcher and health/quota override', () => {
    for (const [name, description] of [
      ['run_agent', RUN_AGENT_DESCRIPTION],
      ['continue_run', CONTINUE_RUN_DESCRIPTION],
    ] as const) {
      expect(description, `${name}: names crew-wait`).toContain('crew-wait');
      expect(description, `${name}: documents dispatch_anyway`).toContain('dispatch_anyway');
      expect(description, `${name}: documents health/quota`).toContain('health/quota');
      expect(description, `${name}: no lazy check-later branch`).not.toMatch(/check (?:status )?later/i);
      // The old framing that re-centered get_run_status as the next op
      // must not come back.
      expect(description, `${name}: no terminal-results-later leak`).not.toContain(
        'read terminal results later with get_run_status',
      );
    }
  });

  it('run_panel description points at panel-level watcher and dispatch_anyway scopes', () => {
    expect(RUN_PANEL_DESCRIPTION).toContain('panel-level crew-wait watcher command');
    expect(RUN_PANEL_DESCRIPTION).toContain('per-reviewer wait commands remain available');
    expect(RUN_PANEL_DESCRIPTION).toContain('dispatch_anyway');
    expect(RUN_PANEL_DESCRIPTION).toContain('top-level or per reviewer');
    expect(RUN_PANEL_DESCRIPTION).not.toMatch(/check (?:status )?later/i);
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
