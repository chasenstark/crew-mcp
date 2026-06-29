import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  buildCrewMcpServer,
  getRunGc,
  getStaleRunSweep,
  type FullRunEnvelope,
} from '../../src/cli/commands/serve.js';
import type { AdapterRegistry } from '../../src/adapters/registry.js';
import type { AgentAdapter } from '../../src/adapters/types.js';
import { WorktreeManager } from '../../src/git/worktree.js';
import { drainPendingTerminalPersists } from '../../src/orchestrator/run-lifecycle-listeners.js';
import type { ListAgentsOutput } from '../../src/orchestrator/tools/list-agents.js';

function makeAdapter(overrides: Partial<AgentAdapter> & { name: string }): AgentAdapter {
  return {
    supportsJsonSchema: false,
    strengths: overrides.strengths ?? [],
    execute: async () => ({
      output: '',
      filesModified: [],
      status: 'success',
      metadata: {},
    }),
    healthCheck: async () => ({ available: true, authenticated: true }),
    ...overrides,
  };
}

function makeRegistry(adapters: AgentAdapter[]): AdapterRegistry {
  const map = new Map(adapters.map((a) => [a.name, a]));
  const aliasToName = new Map<string, string>();
  for (const adapter of adapters) {
    for (const alias of adapter.aliases ?? []) {
      aliasToName.set(alias, adapter.name);
    }
  }
  const resolve = (name: string): AgentAdapter | undefined => {
    const direct = map.get(name);
    if (direct) return direct;
    const canonical = aliasToName.get(name);
    return canonical ? map.get(canonical) : undefined;
  };
  return {
    register: () => undefined,
    get: (name: string) => resolve(name),
    getOrThrow: (name: string) => {
      const a = resolve(name);
      if (!a) throw new Error(`missing: ${name}`);
      return a;
    },
    healthCheckAll: async () => ({}),
    listAvailable: () => Array.from(map.values()),
  } as unknown as AdapterRegistry;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor: timeout');
}

describe('serve quota cache wiring', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('seeds from terminal failure, reads through list_agents, and clears on refresh', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-serve-quota-'));
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-serve-quota-home-'));
    const home = mkdtempSync(join(tmpdir(), 'crew-serve-quota-os-home-'));
    execSync('git init -q', { cwd: root });
    execSync('git config user.email test@crew.local', { cwd: root });
    execSync('git config user.name test', { cwd: root });
    writeFileSync(join(root, 'README.md'), 'init\n', 'utf-8');
    execSync('git add README.md', { cwd: root });
    execSync('git commit -q -m init', { cwd: root });

    const adapter = makeAdapter({
      name: 'claude-code',
      aliases: ['claude'],
      execute: async () => ({
        output: 'quota stopped',
        filesModified: [],
        status: 'error',
        failure: {
          kind: 'quota_exhausted',
          confidence: 'high',
          retryAfterSeconds: 600,
          rawSignal: 'Claude usage limit reached',
        },
        metadata: {},
      }),
    });
    const built = buildCrewMcpServer({
      cwd: root,
      crewHome,
      home,
      registry: makeRegistry([
        adapter,
        makeAdapter({ name: 'codex' }),
      ]),
      worktreeManager: new WorktreeManager({ projectRoot: root, crewHome }),
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'crew-test-client', version: '0.0.0' });
    await Promise.all([
      built.server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    cleanups.push(async () => {
      await client.close();
      await built.server.close();
      await getStaleRunSweep();
      await getRunGc();
      rmSync(root, { recursive: true, force: true });
      rmSync(crewHome, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });

    const run = await client.callTool({
      name: 'run_agent',
      arguments: { agent_id: 'claude', prompt: 'hit a quota' },
    });
    const runEnv = run.structuredContent as FullRunEnvelope;
    await waitFor(() => built.runStateStore.read(runEnv.run_id)?.status === 'error');
    await drainPendingTerminalPersists();

    const list = await client.callTool({ name: 'list_agents', arguments: {} });
    const structured = list.structuredContent as unknown as ListAgentsOutput;
    const byName = Object.fromEntries(structured.agents.map((agent) => [agent.name, agent]));
    expect(byName['claude-code'].quota).toMatchObject({
      state: 'limited',
      confidence: 'high',
      source: 'stream-cache',
      retryAfterSeconds: 600,
      message: 'Claude usage limit reached',
    });
    expect(byName['claude-code'].quota?.checkedAt).toEqual(expect.any(String));
    expect(byName['claude-code'].quota?.staleAfter).toEqual(expect.any(String));
    expect(byName.codex.quota).toBeUndefined();
    expect('quota' in byName.codex).toBe(false);

    const refreshed = await client.callTool({
      name: 'list_agents',
      arguments: { refresh: true },
    });
    const refreshedStructured = refreshed.structuredContent as unknown as ListAgentsOutput;
    const refreshedClaude = refreshedStructured.agents.find((agent) => agent.name === 'claude-code');
    expect(refreshedClaude?.quota).toBeUndefined();
    expect('quota' in (refreshedClaude ?? {})).toBe(false);
  });
});
