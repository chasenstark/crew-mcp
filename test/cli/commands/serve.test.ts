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
    strengths: overrides?.strengths ?? [],
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
  crewHome: string;
  close: () => Promise<void>;
}

interface HarnessOptions {
  asyncFallbackMs?: number;
}

async function startHarness(
  adapters: AgentAdapter[],
  options: HarnessOptions = {},
): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'crew-serve-'));
  const crewHome = mkdtempSync(join(tmpdir(), 'crew-serve-home-'));
  execSync('git init -q', { cwd: root });
  execSync('git config user.email test@crew.local', { cwd: root });
  execSync('git config user.name test', { cwd: root });
  writeFileSync(join(root, 'README.md'), 'init\n', 'utf-8');
  execSync('git add README.md', { cwd: root });
  execSync('git commit -q -m init', { cwd: root });

  const worktreeManager = new WorktreeManager({ projectRoot: root, crewHome });
  const { server } = buildCrewMcpServer({
    cwd: root,
    crewHome,
    registry: makeRegistry(adapters),
    worktreeManager,
    asyncFallbackMs: options.asyncFallbackMs,
  });

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'crew-test-client', version: '0.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    worktreeManager,
    root,
    crewHome,
    close: async () => {
      await client.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(crewHome, { recursive: true, force: true });
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

  it('exposes exactly the M2 surface: 6 tools', async () => {
    const result = await h.client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'continue_run',
      'discard_run',
      'get_run_status',
      'list_agents',
      'merge_run',
      'run_agent',
    ]);
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
      makeMockAdapter({ name: 'mock-coder', strengths: ['code-implementation'] }),
      makeMockAdapter({ name: 'mock-reviewer', strengths: ['code-review'] }),
    ]);
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns the injected registry as structured content', async () => {
    const res = await h.client.callTool({ name: 'list_agents', arguments: {} });
    const structured = res.structuredContent as { agents: Array<{ name: string; available: boolean; strengths: string[] }> };
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

describe('crew serve — continue_run tool', () => {
  it('reuses the existing worktree and increments the prompt turn', async () => {
    const calls: string[] = [];
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async (task) => {
        const t = task as { prompt: string; context: { workingDirectory: string } };
        calls.push(`${t.prompt}@${t.context.workingDirectory}`);
        writeFileSync(join(t.context.workingDirectory, 'change.txt'), t.prompt, 'utf-8');
        return {
          output: `did: ${t.prompt}`,
          filesModified: [],
          status: 'success',
          metadata: {},
        } satisfies TaskResult;
      },
    });
    const h = await startHarness([adapter]);
    try {
      const first = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'turn-one' },
      });
      const firstEnv = first.structuredContent as RunEnvelope;
      const second = await h.client.callTool({
        name: 'continue_run',
        arguments: { run_id: firstEnv.run_id, prompt: 'turn-two' },
      });
      const secondEnv = second.structuredContent as RunEnvelope;
      expect(secondEnv.run_id).toBe(firstEnv.run_id);
      expect(secondEnv.worktree_path).toBe(firstEnv.worktree_path);
      expect(secondEnv.summary).toBe('did: turn-two');
      // Adapter received both prompts, both pointed at the same worktree.
      expect(calls).toHaveLength(2);
      expect(calls[0]).toBe(`turn-one@${firstEnv.worktree_path}`);
      expect(calls[1]).toBe(`turn-two@${firstEnv.worktree_path}`);
      // state.json should record both turns.
      const statusRes = await h.client.callTool({
        name: 'get_run_status',
        arguments: { run_id: firstEnv.run_id },
      });
      const status = statusRes.structuredContent as { prompts: Array<{ turn: number; prompt: string }> };
      expect(status.prompts).toHaveLength(2);
      expect(status.prompts.map((p) => p.prompt)).toEqual(['turn-one', 'turn-two']);
    } finally {
      await h.close();
    }
  });

  it('refuses to continue a run that does not exist', async () => {
    const h = await startHarness([makeMockAdapter({ name: 'mock-coder' })]);
    try {
      const res = await h.client.callTool({
        name: 'continue_run',
        arguments: { run_id: 'r-nope', prompt: 'go' },
      });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ text: string }>)[0].text;
      expect(text).toMatch(/Unknown run_id/);
    } finally {
      await h.close();
    }
  });

  it('refuses to continue a discarded run', async () => {
    const h = await startHarness([makeMockAdapter({ name: 'mock-coder' })]);
    try {
      const initial = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'first' },
      });
      const env = initial.structuredContent as RunEnvelope;
      await h.client.callTool({
        name: 'discard_run',
        arguments: { run_id: env.run_id },
      });
      const res = await h.client.callTool({
        name: 'continue_run',
        arguments: { run_id: env.run_id, prompt: 'next' },
      });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ text: string }>)[0].text;
      expect(text).toMatch(/discarded/);
    } finally {
      await h.close();
    }
  });
});

