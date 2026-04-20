/**
 * M3-13: cross-layer MCP reachability invariant. The fake adapter asserts
 * the tool list AND the per-captain mcpRegistration payload arrive
 * through the session-loop correctly for each captain name.
 *
 * This is the integration test M3-7 (converters) + M3-8 (adapter wiring)
 * individually don't cover — it exercises the assembly path from
 * ToolCatalog → resolveCaptainConverter → ToolLoopContext.mcpRegistration
 * and asserts each captain sees the payload shape its adapter expects.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import { JudgmentRunner } from '../../src/captain/judgment-runner.js';
import { StateStore } from '../../src/state/store.js';
import { WorktreeManager } from '../../src/git/worktree.js';
import { CaptainSession } from '../../src/captain/session.js';
import { ToolDispatcher } from '../../src/captain/tool-dispatcher.js';
import type { WorkflowConfig } from '../../src/workflow/types.js';
import type { AgentRegistry } from '../../src/captain/events.js';
import type { AgentAdapter, McpRegistrationPayload } from '../../src/adapters/types.js';
import { createFakeCaptain } from '../fixtures/captain/fake-adapter.js';

const workflow: WorkflowConfig = {
  name: 'default',
  execution: { mode: 'judgment' },
  steps: [],
  completion: { strategy: 'judge_approval', fallback: 'max_passes' },
};

function makeRegistry(adapters: AgentAdapter[]): AgentRegistry {
  const map = new Map(adapters.map((a) => [a.name, a]));
  return {
    get: (name) => map.get(name),
    list: () =>
      Array.from(map.values()).map((a) => ({
        name: a.name,
        capabilities: [...a.capabilities] as string[],
      })),
  };
}

describe('session-loop tool reachability (M3-13, closes S11)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'crew-e2e-reach-'));
    execSync('git init -q', { cwd: projectRoot });
    execSync('git config user.email t@t', { cwd: projectRoot });
    execSync('git config user.name t', { cwd: projectRoot });
    execSync('git commit -q --allow-empty -m init', { cwd: projectRoot });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const captainNames = ['claude-code', 'gemini-cli', 'codex'] as const;

  for (const captainName of captainNames) {
    it(`${captainName}: receives mcp__crew__ tools and captain-appropriate mcpRegistration payload`, async () => {
      const { adapter, probe } = createFakeCaptain({
        turns: [
          [
            {
              name: 'mcp__crew__finish',
              input: { summary: 'done' },
            },
          ],
        ],
      });
      // Override the adapter.name so the session-loop picks the right converter.
      Object.defineProperty(adapter, 'name', { value: captainName, configurable: true });

      const session = CaptainSession.create({ projectRoot });
      const dispatcher = new ToolDispatcher();
      const runner = new JudgmentRunner(
        adapter,
        makeRegistry([adapter]),
        workflow,
        new StateStore(projectRoot),
        new WorktreeManager(projectRoot),
        { session, dispatcher },
      );

      await runner.run('hello');

      // Tool list invariants: 8 tools, all namespaced with mcp__crew__,
      // including the critical dispatch primitives.
      expect(probe.lastTools).toBeDefined();
      expect(probe.lastTools).toHaveLength(8);
      const names = probe.lastTools!.map((t) => t.name);
      expect(names).toContain('mcp__crew__run_agent');
      expect(names).toContain('mcp__crew__list_agents');
      expect(names).toContain('mcp__crew__finish');

      // mcpRegistration kind must match the captain name. Payloads carry
      // an empty MCP-server set since the M3 `crew-mcp` placeholder was
      // removed (no such binary existed; tool invocation flows through
      // the JSON-envelope loop + `onToolCall`, not the MCP protocol).
      const payload = probe.lastMcpPayload as McpRegistrationPayload | undefined;
      expect(payload?.kind).toBe(captainName);
      if (payload?.kind === 'claude-code') {
        const parsed = JSON.parse(payload.inlineConfigJson);
        // Empty mcpServers is what claude-code receives post-cleanup.
        expect(parsed).toEqual({});
      }
      if (payload?.kind === 'gemini-cli') {
        // Gemini's allowed-server list is empty; no `-c mcp_servers.*`
        // writes to settings.json.
        expect(payload.allowedServerNames).toEqual([]);
      }
      if (payload?.kind === 'codex') {
        // Codex's config-override argv has no mcp_servers.* entries
        // (previously caused it to hang spawning the nonexistent
        // `crew-mcp` binary).
        expect(
          payload.configOverrideArgv.some((a) => a.startsWith('mcp_servers.')),
        ).toBe(false);
      }
    });
  }

  it('non-MCP-aware adapter (e.g., generic) gets undefined mcpRegistration', async () => {
    const { adapter, probe } = createFakeCaptain({
      turns: [
        [
          {
            name: 'mcp__crew__finish',
            input: { summary: 'done' },
          },
        ],
      ],
    });
    Object.defineProperty(adapter, 'name', { value: 'generic', configurable: true });
    const session = CaptainSession.create({ projectRoot });
    const dispatcher = new ToolDispatcher();
    const runner = new JudgmentRunner(
      adapter,
      makeRegistry([adapter]),
      workflow,
      new StateStore(projectRoot),
      new WorktreeManager(projectRoot),
      { session, dispatcher },
    );
    await runner.run('hi');
    expect(probe.lastMcpPayload).toBeUndefined();
  });
});
