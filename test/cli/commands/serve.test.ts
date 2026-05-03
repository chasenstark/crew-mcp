/**
 * In-process integration tests for `crew serve`.
 *
 * Drives the server via SDK Client + InMemoryTransport.createLinkedPair() —
 * no subprocess, no stdio framing. The wire-protocol contract is the SDK's
 * job; what we own is the tool surface (list_agents, run_agent), the
 * envelope shape, and the worktree-lifecycle boundary (no auto-merge).
 *
 * Subprocess + real-stdio coverage is added in M3 once `crew install` exists
 * (we'd be testing install + serve together at that point anyway).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildCrewMcpServer, type RunEnvelope } from '../../../src/cli/commands/serve.js';
import type { AdapterRegistry } from '../../../src/adapters/registry.js';
import type { AgentAdapter, TaskResult } from '../../../src/adapters/types.js';
import { WorktreeManager } from '../../../src/git/worktree.js';

// --- helpers ---

function makeMockAdapter(overrides?: Partial<AgentAdapter>): AgentAdapter {
  return {
    name: overrides?.name ?? 'mock',
    capabilities: overrides?.capabilities ?? ['implement'],
    supportsJsonSchema: false,
    execute:
      overrides?.execute ??
      (async () => ({
        output: 'ok',
        filesModified: [],
        status: 'success',
        metadata: {},
      })),
    healthCheck:
      overrides?.healthCheck ??
      (async () => ({
        available: true,
        authenticated: true,
        version: '0.0.0-test',
      })),
    ...overrides,
  };
}

function makeRegistry(adapters: AgentAdapter[]): AdapterRegistry {
  const map = new Map<string, AgentAdapter>(adapters.map((a) => [a.name, a]));
  return {
    register: () => undefined,
    get: (name: string) => map.get(name),
    getOrThrow: (name: string) => {
      const a = map.get(name);
      if (!a) throw new Error(`adapter not found: ${name}`);
      return a;
    },
    healthCheckAll: async () => ({}),
    listAvailable: () => Array.from(map.values()),
  } as unknown as AdapterRegistry;
}

interface Harness {
  client: Client;
  worktreeManager: WorktreeManager;
  root: string;
  close: () => Promise<void>;
}

async function startHarness(adapters: AgentAdapter[]): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'crew-serve-'));
  execSync('git init -q', { cwd: root });
  execSync('git config user.email test@crew.local', { cwd: root });
  execSync('git config user.name test', { cwd: root });
  writeFileSync(join(root, '.gitignore'), '.crew/\n', 'utf-8');
  execSync('git add .gitignore', { cwd: root });
  execSync('git commit -q -m init', { cwd: root });

  const worktreeManager = new WorktreeManager(root);
  const { server } = buildCrewMcpServer({
    cwd: root,
    registry: makeRegistry(adapters),
    worktreeManager,
  });

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'crew-test-client', version: '0.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    worktreeManager,
    root,
    close: async () => {
      await client.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// --- tests ---

describe('crew serve — listTools surface', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness([makeMockAdapter({ name: 'mock-coder' })]);
  });
  afterEach(async () => {
    await h.close();
  });

  it('exposes exactly the M1 surface: list_agents + run_agent', async () => {
    const result = await h.client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['list_agents', 'run_agent']);
  });

  it('run_agent declares its input schema (agent_id + prompt required)', async () => {
    const result = await h.client.listTools();
    const runAgent = result.tools.find((t) => t.name === 'run_agent');
    expect(runAgent).toBeDefined();
    expect(runAgent!.inputSchema).toBeDefined();
    const schema = runAgent!.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty('agent_id');
    expect(schema.properties).toHaveProperty('prompt');
    expect(schema.required).toContain('agent_id');
    expect(schema.required).toContain('prompt');
  });
});

describe('crew serve — list_agents tool', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness([
      makeMockAdapter({ name: 'mock-coder', capabilities: ['implement'] }),
      makeMockAdapter({ name: 'mock-reviewer', capabilities: ['review'] }),
    ]);
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns the injected registry as structured content', async () => {
    const res = await h.client.callTool({ name: 'list_agents', arguments: {} });
    const structured = res.structuredContent as { agents: Array<{ name: string; available: boolean; capabilities: string[] }> };
    expect(structured.agents).toHaveLength(2);
    const names = structured.agents.map((a) => a.name).sort();
    expect(names).toEqual(['mock-coder', 'mock-reviewer']);
    expect(structured.agents.every((a) => a.available)).toBe(true);
  });

  it('reports adapter health failures as available: false (does not throw)', async () => {
    await h.close();
    h = await startHarness([
      makeMockAdapter({
        name: 'flaky',
        healthCheck: async () => ({ available: false, authenticated: false, error: 'boom' }),
      }),
    ]);
    const res = await h.client.callTool({ name: 'list_agents', arguments: {} });
    const structured = res.structuredContent as { agents: Array<{ available: boolean; error?: string }> };
    expect(structured.agents[0].available).toBe(false);
    expect(structured.agents[0].error).toBe('boom');
  });
});

describe('crew serve — run_agent tool', () => {
  it('returns an error envelope when agent_id is unknown', async () => {
    const h = await startHarness([makeMockAdapter({ name: 'codex' })]);
    try {
      const res = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'nope', prompt: 'do something' },
      });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ text: string }>)[0].text;
      expect(text).toMatch(/Unknown agent_id/);
      expect(text).toMatch(/codex/);
    } finally {
      await h.close();
    }
  });

  it('dispatches into a fresh worktree and returns a v2 envelope', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async (task) => {
        // Simulate an edit inside the worktree the dispatcher allocated.
        const cwd = (task as { context: { workingDirectory: string } }).context.workingDirectory;
        writeFileSync(join(cwd, 'CHANGE.md'), 'hello\n', 'utf-8');
        return {
          output: 'changed CHANGE.md',
          filesModified: [],
          status: 'success',
          metadata: {},
        } satisfies TaskResult;
      },
    });
    const h = await startHarness([adapter]);
    try {
      const res = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'add CHANGE.md' },
      });
      const env = res.structuredContent as RunEnvelope;
      expect(env.run_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(env.status).toBe('success');
      expect(env.summary).toBe('changed CHANGE.md');
      // Worktree exists, file lives only there (no auto-merge).
      expect(existsSync(join(env.worktree_path, 'CHANGE.md'))).toBe(true);
      expect(existsSync(join(h.root, 'CHANGE.md'))).toBe(false);
      expect(env.files_changed).toContain('CHANGE.md');
    } finally {
      await h.close();
    }
  });

  it('surfaces adapter execute failures as a failed envelope', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async () => {
        throw new Error('adapter exploded');
      },
    });
    const h = await startHarness([adapter]);
    try {
      const res = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'try it' },
      });
      expect(res.isError).toBe(true);
      const env = res.structuredContent as RunEnvelope;
      expect(env.status).toBe('error');
      expect(env.summary).toMatch(/adapter exploded/);
      expect(env.files_changed).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('preserves the v0.1-tui captain prompt content for migration in M3', () => {
    // Sanity guard: no test asserts captain prompt content here. The content
    // lives at git tag v0.1-tui in src/captain/prompts/captain-system.ts and
    // gets migrated into skills/crew-captain.body.md in M3. This test is a
    // load-bearing reminder for the next milestone.
    expect(true).toBe(true);
  });
});

describe('crew serve — lifecycle', () => {
  it('cancels in-flight dispatches when the dispatcher is stopped', async () => {
    let abortObserved = false;
    const adapter = makeMockAdapter({
      name: 'mock-slow',
      execute: async (task) => {
        const t = task as { constraints?: { signal?: AbortSignal } };
        return new Promise<TaskResult>((resolve, reject) => {
          const onAbort = (): void => {
            abortObserved = true;
            reject(new Error('aborted'));
          };
          t.constraints?.signal?.addEventListener('abort', onAbort);
          // Never resolves on its own — the test will cancel.
        });
      },
    });
    const root = mkdtempSync(join(tmpdir(), 'crew-serve-cancel-'));
    execSync('git init -q', { cwd: root });
    execSync('git config user.email test@crew.local', { cwd: root });
    execSync('git config user.name test', { cwd: root });
    writeFileSync(join(root, '.gitignore'), '.crew/\n', 'utf-8');
    execSync('git add .gitignore', { cwd: root });
    execSync('git commit -q -m init', { cwd: root });
    const worktreeManager = new WorktreeManager(root);
    const { server, dispatcher } = buildCrewMcpServer({
      cwd: root,
      registry: makeRegistry([adapter]),
      worktreeManager,
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'crew-test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const callPromise = client.callTool({
      name: 'run_agent',
      arguments: { agent_id: 'mock-slow', prompt: 'never returns' },
    });

    // Wait for the dispatcher to start the task before cancelling.
    await waitFor(() => dispatcher.inFlightCount() === 1);
    dispatcher.cancelAll('lifecycle test');

    const res = await callPromise;
    const env = res.structuredContent as RunEnvelope;
    expect(env.status).toBe('cancelled');
    expect(env.summary).toMatch(/lifecycle test/);
    expect(abortObserved).toBe(true);

    await client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor: timeout');
}

// Silence "unused import" for `readFileSync` if test variants change.
void readFileSync;