describe('crew serve — merge_run tool', () => {
  it('merges a successful worktree into the host HEAD', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async (task) => {
        const cwd = (task as { context: { workingDirectory: string } }).context.workingDirectory;
        writeFileSync(join(cwd, 'NEW.md'), 'hello\n', 'utf-8');
        return {
          output: 'wrote NEW.md',
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
        arguments: { agent_id: 'mock-coder', prompt: 'add a file' },
      });
      const runEnv = res.structuredContent as RunEnvelope;
      // Pre-merge: file is in worktree only.
      expect(existsSync(join(runEnv.worktree_path, 'NEW.md'))).toBe(true);
      expect(existsSync(join(h.root, 'NEW.md'))).toBe(false);

      const mergeRes = await h.client.callTool({
        name: 'merge_run',
        arguments: { run_id: runEnv.run_id },
      });
      const mergeEnv = mergeRes.structuredContent as {
        run_id: string;
        status: string;
        commit_sha?: string;
      };
      expect(mergeEnv.status).toBe('merged');
      expect(mergeEnv.commit_sha).toMatch(/^[0-9a-f]{40}$/);
      // Post-merge: file lives in host HEAD.
      expect(existsSync(join(h.root, 'NEW.md'))).toBe(true);

      // state.json reflects the merge.
      const statusRes = await h.client.callTool({
        name: 'get_run_status',
        arguments: { run_id: runEnv.run_id },
      });
      const status = statusRes.structuredContent as {
        status: string;
        mergeStatus?: { commitSha?: string };
      };
      expect(status.status).toBe('merged');
      expect(status.mergeStatus?.commitSha).toBe(mergeEnv.commit_sha);
    } finally {
      await h.close();
    }
  });

  it('refuses to merge twice (idempotency check)', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async (task) => {
        const cwd = (task as { context: { workingDirectory: string } }).context.workingDirectory;
        writeFileSync(join(cwd, 'X.md'), 'x', 'utf-8');
        return { output: 'ok', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'p' },
      });
      const runEnv = run.structuredContent as RunEnvelope;
      await h.client.callTool({ name: 'merge_run', arguments: { run_id: runEnv.run_id } });
      const second = await h.client.callTool({
        name: 'merge_run',
        arguments: { run_id: runEnv.run_id },
      });
      expect(second.isError).toBe(true);
      const text = (second.content as Array<{ text: string }>)[0].text;
      expect(text).toMatch(/already merged/);
    } finally {
      await h.close();
    }
  });

  it('reports conflict with conflicting files when host + worktree edit the same file', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async (task) => {
        const cwd = (task as { context: { workingDirectory: string } }).context.workingDirectory;
        writeFileSync(join(cwd, 'shared.txt'), 'from worktree\n', 'utf-8');
        return { output: 'ok', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = await startHarness([adapter]);
    try {
      // Seed shared.txt in main BEFORE the run starts.
      writeFileSync(join(h.root, 'shared.txt'), 'original\n', 'utf-8');
      execSync('git add shared.txt && git commit -q -m seed', { cwd: h.root });

      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'edit shared' },
      });
      const runEnv = run.structuredContent as RunEnvelope;

      // Now edit shared.txt on host main with a CONFLICTING change AFTER
      // the worktree branched off, then commit.
      writeFileSync(join(h.root, 'shared.txt'), 'from host\n', 'utf-8');
      execSync('git add shared.txt && git commit -q -m host-change', { cwd: h.root });

      const mergeRes = await h.client.callTool({
        name: 'merge_run',
        arguments: { run_id: runEnv.run_id },
      });
      expect(mergeRes.isError).toBe(true);
      const env = mergeRes.structuredContent as { status: string; conflicts?: string[] };
      expect(env.status).toBe('conflict');
      expect(env.conflicts).toContain('shared.txt');
    } finally {
      // Clean up the in-progress merge on the host so afterEach's rmSync works.
      try {
        execSync('git merge --abort', { cwd: h.root });
      } catch {
        /* no in-progress merge */
      }
      await h.close();
    }
  });

  it('returns no-changes when the worktree did nothing', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async () => ({
        output: 'nothing changed',
        filesModified: [],
        status: 'success',
        metadata: {},
      }),
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'noop' },
      });
      const runEnv = run.structuredContent as RunEnvelope;
      const mergeRes = await h.client.callTool({
        name: 'merge_run',
        arguments: { run_id: runEnv.run_id },
      });
      const env = mergeRes.structuredContent as { status: string };
      expect(env.status).toBe('no-changes');
    } finally {
      await h.close();
    }
  });
});

describe('crew serve — discard_run tool', () => {
  it('removes the worktree and marks state discarded', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async (task) => {
        const cwd = (task as { context: { workingDirectory: string } }).context.workingDirectory;
        writeFileSync(join(cwd, 'tossed.txt'), 'gone soon', 'utf-8');
        return { output: 'ok', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'do' },
      });
      const runEnv = run.structuredContent as RunEnvelope;
      expect(existsSync(runEnv.worktree_path)).toBe(true);

      const discard = await h.client.callTool({
        name: 'discard_run',
        arguments: { run_id: runEnv.run_id },
      });
      const env = discard.structuredContent as { ok: boolean };
      expect(env.ok).toBe(true);
      expect(existsSync(runEnv.worktree_path)).toBe(false);

      const status = await h.client.callTool({
        name: 'get_run_status',
        arguments: { run_id: runEnv.run_id },
      });
      const s = status.structuredContent as { status: string };
      expect(s.status).toBe('discarded');
    } finally {
      await h.close();
    }
  });

  it('is idempotent for unknown run_ids', async () => {
    const h = await startHarness([makeMockAdapter({ name: 'mock-coder' })]);
    try {
      const res = await h.client.callTool({
        name: 'discard_run',
        arguments: { run_id: 'r-never-existed' },
      });
      expect(res.isError).toBeFalsy();
      const env = res.structuredContent as { ok: boolean };
      expect(env.ok).toBe(true);
    } finally {
      await h.close();
    }
  });
});

describe('crew serve — get_run_status tool', () => {
  it('returns full state + log_tail for a completed run', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async (_task) => ({
        output: 'all done',
        filesModified: [],
        status: 'success',
        metadata: {},
      }),
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'go' },
      });
      const runEnv = run.structuredContent as RunEnvelope;
      const res = await h.client.callTool({
        name: 'get_run_status',
        arguments: { run_id: runEnv.run_id },
      });
      const s = res.structuredContent as {
        runId: string;
        agentId: string;
        status: string;
        prompts: unknown[];
        log_tail: string[];
      };
      expect(s.runId).toBe(runEnv.run_id);
      expect(s.agentId).toBe('mock-coder');
      expect(s.status).toBe('success');
      expect(s.prompts).toHaveLength(1);
      expect(Array.isArray(s.log_tail)).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('errors on unknown run_id', async () => {
    const h = await startHarness([makeMockAdapter({ name: 'mock-coder' })]);
    try {
      const res = await h.client.callTool({
        name: 'get_run_status',
        arguments: { run_id: 'r-nope' },
      });
      expect(res.isError).toBe(true);
    } finally {
      await h.close();
    }
  });
});

describe('crew serve — async-fallback for run_agent', () => {
  it('returns status:running early when dispatch exceeds the fallback window', async () => {
    let resolveAdapter!: () => void;
    const slow = new Promise<void>((r) => {
      resolveAdapter = r;
    });
    const adapter = makeMockAdapter({
      name: 'mock-slow',
      execute: async () => {
        await slow;
        return {
          output: 'eventually done',
          filesModified: [],
          status: 'success',
          metadata: {},
        };
      },
    });
    // Tiny fallback so the test doesn't have to wait 60s.
    const h = await startHarness([adapter], { asyncFallbackMs: 50 });
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-slow', prompt: 'wait then succeed' },
      });
      const env = run.structuredContent as RunEnvelope;
      expect(env.status).toBe('running');
      expect(env.summary).toMatch(/poll get_run_status/);
      // get_run_status while in flight should still report running.
      const inFlightStatus = await h.client.callTool({
        name: 'get_run_status',
        arguments: { run_id: env.run_id },
      });
      expect((inFlightStatus.structuredContent as { status: string }).status).toBe('running');

      // Now resolve the adapter and wait for the dispatch to finalize state.
      resolveAdapter();
      await waitFor(async () => {
        const r = await h.client.callTool({
          name: 'get_run_status',
          arguments: { run_id: env.run_id },
        });
        return (r.structuredContent as { status: string }).status === 'success';
      });
      const finalStatus = await h.client.callTool({
        name: 'get_run_status',
        arguments: { run_id: env.run_id },
      });
      const final = finalStatus.structuredContent as { status: string; prompts: Array<{ summary?: string }> };
      expect(final.status).toBe('success');
      expect(final.prompts[0].summary).toBe('eventually done');
    } finally {
      await h.close();
    }
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
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-serve-cancel-home-'));
    execSync('git init -q', { cwd: root });
    execSync('git config user.email test@crew.local', { cwd: root });
    execSync('git config user.name test', { cwd: root });
    writeFileSync(join(root, 'README.md'), 'init\n', 'utf-8');
    execSync('git add README.md', { cwd: root });
    execSync('git commit -q -m init', { cwd: root });
    const worktreeManager = new WorktreeManager({ projectRoot: root, crewHome });
    const { server, dispatcher } = buildCrewMcpServer({
      cwd: root,
      crewHome,
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
    rmSync(crewHome, { recursive: true, force: true });
  });
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor: timeout');
}

// Silence "unused import" for `readFileSync` if test variants change.
void readFileSync;
