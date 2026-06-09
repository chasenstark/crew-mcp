/**
 * In-process integration tests for `crew-mcp serve`.
 *
 * Drives the server via SDK Client + InMemoryTransport.createLinkedPair() —
 * no subprocess, no stdio framing. The wire-protocol contract is the SDK's
 * job; what we own is the tool surface (list_agents, run_agent), the
 * envelope shape, and the worktree-lifecycle boundary (no auto-merge).
 *
 * Subprocess + real-stdio coverage is added in M3 once `crew-mcp install` exists
 * (we'd be testing install + serve together at that point anyway).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync, spawn } from 'child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

import {
  buildCrewMcpServer,
  classifyClient,
  fileUrlHref,
  formatProgressLines,
  getRunGc,
  getStaleRunSweep,
  nextStepSentence,
  scheduleRunGc,
  scheduleStaleRunSweep,
  waitForInFlightDrain,
  waitForShutdownDrain,
  type FullRunEnvelope,
  type RunEnvelope,
} from '../../../src/cli/commands/serve.js';
import { crewTailUrl } from '../../../src/cli/commands/tail-url.js';
import type { AdapterRegistry } from '../../../src/adapters/registry.js';
import type { AgentAdapter, TaskResult } from '../../../src/adapters/types.js';
import { WorktreeManager } from '../../../src/git/worktree.js';
import { RunStateStore, type RunStateV1 } from '../../../src/orchestrator/run-state.js';
import { installRunLifecycleListeners } from '../../../src/orchestrator/run-lifecycle-listeners.js';
import { DEFAULT_PEER_MESSAGE_CAPS } from '../../../src/orchestrator/peer-messages/caps.js';
import { buildPrependBlock } from '../../../src/orchestrator/peer-messages/prepend.js';
import type { PeerMessageRendered } from '../../../src/orchestrator/peer-messages/schema.js';
import { ToolDispatcher } from '../../../src/orchestrator/tool-dispatcher.js';
import {
  getRunStatusInputSchema,
  MAX_EVENTS_TAIL_CAP,
} from '../../../src/orchestrator/tools/get-run-status.js';
import { logger } from '../../../src/utils/logger.js';
import * as configStore from '../../../src/utils/config-store.js';
import { AGENT_PREFS_FILENAME } from '../../../src/agent-prefs/store.js';

// --- helpers ---

function makeMockAdapter(overrides?: Partial<AgentAdapter>): AgentAdapter {
  return {
    name: overrides?.name ?? 'mock',
    strengths: overrides?.strengths ?? [],
    supportsJsonSchema: false,
    enforcesReadOnly: overrides?.enforcesReadOnly ?? true,
    filesModifiedReliable: overrides?.filesModifiedReliable ?? true,
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
  dispatcher: ToolDispatcher;
  worktreeManager: WorktreeManager;
  runStateStore: RunStateStore;
  root: string;
  crewHome: string;
  home: string;
  close: () => Promise<void>;
}

interface OpenAiCompatibleMock {
  readonly apiBase: string;
  readonly requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly authorization?: string;
    readonly body?: unknown;
  }>;
  readonly close: () => Promise<void>;
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function toolText(res: { content?: unknown }): string {
  const content = res.content as Array<{ text?: unknown }> | undefined;
  const text = content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error('Expected first tool content item to be text.');
  }
  return text;
}

function expectStructuredJsonBytes(
  res: { structuredContent?: unknown },
  expected: unknown,
): void {
  const actualBytes = Buffer.from(JSON.stringify(res.structuredContent), 'utf8');
  const expectedBytes = Buffer.from(JSON.stringify(expected), 'utf8');
  expect(actualBytes.equals(expectedBytes)).toBe(true);
}

function withEnv(overrides: Record<string, string | undefined>): () => void {
  const prior = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    prior.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function readPersistedState(h: Harness, runId: string): RunStateV1 {
  return JSON.parse(
    readFileSync(join(h.crewHome, 'runs', runId, 'state.json'), 'utf-8'),
  ) as RunStateV1;
}

function renderStoredPeerMessages(
  messages: readonly PeerMessageRendered[],
  h: Harness,
): string {
  const caps = h.runStateStore.caps ?? DEFAULT_PEER_MESSAGE_CAPS;
  return buildPrependBlock(messages, {
    aggregateCap: caps.aggregate,
    hardCeiling: caps.hardCeiling,
  }).rendered;
}

function runWorktreeCount(crewHome: string): number {
  const runsDir = join(crewHome, 'runs');
  if (!existsSync(runsDir)) return 0;
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) =>
      entry.isDirectory()
      && entry.name !== '.meta'
      && existsSync(join(runsDir, entry.name, 'worktree')),
    )
    .length;
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    Connection: 'close',
  });
  res.end(JSON.stringify(body));
}

async function readRequestBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf-8');
  return JSON.parse(text);
}

async function startOpenAiCompatibleMock(): Promise<OpenAiCompatibleMock> {
  const requests: OpenAiCompatibleMock['requests'] = [];
  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const authorization = req.headers.authorization;
    const body = method === 'POST' ? await readRequestBody(req) : undefined;
    requests.push({ method, url, authorization, body });

    if (method === 'GET' && url === '/v1/models') {
      writeJson(res, 200, { data: [{ id: 'gemma4:latest' }] });
      return;
    }

    if (method === 'POST' && url === '/v1/chat/completions') {
      writeJson(res, 200, {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'custom adapter response',
            },
          },
        ],
      });
      return;
    }

    writeJson(res, 404, { error: 'not found' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address.');
  }

  return {
    apiBase: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function startHarness(
  adapters: AgentAdapter[],
  options: {
    fullEnvelope?: boolean;
    clientName?: string;
    beforeBuild?: (paths: { root: string; crewHome: string; home: string }) => void;
  } = {},
): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'crew-serve-'));
  const crewHome = mkdtempSync(join(tmpdir(), 'crew-serve-home-'));
  const home = mkdtempSync(join(tmpdir(), 'crew-serve-os-home-'));
  const previousFullEnvelope = process.env.CREW_FULL_ENVELOPE;
  if (options.fullEnvelope ?? true) {
    process.env.CREW_FULL_ENVELOPE = '1';
  } else {
    delete process.env.CREW_FULL_ENVELOPE;
  }
  execSync('git init -q', { cwd: root });
  execSync('git config user.email test@crew.local', { cwd: root });
  execSync('git config user.name test', { cwd: root });
  writeFileSync(join(root, 'README.md'), 'init\n', 'utf-8');
  execSync('git add README.md', { cwd: root });
  execSync('git commit -q -m init', { cwd: root });
  options.beforeBuild?.({ root, crewHome, home });

  const worktreeManager = new WorktreeManager({ projectRoot: root, crewHome });
  const { server, dispatcher, runStateStore } = buildCrewMcpServer({
    cwd: root,
    crewHome,
    home,
    registry: makeRegistry(adapters),
    worktreeManager,
  });

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  // Default client name is a neutral `crew-test-client` so unrelated
  // serve tests classify as `unknown` and don't silently exercise the
  // Claude Code branch. Tests that need a specific host (e.g. to
  // assert watcher-phrased copy) pass `clientName` explicitly.
  const client = new Client({
    name: options.clientName ?? 'crew-test-client',
    version: '0.0.0',
  });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    dispatcher,
    worktreeManager,
    runStateStore,
    root,
    crewHome,
    home,
    close: async () => {
      await client.close();
      await server.close();
      await getStaleRunSweep();
      if (previousFullEnvelope === undefined) {
        delete process.env.CREW_FULL_ENVELOPE;
      } else {
        process.env.CREW_FULL_ENVELOPE = previousFullEnvelope;
      }
      rmSync(root, { recursive: true, force: true });
      rmSync(crewHome, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

async function startDefaultRegistryHarness(
  agentsJson: Record<string, unknown>,
  options: { fullEnvelope?: boolean; clientName?: string } = {},
): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'crew-serve-'));
  const crewHome = mkdtempSync(join(tmpdir(), 'crew-serve-home-'));
  const home = mkdtempSync(join(tmpdir(), 'crew-serve-os-home-'));
  const previousFullEnvelope = process.env.CREW_FULL_ENVELOPE;
  if (options.fullEnvelope ?? true) {
    process.env.CREW_FULL_ENVELOPE = '1';
  } else {
    delete process.env.CREW_FULL_ENVELOPE;
  }
  execSync('git init -q', { cwd: root });
  execSync('git config user.email test@crew.local', { cwd: root });
  execSync('git config user.name test', { cwd: root });
  writeFileSync(join(root, 'README.md'), 'init\n', 'utf-8');
  execSync('git add README.md', { cwd: root });
  execSync('git commit -q -m init', { cwd: root });
  writeFileSync(
    join(crewHome, AGENT_PREFS_FILENAME),
    JSON.stringify(agentsJson, null, 2),
    'utf-8',
  );

  const worktreeManager = new WorktreeManager({ projectRoot: root, crewHome });
  const { server, dispatcher, runStateStore } = buildCrewMcpServer({
    cwd: root,
    crewHome,
    home,
    worktreeManager,
  });

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: options.clientName ?? 'crew-test-client',
    version: '0.0.0',
  });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    dispatcher,
    worktreeManager,
    runStateStore,
    root,
    crewHome,
    home,
    close: async () => {
      await client.close();
      await server.close();
      await getStaleRunSweep();
      if (previousFullEnvelope === undefined) {
        delete process.env.CREW_FULL_ENVELOPE;
      } else {
        process.env.CREW_FULL_ENVELOPE = previousFullEnvelope;
      }
      rmSync(root, { recursive: true, force: true });
      rmSync(crewHome, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * Async-first dispatch helper. `run_agent` and `continue_run` always
 * return `status: "running"` immediately now; tests that need to assert
 * terminal state call this to read status until the run resolves.
 * Tests poll because they need deterministic terminal assertions; the
 * captain's default flow yields the turn and reads status on demand.
 */
async function pollUntilTerminal(
  client: Client,
  runId: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{
  status: string;
  state: Record<string, unknown>;
  events_tail: readonly string[];
  text: string;
}> {
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  const interval = options.intervalMs ?? 5;
  while (Date.now() < deadline) {
    const res = await client.callTool({
      name: 'get_run_status',
      arguments: { run_id: runId },
    });
    const state = res.structuredContent as Record<string, unknown> & {
      status: string;
      events_tail: readonly string[];
    };
    if (
      state.status !== 'running'
      && state.status !== undefined
    ) {
      return { status: state.status, state, events_tail: state.events_tail, text: toolText(res) };
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Run ${runId} did not reach terminal state within timeout`);
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

  it('exposes the v2 tool surface (16 tools incl. preferences, panel, and criteria tools)', async () => {
    const result = await h.client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'aggregate_panel',
      'cancel_run',
      'confirm_criteria',
      'continue_run',
      'create_criteria',
      'discard_run',
      'get_crew_preferences',
      'get_criteria',
      'get_panel_status',
      'get_run_status',
      'list_agents',
      'list_runs',
      'merge_run',
      'revise_criteria',
      'run_agent',
      'run_panel',
    ]);
  });

  it('run_agent declares its input schema (agent_id + prompt required, peer_messages optional)', async () => {
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
    expect(schema.properties).toHaveProperty('peer_messages');
    expect(schema.properties).toHaveProperty('criteria_set_id');
    expect(schema.required).toContain('agent_id');
    expect(schema.required).toContain('prompt');
  });

  it('continue_run declares peer_messages and does not require prompt', async () => {
    const result = await h.client.listTools();
    const continueRun = result.tools.find((t) => t.name === 'continue_run');
    expect(continueRun).toBeDefined();
    const schema = continueRun!.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty('run_id');
    expect(schema.properties).toHaveProperty('prompt');
    expect(schema.properties).toHaveProperty('peer_messages');
    expect(schema.properties).toHaveProperty('criteria_set_id');
    expect(schema.required).toContain('run_id');
    expect(schema.required ?? []).not.toContain('prompt');
  });
});

/**
 * Cross-host MCP schema compatibility guard.
 *
 * The JSON Schemas we publish via `listTools` must be accepted by all three
 * host MCP runtimes (Claude Code, Codex, Gemini), not just Anthropic's. The
 * empirically-confirmed failure mode (2026-05-16, see
 * `docs/plans/active/host-mcp-schema-compatibility.md`) is **tuple-style
 * arrays**: a `z.tuple([...])` emits `items: [schemaA, schemaB]`, but Gemini's
 * OpenAPI-flavored validator and Codex's Rust `JsonSchemaType` deserializer
 * both require `items` to be a single schema object (or boolean), never an
 * array. The 2020-12 spelling `prefixItems` is rejected for the same reason.
 *
 * That bug shipped once (the `peer_messages` excerpt `range` field, fixed in
 * 3b9c27e by switching to a fixed-length uniform array) without a regression
 * guard. This test walks every emitted tool schema and fails if any tuple
 * construct reappears — on any tool, at any depth.
 */
describe('crew serve — cross-host schema compatibility', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness([makeMockAdapter({ name: 'mock-coder' })]);
  });
  afterEach(async () => {
    await h.close();
  });

  // Keys whose values are maps of named sub-schemas. Their keys are author
  // chosen names (tool argument names), NOT schema keywords — so we must
  // recurse into the values as schemas without treating the map object itself
  // as a schema node. Otherwise a tool with an argument literally named
  // `items`/`prefixItems` would false-positive.
  const PROPERTY_MAP_KEYS = new Set([
    'properties',
    'patternProperties',
    '$defs',
    'definitions',
    'dependentSchemas',
  ]);

  /**
   * Walk a JSON Schema (treating `node` as a schema object) and collect
   * JSON-path locations of any tuple-style array construct (array-valued
   * `items`, or any `prefixItems`). Keyword detection applies only at schema
   * positions, never to the key names inside a properties/$defs map. Returns
   * an empty array when the schema is host-portable.
   */
  function findTupleConstructs(node: unknown, path = '$'): string[] {
    if (Array.isArray(node)) {
      return node.flatMap((child, i) => findTupleConstructs(child, `${path}[${i}]`));
    }
    if (node === null || typeof node !== 'object') {
      return [];
    }
    const obj = node as Record<string, unknown>;
    const violations: string[] = [];
    if (Array.isArray(obj.items)) {
      violations.push(`${path}.items (array-form / tuple)`);
    }
    if ('prefixItems' in obj) {
      violations.push(`${path}.prefixItems (2020-12 tuple)`);
    }
    for (const [key, value] of Object.entries(obj)) {
      if (PROPERTY_MAP_KEYS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
        // Recurse into each named sub-schema value; the map's own keys are
        // argument names, not schema keywords.
        for (const [name, schema] of Object.entries(value as Record<string, unknown>)) {
          violations.push(...findTupleConstructs(schema, `${path}.${key}.${name}`));
        }
      } else {
        violations.push(...findTupleConstructs(value, `${path}.${key}`));
      }
    }
    return violations;
  }

  it('no published tool schema uses a tuple-style array (Gemini/Codex reject these)', async () => {
    const result = await h.client.listTools();
    expect(result.tools.length).toBeGreaterThan(0);

    const offenders = result.tools.flatMap((tool) =>
      findTupleConstructs(tool.inputSchema, `${tool.name}.inputSchema`),
    );

    expect(
      offenders,
      `Tuple-style array schemas are rejected by Gemini and Codex. Replace `
        + `z.tuple([...]) with a fixed-length uniform array `
        + `(z.array(...).length(n)). Offending locations:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('flags a tuple nested inside a property value', () => {
    const schema = {
      type: 'object',
      properties: {
        range: { type: 'array', items: [{ type: 'integer' }, { type: 'integer' }] },
      },
    };
    expect(findTupleConstructs(schema, 'tool.inputSchema')).toEqual([
      'tool.inputSchema.properties.range.items (array-form / tuple)',
    ]);
  });

  it('does not false-positive on an argument literally named prefixItems/items', () => {
    const schema = {
      type: 'object',
      properties: {
        // Author named their arguments after schema keywords — these are
        // property names, not keywords, so the walker must ignore them.
        prefixItems: { type: 'string' },
        items: { type: 'number' },
      },
    };
    expect(findTupleConstructs(schema, 'tool.inputSchema')).toEqual([]);
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

  it('renders compact JSON content through jsonContent', async () => {
    const res = await h.client.callTool({ name: 'list_agents', arguments: {} });
    const structured = res.structuredContent as { agents: unknown[] };
    const text = toolText(res);
    expect(text).toBe(JSON.stringify(structured));
    expect(text).not.toBe(JSON.stringify(structured, null, 2));
    expect(text).not.toContain('\n');
    expectStructuredJsonBytes(res, structured);
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

  it('passes refresh through to adapter health checks', async () => {
    const healthCheck = vi.fn(async () => ({
      available: true,
      authenticated: true,
      version: '0.0.0-test',
    }));
    await h.close();
    h = await startHarness([
      makeMockAdapter({ name: 'refreshable', healthCheck }),
    ]);

    await h.client.callTool({ name: 'list_agents', arguments: { refresh: true } });

    expect(healthCheck).toHaveBeenCalledWith({ refresh: true });
  });

  it('loads custom agents.json entries into the default serve registry and dispatches through them', async () => {
    await h.close();
    const openAiMock = await startOpenAiCompatibleMock();
    try {
      h = await startDefaultRegistryHarness({
        gemma4: {
          adapter: 'openai-compatible',
          model: 'gemma4:latest',
          apiBase: openAiMock.apiBase,
          apiKey: 'ollama',
          strengths: ['local', 'private', 'fast-iteration'],
        },
      });

      const emptyPath = mkdtempSync(join(tmpdir(), 'crew-empty-path-'));
      const restorePath = withEnv({ PATH: emptyPath });
      let list: Awaited<ReturnType<Client['callTool']>>;
      try {
        list = await h.client.callTool({ name: 'list_agents', arguments: {} });
      } finally {
        restorePath();
        rmSync(emptyPath, { recursive: true, force: true });
      }
      const structured = list.structuredContent as {
        agents: Array<{ name: string; available: boolean; strengths: string[] }>;
      };
      const gemma4 = structured.agents.find((agent) => agent.name === 'gemma4');
      expect(gemma4).toMatchObject({
        name: 'gemma4',
        available: true,
        strengths: ['local', 'private', 'fast-iteration'],
      });

      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'gemma4', prompt: 'say ok' },
      });
      const runEnv = run.structuredContent as FullRunEnvelope;
      const terminal = await pollUntilTerminal(h.client, runEnv.run_id);
      expect(terminal.status).toBe('success');
      expect(terminal.state.summary).toBe('custom adapter response');

      expect(openAiMock.requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'GET',
            url: '/v1/models',
            authorization: 'Bearer ollama',
          }),
          expect.objectContaining({
            method: 'POST',
            url: '/v1/chat/completions',
            authorization: 'Bearer ollama',
          }),
        ]),
      );
    } finally {
      await openAiMock.close();
    }
  });
});

describe('crew serve — list_runs tool', () => {
  it('renders compact JSON content through jsonContent', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async () => ({
        output: 'listed run',
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
      const runEnv = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, runEnv.run_id);

      const res = await h.client.callTool({ name: 'list_runs', arguments: {} });
      const structured = res.structuredContent as {
        runs: Array<{ run_id: string; status: string; summary?: string }>;
      };
      expect(structured.runs[0]).toMatchObject({
        run_id: runEnv.run_id,
        status: 'success',
        summary: 'listed run',
      });
      const text = toolText(res);
      expect(text).toBe(JSON.stringify(structured));
      expect(text).not.toBe(JSON.stringify(structured, null, 2));
      expect(text).not.toContain('\n');
      expectStructuredJsonBytes(res, structured);
    } finally {
      await h.close();
    }
  });
});

describe('crew serve — stale-run sweeper', () => {
  it('marks current-repo running runs abandoned (dead serverPid) and leaves other/legacy records untouched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-root-'));
    const otherRoot = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-other-'));
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-home-'));
    const runsDir = join(crewHome, 'runs');
    const now = '2026-05-09T00:00:00.000Z';
    // PID virtually certain to be unused (past every modern kernel's
    // pid_max). Used to simulate a crashed prior server.
    const DEAD_PID = 2_000_000_000;

    const writeState = (
      runId: string,
      state: Record<string, unknown>,
    ): void => {
      const dir = join(runsDir, runId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'state.json'),
        JSON.stringify({
          schemaVersion: 1,
          runId,
          agentId: 'mock-coder',
          status: 'running',
          startedAt: now,
          worktreePath: join(dir, 'worktree'),
          prompts: [{ turn: 1, prompt: 'go', startedAt: now }],
          filesChanged: [],
          ...state,
        }, null, 2),
        'utf-8',
      );
    };

    writeState('current-running', { repoRoot: root, serverPid: DEAD_PID });
    writeState('other-running', { repoRoot: otherRoot, serverPid: DEAD_PID });
    writeState('legacy-running', {});

    try {
      const first = buildCrewMcpServer({
        cwd: root,
        crewHome,
        registry: makeRegistry([makeMockAdapter({ name: 'mock-coder' })]),
      });
      const currentBeforeSweep = JSON.parse(
        readFileSync(join(runsDir, 'current-running', 'state.json'), 'utf-8'),
      ) as { status: string };
      expect(currentBeforeSweep.status).toBe('running');
      await getStaleRunSweep();
      await first.server.close();

      const current = JSON.parse(
        readFileSync(join(runsDir, 'current-running', 'state.json'), 'utf-8'),
      ) as { status: string; lastError?: string; completedAt?: string };
      const other = JSON.parse(
        readFileSync(join(runsDir, 'other-running', 'state.json'), 'utf-8'),
      ) as { status: string; lastError?: string };
      const legacy = JSON.parse(
        readFileSync(join(runsDir, 'legacy-running', 'state.json'), 'utf-8'),
      ) as { status: string; lastError?: string; repoRoot?: string };

      expect(current.status).toBe('error');
      expect(current.lastError).toBe('abandoned (server restart)');
      expect(current.completedAt).toBeDefined();
      expect(other.status).toBe('running');
      expect(other.lastError).toBeUndefined();
      expect(legacy.status).toBe('running');
      expect(legacy.repoRoot).toBeUndefined();
      expect(legacy.lastError).toBeUndefined();

      const completedAt = current.completedAt;
      const second = buildCrewMcpServer({
        cwd: root,
        crewHome,
        registry: makeRegistry([makeMockAdapter({ name: 'mock-coder' })]),
      });
      await getStaleRunSweep();
      await second.server.close();
      const currentAfterSecondBoot = JSON.parse(
        readFileSync(join(runsDir, 'current-running', 'state.json'), 'utf-8'),
      ) as { status: string; lastError?: string; completedAt?: string };
      expect(currentAfterSecondBoot.status).toBe('error');
      expect(currentAfterSecondBoot.lastError).toBe('abandoned (server restart)');
      expect(currentAfterSecondBoot.completedAt).toBe(completedAt);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(otherRoot, { recursive: true, force: true });
      rmSync(crewHome, { recursive: true, force: true });
    }
  });

  it('marks same-server running records abandoned only when no in-flight task matches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-same-server-'));
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-same-server-home-'));
    const runsDir = join(crewHome, 'runs');
    const now = '2026-05-09T00:00:00.000Z';

    const writeState = (runId: string): void => {
      const dir = join(runsDir, runId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'state.json'),
        JSON.stringify({
          schemaVersion: 1,
          runId,
          agentId: 'mock-coder',
          status: 'running',
          startedAt: now,
          worktreePath: join(dir, 'worktree'),
          repoRoot: root,
          serverPid: process.pid,
          prompts: [{ turn: 1, prompt: 'go', startedAt: now }],
          filesChanged: [],
        }, null, 2),
        'utf-8',
      );
    };

    writeState('orphan-running');
    writeState('in-flight-running');

    const runStateStore = new RunStateStore({ crewHome, repoRoot: root });
    const dispatcher = new ToolDispatcher();
    const releaseInFlight = createDeferred<unknown>();
    dispatcher.start({
      toolCallId: 'tool-call-1',
      toolName: 'run_agent',
      runId: 'in-flight-running',
      run: () => releaseInFlight.promise,
    });

    try {
      await scheduleStaleRunSweep({ crewHome, projectRoot: root, runStateStore, dispatcher });

      const orphan = JSON.parse(
        readFileSync(join(runsDir, 'orphan-running', 'state.json'), 'utf-8'),
      ) as { status: string; lastError?: string };
      const inFlight = JSON.parse(
        readFileSync(join(runsDir, 'in-flight-running', 'state.json'), 'utf-8'),
      ) as { status: string; lastError?: string };

      expect(orphan.status).toBe('error');
      expect(orphan.lastError).toBe('abandoned (not in-flight)');
      expect(inFlight.status).toBe('running');
      expect(inFlight.lastError).toBeUndefined();
    } finally {
      releaseInFlight.resolve({});
      await new Promise((resolve) => setImmediate(resolve));
      rmSync(root, { recursive: true, force: true });
      rmSync(crewHome, { recursive: true, force: true });
    }
  });

  it('does not abandon a same-server run that appears in the fresh in-flight check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-fresh-inflight-'));
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-fresh-inflight-home-'));
    const runsDir = join(crewHome, 'runs');
    const runId = 'late-in-flight-running';
    const dir = join(runsDir, runId);
    const ancient = '2026-05-09T00:00:00.000Z';
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId,
        agentId: 'mock-coder',
        status: 'running',
        startedAt: ancient,
        worktreePath: join(dir, 'worktree'),
        repoRoot: root,
        serverPid: process.pid,
        prompts: [{ turn: 1, prompt: 'go', startedAt: ancient }],
        filesChanged: [],
      }, null, 2),
      'utf-8',
    );

    const runStateStore = new RunStateStore({ crewHome, repoRoot: root });
    const dispatcher = new ToolDispatcher();
    vi.spyOn(dispatcher, 'listInFlight')
      .mockReturnValueOnce([])
      .mockReturnValue([
        { toolCallId: 'tool-call-late', toolName: 'run_agent', runId },
      ]);

    try {
      await scheduleStaleRunSweep({ crewHome, projectRoot: root, runStateStore, dispatcher });

      const state = JSON.parse(
        readFileSync(join(dir, 'state.json'), 'utf-8'),
      ) as { status: string; lastError?: string };
      expect(state.status).toBe('running');
      expect(state.lastError).toBeUndefined();
      expect(dispatcher.listInFlight).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(crewHome, { recursive: true, force: true });
    }
  });

  it('applies the stale-run grace to same-server no-inflight records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-same-grace-'));
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-same-grace-home-'));
    const runsDir = join(crewHome, 'runs');
    const fresh = new Date().toISOString();
    const ancient = '2026-05-09T00:00:00.000Z';

    const writeState = (runId: string, startedAt: string): void => {
      const dir = join(runsDir, runId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'state.json'),
        JSON.stringify({
          schemaVersion: 1,
          runId,
          agentId: 'mock-coder',
          status: 'running',
          startedAt,
          worktreePath: join(dir, 'worktree'),
          repoRoot: root,
          serverPid: process.pid,
          prompts: [{ turn: 1, prompt: 'go', startedAt }],
          filesChanged: [],
        }, null, 2),
        'utf-8',
      );
    };

    writeState('fresh-same-server', fresh);
    writeState('stale-same-server', ancient);

    const runStateStore = new RunStateStore({ crewHome, repoRoot: root });
    const dispatcher = new ToolDispatcher();

    try {
      await scheduleStaleRunSweep({ crewHome, projectRoot: root, runStateStore, dispatcher });

      const freshState = JSON.parse(
        readFileSync(join(runsDir, 'fresh-same-server', 'state.json'), 'utf-8'),
      ) as { status: string; lastError?: string };
      const staleState = JSON.parse(
        readFileSync(join(runsDir, 'stale-same-server', 'state.json'), 'utf-8'),
      ) as { status: string; lastError?: string };

      expect(freshState.status).toBe('running');
      expect(freshState.lastError).toBeUndefined();
      expect(staleState.status).toBe('error');
      expect(staleState.lastError).toBe('abandoned (not in-flight)');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(crewHome, { recursive: true, force: true });
    }
  });

  it('skips runs whose recorded serverPid belongs to a different live server', async () => {
    // Regression: every dispatched agent's MCP connection spawns its own
    // crew-mcp server, which would otherwise mark its sibling agents'
    // in-flight runs as abandoned. Records that include a serverPid the
    // OS reports as alive must be left untouched when owned by another PID.
    const root = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-pid-'));
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-pid-home-'));
    const runsDir = join(crewHome, 'runs');
    const now = '2026-05-09T00:00:00.000Z';
    const otherServer = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000);'], {
      stdio: 'ignore',
    });

    const writeState = (
      runId: string,
      serverPid: number | undefined,
    ): void => {
      const dir = join(runsDir, runId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'state.json'),
        JSON.stringify({
          schemaVersion: 1,
          runId,
          agentId: 'mock-coder',
          status: 'running',
          startedAt: now,
          worktreePath: join(dir, 'worktree'),
          repoRoot: root,
          ...(serverPid !== undefined ? { serverPid } : {}),
          prompts: [{ turn: 1, prompt: 'go', startedAt: now }],
          filesChanged: [],
        }, null, 2),
        'utf-8',
      );
    };

    // Use a spawned child as a guaranteed different live PID. Use a PID that
    // is virtually certain to be unused (Linux/macOS PIDs are bounded;
    // 2_000_000_000 is past every modern kernel's pid_max).
    const ALIVE_PID = otherServer.pid;
    const DEAD_PID = 2_000_000_000;
    expect(ALIVE_PID).toBeDefined();

    writeState('alive-pid-running', ALIVE_PID!);
    writeState('dead-pid-running', DEAD_PID);

    try {
      const server = buildCrewMcpServer({
        cwd: root,
        crewHome,
        registry: makeRegistry([makeMockAdapter({ name: 'mock-coder' })]),
      });
      await getStaleRunSweep();
      await server.server.close();

      const alive = JSON.parse(
        readFileSync(join(runsDir, 'alive-pid-running', 'state.json'), 'utf-8'),
      ) as { status: string; lastError?: string };
      const dead = JSON.parse(
        readFileSync(join(runsDir, 'dead-pid-running', 'state.json'), 'utf-8'),
      ) as { status: string; lastError?: string };

      expect(alive.status).toBe('running');
      expect(alive.lastError).toBeUndefined();
      expect(dead.status).toBe('error');
      expect(dead.lastError).toBe('abandoned (server restart)');
    } finally {
      otherServer.kill();
      rmSync(root, { recursive: true, force: true });
      rmSync(crewHome, { recursive: true, force: true });
    }
  });

  it('does not act on running records rejected by the run-state schema guard', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-schema-'));
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-schema-home-'));
    const runsDir = join(crewHome, 'runs');
    const runId = 'future-schema-running';
    const dir = join(runsDir, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        schemaVersion: 2,
        runId,
        agentId: 'mock-coder',
        status: 'running',
        startedAt: '2026-05-09T00:00:00.000Z',
        worktreePath: join(dir, 'worktree'),
        repoRoot: root,
        serverPid: process.pid,
        prompts: [{ turn: 1, prompt: 'go', startedAt: '2026-05-09T00:00:00.000Z' }],
        filesChanged: [],
      }, null, 2),
      'utf-8',
    );

    try {
      const server = buildCrewMcpServer({
        cwd: root,
        crewHome,
        registry: makeRegistry([makeMockAdapter({ name: 'mock-coder' })]),
      });
      await getStaleRunSweep();
      await server.server.close();

      const state = JSON.parse(
        readFileSync(join(dir, 'state.json'), 'utf-8'),
      ) as { schemaVersion: number; status: string; lastError?: string };
      expect(state.schemaVersion).toBe(2);
      expect(state.status).toBe('running');
      expect(state.lastError).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(crewHome, { recursive: true, force: true });
    }
  });

  it('skips runs whose latest prompt.startedAt is within the grace window (same-second restart race)', async () => {
    // Regression for the Conductor-style restart race: the host SIGTERMed
    // crew-mcp ~3s after dispatch and the immediate respawn's sweeper
    // would reap an in-flight run because its predecessor's serverPid
    // was already ESRCH. The grace window protects records whose serverPid
    // was JUST stamped by the dying predecessor — they're either picked
    // up by another live server or seconds-fresh garbage the next
    // dispatch (or a user-driven discard_run) will clear.
    const root = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-grace-'));
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-grace-home-'));
    const runsDir = join(crewHome, 'runs');
    const DEAD_PID = 2_000_000_000;
    const fresh = new Date().toISOString();
    const ancient = '2026-05-09T00:00:00.000Z';

    const writeState = (
      runId: string,
      startedAt: string,
      promptStartedAt: string,
    ): void => {
      const dir = join(runsDir, runId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'state.json'),
        JSON.stringify({
          schemaVersion: 1,
          runId,
          agentId: 'mock-coder',
          status: 'running',
          startedAt,
          worktreePath: join(dir, 'worktree'),
          repoRoot: root,
          serverPid: DEAD_PID,
          prompts: [{ turn: 1, prompt: 'go', startedAt: promptStartedAt }],
          filesChanged: [],
        }, null, 2),
        'utf-8',
      );
    };

    // "fresh": latest prompt timestamp is now → grace window saves it
    // even though serverPid is dead.
    writeState('fresh-running', ancient, fresh);
    // "ancient": both timestamps are days old → sweep should reap.
    writeState('ancient-running', ancient, ancient);

    try {
      const server = buildCrewMcpServer({
        cwd: root,
        crewHome,
        registry: makeRegistry([makeMockAdapter({ name: 'mock-coder' })]),
      });
      await getStaleRunSweep();
      await server.server.close();

      const freshState = JSON.parse(
        readFileSync(join(runsDir, 'fresh-running', 'state.json'), 'utf-8'),
      ) as { status: string; lastError?: string };
      const ancientState = JSON.parse(
        readFileSync(join(runsDir, 'ancient-running', 'state.json'), 'utf-8'),
      ) as { status: string; lastError?: string };

      expect(freshState.status).toBe('running');
      expect(freshState.lastError).toBeUndefined();
      expect(ancientState.status).toBe('error');
      expect(ancientState.lastError).toBe('abandoned (server restart)');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(crewHome, { recursive: true, force: true });
    }
  });

  it('single-flights concurrent stale-run sweep triggers', async () => {
    await getStaleRunSweep();

    const root = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-flight-'));
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-flight-home-'));
    const runStateStore = new RunStateStore({ crewHome, repoRoot: root });
    const dispatcher = new ToolDispatcher();
    const sweepStarted = createDeferred<void>();
    const releaseSweep = createDeferred<void>();
    let calls = 0;

    try {
      const args = { crewHome, projectRoot: root, runStateStore, dispatcher };
      const first = scheduleStaleRunSweep(args, async () => {
        calls += 1;
        sweepStarted.resolve();
        await releaseSweep.promise;
      });
      const second = scheduleStaleRunSweep(args, async () => {
        calls += 1;
      });

      expect(second).toBe(first);
      await sweepStarted.promise;
      expect(calls).toBe(1);

      releaseSweep.resolve();
      await first;
      expect(calls).toBe(1);
      expect(getStaleRunSweep()).toBeNull();
    } finally {
      releaseSweep.resolve();
      await getStaleRunSweep();
      rmSync(root, { recursive: true, force: true });
      rmSync(crewHome, { recursive: true, force: true });
    }
  });

  it('does not single-flight stale-run sweeps across different crewHome/projectRoot keys', async () => {
    await getStaleRunSweep();

    const rootA = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-key-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-key-b-'));
    const crewHomeA = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-key-home-a-'));
    const crewHomeB = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-key-home-b-'));
    const dispatcher = new ToolDispatcher();
    const release = createDeferred<void>();
    let calls = 0;

    try {
      const first = scheduleStaleRunSweep({
        crewHome: crewHomeA,
        projectRoot: rootA,
        runStateStore: new RunStateStore({ crewHome: crewHomeA, repoRoot: rootA }),
        dispatcher,
      }, async () => {
        calls += 1;
        await release.promise;
      });
      const second = scheduleStaleRunSweep({
        crewHome: crewHomeB,
        projectRoot: rootB,
        runStateStore: new RunStateStore({ crewHome: crewHomeB, repoRoot: rootB }),
        dispatcher,
      }, async () => {
        calls += 1;
      });

      expect(second).not.toBe(first);
      await second;
      expect(calls).toBe(2);
      release.resolve();
      await first;
    } finally {
      release.resolve();
      await getStaleRunSweep();
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
      rmSync(crewHomeA, { recursive: true, force: true });
      rmSync(crewHomeB, { recursive: true, force: true });
    }
  });

  it('logs deferred stale-run sweep errors without failing server startup', async () => {
    await getStaleRunSweep();

    const root = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-error-'));
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-serve-sweep-error-home-'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    try {
      const built = buildCrewMcpServer({
        cwd: root,
        crewHome,
        registry: makeRegistry([makeMockAdapter({ name: 'mock-coder' })]),
        staleRunSweeper: () => {
          throw new Error('mock sweep failure');
        },
      });

      expect(built.server).toBeDefined();
      await getStaleRunSweep();
      await built.server.close();
      expect(warn).toHaveBeenCalledWith(
        'stale-run sweeper: failed: mock sweep failure',
      );
    } finally {
      warn.mockRestore();
      rmSync(root, { recursive: true, force: true });
      rmSync(crewHome, { recursive: true, force: true });
    }
  });

  it('schedules the run GC on server startup and passes it the worktree manager', async () => {
    await getRunGc();

    const root = mkdtempSync(join(tmpdir(), 'crew-serve-gc-'));
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-serve-gc-home-'));
    let received: { crewHome?: string; hasWorktreeManager?: boolean } = {};

    try {
      const built = buildCrewMcpServer({
        cwd: root,
        crewHome,
        registry: makeRegistry([makeMockAdapter({ name: 'mock-coder' })]),
        runGc: (args) => {
          received = {
            crewHome: args.crewHome,
            hasWorktreeManager: args.worktreeManager !== undefined,
          };
        },
      });
      await getRunGc();
      await built.server.close();

      expect(received.crewHome).toBe(crewHome);
      expect(received.hasWorktreeManager).toBe(true);
    } finally {
      await getRunGc();
      rmSync(root, { recursive: true, force: true });
      rmSync(crewHome, { recursive: true, force: true });
    }
  });

  it('logs deferred run GC errors without failing server startup', async () => {
    await getRunGc();

    const root = mkdtempSync(join(tmpdir(), 'crew-serve-gc-error-'));
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-serve-gc-error-home-'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    try {
      const built = buildCrewMcpServer({
        cwd: root,
        crewHome,
        registry: makeRegistry([makeMockAdapter({ name: 'mock-coder' })]),
        runGc: () => {
          throw new Error('mock gc failure');
        },
      });

      expect(built.server).toBeDefined();
      await getRunGc();
      await built.server.close();
      expect(warn).toHaveBeenCalledWith('run GC: failed: mock gc failure');
    } finally {
      warn.mockRestore();
      rmSync(root, { recursive: true, force: true });
      rmSync(crewHome, { recursive: true, force: true });
    }
  });

  it('single-flights concurrent run GC triggers', async () => {
    await getRunGc();

    const root = mkdtempSync(join(tmpdir(), 'crew-serve-gc-flight-'));
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-serve-gc-flight-home-'));
    const runStateStore = new RunStateStore({ crewHome, repoRoot: root });
    const worktreeManager = new WorktreeManager({ projectRoot: root, crewHome });
    const gcStarted = createDeferred<void>();
    const releaseGc = createDeferred<void>();
    let calls = 0;

    try {
      const args = { crewHome, projectRoot: root, runStateStore, worktreeManager };
      const first = scheduleRunGc(args, async () => {
        calls += 1;
        gcStarted.resolve();
        await releaseGc.promise;
      });
      const second = scheduleRunGc(args, async () => {
        calls += 1;
      });

      expect(second).toBe(first);
      await gcStarted.promise;
      expect(calls).toBe(1);

      releaseGc.resolve();
      await first;
      expect(calls).toBe(1);
      expect(getRunGc()).toBeNull();
    } finally {
      releaseGc.resolve();
      await getRunGc();
      rmSync(root, { recursive: true, force: true });
      rmSync(crewHome, { recursive: true, force: true });
    }
  });

  it('does not single-flight run GC across different crewHome/projectRoot keys', async () => {
    await getRunGc();

    const rootA = mkdtempSync(join(tmpdir(), 'crew-serve-gc-key-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'crew-serve-gc-key-b-'));
    const crewHomeA = mkdtempSync(join(tmpdir(), 'crew-serve-gc-key-home-a-'));
    const crewHomeB = mkdtempSync(join(tmpdir(), 'crew-serve-gc-key-home-b-'));
    const release = createDeferred<void>();
    let calls = 0;

    try {
      const first = scheduleRunGc({
        crewHome: crewHomeA,
        projectRoot: rootA,
        runStateStore: new RunStateStore({ crewHome: crewHomeA, repoRoot: rootA }),
        worktreeManager: new WorktreeManager({ projectRoot: rootA, crewHome: crewHomeA }),
      }, async () => {
        calls += 1;
        await release.promise;
      });
      const second = scheduleRunGc({
        crewHome: crewHomeB,
        projectRoot: rootB,
        runStateStore: new RunStateStore({ crewHome: crewHomeB, repoRoot: rootB }),
        worktreeManager: new WorktreeManager({ projectRoot: rootB, crewHome: crewHomeB }),
      }, async () => {
        calls += 1;
      });

      expect(second).not.toBe(first);
      await second;
      expect(calls).toBe(2);
      release.resolve();
      await first;
    } finally {
      release.resolve();
      await getRunGc();
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
      rmSync(crewHomeA, { recursive: true, force: true });
      rmSync(crewHomeB, { recursive: true, force: true });
    }
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
      const env = res.structuredContent as FullRunEnvelope;
      expect(env.run_id).toMatch(/^mock-coder-add-change-md-[0-9a-f]{8}$/);
      // Async-first: run_agent always returns running; poll for terminal.
      expect(env.status).toBe('running');
      expect(env.events_log_path).toBe(join(h.crewHome, 'runs', env.run_id, 'events.log'));
      const final = await pollUntilTerminal(h.client, env.run_id);
      expect(final.status).toBe('success');
      // Worktree exists, file lives only there (no auto-merge).
      expect(existsSync(join(env.worktree_path, 'CHANGE.md'))).toBe(true);
      expect(existsSync(join(h.root, 'CHANGE.md'))).toBe(false);
      expect(final.state.filesChanged).toContain('CHANGE.md');
      // Top-level `summary` carries the latest turn's adapter output;
      // per-turn `prompts[].summary` is intentionally elided from the
      // wire (durable in state.json, not re-shipped on every poll).
      const wire = final.state as {
        summary?: string;
        prompts: Array<{ turn: number; summary?: string }>;
      };
      expect(wire.summary).toBe('changed CHANGE.md');
      expect(wire.prompts[wire.prompts.length - 1].summary).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  it('returns a trimmed structured dispatch envelope by default', async () => {
    const adapter = makeMockAdapter({ name: 'mock-coder' });
    const h = await startHarness([adapter], { fullEnvelope: false });
    try {
      const res = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'go' },
      });
      const env = res.structuredContent as RunEnvelope;
      expect(Object.keys(env).sort()).toEqual([
        'files_changed',
        'run_id',
        'summary',
        'tail_url',
      ]);
      expect(env.run_id).toMatch(/^mock-coder-go-[0-9a-f]{8}$/);
      expect(env.tail_url).toBe(crewTailUrl(join(h.crewHome, 'runs', env.run_id, 'events.log')));
      expect(env.summary).toContain(`Dispatched as "${env.run_id}"`);
      expect(env.files_changed).toEqual([]);
      expect(env.status).toBeUndefined();
      expect(env.agent_id).toBeUndefined();
      expect(env.worktree_path).toBeUndefined();
      expect(env.events_log_path).toBeUndefined();
      expect(env.tail_command_path).toBeUndefined();
      expect(env.tail_command_url).toBeUndefined();

      const text = (res.content as Array<{ text: string }>)[0].text;
      expect(text).toContain(`**Dispatched** \`mock-coder\` as run \`${env.run_id}\`.`);
      expect(text).toContain(`tail -F ${join(h.crewHome, 'runs', env.run_id, 'events.log')}`);
      expect(text).toContain('- Worktree: `');

      await pollUntilTerminal(h.client, env.run_id);
    } finally {
      await h.close();
    }
  });

  it('includes required_next_action in the trimmed Claude Code dispatch envelope', async () => {
    const adapter = makeMockAdapter({ name: 'mock-coder' });
    const h = await startHarness([adapter], {
      fullEnvelope: false,
      clientName: 'claude-code',
    });
    try {
      const res = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'go' },
      });
      const env = res.structuredContent as RunEnvelope;
      expect(Object.keys(env).sort()).toEqual([
        'files_changed',
        'required_next_action',
        'run_id',
        'summary',
        'tail_url',
      ]);
      expect(env.required_next_action).toMatchObject({
        type: 'spawn_watcher',
        mechanism: 'background_shell',
        command: `crew-wait ${env.run_id}`,
        run_id: env.run_id,
        run_in_background: true,
        per_run: true,
      });
      expect(toolText(res)).toContain(
        `Bash(crew-wait ${env.run_id}, run_in_background: true)`,
      );

      await pollUntilTerminal(h.client, env.run_id);
    } finally {
      await h.close();
    }
  });

  it('uses project crewWaitCommand over global crewWaitCommand for Claude Code dispatches', async () => {
    const adapter = makeMockAdapter({ name: 'mock-coder' });
    const h = await startHarness([adapter], {
      clientName: 'claude-code',
      beforeBuild: ({ root, home }) => {
        mkdirSync(join(home, '.crew'), { recursive: true });
        writeFileSync(
          join(home, '.crew', 'install.json'),
          JSON.stringify({
            schemaVersion: 2,
            targets: {
              'claude-code': {
                crewWaitCommand: '/usr/local/bin/crew-wait',
              },
            },
          }),
          'utf-8',
        );
        mkdirSync(join(root, '.crew'), { recursive: true });
        writeFileSync(
          join(root, '.crew', 'install.project.json'),
          JSON.stringify({
            schemaVersion: 1,
            scope: 'project',
            targets: {
              'claude-code': {
                crewWaitCommand: 'npx --no-install crew-wait',
              },
            },
          }),
          'utf-8',
        );
      },
    });
    try {
      const res = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'go' },
      });
      const env = res.structuredContent as FullRunEnvelope;
      expect(env.required_next_action?.command).toBe(
        `npx --no-install crew-wait ${env.run_id}`,
      );
      expect(toolText(res)).toContain(
        `Bash(npx --no-install crew-wait ${env.run_id}, run_in_background: true)`,
      );

      await pollUntilTerminal(h.client, env.run_id);
    } finally {
      await h.close();
    }
  });

  it('returns markdown text plus structuredContent (not raw JSON) on dispatch', async () => {
    // #1: hosts collapse MCP tool calls to a one-line title and only
    // show the result when the user expands. Markdown reads as a
    // status report there; raw JSON reads as noise. The structured
    // payload can be expanded with CREW_FULL_ENVELOPE=1 for legacy
    // programmatic consumers.
    const adapter = makeMockAdapter({ name: 'mock-coder' });
    const h = await startHarness([adapter]);
    try {
      const res = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'go' },
      });
      const env = res.structuredContent as FullRunEnvelope;
      // CREW_FULL_ENVELOPE=1 restores the legacy structuredContent shape
      // for any host UI that still plucks path fields programmatically.
      expect(env.run_id).toMatch(/^mock-coder-go-[0-9a-f]{8}$/);
      expect(env.agent_id).toBe('mock-coder');
      expect(env.status).toBe('running');
      expect(env.events_log_path).toBe(join(h.crewHome, 'runs', env.run_id, 'events.log'));
      // tail_command_path: the run-dir-local helper script the user
      // can open in a side terminal to follow the run live.
      expect(env.tail_command_path).toBe(join(h.crewHome, 'runs', env.run_id, 'tail.command'));
      // tail_command_url: pre-encoded file:// URL the captain can
      // paste directly into a markdown link in its inline dispatch
      // confirmation (so the user sees the link without expanding
      // the collapsed tool result).
      expect(env.tail_command_url).toBe(fileUrlHref(env.tail_command_path));
      expect(env.tail_command_url.startsWith('file://')).toBe(true);
      expect(env.tail_url).toBe(crewTailUrl(env.events_log_path));
      expect(env.tail_url.startsWith('crew-tail://')).toBe(true);
      // text is markdown, not stringified JSON.
      const text = (res.content as Array<{ text: string }>)[0].text;
      expect(text).not.toMatch(/^\s*\{/); // not a JSON blob
      expect(text).toMatch(/^\*\*Dispatched\*\* `mock-coder` as run `/);
      expect(text).toContain(env.run_id);
      expect(text).toContain(env.worktree_path);
      expect(text).toContain(`tail -F ${env.events_log_path}`);
      expect(text).toContain('get_run_status');
      expect(text).toContain('user is free to chat');
      expect(text).toContain(`get_run_status({ run_id: "${env.run_id}" })`);
      expect(text).not.toContain('wait_for_change_ms: 30000');
      // Clickable link only shows on macOS (Terminal.app handles
      // crew-tail:// when the optional handler is installed). On other
      // platforms the manual tail line remains the portable path.
      if (process.platform === 'darwin') {
        expect(text).toContain(env.tail_url);
        expect(text).not.toContain(fileUrlHref(env.tail_command_path));
        expect(text).toContain('Tail in Terminal');
      } else {
        expect(text).not.toContain('file://');
        expect(text).not.toContain('crew-tail://');
      }
      // Wait so the lifecycle terminates before harness teardown — otherwise
      // the dispatcher's listeners outlive the test.
      await pollUntilTerminal(h.client, env.run_id);
    } finally {
      await h.close();
    }
  });

  it('encodes file:// markdown links with literal # and ? path characters', () => {
    expect(fileUrlHref('/tmp/crew #run?leaf/tail.command')).toBe(
      'file:///tmp/crew%20%23run%3Fleaf/tail.command',
    );
  });

  it('writes an executable tail.command helper that targets the run\'s events.log', async () => {
    // The tail.command file is the load-bearing piece of the user's
    // progress channel: a click (macOS) or a manual `bash <path>`
    // (Linux) opens a side terminal that follows events.log live so
    // the captain doesn't have to render progress into its reply.
    // Asserts the file exists, is executable, and runs `tail -F`
    // against the right log path with shell-quote-safe escaping.
    const adapter = makeMockAdapter({ name: 'mock-coder' });
    const h = await startHarness([adapter]);
    try {
      const res = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'go' },
      });
      const env = res.structuredContent as FullRunEnvelope;

      const tailPath = env.tail_command_path;
      expect(existsSync(tailPath)).toBe(true);
      // chmod 0755 — owner exec bit is the load-bearing one for
      // double-click launching on macOS and `./tail.command` on Linux.
      const mode = statSync(tailPath).mode;
      expect(mode & 0o100).toBe(0o100);

      const contents = readFileSync(tailPath, 'utf-8');
      expect(contents.startsWith('#!/bin/bash\n')).toBe(true);
      expect(contents).toContain(`exec tail -F '${env.events_log_path}'`);

      // Cleanup.
      await pollUntilTerminal(h.client, env.run_id);
    } finally {
      await h.close();
    }
  });

  it('escapes backticks and newlines in markdown inline-code fields', async () => {
    const agentName = 'mock`coder\nline';
    const worktreePath = join(tmpdir(), 'path`with\nnewline');
    const adapter = makeMockAdapter({ name: agentName });
    const h = await startHarness([adapter]);
    try {
      const res = await h.client.callTool({
        name: 'run_agent',
        arguments: {
          agent_id: agentName,
          prompt: 'go',
          read_only: true,
          working_directory: worktreePath,
        },
      });
      const env = res.structuredContent as FullRunEnvelope;
      const text = (res.content as Array<{ text: string }>)[0].text;
      expect(text).toContain('**Dispatched** `` mock`coder line `` as run `');
      expect(text).toContain(
        '- Worktree: `` ' + worktreePath.replace(/[\r\n]+/g, ' ') + ' ``',
      );
      expect(env.agent_id).toBe(agentName);
      expect(env.worktree_path).toBe(worktreePath);
      await pollUntilTerminal(h.client, env.run_id);
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
      // Async-first: run_agent itself succeeds even when the dispatch
      // will fail. Adapter errors surface via get_run_status terminal.
      const env = res.structuredContent as FullRunEnvelope;
      expect(env.status).toBe('running');
      const final = await pollUntilTerminal(h.client, env.run_id);
      expect(final.status).toBe('error');
      expect(String(final.state.lastError ?? '')).toMatch(/adapter exploded/);
      expect(final.state.filesChanged).toEqual([]);
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
      const firstEnv = first.structuredContent as FullRunEnvelope;
      // Wait for turn 1 to terminate before continuing — continue_run
      // doesn't gate on terminal but the adapter mock isn't reentrant.
      await pollUntilTerminal(h.client, firstEnv.run_id);
      const second = await h.client.callTool({
        name: 'continue_run',
        arguments: { run_id: firstEnv.run_id, prompt: 'turn-two' },
      });
      const secondEnv = second.structuredContent as FullRunEnvelope;
      expect(secondEnv.run_id).toBe(firstEnv.run_id);
      expect(secondEnv.worktree_path).toBe(firstEnv.worktree_path);
      expect(secondEnv.status).toBe('running');
      const secondText = (second.content as Array<{ text: string }>)[0].text;
      expect(secondText).not.toMatch(/^\s*\{/);
      expect(secondText).toMatch(/^\*\*Dispatched\*\* `mock-coder` as run `/);
      expect(secondText).toContain(firstEnv.run_id);
      expect(secondText).toContain(firstEnv.worktree_path);
      expect(secondText).toContain('get_run_status');
      const final = await pollUntilTerminal(h.client, firstEnv.run_id);
      expect(final.status).toBe('success');
      // Adapter received both prompts, both pointed at the same worktree.
      expect(calls).toHaveLength(2);
      expect(calls[0]).toBe(`turn-one@${firstEnv.worktree_path}`);
      expect(calls[1]).toBe(`turn-two@${firstEnv.worktree_path}`);
      // state.json (durable record) holds both verbatim prompts.
      // The wire payload from get_run_status no longer surfaces raw
      // prompt text — captains already have what they sent — so we
      // assert against the on-disk state.json instead.
      const stateJsonPath = join(h.crewHome, 'runs', firstEnv.run_id, 'state.json');
      const persisted = JSON.parse(readFileSync(stateJsonPath, 'utf-8')) as {
        prompts: Array<{ turn: number; prompt: string }>;
      };
      expect(persisted.prompts).toHaveLength(2);
      expect(persisted.prompts.map((p) => p.prompt)).toEqual(['turn-one', 'turn-two']);
      // Wire payload still surfaces per-turn metadata (turn, summary)
      // but elides the verbatim prompt text.
      const wirePrompts = final.state.prompts as Array<{ turn: number; prompt?: string; summary?: string }>;
      expect(wirePrompts).toHaveLength(2);
      expect(wirePrompts.every((p) => p.prompt === undefined)).toBe(true);
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

  it('refuses to continue a currently running run', async () => {
    const terminal = createDeferred<TaskResult>();
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async () => terminal.promise,
    });
    const h = await startHarness([adapter]);
    try {
      const initial = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'first' },
      });
      const env = initial.structuredContent as FullRunEnvelope;
      const res = await h.client.callTool({
        name: 'continue_run',
        arguments: { run_id: env.run_id, prompt: 'next' },
      });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ text: string }>)[0].text;
      expect(text).toBe('continue_run: run is currently running; call cancel_run first.');

      terminal.resolve({ output: 'done', filesModified: [], status: 'success', metadata: {} });
      await pollUntilTerminal(h.client, env.run_id);
    } finally {
      terminal.resolve({ output: 'done', filesModified: [], status: 'success', metadata: {} });
      await h.close();
    }
  });

  it('refuses to continue when a terminal run still has in-flight cleanup', async () => {
    const h = await startHarness([makeMockAdapter({ name: 'mock-coder' })]);
    try {
      const initial = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'first' },
      });
      const env = initial.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, env.run_id);
      const append = vi.spyOn(h.runStateStore, 'appendPrompt');
      vi.spyOn(h.dispatcher, 'listInFlight').mockReturnValue([
        { toolCallId: 'still-finishing', toolName: 'run_agent', runId: env.run_id },
      ]);

      const res = await h.client.callTool({
        name: 'continue_run',
        arguments: { run_id: env.run_id, prompt: 'next' },
      });

      expect(res.isError).toBe(true);
      expect(toolText(res)).toContain('still has in-flight work');
      expect(append).not.toHaveBeenCalled();
      expect(readPersistedState(h, env.run_id).status).toBe('success');
    } finally {
      await h.close();
    }
  });

  it('marks continue_run error when worktree sync throws after appendPrompt', async () => {
    const h = await startHarness([makeMockAdapter({ name: 'mock-coder' })]);
    try {
      const initial = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'first' },
      });
      const env = initial.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, env.run_id);
      vi.spyOn(h.worktreeManager, 'syncUncommittedToRunWorktree')
        .mockRejectedValue(new Error('mock sync failure'));

      const res = await h.client.callTool({
        name: 'continue_run',
        arguments: { run_id: env.run_id, prompt: 'next' },
      });

      expect(res.isError).toBe(true);
      expect(toolText(res)).toContain('continue_run dispatch failed');
      expect(toolText(res)).toContain('mock sync failure');
      const state = readPersistedState(h, env.run_id);
      expect(state.status).toBe('error');
      expect(state.lastError).toContain('mock sync failure');
      expect(state.prompts).toHaveLength(2);
      expect(state.prompts[1]?.completedAt).toBeDefined();
    } finally {
      await h.close();
    }
  });

  it('marks continue_run error when dispatcher.start throws after appendPrompt', async () => {
    const h = await startHarness([makeMockAdapter({ name: 'mock-coder' })]);
    try {
      const initial = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'first' },
      });
      const env = initial.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, env.run_id);
      vi.spyOn(h.dispatcher, 'start').mockImplementationOnce(() => {
        throw new Error('mock start failure');
      });

      const res = await h.client.callTool({
        name: 'continue_run',
        arguments: { run_id: env.run_id, prompt: 'next' },
      });

      expect(res.isError).toBe(true);
      expect(toolText(res)).toContain('continue_run dispatch failed');
      expect(toolText(res)).toContain('mock start failure');
      const state = readPersistedState(h, env.run_id);
      expect(state.status).toBe('error');
      expect(state.lastError).toContain('mock start failure');
      expect(state.prompts).toHaveLength(2);
      expect(state.prompts[1]?.completedAt).toBeDefined();
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
      const env = initial.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, env.run_id);
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

describe('crew serve — peer_messages integration', () => {
  const peerMessage = {
    body: 'Reviewer found the missing edge case.',
    kind: 'review' as const,
    from_label: 'reviewer-A',
    files: ['src/edge.ts'],
    excerpts: [
      {
        file: 'src/edge.ts',
        range: [12, 18] as [number, number],
        text: 'if (!value) return;',
      },
    ],
  };

  function manyPeerMessages(count: number): Array<typeof peerMessage> {
    return Array.from({ length: count }, (_, index) => ({
      ...peerMessage,
      body: `peer message ${index}`,
      from_label: `peer-${index}`,
      excerpts: undefined,
    }));
  }

  it('run_agent prepends peer_messages byte-for-byte and stores the post-pipeline audit form', async () => {
    const prompts: string[] = [];
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async (task) => {
        prompts.push(task.prompt);
        return { output: 'ok', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: {
          agent_id: 'mock-coder',
          prompt: 'implement the fix',
          peer_messages: [peerMessage],
        },
      });
      const env = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, env.run_id);

      const state = readPersistedState(h, env.run_id);
      const stored = state.prompts[0].peer_messages_input ?? [];
      const expectedBlock = renderStoredPeerMessages(stored, h);
      expect(prompts[0]).toBe(`${expectedBlock}implement the fix`);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        body: peerMessage.body,
        kind: 'review',
        from_label: 'reviewer-A',
        files: ['src/edge.ts'],
        rendered_in_turn: 1,
      });
    } finally {
      await h.close();
    }
  });

  it('run_panel prepends the implementer-context peer_message byte-for-byte', async () => {
    const prompts: string[] = [];
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async (task) => {
        prompts.push(task.prompt);
        if (prompts.length === 1) {
          return {
            output: 'Implementation summary',
            filesModified: ['src/impl.ts'],
            status: 'success',
            metadata: {},
          };
        }
        return { output: 'review ok', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const impl = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'implement the feature' },
      });
      const implEnv = impl.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, implEnv.run_id);

      const panel = await h.client.callTool({
        name: 'run_panel',
        arguments: {
          implementer_run_id: implEnv.run_id,
          reviewers: [{ agent_id: 'mock-coder', prompt: 'review the feature' }],
        },
      });
      const panelEnv = panel.structuredContent as {
        reviewers: Array<{ run_id: string }>;
      };
      await pollUntilTerminal(h.client, panelEnv.reviewers[0].run_id);

      const state = readPersistedState(h, panelEnv.reviewers[0].run_id);
      const stored = state.prompts[0].peer_messages_input ?? [];
      const expectedBlock = renderStoredPeerMessages(stored, h);
      expect(prompts[1]).toBe(`${expectedBlock}review the feature`);
      expect(stored[0]).toMatchObject({
        body: 'Implementation summary',
        kind: 'review',
        files: ['src/impl.ts'],
      });
    } finally {
      await h.close();
    }
  });

  it('run_panel lists one Claude Code watcher per reviewer run', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async () => ({ output: 'review ok', filesModified: [], status: 'success', metadata: {} }),
    });
    const h = await startHarness([adapter], { clientName: 'claude-code' });
    try {
      const panel = await h.client.callTool({
        name: 'run_panel',
        arguments: {
          reviewers: [
            { agent_id: 'mock-coder', prompt: 'review 1' },
            { agent_id: 'mock-coder', prompt: 'review 2' },
          ],
        },
      });
      const panelEnv = panel.structuredContent as {
        reviewers: Array<{
          run_id: string;
          required_next_action?: { command: string; run_id: string };
        }>;
      };
      expect(panelEnv.reviewers).toHaveLength(2);
      const text = toolText(panel);
      expect(text).toContain('spawn one watcher per reviewer run');
      for (const reviewer of panelEnv.reviewers) {
        expect(reviewer.required_next_action).toEqual({
          type: 'spawn_watcher',
          mechanism: 'background_shell',
          command: `crew-wait ${reviewer.run_id}`,
          run_id: reviewer.run_id,
          run_in_background: true,
          per_run: true,
          consequence_if_skipped:
            'Skip it and the run is orphaned; no watcher-triggered terminal turn will surface completion.',
        });
        expect(text).toContain(
          `Bash(crew-wait ${reviewer.run_id}, run_in_background: true)`,
        );
        await pollUntilTerminal(h.client, reviewer.run_id);
      }
    } finally {
      await h.close();
    }
  });

  it('continue_run accepts peer_messages without a prompt and prepends them byte-for-byte', async () => {
    const prompts: string[] = [];
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async (task) => {
        prompts.push(task.prompt);
        return { output: 'ok', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const first = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'turn one' },
      });
      const env = first.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, env.run_id);

      const second = await h.client.callTool({
        name: 'continue_run',
        arguments: {
          run_id: env.run_id,
          prompt: '',
          peer_messages: [peerMessage],
        },
      });
      expect(second.isError).toBeUndefined();
      await pollUntilTerminal(h.client, env.run_id);

      const state = readPersistedState(h, env.run_id);
      const stored = state.prompts[1].peer_messages_input ?? [];
      const expectedBlock = renderStoredPeerMessages(stored, h);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toBe(expectedBlock);
      expect(stored[0]).toMatchObject({
        body: peerMessage.body,
        kind: 'review',
        rendered_in_turn: 2,
      });
    } finally {
      await h.close();
    }
  });

  it.each(['codex', 'claude-code', 'gemini-cli', 'generic', 'openai-compatible'])(
    'passes the composed peer_messages prompt to the %s adapter',
    async (agentName) => {
      let observedPrompt = '';
      const adapter = makeMockAdapter({
        name: agentName,
        execute: async (task) => {
          observedPrompt = task.prompt;
          return { output: 'ok', filesModified: [], status: 'success', metadata: {} };
        },
      });
      const h = await startHarness([adapter]);
      try {
        const run = await h.client.callTool({
          name: 'run_agent',
          arguments: {
            agent_id: agentName,
            prompt: 'review this',
            peer_messages: [peerMessage],
          },
        });
        const env = run.structuredContent as FullRunEnvelope;
        await pollUntilTerminal(h.client, env.run_id);
        const state = readPersistedState(h, env.run_id);
        const expectedBlock = renderStoredPeerMessages(
          state.prompts[0].peer_messages_input ?? [],
          h,
        );
        expect(observedPrompt).toBe(`${expectedBlock}review this`);
      } finally {
        await h.close();
      }
    },
  );

  it('rejects continue_run as peer_messages.no_op when prompt and peer_messages are both empty', async () => {
    const h = await startHarness([makeMockAdapter({ name: 'mock-coder' })]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'first' },
      });
      const env = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, env.run_id);

      const res = await h.client.callTool({
        name: 'continue_run',
        arguments: { run_id: env.run_id },
      });
      expect(res.isError).toBe(true);
      expect(toolText(res)).toBe(
        'peer_messages.no_op: continue_run requires either prompt or peer_messages',
      );
    } finally {
      await h.close();
    }
  });

  it('rejects peer_messages.too_many before allocating a worktree', async () => {
    const restore = withEnv({ CREW_PEER_MESSAGES_MAX_ITEMS: '1' });
    const h = await startHarness([makeMockAdapter({ name: 'mock-coder' })]);
    try {
      expect(runWorktreeCount(h.crewHome)).toBe(0);
      const res = await h.client.callTool({
        name: 'run_agent',
        arguments: {
          agent_id: 'mock-coder',
          prompt: 'go',
          peer_messages: manyPeerMessages(2),
        },
      });
      expect(res.isError).toBe(true);
      expect(toolText(res)).toMatch(/^peer_messages\.too_many:/);
      expect(runWorktreeCount(h.crewHome)).toBe(0);
    } finally {
      await h.close();
      restore();
    }
  });

  it('rejects concurrent continue_run with peer_messages.run_in_flight inside appendPrompt', async () => {
    let executeCount = 0;
    const continuationTerminal = createDeferred<TaskResult>();
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async () => {
        executeCount += 1;
        if (executeCount === 1) {
          return { output: 'initial', filesModified: [], status: 'success', metadata: {} };
        }
        return continuationTerminal.promise;
      },
    });
    const h = await startHarness([adapter]);
    const bothInAppend = createDeferred<void>();
    let appendEntrants = 0;
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'first' },
      });
      const env = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, env.run_id);

      const originalAppend = h.runStateStore.appendPrompt.bind(h.runStateStore);
      vi.spyOn(h.runStateStore, 'appendPrompt').mockImplementation(async (runId, options) => {
        appendEntrants += 1;
        if (appendEntrants === 2) bothInAppend.resolve();
        await bothInAppend.promise;
        return originalAppend(runId, options);
      });

      const first = h.client.callTool({
        name: 'continue_run',
        arguments: { run_id: env.run_id, prompt: 'one' },
      });
      const second = h.client.callTool({
        name: 'continue_run',
        arguments: { run_id: env.run_id, prompt: 'two' },
      });
      const results = await Promise.all([first, second]);
      const errors = results.filter((res) => res.isError);
      expect(errors).toHaveLength(1);
      expect(toolText(errors[0])).toMatch(/^peer_messages\.run_in_flight:/);

      continuationTerminal.resolve({
        output: 'continued',
        filesModified: [],
        status: 'success',
        metadata: {},
      });
      await pollUntilTerminal(h.client, env.run_id);
    } finally {
      continuationTerminal.resolve({
        output: 'continued',
        filesModified: [],
        status: 'success',
        metadata: {},
      });
      await h.close();
    }
  });

  it('cleans up the allocated worktree when run_agent composed prompt cap rejects', async () => {
    const restore = withEnv({
      CREW_PEER_MESSAGES_PREPEND_CAP_CHARS: '100',
      CREW_PEER_MESSAGES_HARD_CEILING: '150',
      CREW_DISPATCH_PROMPT_CAP_CHARS: '160',
    });
    const h = await startHarness([makeMockAdapter({ name: 'mock-coder' })]);
    try {
      const res = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'x'.repeat(200) },
      });
      expect(res.isError).toBe(true);
      expect(toolText(res)).toMatch(/^peer_messages\.composed_prompt_too_large:/);
      expect(runWorktreeCount(h.crewHome)).toBe(0);
    } finally {
      await h.close();
      restore();
    }
  });

  it('leaves prior state bytes intact when continue_run composed prompt cap rejects', async () => {
    const restore = withEnv({
      CREW_PEER_MESSAGES_PREPEND_CAP_CHARS: '100',
      CREW_PEER_MESSAGES_HARD_CEILING: '150',
      CREW_DISPATCH_PROMPT_CAP_CHARS: '160',
    });
    const h = await startHarness([makeMockAdapter({ name: 'mock-coder' })]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'short' },
      });
      const env = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, env.run_id);
      const statePath = join(h.crewHome, 'runs', env.run_id, 'state.json');
      const before = readFileSync(statePath, 'utf-8');

      const res = await h.client.callTool({
        name: 'continue_run',
        arguments: { run_id: env.run_id, prompt: 'x'.repeat(200) },
      });
      expect(res.isError).toBe(true);
      expect(toolText(res)).toMatch(/^peer_messages\.composed_prompt_too_large:/);
      expect(readFileSync(statePath, 'utf-8')).toBe(before);
    } finally {
      await h.close();
      restore();
    }
  });

  it('honors CREW_PEER_MESSAGES_MAX_ITEMS while the default accepts six items', async () => {
    let restore = withEnv({ CREW_PEER_MESSAGES_MAX_ITEMS: '5' });
    let h = await startHarness([makeMockAdapter({ name: 'mock-coder' })]);
    try {
      const rejected = await h.client.callTool({
        name: 'run_agent',
        arguments: {
          agent_id: 'mock-coder',
          prompt: 'go',
          peer_messages: manyPeerMessages(6),
        },
      });
      expect(rejected.isError).toBe(true);
      expect(toolText(rejected)).toMatch(/^peer_messages\.too_many:/);
    } finally {
      await h.close();
      restore();
    }

    restore = withEnv({ CREW_PEER_MESSAGES_MAX_ITEMS: undefined });
    h = await startHarness([makeMockAdapter({ name: 'mock-coder' })]);
    try {
      const accepted = await h.client.callTool({
        name: 'run_agent',
        arguments: {
          agent_id: 'mock-coder',
          prompt: 'go',
          peer_messages: manyPeerMessages(6),
        },
      });
      expect(accepted.isError).toBeUndefined();
      const env = accepted.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, env.run_id);
    } finally {
      await h.close();
      restore();
    }
  });

  it('surfaces cap_overrides_invalid once on the first dispatch that uses peer_messages', async () => {
    const restore = withEnv({ CREW_PEER_MESSAGES_PREPEND_CAP_CHARS: '200000' });
    const h = await startHarness([makeMockAdapter({ name: 'mock-coder' })]);
    try {
      const first = await h.client.callTool({
        name: 'run_agent',
        arguments: {
          agent_id: 'mock-coder',
          prompt: 'first',
          peer_messages: [peerMessage],
        },
      });
      const firstEnv = first.structuredContent as FullRunEnvelope;
      expect(firstEnv.warnings).toContain('peer_messages.cap_overrides_invalid: aggregate');
      expect(toolText(first)).toContain('peer_messages.cap_overrides_invalid: aggregate');
      await pollUntilTerminal(h.client, firstEnv.run_id);

      const second = await h.client.callTool({
        name: 'run_agent',
        arguments: {
          agent_id: 'mock-coder',
          prompt: 'second',
          peer_messages: [peerMessage],
        },
      });
      const secondEnv = second.structuredContent as FullRunEnvelope;
      expect(secondEnv.warnings ?? []).not.toContain('peer_messages.cap_overrides_invalid: aggregate');
      await pollUntilTerminal(h.client, secondEnv.run_id);
    } finally {
      await h.close();
      restore();
    }
  });

  it('surfaces body and excerpt truncation warnings on the envelope and markdown', async () => {
    const restore = withEnv({
      CREW_PEER_MESSAGE_BODY_CAP_CHARS: '24',
      CREW_PEER_MESSAGE_EXCERPT_CAP_CHARS: '12',
    });
    const h = await startHarness([makeMockAdapter({ name: 'mock-coder' })]);
    try {
      const res = await h.client.callTool({
        name: 'run_agent',
        arguments: {
          agent_id: 'mock-coder',
          prompt: 'go',
          peer_messages: [{
            ...peerMessage,
            body: 'b'.repeat(80),
            excerpts: [{ file: 'src/a.ts', range: [1, 2], text: 'e'.repeat(80) }],
          }],
        },
      });
      const env = res.structuredContent as FullRunEnvelope;
      expect(env.warnings?.some((w) => w.startsWith('peer_messages.body_truncated:'))).toBe(true);
      expect(env.warnings?.some((w) => w.startsWith('peer_messages.excerpt_truncated:'))).toBe(true);
      const text = toolText(res);
      expect(text).toContain('## Warnings');
      expect(text).toContain('peer_messages.body_truncated:');
      expect(text).toContain('peer_messages.excerpt_truncated:');
      await pollUntilTerminal(h.client, env.run_id);
    } finally {
      await h.close();
      restore();
    }
  });

  it('surfaces aggregate cap drop warnings on the envelope and markdown', async () => {
    const restore = withEnv({
      CREW_PEER_MESSAGES_PREPEND_CAP_CHARS: '500',
      CREW_PEER_MESSAGES_HARD_CEILING: '2000',
      CREW_DISPATCH_PROMPT_CAP_CHARS: '4000',
    });
    const h = await startHarness([makeMockAdapter({ name: 'mock-coder' })]);
    try {
      const res = await h.client.callTool({
        name: 'run_agent',
        arguments: {
          agent_id: 'mock-coder',
          prompt: 'go',
          peer_messages: manyPeerMessages(12).map((message) => ({
            ...message,
            body: 'm'.repeat(80),
          })),
        },
      });
      const env = res.structuredContent as FullRunEnvelope;
      expect(env.warnings?.some((w) => w.startsWith('peer_messages.aggregate_cap_reached:'))).toBe(true);
      expect(toolText(res)).toContain('peer_messages.aggregate_cap_reached:');
      await pollUntilTerminal(h.client, env.run_id);
    } finally {
      await h.close();
      restore();
    }
  });

  it.each([
    { fullEnvelope: true, label: 'full envelope' },
    { fullEnvelope: false, label: 'default envelope' },
  ])('surfaces warnings in $label mode and markdown', async ({ fullEnvelope }) => {
    const restore = withEnv({ CREW_PEER_MESSAGE_BODY_CAP_CHARS: '24' });
    const h = await startHarness([makeMockAdapter({ name: 'mock-coder' })], { fullEnvelope });
    try {
      const res = await h.client.callTool({
        name: 'run_agent',
        arguments: {
          agent_id: 'mock-coder',
          prompt: 'go',
          peer_messages: [{ ...peerMessage, body: 'b'.repeat(80) }],
        },
      });
      const env = res.structuredContent as RunEnvelope;
      expect(env.warnings?.some((w) => w.startsWith('peer_messages.body_truncated:'))).toBe(true);
      expect(toolText(res)).toContain('## Warnings');
      expect(toolText(res)).toContain('peer_messages.body_truncated:');
      await pollUntilTerminal(h.client, env.run_id);
    } finally {
      await h.close();
      restore();
    }
  });

  it('runs continue_run worktree sync after appendPrompt and before dispatch', async () => {
    const sequence: string[] = [];
    let executeCount = 0;
    let promptCountAtSync = 0;
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async () => {
        executeCount += 1;
        if (executeCount === 2) sequence.push('execute');
        return { output: 'ok', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'first' },
      });
      const env = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, env.run_id);

      vi.spyOn(h.worktreeManager, 'syncUncommittedToRunWorktree')
        .mockImplementation(async (runId) => {
          sequence.push('sync');
          promptCountAtSync = readPersistedState(h, runId).prompts.length;
          return { copied: 0, removed: 0 };
        });

      await h.client.callTool({
        name: 'continue_run',
        arguments: {
          run_id: env.run_id,
          prompt: 'second',
          peer_messages: [peerMessage],
        },
      });
      await pollUntilTerminal(h.client, env.run_id);
      expect(promptCountAtSync).toBe(2);
      expect(sequence).toEqual(['sync', 'execute']);
    } finally {
      await h.close();
    }
  });

  it('uses one stable toolCallId from planner task construction through dispatcher lifecycle', async () => {
    let startToolCallId = '';
    let completeToolCallId = '';
    const adapter = makeMockAdapter({ name: 'mock-coder' });
    const h = await startHarness([adapter]);
    const startSub = h.dispatcher.onEvent('run:start', (info) => {
      startToolCallId = info.toolCallId;
    });
    const completeSub = h.dispatcher.onEvent('run:complete', (info) => {
      completeToolCallId = info.toolCallId;
    });
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: {
          agent_id: 'mock-coder',
          prompt: 'go',
          peer_messages: [peerMessage],
        },
      });
      const env = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, env.run_id);
      expect(startToolCallId).toBeTruthy();
      expect(completeToolCallId).toBe(startToolCallId);
    } finally {
      startSub.dispose();
      completeSub.dispose();
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
      const runEnv = res.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, runEnv.run_id);
      // Pre-merge: file is in worktree only.
      expect(existsSync(join(runEnv.worktree_path, 'NEW.md'))).toBe(true);
      expect(existsSync(join(h.root, 'NEW.md'))).toBe(false);

      const mergeRes = await h.client.callTool({
        name: 'merge_run',
        arguments: { run_id: runEnv.run_id, confirmed: true },
      });
      const mergeEnv = mergeRes.structuredContent as {
        run_id: string;
        status: string;
        commit_sha?: string;
      };
      expect(mergeEnv.status).toBe('merged');
      expect(mergeEnv.commit_sha).toMatch(/^[0-9a-f]{40}$/);
      expect(toolText(mergeRes)).toBe(
        `**Merged** \`${runEnv.run_id}\` → \`${mergeEnv.commit_sha}\``,
      );
      expectStructuredJsonBytes(mergeRes, {
        run_id: runEnv.run_id,
        status: 'merged',
        commit_sha: mergeEnv.commit_sha,
      });
      // Post-merge: file lives in host HEAD.
      expect(existsSync(join(h.root, 'NEW.md'))).toBe(true);
      // Post-merge: worktree directory is auto-cleaned (the changes
      // are durably in main, so the worktree has no remaining value).
      expect(existsSync(runEnv.worktree_path)).toBe(false);

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

      // Squash merge: the landed commit is a single-parent ordinary
      // commit, NOT an empty two-parent `--no-ff` wrapper.
      const parents = execSync(`git rev-list --parents -n 1 ${mergeEnv.commit_sha}`, {
        cwd: h.root,
      }).toString().trim().split(/\s+/);
      // [commit, parent1] — exactly one parent, no second merge parent.
      expect(parents.length).toBe(2);
      // And no machine trailer on the message.
      const body = execSync(`git log -1 --format=%B ${mergeEnv.commit_sha}`, {
        cwd: h.root,
      }).toString();
      expect(body).not.toMatch(/Crew-Run:/);
    } finally {
      await h.close();
    }
  });

  it('surfaces and restores when merge_run lands on a branch other than the original checkout', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async (task) => {
        const cwd = (task as { context: { workingDirectory: string } }).context.workingDirectory;
        writeFileSync(join(cwd, 'TARGET.md'), 'target branch landing\n', 'utf-8');
        return {
          output: 'wrote TARGET.md',
          filesModified: [],
          status: 'success',
          metadata: {},
        } satisfies TaskResult;
      },
    });
    const h = await startHarness([adapter]);
    try {
      const target = execSync('git branch --show-current', { cwd: h.root }).toString().trim();
      execSync('git checkout -q -b feature', { cwd: h.root });
      const originalHead = execSync('git rev-parse HEAD', { cwd: h.root }).toString().trim();

      const res = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'add target file' },
      });
      const runEnv = res.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, runEnv.run_id);

      const mergeRes = await h.client.callTool({
        name: 'merge_run',
        arguments: {
          run_id: runEnv.run_id,
          target_branch: target,
          confirmed: true,
        },
      });
      const mergeEnv = mergeRes.structuredContent as {
        run_id: string;
        status: string;
        commit_sha?: string;
        target_branch?: string;
        original_branch?: string;
        original_head?: string;
        landed_off_current_branch?: boolean;
      };

      expect(mergeEnv).toMatchObject({
        run_id: runEnv.run_id,
        status: 'merged',
        target_branch: target,
        original_branch: 'feature',
        original_head: originalHead,
        landed_off_current_branch: true,
      });
      expect(mergeEnv.commit_sha).toMatch(/^[0-9a-f]{40}$/);
      expect(toolText(mergeRes)).toBe(
        `**Merged** \`${runEnv.run_id}\` → \`${mergeEnv.commit_sha}\`\n\n`
        + `Landed on \`${target}\`; restored \`feature\`.`,
      );
      expect(execSync('git branch --show-current', { cwd: h.root }).toString().trim()).toBe('feature');
      expect(execSync(`git show ${target}:TARGET.md`, { cwd: h.root }).toString()).toBe(
        'target branch landing\n',
      );
      expect(existsSync(join(h.root, 'TARGET.md'))).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('marks the run merged when merge_run returns merged with restore_failed', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async (task) => {
        const cwd = (task as { context: { workingDirectory: string } }).context.workingDirectory;
        writeFileSync(join(cwd, 'RESTORE.md'), 'restore failure\n', 'utf-8');
        return {
          output: 'wrote RESTORE.md',
          filesModified: [],
          status: 'success',
          metadata: {},
        } satisfies TaskResult;
      },
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'add restore file' },
      });
      const runEnv = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, runEnv.run_id);
      const cleanup = vi.spyOn(h.worktreeManager, 'cleanupByRunId').mockResolvedValue({
        success: true,
        errors: [],
        hadRecord: true,
        worktreeRemoved: true,
        branchDeleted: true,
        recordDeleted: true,
      });
      vi.spyOn(h.worktreeManager, 'mergeRunWorktree').mockResolvedValue({
        status: 'merged',
        commitSha: 'abc123',
        targetBranch: 'main',
        originalBranch: 'feature',
        originalHead: 'feature-head',
        landedOffCurrentBranch: true,
        restoreFailed: true,
        restoreWarning: "Merge landed but I couldn't return you to feature; you're on main. Restore failed: checkout failed",
      });

      const mergeRes = await h.client.callTool({
        name: 'merge_run',
        arguments: { run_id: runEnv.run_id, confirmed: true },
      });
      const mergeEnv = mergeRes.structuredContent as {
        status: string;
        restore_failed?: boolean;
        restore_warning?: string;
      };

      expect(mergeEnv.status).toBe('merged');
      expect(mergeEnv.restore_failed).toBe(true);
      expect(mergeEnv.restore_warning).toContain("couldn't return you to feature");
      expect(toolText(mergeRes)).toContain("couldn't return you to feature");
      expect(cleanup).toHaveBeenCalledWith(runEnv.run_id);

      const statusRes = await h.client.callTool({
        name: 'get_run_status',
        arguments: { run_id: runEnv.run_id },
      });
      const status = statusRes.structuredContent as {
        status: string;
        mergeStatus?: { commitSha?: string };
      };
      expect(status.status).toBe('merged');
      expect(status.mergeStatus?.commitSha).toBe('abc123');
    } finally {
      await h.close();
    }
  });

  it('merge_strategy preserve keeps the run\'s individual commits linearly', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async (task) => {
        const cwd = (task as { context: { workingDirectory: string } }).context.workingDirectory;
        // Two discrete, standalone commits — a deliberate stack.
        writeFileSync(join(cwd, 'a.txt'), 'a\n', 'utf-8');
        execSync('git add a.txt && git commit -q -m "feat: add a"', { cwd });
        writeFileSync(join(cwd, 'b.txt'), 'b\n', 'utf-8');
        execSync('git add b.txt && git commit -q -m "feat: add b"', { cwd });
        return { output: 'two commits', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'stack two commits' },
      });
      const runEnv = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, runEnv.run_id);

      const mergeRes = await h.client.callTool({
        name: 'merge_run',
        arguments: { run_id: runEnv.run_id, confirmed: true, merge_strategy: 'preserve' },
      });
      const mergeEnv = mergeRes.structuredContent as { status: string; commit_sha?: string };
      expect(mergeEnv.status).toBe('merged');

      // Both files landed.
      expect(existsSync(join(h.root, 'a.txt'))).toBe(true);
      expect(existsSync(join(h.root, 'b.txt'))).toBe(true);

      // The two commits are preserved as distinct, single-parent commits
      // on top of the host branch — no squash, no merge commit.
      const subjects = execSync('git log -2 --format=%s', { cwd: h.root })
        .toString().trim().split('\n');
      expect(subjects).toEqual(['feat: add b', 'feat: add a']);
      const tipParents = execSync('git rev-list --parents -n 1 HEAD', { cwd: h.root })
        .toString().trim().split(/\s+/);
      expect(tipParents.length).toBe(2); // [commit, single-parent]
    } finally {
      await h.close();
    }
  });

  it('refuses to merge without confirmed:true when confirmBeforeMerge is enabled', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async (task) => {
        const cwd = (task as { context: { workingDirectory: string } }).context.workingDirectory;
        writeFileSync(join(cwd, 'GATE.md'), 'gate\n', 'utf-8');
        return { output: 'ok', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'p' },
      });
      const runEnv = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, runEnv.run_id);

      const merge = await h.client.callTool({
        name: 'merge_run',
        arguments: { run_id: runEnv.run_id },
      });

      expect(merge.isError).toBe(true);
      expect(toolText(merge)).toBe(
        'merge_run: requires explicit user confirmation (config: confirmBeforeMerge=true). ' +
        'Ask the user to approve, then call merge_run again with {confirmed: true}. ' +
        'Run this from the captain skill — never auto-pass confirmed:true without an explicit user "yes".',
      );
      expect(existsSync(join(h.root, 'GATE.md'))).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('bypasses merge confirmation when confirmBeforeMerge=false', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async (task) => {
        const cwd = (task as { context: { workingDirectory: string } }).context.workingDirectory;
        writeFileSync(join(cwd, 'NO-GATE.md'), 'ok\n', 'utf-8');
        return { output: 'ok', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = await startHarness([adapter]);
    try {
      configStore.writeConfigFile(h.crewHome, {
        notifications: { success: true, error: true },
        confirmBeforeMerge: false,
      });
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'p' },
      });
      const runEnv = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, runEnv.run_id);

      const merge = await h.client.callTool({
        name: 'merge_run',
        arguments: { run_id: runEnv.run_id },
      });

      const env = merge.structuredContent as { status: string };
      expect(env.status).toBe('merged');
      expect(existsSync(join(h.root, 'NO-GATE.md'))).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('bypasses merge confirmation when CREW_CONFIRM_BEFORE_MERGE=off', async () => {
    const previous = process.env.CREW_CONFIRM_BEFORE_MERGE;
    process.env.CREW_CONFIRM_BEFORE_MERGE = 'off';
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async (task) => {
        const cwd = (task as { context: { workingDirectory: string } }).context.workingDirectory;
        writeFileSync(join(cwd, 'ENV-GATE.md'), 'ok\n', 'utf-8');
        return { output: 'ok', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'p' },
      });
      const runEnv = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, runEnv.run_id);

      const merge = await h.client.callTool({
        name: 'merge_run',
        arguments: { run_id: runEnv.run_id },
      });

      const env = merge.structuredContent as { status: string };
      expect(env.status).toBe('merged');
      expect(existsSync(join(h.root, 'ENV-GATE.md'))).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.CREW_CONFIRM_BEFORE_MERGE;
      } else {
        process.env.CREW_CONFIRM_BEFORE_MERGE = previous;
      }
      await h.close();
    }
  });

  it('only bypasses merge confirmation when CREW_CONFIRM_BEFORE_MERGE is exactly off', async () => {
    const previous = process.env.CREW_CONFIRM_BEFORE_MERGE;
    const envValues = ['on', 'false', '0', '', '1'];
    try {
      for (const value of envValues) {
        process.env.CREW_CONFIRM_BEFORE_MERGE = value;
        const adapter = makeMockAdapter({
          name: `mock-coder-${value || 'empty'}`,
          execute: async (task) => {
            const cwd = (task as { context: { workingDirectory: string } }).context.workingDirectory;
            writeFileSync(join(cwd, `ENV-GATE-${value || 'empty'}.md`), 'ok\n', 'utf-8');
            return { output: 'ok', filesModified: [], status: 'success', metadata: {} };
          },
        });
        const h = await startHarness([adapter]);
        try {
          const run = await h.client.callTool({
            name: 'run_agent',
            arguments: { agent_id: adapter.name, prompt: 'p' },
          });
          const runEnv = run.structuredContent as FullRunEnvelope;
          await pollUntilTerminal(h.client, runEnv.run_id);

          const merge = await h.client.callTool({
            name: 'merge_run',
            arguments: { run_id: runEnv.run_id },
          });

          expect(toolText(merge)).toContain(
            'merge_run: requires explicit user confirmation (config: confirmBeforeMerge=true).',
          );
          expect(existsSync(join(h.root, `ENV-GATE-${value || 'empty'}.md`))).toBe(false);
        } finally {
          await h.close();
        }
      }
    } finally {
      if (previous === undefined) {
        delete process.env.CREW_CONFIRM_BEFORE_MERGE;
      } else {
        process.env.CREW_CONFIRM_BEFORE_MERGE = previous;
      }
    }
  }, 20_000);

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
      const runEnv = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, runEnv.run_id);
      await h.client.callTool({
        name: 'merge_run',
        arguments: { run_id: runEnv.run_id, confirmed: true },
      });
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

  it('refuses to merge a currently running run', async () => {
    const terminal = createDeferred<TaskResult>();
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async () => terminal.promise,
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'p' },
      });
      const runEnv = run.structuredContent as FullRunEnvelope;
      const merge = await h.client.callTool({
        name: 'merge_run',
        arguments: { run_id: runEnv.run_id },
      });
      expect(merge.isError).toBe(true);
      const text = (merge.content as Array<{ text: string }>)[0].text;
      expect(text).toBe('merge_run: run is currently running; call cancel_run first.');

      terminal.resolve({ output: 'done', filesModified: [], status: 'success', metadata: {} });
      await pollUntilTerminal(h.client, runEnv.run_id);
    } finally {
      terminal.resolve({ output: 'done', filesModified: [], status: 'success', metadata: {} });
      await h.close();
    }
  });

  it('reports conflict and keeps merge_conflict recovery paths open', async () => {
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
      const runEnv = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, runEnv.run_id);

      // Now edit shared.txt on host main with a CONFLICTING change AFTER
      // the worktree branched off, then commit.
      writeFileSync(join(h.root, 'shared.txt'), 'from host\n', 'utf-8');
      execSync('git add shared.txt && git commit -q -m host-change', { cwd: h.root });

      const mergeRes = await h.client.callTool({
        name: 'merge_run',
        arguments: { run_id: runEnv.run_id, confirmed: true },
      });
      expect(mergeRes.isError).toBe(true);
      const env = mergeRes.structuredContent as { status: string; conflicts?: string[] };
      expect(env.status).toBe('conflict');
      expect(env.conflicts).toContain('shared.txt');
      expect(toolText(mergeRes)).toBe(
        `**Conflict** on \`${runEnv.run_id}\` (1 files): shared.txt`,
      );
      expectStructuredJsonBytes(mergeRes, {
        run_id: runEnv.run_id,
        status: 'conflict',
        conflicts: ['shared.txt'],
      });

      const continueRes = await h.client.callTool({
        name: 'continue_run',
        arguments: { run_id: runEnv.run_id, prompt: 'try something else' },
      });
      expect(continueRes.isError).toBe(true);
      const continueText = (continueRes.content as Array<{ text: string }>)[0].text;
      expect(continueText).toMatch(/merge_conflict/);

      // merge_run squash-merges, so the conflict leaves staged conflict
      // markers but no MERGE_HEAD — `git merge --abort` does not apply.
      // Bail with a hard reset back to the target tip.
      execSync('git reset --hard HEAD', { cwd: h.root });

      const retry = await h.client.callTool({
        name: 'merge_run',
        arguments: { run_id: runEnv.run_id, confirmed: true },
      });
      expect(retry.isError).toBe(true);
      const retryEnv = retry.structuredContent as { status: string; conflicts?: string[] };
      expect(retryEnv.status).toBe('conflict');
      expect(retryEnv.conflicts).toContain('shared.txt');

      execSync('git reset --hard HEAD', { cwd: h.root });

      const discard = await h.client.callTool({
        name: 'discard_run',
        arguments: { run_id: runEnv.run_id },
      });
      expect(discard.isError).toBeFalsy();
      const discardEnv = discard.structuredContent as { ok: boolean };
      expect(discardEnv.ok).toBe(true);
    } finally {
      // Clean up any staged squash conflict on the host so afterEach's
      // rmSync works.
      try {
        execSync('git reset --hard HEAD', { cwd: h.root, stdio: 'ignore' });
      } catch {
        /* nothing to reset */
      }
      await h.close();
    }
  });

  it('refuses when the host repo already has unmerged index paths even with force=true', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async (task) => {
        const cwd = (task as { context: { workingDirectory: string } }).context.workingDirectory;
        writeFileSync(join(cwd, 'AGENT.md'), 'agent work\n', 'utf-8');
        return { output: 'ok', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const target = execSync('git branch --show-current', { cwd: h.root }).toString().trim();
      writeFileSync(join(h.root, 'blocked.txt'), 'base\n', 'utf-8');
      execSync('git add blocked.txt && git commit -q -m blocked-base', { cwd: h.root });

      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'add agent file' },
      });
      const runEnv = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, runEnv.run_id);

      execSync('git checkout -q -b conflict-side', { cwd: h.root });
      writeFileSync(join(h.root, 'blocked.txt'), 'side\n', 'utf-8');
      execSync('git add blocked.txt && git commit -q -m side-change', { cwd: h.root });
      execSync(`git checkout -q ${target}`, { cwd: h.root });
      writeFileSync(join(h.root, 'blocked.txt'), 'target\n', 'utf-8');
      execSync('git add blocked.txt && git commit -q -m target-change', { cwd: h.root });
      expect(() => execSync('git merge conflict-side', { cwd: h.root, stdio: 'ignore' })).toThrow();

      const merge = await h.client.callTool({
        name: 'merge_run',
        arguments: {
          run_id: runEnv.run_id,
          target_branch: target,
          confirmed: true,
          force: true,
        },
      });

      expect(merge.isError).toBe(true);
      expect(toolText(merge)).toContain('unmerged index paths: blocked.txt');
      expect(existsSync(join(h.root, 'AGENT.md'))).toBe(false);
    } finally {
      try {
        execSync('git reset --hard HEAD', { cwd: h.root, stdio: 'ignore' });
      } catch {
        /* nothing to reset */
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
      const runEnv = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, runEnv.run_id);
      const mergeRes = await h.client.callTool({
        name: 'merge_run',
        arguments: { run_id: runEnv.run_id, confirmed: true },
      });
      const env = mergeRes.structuredContent as { status: string };
      expect(env.status).toBe('no-changes');
      expect(toolText(mergeRes)).toBe(`**No changes** to merge from \`${runEnv.run_id}\``);
      expectStructuredJsonBytes(mergeRes, {
        run_id: runEnv.run_id,
        status: 'no-changes',
      });
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
      const runEnv = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, runEnv.run_id);
      expect(existsSync(runEnv.worktree_path)).toBe(true);

      const discard = await h.client.callTool({
        name: 'discard_run',
        arguments: { run_id: runEnv.run_id },
      });
      const env = discard.structuredContent as { ok: boolean };
      expect(env.ok).toBe(true);
      expect(toolText(discard)).toBe(`**Discarded** \`${runEnv.run_id}\``);
      expectStructuredJsonBytes(discard, {
        run_id: runEnv.run_id,
        ok: true,
      });
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

  it('marks discarded when cleanup fails and retries cleanup on repeat discard', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async (task) => {
        const cwd = (task as { context: { workingDirectory: string } }).context.workingDirectory;
        writeFileSync(join(cwd, 'partial-cleanup.txt'), 'cleanup warning', 'utf-8');
        return { output: 'ok', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'do' },
      });
      const runEnv = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, runEnv.run_id);
      const cleanup = vi.spyOn(h.worktreeManager, 'cleanupByRunId')
        .mockResolvedValueOnce({
          success: false,
          errors: ['delete branch: mocked failure'],
          hadRecord: true,
          worktreeRemoved: true,
          branchDeleted: false,
          recordDeleted: false,
        })
        .mockResolvedValueOnce({
          success: true,
          errors: [],
          hadRecord: true,
          worktreeRemoved: true,
          branchDeleted: true,
          recordDeleted: true,
        });

      const first = await h.client.callTool({
        name: 'discard_run',
        arguments: { run_id: runEnv.run_id },
      });
      expect(first.isError).toBeFalsy();
      expect(toolText(first)).toBe(
        `**Discarded** \`${runEnv.run_id}\`\n\nCleanup warning: delete branch: mocked failure`,
      );
      expect(first.structuredContent).toEqual({
        run_id: runEnv.run_id,
        ok: true,
        cleanup_failed: true,
        cleanup_errors: ['delete branch: mocked failure'],
      });
      expect(readPersistedState(h, runEnv.run_id).status).toBe('discarded');

      const second = await h.client.callTool({
        name: 'discard_run',
        arguments: { run_id: runEnv.run_id },
      });
      expect(second.isError).toBeFalsy();
      expect(second.structuredContent).toEqual({
        run_id: runEnv.run_id,
        ok: true,
      });
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(cleanup).toHaveBeenNthCalledWith(1, runEnv.run_id);
      expect(cleanup).toHaveBeenNthCalledWith(2, runEnv.run_id);
    } finally {
      await h.close();
    }
  });

  it('marks metadata discarded but skips worktree cleanup while the run is still in-flight', async () => {
    const h = await startHarness([makeMockAdapter({ name: 'mock-coder' })]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'do' },
      });
      const runEnv = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, runEnv.run_id);
      const cleanup = vi.spyOn(h.worktreeManager, 'cleanupByRunId');
      vi.spyOn(h.dispatcher, 'listInFlight').mockReturnValue([
        { toolCallId: 'still-finishing', toolName: 'run_agent', runId: runEnv.run_id },
      ]);

      const discard = await h.client.callTool({
        name: 'discard_run',
        arguments: { run_id: runEnv.run_id },
      });

      expect(discard.isError).toBeFalsy();
      expect(cleanup).not.toHaveBeenCalled();
      expect(existsSync(runEnv.worktree_path)).toBe(true);
      expect(readPersistedState(h, runEnv.run_id).status).toBe('discarded');
      expect(discard.structuredContent).toEqual({
        run_id: runEnv.run_id,
        ok: true,
        cleanup_failed: true,
        cleanup_errors: [
          `worktree cleanup skipped: run "${runEnv.run_id}" still has in-flight work (run_agent)`,
        ],
      });
      expect(toolText(discard)).toContain('Cleanup warning: worktree cleanup skipped');
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
      expect(toolText(res)).toBe('**Discarded** `r-never-existed`');
    } finally {
      await h.close();
    }
  });

  it('refuses to discard a currently running run', async () => {
    const terminal = createDeferred<TaskResult>();
    const adapter = makeMockAdapter({
      name: 'mock-coder',
      execute: async () => terminal.promise,
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-coder', prompt: 'do' },
      });
      const runEnv = run.structuredContent as FullRunEnvelope;
      const discard = await h.client.callTool({
        name: 'discard_run',
        arguments: { run_id: runEnv.run_id },
      });
      expect(discard.isError).toBe(true);
      const text = (discard.content as Array<{ text: string }>)[0].text;
      expect(text).toBe('discard_run: run is currently running; call cancel_run first.');

      terminal.resolve({ output: 'done', filesModified: [], status: 'success', metadata: {} });
      await pollUntilTerminal(h.client, runEnv.run_id);
    } finally {
      terminal.resolve({ output: 'done', filesModified: [], status: 'success', metadata: {} });
      await h.close();
    }
  });
});

describe('crew serve — read_only runs', () => {
  it('does not allocate a worktree and runs against host repo when working_directory is unset', async () => {
    let observedCwd: string | undefined;
    const adapter = makeMockAdapter({
      name: 'reviewer',
      execute: async (task) => {
        observedCwd = (task as { context: { workingDirectory: string } }).context.workingDirectory;
        return { output: 'looked', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const res = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'reviewer', prompt: 'review please', read_only: true },
      });
      const env = res.structuredContent as FullRunEnvelope;
      expect(env.status).toBe('running');
      expect(env.worktree_path).toBe(h.root);
      const final = await pollUntilTerminal(h.client, env.run_id);
      expect(final.status).toBe('success');
      expect(observedCwd).toBe(h.root);
      // No worktree on disk under .crew/runs/<runId>/worktree/.
      expect(existsSync(join(h.crewHome, 'runs', env.run_id, 'worktree'))).toBe(false);
      // state.json carries the readOnly bit so continue_run / merge_run
      // can branch on it without consulting the dispatcher.
      expect(final.state.readOnly).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('merge_run refuses on a read-only run with an explicit reason', async () => {
    const adapter = makeMockAdapter({
      name: 'reviewer',
      execute: async () => ({ output: '', filesModified: [], status: 'success', metadata: {} }),
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'reviewer', prompt: 'p', read_only: true },
      });
      const env = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, env.run_id);
      const merge = await h.client.callTool({
        name: 'merge_run',
        arguments: { run_id: env.run_id },
      });
      expect(merge.isError).toBe(true);
      const text = (merge.content as Array<{ text: string }>)[0].text;
      expect(text).toMatch(/read-only/);
      expect(text).toMatch(/nothing to merge/);
    } finally {
      await h.close();
    }
  });

  it('discard_run on a read-only run is metadata-only (no FS to clean)', async () => {
    const adapter = makeMockAdapter({
      name: 'reviewer',
      execute: async () => ({ output: '', filesModified: [], status: 'success', metadata: {} }),
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'reviewer', prompt: 'p', read_only: true },
      });
      const env = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, env.run_id);
      const discard = await h.client.callTool({
        name: 'discard_run',
        arguments: { run_id: env.run_id },
      });
      const denv = discard.structuredContent as { ok: boolean };
      expect(denv.ok).toBe(true);
      // host repo still exists & is unchanged.
      expect(existsSync(h.root)).toBe(true);
      // state.json reflects discarded.
      const status = await h.client.callTool({
        name: 'get_run_status',
        arguments: { run_id: env.run_id },
      });
      const s = status.structuredContent as { status: string };
      expect(s.status).toBe('discarded');
    } finally {
      await h.close();
    }
  });

  it('continue_run on a read-only run stays read-only (sticky)', async () => {
    let secondCwd: string | undefined;
    const adapter = makeMockAdapter({
      name: 'reviewer',
      execute: async (task) => {
        const t = task as { context: { workingDirectory: string }; prompt: string };
        if (t.prompt === 'turn-two') secondCwd = t.context.workingDirectory;
        return { output: `did: ${t.prompt}`, filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const first = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'reviewer', prompt: 'turn-one', read_only: true },
      });
      const firstEnv = first.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, firstEnv.run_id);
      // continue_run does not accept read_only — but the bit is sticky from state.json.
      await h.client.callTool({
        name: 'continue_run',
        arguments: { run_id: firstEnv.run_id, prompt: 'turn-two' },
      });
      // continue_run is async-first; wait for the second turn to land
      // before reading secondCwd. (Previously raced; the read-only
      // dirty-tree pre-snapshot adds enough async work pre-execute that
      // the race now reliably loses on a fast box.)
      await pollUntilTerminal(h.client, firstEnv.run_id);
      // The second turn ran against host repo (the original "worktree path"),
      // not against a freshly-allocated worktree. Confirms the sticky path.
      expect(secondCwd).toBe(h.root);
      // No worktree was allocated for either turn.
      expect(existsSync(join(h.crewHome, 'runs', firstEnv.run_id, 'worktree'))).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('surfaces a warnings field when a read-only run dirties the working directory', async () => {
    const adapter = makeMockAdapter({
      name: 'reviewer',
      execute: async (task) => {
        const cwd = (task as { context: { workingDirectory: string } }).context.workingDirectory;
        writeFileSync(join(cwd, 'leaked.md'), 'oops\n', 'utf-8');
        return { output: 'leaked', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const res = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'reviewer', prompt: 'p', read_only: true },
      });
      const env = res.structuredContent as FullRunEnvelope;
      expect(env.status).toBe('running');
      const final = await pollUntilTerminal(h.client, env.run_id);
      expect(final.status).toBe('success');
      // With async-first dispatch, warnings are persisted on the run
      // state and surfaced via get_run_status (not on a synchronous
      // envelope). The probe records the leaked file path.
      const warnings = final.state.warnings as readonly string[] | undefined;
      expect(warnings).toBeDefined();
      expect(warnings?.length).toBeGreaterThan(0);
      expect(warnings?.[0]).toMatch(/leaked\.md/);
      // Cleanup leaked file before harness teardown.
      rmSync(join(h.root, 'leaked.md'), { force: true });
    } finally {
      await h.close();
    }
  });
});

describe('crew serve — get_run_status tool', () => {
  it('returns the lean terminal projection for a completed run', async () => {
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
      const runEnv = run.structuredContent as FullRunEnvelope;
      const final = await pollUntilTerminal(h.client, runEnv.run_id);
      // Lean terminal contract: the response carries status + cursor +
      // events_tail + the synthesis surface (filesChanged, prompts
      // metadata, top-level summary). Static fields (runId, agentId,
      // worktreePath, repoRoot, events_log_path, tail_command_path,
      // tail_url, schemaVersion, startedAt, completedAt) live on the dispatch
      // envelope and are NOT re-shipped on every poll.
      const s = final.state as unknown as Record<string, unknown> & {
        status: string;
        prompts: Array<Record<string, unknown>>;
        events_tail: string[];
        next_event_line: number;
        filesChanged: string[];
        summary?: string;
      };
      expect(s.status).toBe('success');
      expect(s.filesChanged).toEqual([]);
      expect(s.summary).toBe('all done');
      expect(s.prompts).toHaveLength(1);
      expect(final.text).toBe(`**\`${runEnv.run_id}\` success**\n> all done`);
      expectStructuredJsonBytes({ structuredContent: s }, {
        status: 'success',
        events_tail: s.events_tail,
        next_event_line: s.next_event_line,
        filesChanged: [],
        prompts: s.prompts,
        summary: 'all done',
      });
      // Verbatim prompt text AND per-turn summary are intentionally
      // elided from the wire payload — captains have what they sent
      // (in their own conversation history), and the latest summary
      // surfaces top-level. Per-turn metadata (turn, startedAt,
      // completedAt) is preserved for ordering / display.
      expect(s.prompts[0]).toMatchObject({ turn: 1 });
      expect(s.prompts[0].prompt).toBeUndefined();
      expect(s.prompts[0].summary).toBeUndefined();
      expect(Array.isArray(s.events_tail)).toBe(true);
      expect(typeof s.next_event_line).toBe('number');
      // Static-field elision contract — hardcoded names so a future
      // regression that re-spreads RunStateV1 fails loudly here.
      for (const field of [
        'runId',
        'agentId',
        'schemaVersion',
        'worktreePath',
        'repoRoot',
        'startedAt',
        'completedAt',
        'events_log_path',
        'tail_command_path',
        'tail_url',
      ]) {
        expect(s[field]).toBeUndefined();
      }
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

describe('crew serve — cancel_run tool', () => {
  it('cancels an in-flight run, marking state="cancelled"', async () => {
    let abortFired = false;
    const adapter = makeMockAdapter({
      name: 'mock-cancellable',
      execute: async (task) => {
        const t = task as { constraints?: { signal?: AbortSignal } };
        return new Promise<TaskResult>((_resolve, reject) => {
          t.constraints?.signal?.addEventListener('abort', () => {
            abortFired = true;
            reject(new Error('aborted'));
          });
        });
      },
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-cancellable', prompt: 'hang forever' },
      });
      const env = run.structuredContent as FullRunEnvelope;
      expect(env.status).toBe('running');

      const cancel = await h.client.callTool({
        name: 'cancel_run',
        arguments: { run_id: env.run_id },
      });
      expect((cancel.structuredContent as { ok: boolean }).ok).toBe(true);
      expect(toolText(cancel)).toBe(`**Cancelled** \`${env.run_id}\``);
      expectStructuredJsonBytes(cancel, {
        run_id: env.run_id,
        ok: true,
      });

      // Wait for the dispatcher to finalize cancellation in run state.
      await waitFor(async () => {
        const r = await h.client.callTool({
          name: 'get_run_status',
          arguments: { run_id: env.run_id },
        });
        return (r.structuredContent as { status: string }).status === 'cancelled';
      });
      expect(abortFired).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('returns ok:false with reason when run_id is unknown', async () => {
    const h = await startHarness([makeMockAdapter({ name: 'noop' })]);
    try {
      const result = await h.client.callTool({
        name: 'cancel_run',
        arguments: { run_id: 'never-existed' },
      });
      const body = result.structuredContent as { ok: boolean; reason?: string };
      expect(body.ok).toBe(false);
      expect(body.reason).toMatch(/Unknown run_id/);
      expect(toolText(result)).toBe('`never-existed` not cancelled: Unknown run_id "never-existed".');
      expectStructuredJsonBytes(result, {
        run_id: 'never-existed',
        ok: false,
        reason: 'Unknown run_id "never-existed".',
      });
    } finally {
      await h.close();
    }
  });

  it('returns ok:false with reason when run is already terminal', async () => {
    const adapter = makeMockAdapter({
      name: 'fast',
      execute: async () => ({
        output: 'done',
        filesModified: [],
        status: 'success',
        metadata: {},
      }),
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'fast', prompt: 'finish quickly' },
      });
      const env = run.structuredContent as FullRunEnvelope;
      expect(env.status).toBe('running');
      const final = await pollUntilTerminal(h.client, env.run_id);
      expect(final.status).toBe('success');

      const cancel = await h.client.callTool({
        name: 'cancel_run',
        arguments: { run_id: env.run_id },
      });
      const body = cancel.structuredContent as { ok: boolean; reason?: string };
      expect(body.ok).toBe(false);
      expect(body.reason).toMatch(/not in-flight.*status="success"/);
      expect(toolText(cancel)).toBe(
        `\`${env.run_id}\` not cancelled: Run "${env.run_id}" is not in-flight (status="success").`,
      );
    } finally {
      await h.close();
    }
  });
});

describe('crew serve — progress notifications', () => {
  it('forwards adapter onOutput chunks as notifications/progress when client supplies a progressToken', async () => {
    const adapter = makeMockAdapter({
      name: 'streamy',
      execute: async (task) => {
        const t = task as { onOutput?: (chunk: string) => void };
        t.onOutput?.('chunk-one');
        t.onOutput?.('chunk-two');
        return {
          output: 'done',
          filesModified: [],
          status: 'success',
          metadata: {},
        };
      },
    });
    const h = await startHarness([adapter]);
    try {
      // Capture progress notifications. The MCP SDK's Client exposes
      // setNotificationHandler for arbitrary methods; we install one
      // for notifications/progress and assert chunks land.
      const progress: Array<{ progress: number; message?: string }> = [];
      h.client.setNotificationHandler(
        z.object({
          method: z.literal('notifications/progress'),
          params: z.object({
            progressToken: z.union([z.string(), z.number()]),
            progress: z.number(),
            message: z.string().optional(),
          }),
        }) as unknown as Parameters<typeof h.client.setNotificationHandler>[0],
        async (notif: unknown) => {
          const n = notif as { params: { progress: number; message?: string } };
          progress.push({ progress: n.params.progress, message: n.params.message });
        },
      );

      await h.client.callTool(
        {
          name: 'run_agent',
          arguments: { agent_id: 'streamy', prompt: 'stream chunks' },
        },
        undefined,
        { onprogress: () => undefined }, // request a progressToken from the SDK
      );
      // The SDK's onprogress callback also receives notifications, but
      // our setNotificationHandler captures the raw payload for assert.
      // Per #5: each line is prefixed `[<agent>] ` so the host's
      // inline progress UI labels which subagent emitted it.
      await waitFor(() => progress.length >= 2, 1000);
      expect(progress.map((p) => p.message)).toEqual([
        '[streamy] chunk-one',
        '[streamy] chunk-two',
      ]);
      expect(progress[0].progress).toBe(1);
      expect(progress[1].progress).toBe(2);
    } finally {
      await h.close();
    }
  });

  it('does NOT send progress notifications when client omits progressToken', async () => {
    const adapter = makeMockAdapter({
      name: 'streamy',
      execute: async (task) => {
        const t = task as { onOutput?: (chunk: string) => void };
        t.onOutput?.('only-chunk');
        return {
          output: 'done',
          filesModified: [],
          status: 'success',
          metadata: {},
        };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const progress: unknown[] = [];
      h.client.setNotificationHandler(
        z.object({
          method: z.literal('notifications/progress'),
          params: z.unknown(),
        }) as unknown as Parameters<typeof h.client.setNotificationHandler>[0],
        async (notif: unknown) => {
          progress.push(notif);
        },
      );
      // No onprogress callback → SDK omits progressToken in _meta.
      await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'streamy', prompt: 'stream chunks' },
      });
      // Give the server a beat to emit any in-flight notifications.
      await new Promise((r) => setTimeout(r, 50));
      expect(progress).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('logs first absent progressToken state once per server', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const h = await startHarness([makeMockAdapter({ name: 'streamy' })]);
    try {
      await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'streamy', prompt: 'first' },
      });
      await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'streamy', prompt: 'second' },
      });
      const absentLogs = warnSpy.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes('progressToken absent on first dispatch'));
      expect(absentLogs).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
      await h.close();
    }
  });

  it('logs first present progressToken state once per server', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const h = await startHarness([makeMockAdapter({ name: 'streamy' })]);
    try {
      await h.client.callTool(
        {
          name: 'run_agent',
          arguments: { agent_id: 'streamy', prompt: 'first' },
        },
        undefined,
        { onprogress: () => undefined },
      );
      await h.client.callTool(
        {
          name: 'run_agent',
          arguments: { agent_id: 'streamy', prompt: 'second' },
        },
        undefined,
        { onprogress: () => undefined },
      );
      const presentLogs = infoSpy.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes('progressToken present on first dispatch'));
      expect(presentLogs).toHaveLength(1);
      expect(
        warnSpy.mock.calls
          .map(([message]) => String(message))
          .filter((message) => message.includes('progressToken absent on first dispatch')),
      ).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
      await h.close();
    }
  });

  it('logs both observed progressToken states and a transition when state flips', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const h = await startHarness([makeMockAdapter({ name: 'streamy' })]);
    try {
      await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'streamy', prompt: 'absent' },
      });
      await h.client.callTool(
        {
          name: 'run_agent',
          arguments: { agent_id: 'streamy', prompt: 'present' },
        },
        undefined,
        { onprogress: () => undefined },
      );
      const warnMessages = warnSpy.mock.calls.map(([message]) => String(message));
      const infoMessages = infoSpy.mock.calls.map(([message]) => String(message));
      expect(warnMessages.filter((message) => message.includes('progressToken absent on first dispatch'))).toHaveLength(1);
      expect(infoMessages.filter((message) => message.includes('progressToken present on first dispatch'))).toHaveLength(1);
      expect(infoMessages.filter((message) => message.includes('progressToken state changed from absent to present'))).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
      await h.close();
    }
  });

  it('splits multi-line chunks into one progress notification per non-empty line', async () => {
    // #5: an adapter may emit a buffer flush that contains multiple
    // newline-delimited records. Sending that as one notification
    // means the host's inline UI shows a wall of text it has to
    // layout itself; sending one notification per line gives the
    // host a clean list of discrete updates. Empty lines (e.g.,
    // trailing newlines from line-buffered subprocesses) are
    // dropped so the counter doesn't tick on whitespace.
    const adapter = makeMockAdapter({
      name: 'multi',
      execute: async (task) => {
        const t = task as { onOutput?: (chunk: string) => void };
        t.onOutput?.('first line\nsecond line\n\nthird line\n');
        return { output: 'done', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const progress: Array<{ progress: number; message?: string }> = [];
      h.client.setNotificationHandler(
        z.object({
          method: z.literal('notifications/progress'),
          params: z.object({
            progressToken: z.union([z.string(), z.number()]),
            progress: z.number(),
            message: z.string().optional(),
          }),
        }) as unknown as Parameters<typeof h.client.setNotificationHandler>[0],
        async (notif: unknown) => {
          const n = notif as { params: { progress: number; message?: string } };
          progress.push({ progress: n.params.progress, message: n.params.message });
        },
      );
      await h.client.callTool(
        { name: 'run_agent', arguments: { agent_id: 'multi', prompt: 'p' } },
        undefined,
        { onprogress: () => undefined },
      );
      await waitFor(() => progress.length >= 3, 1000);
      expect(progress.map((p) => p.message)).toEqual([
        '[multi] first line',
        '[multi] second line',
        '[multi] third line',
      ]);
      // Counter is monotonic across the split lines — no resets per chunk.
      expect(progress.map((p) => p.progress)).toEqual([1, 2, 3]);
    } finally {
      await h.close();
    }
  });

  it('truncates over-long lines with an ellipsis suffix', async () => {
    // #5 PROGRESS_LINE_MAX_LEN = 240. Progress notifications and
    // events.log share the same bounded server-side rendering so the
    // host UI and event tail stay readable.
    const huge = 'x'.repeat(500);
    const adapter = makeMockAdapter({
      name: 'verbose',
      execute: async (task) => {
        const t = task as { onOutput?: (chunk: string) => void };
        t.onOutput?.(huge);
        return { output: 'done', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const progress: Array<{ message?: string }> = [];
      h.client.setNotificationHandler(
        z.object({
          method: z.literal('notifications/progress'),
          params: z.object({
            progressToken: z.union([z.string(), z.number()]),
            progress: z.number(),
            message: z.string().optional(),
          }),
        }) as unknown as Parameters<typeof h.client.setNotificationHandler>[0],
        async (notif: unknown) => {
          const n = notif as { params: { message?: string } };
          progress.push({ message: n.params.message });
        },
      );
      await h.client.callTool(
        { name: 'run_agent', arguments: { agent_id: 'verbose', prompt: 'p' } },
        undefined,
        { onprogress: () => undefined },
      );
      await waitFor(() => progress.length >= 1, 1000);
      const msg = progress[0].message ?? '';
      expect(msg.startsWith('[verbose] ')).toBe(true);
      // Whole progress messages are bounded, including the `[agent] ` prefix.
      expect(msg.length).toBeLessThanOrEqual(240);
      expect(msg.endsWith('…')).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('keeps events_tail aligned with split and bounded server-side progress lines', async () => {
    const firstRaw = 'a'.repeat(300);
    const secondRaw = 'b'.repeat(300);
    const rawChunk = `${firstRaw}\n${secondRaw}`;
    const adapter = makeMockAdapter({
      name: 'verbose',
      execute: async (task) => {
        const t = task as { onOutput?: (chunk: string) => void };
        t.onOutput?.(rawChunk);
        return { output: 'done', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const progress: Array<{ message?: string }> = [];
      h.client.setNotificationHandler(
        z.object({
          method: z.literal('notifications/progress'),
          params: z.object({
            progressToken: z.union([z.string(), z.number()]),
            progress: z.number(),
            message: z.string().optional(),
          }),
        }) as unknown as Parameters<typeof h.client.setNotificationHandler>[0],
        async (notif: unknown) => {
          const n = notif as { params: { message?: string } };
          progress.push({ message: n.params.message });
        },
      );
      const run = await h.client.callTool(
        { name: 'run_agent', arguments: { agent_id: 'verbose', prompt: 'p' } },
        undefined,
        { onprogress: () => undefined },
      );
      const env = run.structuredContent as FullRunEnvelope;
      await waitFor(() => progress.length >= 2, 1000);
      expect(progress.map((p) => p.message)).toHaveLength(2);
      for (const message of progress.map((p) => p.message ?? '')) {
        expect(message.startsWith('[verbose] ')).toBe(true);
        expect(message.length).toBeLessThanOrEqual(240);
        expect(message.endsWith('…')).toBe(true);
      }

      const final = await pollUntilTerminal(h.client, env.run_id);
      expect(final.events_tail).toEqual(progress.map((p) => p.message));
      for (const line of final.events_tail) {
        expect(line.startsWith('[verbose] ')).toBe(true);
        expect(line.endsWith('…')).toBe(true);
        expect(line.length).toBeLessThanOrEqual(240);
      }
    } finally {
      await h.close();
    }
  });
});

describe('crew serve — async-first dispatch + on-demand get_run_status', () => {
  it('run_agent returns status:running immediately even when adapter is fast', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-fast',
      execute: async () => ({
        output: 'instant',
        filesModified: [],
        status: 'success',
        metadata: {},
      }),
    });
    // Opt into the claude-code branch so this test's watcher-phrased
    // copy assertions are explicit about which host they target —
    // the harness default is neutral.
    const h = await startHarness([adapter], { clientName: 'claude-code' });
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-fast', prompt: 'go' },
      });
      const env = run.structuredContent as FullRunEnvelope;
      // Async-first: run_agent never inlines a terminal envelope —
      // the captain ends the turn and reads status on demand later.
      expect(env.status).toBe('running');
      expect(env.summary).toContain('user is free to chat');
      expect(env.summary).toContain('One required action');
      expect(env.summary).toContain('spawn the crew-wait watcher');
      expect(env.summary).not.toMatch(/Poll get_run_status/);
      expect(env.summary).not.toMatch(/wait_for_change_ms/);
      expect(env.summary).not.toMatch(/wait_for_terminal_only/);
      expect(env.required_next_action).toEqual({
        type: 'spawn_watcher',
        mechanism: 'background_shell',
        command: `crew-wait ${env.run_id}`,
        run_id: env.run_id,
        run_in_background: true,
        per_run: true,
        consequence_if_skipped:
          'Skip it and the run is orphaned; no watcher-triggered terminal turn will surface completion.',
      });
      const text = toolText(run);
      expect(text).toContain('**REQUIRED before you end this turn:**');
      expect(text).toContain(`Bash(crew-wait ${env.run_id}, run_in_background: true)`);
      expect(text).not.toContain('- Next:');
      // Status reads still resolve to terminal.
      const final = await pollUntilTerminal(h.client, env.run_id);
      expect(final.status).toBe('success');
    } finally {
      await h.close();
    }
  });

  // The dispatch envelope's "next step" sentence is keyed off the MCP
  // `clientInfo.name` carried in the initialize handshake. These cases
  // guard the three branches (codex/gemini → "dispatch returns",
  // unknown → neutral) so a future copy edit can't silently drift on
  // non-Claude-Code hosts.
  it('codex client gets "after this dispatch returns" copy', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-fast',
      execute: async () => ({
        output: 'instant',
        filesModified: [],
        status: 'success',
        metadata: {},
      }),
    });
    const h = await startHarness([adapter], { clientName: 'codex-cli' });
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-fast', prompt: 'go' },
      });
      const env = run.structuredContent as FullRunEnvelope;
      expect(env.summary).toContain('after this dispatch returns');
      expect(env.summary).not.toContain('spawn the crew-wait watcher');
      expect(env.required_next_action).toBeUndefined();
      const text = toolText(run);
      expect(text).toContain('after this dispatch returns');
      expect(text).toContain('- Next:');
      expect(text).not.toContain('REQUIRED before you end this turn');
    } finally {
      await h.close();
    }
  });

  it('gemini client omits required_next_action', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-fast',
      execute: async () => ({
        output: 'instant',
        filesModified: [],
        status: 'success',
        metadata: {},
      }),
    });
    const h = await startHarness([adapter], { clientName: 'gemini-cli' });
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-fast', prompt: 'go' },
      });
      const env = run.structuredContent as FullRunEnvelope;
      expect(env.summary).toContain('after this dispatch returns');
      expect(env.required_next_action).toBeUndefined();
      expect(toolText(run)).not.toContain('REQUIRED before you end this turn');
    } finally {
      await h.close();
    }
  });

  it('continue_run emits required_next_action for Claude Code', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-fast',
      execute: async () => ({
        output: 'instant',
        filesModified: [],
        status: 'success',
        metadata: {},
      }),
    });
    const h = await startHarness([adapter], { clientName: 'claude-code' });
    try {
      const first = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-fast', prompt: 'first' },
      });
      const firstEnv = first.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, firstEnv.run_id);

      const second = await h.client.callTool({
        name: 'continue_run',
        arguments: { run_id: firstEnv.run_id, prompt: 'second' },
      });
      const secondEnv = second.structuredContent as FullRunEnvelope;
      expect(secondEnv.run_id).toBe(firstEnv.run_id);
      expect(secondEnv.required_next_action).toMatchObject({
        type: 'spawn_watcher',
        command: `crew-wait ${firstEnv.run_id}`,
        run_id: firstEnv.run_id,
        run_in_background: true,
      });
      expect(toolText(second)).toContain(
        `Bash(crew-wait ${firstEnv.run_id}, run_in_background: true)`,
      );
      await pollUntilTerminal(h.client, firstEnv.run_id);
    } finally {
      await h.close();
    }
  });

  it.each([
    ['codex-cli', 'codex'],
    ['gemini-cli', 'gemini'],
    ['some-future-host', 'unknown'],
  ] as const)('continue_run omits required_next_action for %s', async (clientName) => {
    const adapter = makeMockAdapter({
      name: 'mock-fast',
      execute: async () => ({
        output: 'instant',
        filesModified: [],
        status: 'success',
        metadata: {},
      }),
    });
    const h = await startHarness([adapter], { clientName });
    try {
      const first = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-fast', prompt: 'first' },
      });
      const firstEnv = first.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, firstEnv.run_id);

      const second = await h.client.callTool({
        name: 'continue_run',
        arguments: { run_id: firstEnv.run_id, prompt: 'second' },
      });
      const secondEnv = second.structuredContent as FullRunEnvelope;
      expect(secondEnv.required_next_action).toBeUndefined();
      expect(toolText(second)).not.toContain('REQUIRED before you end this turn');
      await pollUntilTerminal(h.client, firstEnv.run_id);
    } finally {
      await h.close();
    }
  });

  it('unknown client gets the neutral fallback copy', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-fast',
      execute: async () => ({
        output: 'instant',
        filesModified: [],
        status: 'success',
        metadata: {},
      }),
    });
    const h = await startHarness([adapter], { clientName: 'some-future-host' });
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-fast', prompt: 'go' },
      });
      const env = run.structuredContent as FullRunEnvelope;
      expect(env.summary).toContain('End your turn after dispatch');
      expect(env.summary).not.toContain('spawn the crew-wait watcher');
      expect(env.summary).not.toContain('after this dispatch returns');
      expect(env.required_next_action).toBeUndefined();
      const text = toolText(run);
      expect(text).toContain('End your turn after dispatch');
      expect(text).not.toContain('REQUIRED before you end this turn');
      expect(text).not.toContain('after this dispatch returns');
    } finally {
      await h.close();
    }
  });

  it('long-poll get_run_status resolves immediately when run already terminated', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-fast',
      execute: async () => ({
        output: 'done',
        filesModified: [],
        status: 'success',
        metadata: {},
      }),
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-fast', prompt: 'go' },
      });
      const env = run.structuredContent as FullRunEnvelope;
      // Wait for terminal first.
      await pollUntilTerminal(h.client, env.run_id);
      // Now a long-poll with a generous wait should still return fast
      // because the run is already terminal — server short-circuits.
      const t0 = Date.now();
      const res = await h.client.callTool({
        name: 'get_run_status',
        arguments: { run_id: env.run_id, wait_for_change_ms: 5000 },
      });
      const elapsed = Date.now() - t0;
      const s = res.structuredContent as { status: string };
      expect(s.status).toBe('success');
      // < 1s proves we didn't actually wait the 5000ms.
      expect(elapsed).toBeLessThan(1000);
    } finally {
      await h.close();
    }
  });

  it('terminal-only get_run_status resolves immediately when run already terminated', async () => {
    const adapter = makeMockAdapter({
      name: 'mock-fast-terminal-only',
      execute: async () => ({
        output: 'done terminal-only',
        filesModified: ['README.md'],
        status: 'success',
        metadata: {},
      }),
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-fast-terminal-only', prompt: 'go' },
      });
      const env = run.structuredContent as FullRunEnvelope;
      await pollUntilTerminal(h.client, env.run_id);

      const t0 = Date.now();
      const res = await h.client.callTool({
        name: 'get_run_status',
        arguments: {
          run_id: env.run_id,
          wait_for_change_ms: 5000,
          wait_for_terminal_only: true,
        },
      });
      const elapsed = Date.now() - t0;
      const s = res.structuredContent as {
        status: string;
        timed_out?: true;
        summary?: string;
        filesChanged?: string[];
      };
      expect(s.status).toBe('success');
      expect(s.timed_out).toBeUndefined();
      expect(s.summary).toBe('done terminal-only');
      expect(s.filesChanged).toEqual(['README.md']);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      await h.close();
    }
  });

  it('long-poll does NOT wake on adapter receipt chunks; wakes on the first signal chunk', async () => {
    // Symmetric noise filter: codex emits ~88% receipt-style stream
    // chunks (`command: started ...`, `(exit 0)`, `item.*` lifecycle
    // frames). Today's e9cacf8 filter strips them from the response
    // payload, but pre-fix the long-poll listener was waking on
    // every chunk and the fast-return was treating the bumped
    // cursor as "data to surface" — net: ~40 wakeups returning
    // events_tail:[] for a chatty run. This test pins the new
    // contract: receipts advance the cursor on disk but do NOT wake
    // the captain; the first signal chunk does.
    // See docs/plans/active/noise-symmetric-filter.md.
    let onOutputRef: ((chunk: string) => void) | undefined;
    let resolveAdapter!: () => void;
    const slow = new Promise<void>((r) => {
      resolveAdapter = r;
    });
    const adapter = makeMockAdapter({
      name: 'codex',
      execute: async (task) => {
        const t = task as { onOutput?: (chunk: string) => void };
        onOutputRef = t.onOutput;
        await slow;
        return {
          output: 'done',
          filesModified: [],
          status: 'success',
          metadata: {},
        };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'codex', prompt: 'noisy' },
      });
      const env = run.structuredContent as FullRunEnvelope;
      await waitFor(() => onOutputRef !== undefined);

      // Start the long-poll first; emit a burst of receipts; assert
      // the poll is still pending (i.e. did not wake on receipts).
      const pollPromise = h.client.callTool({
        name: 'get_run_status',
        arguments: {
          run_id: env.run_id,
          wait_for_change_ms: 1500,
          since_event_line: 0,
        },
      });

      let resolved = false;
      void pollPromise.then(() => {
        resolved = true;
      });

      // Give the poll a tick to install its listener.
      await new Promise((r) => setTimeout(r, 30));
      // Burst of pure receipts.
      onOutputRef?.('command: started rg foo');
      onOutputRef?.('command: rg foo (exit 0)');
      onOutputRef?.('event: item.started/web_search');
      onOutputRef?.('event: item.completed/web_search');
      // Wait long enough for the listener to (incorrectly, if buggy)
      // wake on a receipt. The test is sensitive to this: if any
      // receipt slips through, `resolved` flips here.
      await new Promise((r) => setTimeout(r, 200));
      expect(resolved).toBe(false);

      // Now emit a signal chunk; the poll should wake promptly.
      onOutputRef?.('message: real synthesis');
      const t0 = Date.now();
      const res = await pollPromise;
      const elapsed = Date.now() - t0;
      // Signal woke the poll well under the 1500ms cap.
      expect(elapsed).toBeLessThan(1000);
      const s = res.structuredContent as {
        status: string;
        events_tail: string[];
        next_event_line: number;
      };
      expect(s.status).toBe('running');
      expect(s.events_tail).toEqual([]);
      // Cursor reflects the raw file offset — 4 receipts + 1 signal.
      expect(s.next_event_line).toBe(5);

      resolveAdapter();
      const final = await pollUntilTerminal(h.client, env.run_id);
      // events_tail on terminal preserves the signal line and drops
      // the receipts, matching the existing terminal-tail filter.
      expect(final.events_tail).toContain('[codex] message: real synthesis');
      expect(final.events_tail).not.toContain('[codex] command: started rg foo');
    } finally {
      await h.close();
    }
  });

  it('terminal-only long-poll does not wake on stream chunks from an in-flight run', async () => {
    let onOutputRef: ((chunk: string) => void) | undefined;
    let resolveAdapter!: () => void;
    const slow = new Promise<void>((r) => {
      resolveAdapter = r;
    });
    const adapter = makeMockAdapter({
      name: 'mock-terminal-only-streaming',
      execute: async (task) => {
        const t = task as { onOutput?: (chunk: string) => void };
        onOutputRef = t.onOutput;
        await slow;
        return {
          output: 'done',
          filesModified: [],
          status: 'success',
          metadata: {},
        };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-terminal-only-streaming', prompt: 'stream' },
      });
      const env = run.structuredContent as FullRunEnvelope;
      await waitFor(() => onOutputRef !== undefined);

      const pollPromise = h.client.callTool({
        name: 'get_run_status',
        arguments: {
          run_id: env.run_id,
          wait_for_change_ms: 1500,
          since_event_line: 0,
          wait_for_terminal_only: true,
        },
      });
      let resolved = false;
      void pollPromise.then(() => {
        resolved = true;
      });

      await new Promise((r) => setTimeout(r, 30));
      onOutputRef?.('message: still working');
      await new Promise((r) => setTimeout(r, 200));
      expect(resolved).toBe(false);

      resolveAdapter();
      const res = await pollPromise;
      const s = res.structuredContent as {
        status: string;
        timed_out?: true;
        events_tail: string[];
        summary?: string;
      };
      expect(s.status).toBe('success');
      expect(s.timed_out).toBeUndefined();
      expect(s.summary).toBe('done');
      expect(s.events_tail).toContain('[mock-terminal-only-streaming] message: still working');
    } finally {
      await h.close();
    }
  });

  it('terminal-only long-poll returns terminal payload when the run completes', async () => {
    let resolveAdapter!: () => void;
    const slow = new Promise<void>((r) => {
      resolveAdapter = r;
    });
    const adapter = makeMockAdapter({
      name: 'mock-terminal-only-complete',
      execute: async () => {
        await slow;
        return {
          output: 'terminal summary',
          filesModified: ['src/index.ts'],
          status: 'success',
          metadata: {},
        };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-terminal-only-complete', prompt: 'complete' },
      });
      const env = run.structuredContent as FullRunEnvelope;
      const pollPromise = h.client.callTool({
        name: 'get_run_status',
        arguments: {
          run_id: env.run_id,
          wait_for_change_ms: 5000,
          since_event_line: 0,
          wait_for_terminal_only: true,
        },
      });
      await new Promise((r) => setTimeout(r, 30));
      const t0 = Date.now();
      resolveAdapter();
      const res = await pollPromise;
      const elapsed = Date.now() - t0;
      const s = res.structuredContent as {
        status: string;
        timed_out?: true;
        summary?: string;
        filesChanged?: string[];
        events_tail: string[];
      };
      expect(elapsed).toBeLessThan(1000);
      expect(s.status).toBe('success');
      expect(s.timed_out).toBeUndefined();
      expect(s.summary).toBe('terminal summary');
      expect(s.filesChanged).toEqual(['src/index.ts']);
      expect(toolText(res)).toBe(
        `**\`${env.run_id}\` success**\n1 files changed: src/index.ts\n> terminal summary`,
      );
      expect(Array.isArray(s.events_tail)).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('terminal-only long-poll returns terminal cancelled payload when cancel_run wakes it', async () => {
    let abortFired = false;
    const adapter = makeMockAdapter({
      name: 'mock-terminal-only-cancel',
      execute: async (task) => {
        const t = task as { constraints?: { signal?: AbortSignal } };
        return new Promise<TaskResult>((_resolve, reject) => {
          t.constraints?.signal?.addEventListener('abort', () => {
            abortFired = true;
            reject(new Error('aborted'));
          });
        });
      },
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-terminal-only-cancel', prompt: 'cancel' },
      });
      const env = run.structuredContent as FullRunEnvelope;
      const pollPromise = h.client.callTool({
        name: 'get_run_status',
        arguments: {
          run_id: env.run_id,
          wait_for_change_ms: 5000,
          since_event_line: 0,
          wait_for_terminal_only: true,
        },
      });

      await new Promise((r) => setTimeout(r, 30));
      const t0 = Date.now();
      const cancel = await h.client.callTool({
        name: 'cancel_run',
        arguments: { run_id: env.run_id },
      });
      expect((cancel.structuredContent as { ok: boolean }).ok).toBe(true);

      const res = await pollPromise;
      const elapsed = Date.now() - t0;
      const s = res.structuredContent as {
        status: string;
        timed_out?: true;
        summary?: string;
        filesChanged?: string[];
        events_tail?: string[];
        next_event_line?: number;
      };
      expect(elapsed).toBeLessThan(1000);
      expect(abortFired).toBe(true);
      expect(s.status).toBe('cancelled');
      expect(s.timed_out).toBeUndefined();
      expect(s.summary).toBe('cancel_run requested');
      expect(s.filesChanged).toEqual([]);
      expect(Array.isArray(s.events_tail)).toBe(true);
      expect(typeof s.next_event_line).toBe('number');
    } finally {
      await h.close();
    }
  });

  it('terminal-only long-poll timeout returns a lean timed_out payload', async () => {
    let resolveAdapter!: () => void;
    const slow = new Promise<void>((r) => {
      resolveAdapter = r;
    });
    const adapter = makeMockAdapter({
      name: 'mock-terminal-only-timeout',
      execute: async () => {
        await slow;
        return {
          output: 'eventual done',
          filesModified: [],
          status: 'success',
          metadata: {},
        };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-terminal-only-timeout', prompt: 'timeout' },
      });
      const env = run.structuredContent as FullRunEnvelope;
      const readSpy = vi.spyOn(RunStateStore.prototype, 'read');
      const readsBeforeStatusCall = readSpy.mock.calls.length;
      const res = await h.client.callTool({
        name: 'get_run_status',
        arguments: {
          run_id: env.run_id,
          wait_for_change_ms: 100,
          since_event_line: 0,
          wait_for_terminal_only: true,
        },
      });
      expect(res.structuredContent).toEqual({
        status: 'running',
        timed_out: true,
      });
      expect(toolText(res)).toBe(`\`${env.run_id}\` status: \`running\` (timed out)`);
      expectStructuredJsonBytes(res, {
        status: 'running',
        timed_out: true,
      });
      const s = res.structuredContent as {
        next_event_line?: number;
        events_tail?: string[];
      };
      expect(s.next_event_line).toBeUndefined();
      expect(s.events_tail).toBeUndefined();
      expect(readSpy.mock.calls.length - readsBeforeStatusCall).toBe(1);
      readSpy.mockRestore();

      resolveAdapter();
      await pollUntilTerminal(h.client, env.run_id);
    } finally {
      await h.close();
    }
  });

  it('long-poll fast-return waits when only receipts have arrived past the cursor', async () => {
    // Companion to the wakeup test above: the fast-return path at
    // serve.ts:541 must not short-circuit when every line past the
    // cursor would be filtered. Otherwise a captain that polls AFTER
    // a burst of receipts would round-trip immediately with
    // events_tail: [] — same context burn the wakeup filter blocks.
    let onOutputRef: ((chunk: string) => void) | undefined;
    let resolveAdapter!: () => void;
    const slow = new Promise<void>((r) => {
      resolveAdapter = r;
    });
    const adapter = makeMockAdapter({
      name: 'codex',
      execute: async (task) => {
        const t = task as { onOutput?: (chunk: string) => void };
        onOutputRef = t.onOutput;
        await slow;
        return {
          output: 'done',
          filesModified: [],
          status: 'success',
          metadata: {},
        };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'codex', prompt: 'noisy' },
      });
      const env = run.structuredContent as FullRunEnvelope;
      await waitFor(() => onOutputRef !== undefined);

      // Emit receipts BEFORE the captain polls. They advance the
      // raw cursor; readSignalEventsSince returns lines:[] so the
      // fast-return falls through to long-poll.
      onOutputRef?.('command: started rg foo');
      onOutputRef?.('command: rg foo (exit 0)');
      // Wait for events.log to flush so the receipts are durable.
      await waitFor(async () => {
        const r = await h.client.callTool({
          name: 'get_run_status',
          arguments: { run_id: env.run_id },
        });
        const s = r.structuredContent as { next_event_line: number };
        return s.next_event_line >= 2;
      });

      const pollStart = Date.now();
      const pollPromise = h.client.callTool({
        name: 'get_run_status',
        arguments: {
          run_id: env.run_id,
          wait_for_change_ms: 1500,
          since_event_line: 0,
        },
      });
      let resolved = false;
      void pollPromise.then(() => {
        resolved = true;
      });
      // Short delay: if the fast-return short-circuited on the
      // already-arrived receipts, the poll would resolve here.
      await new Promise((r) => setTimeout(r, 200));
      expect(resolved).toBe(false);

      // Signal arrives → poll resolves.
      onOutputRef?.('message: real synthesis');
      const res = await pollPromise;
      const elapsed = Date.now() - pollStart;
      expect(elapsed).toBeLessThan(1500);
      const s = res.structuredContent as {
        next_event_line: number;
        events_tail: string[];
      };
      expect(s.events_tail).toEqual([]);
      expect(s.next_event_line).toBe(3);

      resolveAdapter();
      await pollUntilTerminal(h.client, env.run_id);
    } finally {
      await h.close();
    }
  });

  it('terminal-only long-poll skips the already-have-signal fast-return', async () => {
    let onOutputRef: ((chunk: string) => void) | undefined;
    let resolveAdapter!: () => void;
    const slow = new Promise<void>((r) => {
      resolveAdapter = r;
    });
    const adapter = makeMockAdapter({
      name: 'mock-terminal-only-precursor',
      execute: async (task) => {
        const t = task as { onOutput?: (chunk: string) => void };
        onOutputRef = t.onOutput;
        await slow;
        return {
          output: 'done',
          filesModified: [],
          status: 'success',
          metadata: {},
        };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-terminal-only-precursor', prompt: 'signal first' },
      });
      const env = run.structuredContent as FullRunEnvelope;
      await waitFor(() => onOutputRef !== undefined);
      onOutputRef?.('message: signal before poll');
      await waitFor(async () => {
        const r = await h.client.callTool({
          name: 'get_run_status',
          arguments: { run_id: env.run_id },
        });
        const s = r.structuredContent as { next_event_line: number };
        return s.next_event_line >= 1;
      });

      const pollPromise = h.client.callTool({
        name: 'get_run_status',
        arguments: {
          run_id: env.run_id,
          wait_for_change_ms: 1500,
          since_event_line: 0,
          wait_for_terminal_only: true,
        },
      });
      let resolved = false;
      void pollPromise.then(() => {
        resolved = true;
      });
      await new Promise((r) => setTimeout(r, 200));
      expect(resolved).toBe(false);

      resolveAdapter();
      const res = await pollPromise;
      const s = res.structuredContent as {
        status: string;
        events_tail: string[];
        timed_out?: true;
      };
      expect(s.status).toBe('success');
      expect(s.timed_out).toBeUndefined();
      expect(s.events_tail).toContain('[mock-terminal-only-precursor] message: signal before poll');
    } finally {
      await h.close();
    }
  });

  it('long-poll get_run_status wakes on stream events from an in-flight run', async () => {
    let onOutputRef: ((chunk: string) => void) | undefined;
    let resolveAdapter!: () => void;
    const slow = new Promise<void>((r) => {
      resolveAdapter = r;
    });
    const adapter = makeMockAdapter({
      name: 'mock-streaming',
      execute: async (task) => {
        const t = task as { onOutput?: (chunk: string) => void };
        onOutputRef = t.onOutput;
        await slow;
        return {
          output: 'done',
          filesModified: [],
          status: 'success',
          metadata: {},
        };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-streaming', prompt: 'stream' },
      });
      const env = run.structuredContent as FullRunEnvelope;
      // Wait briefly for the adapter to capture onOutput.
      await waitFor(() => onOutputRef !== undefined);

      // Start a long-poll with no events yet; trigger a stream event
      // mid-poll and observe that the call wakes promptly. Under the
      // terminal-only events_tail contract, the wake-up is signaled
      // by `next_event_line` advancing — `events_tail` itself stays
      // empty while the run is still `running` (the captain doesn't
      // narrate progress; users follow events_log_path or tail.command).
      const pollPromise = h.client.callTool({
        name: 'get_run_status',
        arguments: {
          run_id: env.run_id,
          wait_for_change_ms: 5000,
          since_event_line: 0,
        },
      });
      // Fire a chunk after a small delay so the long-poll is already
      // installed when the dispatcher emits run:stream.
      await new Promise((r) => setTimeout(r, 30));
      onOutputRef?.('first chunk');

      const t0 = Date.now();
      const res = await pollPromise;
      const elapsed = Date.now() - t0;
      const s = res.structuredContent as Record<string, unknown> & {
        status: string;
        events_tail: string[];
        next_event_line: number;
      };
      // The wake should have fired well under the 5000ms cap.
      expect(elapsed).toBeLessThan(2000);
      expect(s.status).toBe('running');
      expect(toolText(res)).toBe(`\`${env.run_id}\` status: \`running\` (cursor: 1)`);
      // Running poll-returns are lean by design: status, events_tail
      // (empty), next_event_line — and nothing else. Static fields
      // (run_id, tail_command_path, etc.) live on the dispatch envelope.
      expect(s.tail_command_path).toBeUndefined();
      expect(s.run_id).toBeUndefined();
      expect(s.worktreePath).toBeUndefined();
      expect(s.events_tail).toEqual([]);
      // Cursor advanced past the emitted chunk so the eventual
      // terminal poll-return knows where the log head sits.
      expect(s.next_event_line).toBe(1);
      expectStructuredJsonBytes(res, {
        status: 'running',
        events_tail: [],
        next_event_line: 1,
      });

      // Cleanup: complete the dispatch and verify the terminal
      // poll-return DOES surface the chunk via events_tail.
      resolveAdapter();
      const final = await pollUntilTerminal(h.client, env.run_id);
      expect(final.events_tail).toContain('[mock-streaming] first chunk');
    } finally {
      await h.close();
    }
  });

  it('keeps events_tail empty while running and surfaces the full tail on terminal', async () => {
    // Captain-context conservation: while `status === "running"`, the
    // cursor still advances (so external readers and the terminal poll
    // see a coherent view), but `events_tail` stays empty so the
    // captain isn't tempted to render plumbing into its reply. Once
    // the run reaches terminal, `events_tail` carries the recent tail
    // of the entire log — the captain's evidence base for its
    // synthesized summary.
    let onOutputRef: ((chunk: string) => void) | undefined;
    let resolveAdapter!: () => void;
    const slow = new Promise<void>((r) => {
      resolveAdapter = r;
    });
    const adapter = makeMockAdapter({
      name: 'mock-streaming',
      execute: async (task) => {
        const t = task as { onOutput?: (chunk: string) => void };
        onOutputRef = t.onOutput;
        await slow;
        return {
          output: 'done',
          filesModified: [],
          status: 'success',
          metadata: {},
        };
      },
    });
    const h = await startHarness([adapter]);
    try {
      const run = await h.client.callTool({
        name: 'run_agent',
        arguments: { agent_id: 'mock-streaming', prompt: 'stream' },
      });
      const env = run.structuredContent as FullRunEnvelope;
      await waitFor(() => onOutputRef !== undefined);
      onOutputRef?.('line 1');
      onOutputRef?.('line 2');
      // Wait for events.log to flush — assert via cursor advance,
      // since events_tail itself stays empty while running.
      await waitFor(async () => {
        const r = await h.client.callTool({
          name: 'get_run_status',
          arguments: { run_id: env.run_id },
        });
        const s = r.structuredContent as { next_event_line: number };
        return s.next_event_line >= 2;
      });

      // Running poll from cursor 0: events_tail empty, cursor at 2.
      const first = await h.client.callTool({
        name: 'get_run_status',
        arguments: { run_id: env.run_id, since_event_line: 0 },
      });
      const f = first.structuredContent as {
        status: string;
        events_tail: string[];
        next_event_line: number;
      };
      expect(f.status).toBe('running');
      expect(f.events_tail).toEqual([]);
      expect(f.next_event_line).toBe(2);

      // Polling again from the returned cursor: still empty, cursor stable.
      const second = await h.client.callTool({
        name: 'get_run_status',
        arguments: { run_id: env.run_id, since_event_line: f.next_event_line },
      });
      const s2 = second.structuredContent as {
        events_tail: string[];
        next_event_line: number;
      };
      expect(s2.events_tail).toEqual([]);
      expect(s2.next_event_line).toBe(2);

      // Drive to terminal — now events_tail is populated with the
      // full log tail regardless of cursor (the captain wants "what
      // the run did", not "what happened since I last polled").
      resolveAdapter();
      const final = await pollUntilTerminal(h.client, env.run_id);
      expect(final.status).toBe('success');
      expect(final.events_tail).toEqual(['[mock-streaming] line 1', '[mock-streaming] line 2']);
    } finally {
      await h.close();
    }
  });

  // ---------------------------------------------------------------
  // Cap tests — exercise the events_tail cap on the *terminal*
  // poll-return (running poll-returns always emit []). Each test
  // emits N lines, drives to terminal, then re-polls with a custom
  // `max_events_tail` to assert the resulting cap behavior.
  // ---------------------------------------------------------------

  /**
   * Helper: build a controllable mock adapter + the harness around it
   * that emits the given lines via onOutput then completes. Returns
   * the harness + the dispatched envelope so callers can re-poll the
   * terminal state with a custom `max_events_tail`.
   */
  async function emitAndTerminate(
    agentName: string,
    lines: readonly string[],
  ): Promise<{ h: Harness; env: FullRunEnvelope }> {
    let onOutputRef: ((chunk: string) => void) | undefined;
    let resolveAdapter!: () => void;
    const slow = new Promise<void>((r) => {
      resolveAdapter = r;
    });
    const adapter = makeMockAdapter({
      name: agentName,
      execute: async (task) => {
        const t = task as { onOutput?: (chunk: string) => void };
        onOutputRef = t.onOutput;
        await slow;
        return { output: 'done', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = await startHarness([adapter]);
    const run = await h.client.callTool({
      name: 'run_agent',
      arguments: { agent_id: agentName, prompt: 'stream' },
    });
    const env = run.structuredContent as FullRunEnvelope;
    await waitFor(() => onOutputRef !== undefined);
    for (const line of lines) onOutputRef?.(line);
    await waitFor(async () => {
      const r = await h.client.callTool({
        name: 'get_run_status',
        arguments: { run_id: env.run_id },
      });
      const s = r.structuredContent as { next_event_line: number };
      return s.next_event_line >= lines.length;
    });
    resolveAdapter();
    await pollUntilTerminal(h.client, env.run_id);
    return { h, env };
  }

  it('caps events_tail on the terminal poll and emits the skipped-events marker', async () => {
    const lines = Array.from({ length: 8 }, (_, i) => `[mock-streaming] message: line ${i + 1}`);
    const { h, env } = await emitAndTerminate('mock-streaming', lines);
    const readEventsSinceSpy = vi.spyOn(RunStateStore.prototype, 'readEventsSince');
    const readFilteredTailSpy = vi.spyOn(RunStateStore.prototype, 'readFilteredTailFromEnd');
    try {
      const capped = await h.client.callTool({
        name: 'get_run_status',
        arguments: { run_id: env.run_id, max_events_tail: 3 },
      });
      const c = capped.structuredContent as {
        status: string;
        events_tail: string[];
        events_tail_skipped?: number;
      };
      expect(c.status).toBe('success');
      // cap=3, lines=8 → reserve 1 slot for marker + 2 surviving = 3 total.
      expect(c.events_tail).toEqual([
        '(6 more events skipped)',
        '[mock-streaming] message: line 7',
        '[mock-streaming] message: line 8',
      ]);
      expect(c.events_tail_skipped).toBe(6);
      expect(toolText(capped)).toBe(`**\`${env.run_id}\` success**\n> done\n6 events skipped`);
      expect(toolText(capped)).not.toContain('line 7');
      expect(readEventsSinceSpy).not.toHaveBeenCalled();
      expect(readFilteredTailSpy).toHaveBeenCalledTimes(1);
    } finally {
      readEventsSinceSpy.mockRestore();
      readFilteredTailSpy.mockRestore();
      await h.close();
    }
  });

  it('does not set events_tail_skipped when the run log fits under the cap', async () => {
    // Regression: a captain reading `events_tail_skipped` to decide
    // whether to render an "(N skipped)" hint must see *no* field
    // when nothing was elided. Verify both the marker line and the
    // field are absent when lines.length < cap.
    const lines = Array.from({ length: 4 }, (_, i) => `[mock-undercap] message: line ${i + 1}`);
    const { h, env } = await emitAndTerminate('mock-undercap', lines);
    try {
      const r = await h.client.callTool({
        name: 'get_run_status',
        arguments: { run_id: env.run_id, max_events_tail: 10 },
      });
      const s = r.structuredContent as {
        events_tail: string[];
        events_tail_skipped?: number;
      };
      expect(s.events_tail).toEqual(lines);
      // Field omitted (not 0) when nothing was skipped.
      expect(s.events_tail_skipped).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  it('does not skip when run-log length exactly equals the cap', async () => {
    // Boundary: lines.length === cap is the "fits exactly" case. The
    // cap fires only when lines.length > cap, so no marker should be
    // injected here even though we're right at the limit.
    const lines = Array.from({ length: 5 }, (_, i) => `[mock-exact] message: line ${i + 1}`);
    const { h, env } = await emitAndTerminate('mock-exact', lines);
    try {
      const r = await h.client.callTool({
        name: 'get_run_status',
        arguments: { run_id: env.run_id, max_events_tail: 5 },
      });
      const s = r.structuredContent as {
        events_tail: string[];
        events_tail_skipped?: number;
      };
      expect(s.events_tail).toEqual(lines);
      expect(s.events_tail_skipped).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  it('skips exactly the surplus when run-log length is cap+1', async () => {
    // Boundary: cap+1. The marker takes one slot of the budget so
    // the surviving tail is `cap-1` lines, and `events_tail_skipped`
    // is the count of lines elided from the front (here, 2 — the
    // marker displaces one survivor when the cap is tight).
    const lines = Array.from({ length: 6 }, (_, i) => `[mock-plus1] message: line ${i + 1}`);
    const { h, env } = await emitAndTerminate('mock-plus1', lines);
    try {
      const r = await h.client.callTool({
        name: 'get_run_status',
        arguments: { run_id: env.run_id, max_events_tail: 5 },
      });
      const s = r.structuredContent as {
        events_tail: string[];
        events_tail_skipped?: number;
      };
      // cap=5, lines=6 → budget=4 surviving + 1 marker line.
      expect(s.events_tail).toEqual([
        '(2 more events skipped)',
        '[mock-plus1] message: line 3',
        '[mock-plus1] message: line 4',
        '[mock-plus1] message: line 5',
        '[mock-plus1] message: line 6',
      ]);
      expect(s.events_tail_skipped).toBe(2);
    } finally {
      await h.close();
    }
  });

  it('rejects max_events_tail above MAX_EVENTS_TAIL_CAP at the schema boundary', () => {
    // The schema bound (MAX_EVENTS_TAIL_CAP) is enforced via zod, not
    // via runtime clamping; a misuse should surface as a clean
    // ValidationError rather than silently capping. Verify the schema
    // itself rejects 501 and accepts 500.
    expect(() => getRunStatusInputSchema.parse({ run_id: 'r', max_events_tail: 501 })).toThrow();
    expect(() =>
      getRunStatusInputSchema.parse({ run_id: 'r', max_events_tail: MAX_EVENTS_TAIL_CAP }),
    ).not.toThrow();
    expect(() =>
      getRunStatusInputSchema.parse({ run_id: 'r', max_events_tail: 0 }),
    ).toThrow();
  });

  it('accepts wait_for_terminal_only in the get_run_status schema', () => {
    expect(() =>
      getRunStatusInputSchema.parse({
        run_id: 'r',
        wait_for_change_ms: 30000,
        since_event_line: 0,
        wait_for_terminal_only: true,
      }),
    ).not.toThrow();
    expect(() =>
      getRunStatusInputSchema.parse({
        run_id: 'r',
        wait_for_terminal_only: 'true',
      }),
    ).toThrow();
  });
});

describe('crew serve — lifecycle', () => {
  it('waits for in-flight dispatches to drain during shutdown grace', async () => {
    let busy = true;
    setTimeout(() => {
      busy = false;
    }, 25);
    const startedAt = Date.now();

    const drained = await waitForInFlightDrain({
      listInFlight: () => busy
        ? [{ toolCallId: 'tool-call', toolName: 'run_agent', runId: 'run-1' }]
        : [],
    }, { maxWaitMs: 200, pollIntervalMs: 5 });

    expect(drained).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
  });

  it('stops waiting for shutdown drain at the grace bound', async () => {
    const startedAt = Date.now();

    const drained = await waitForInFlightDrain({
      listInFlight: () => [
        { toolCallId: 'tool-call', toolName: 'run_agent', runId: 'run-1' },
      ],
    }, { maxWaitMs: 30, pollIntervalMs: 5 });

    expect(drained).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(150);
  });

  it('waits for terminal state writes after in-flight dispatches drain', async () => {
    const dispatcher = new ToolDispatcher();
    let busy = true;
    let resolvePersist!: () => void;
    const persistPromise = new Promise<void>((resolve) => {
      resolvePersist = resolve;
    });
    const runStateStore = {
      markTerminal: vi.fn(() => persistPromise),
    } as unknown as RunStateStore;

    vi.spyOn(dispatcher, 'listInFlight').mockImplementation(() => busy
      ? [{ toolCallId: 'tool-call', toolName: 'run_agent', runId: 'run-1' }]
      : []);

    const terminal = installRunLifecycleListeners({
      dispatcher,
      runStateStore,
      runId: 'run-1',
      agentName: 'mock',
      toolCallId: 'tool-call',
    });
    const emitter = dispatcher as unknown as {
      emitter: {
        emit(event: string, info: Record<string, unknown>): boolean;
      };
    };

    emitter.emitter.emit('run:cancelled', {
      toolCallId: 'tool-call',
      toolName: 'run_agent',
      reason: 'shutdown',
      runId: 'run-1',
    });
    await expect(terminal).resolves.toMatchObject({ kind: 'cancelled' });

    setTimeout(() => {
      busy = false;
    }, 10);
    setTimeout(() => {
      resolvePersist();
    }, 30);

    const startedAt = Date.now();
    const drained = await waitForShutdownDrain(dispatcher, {
      maxWaitMs: 200,
      pollIntervalMs: 5,
    });

    expect(drained).toEqual({
      inFlightDrained: true,
      terminalPersistsDrained: true,
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
  });

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
    const previousFullEnvelope = process.env.CREW_FULL_ENVELOPE;
    process.env.CREW_FULL_ENVELOPE = '1';
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

    const run = await client.callTool({
      name: 'run_agent',
      arguments: { agent_id: 'mock-slow', prompt: 'never returns' },
    });
    const env = run.structuredContent as FullRunEnvelope;
    expect(env.status).toBe('running');

    // Wait for the dispatcher to start the task before cancelling.
    await waitFor(() => dispatcher.inFlightCount() === 1);
    dispatcher.cancelAll('lifecycle test');

    // Async-first: cancellation lands in state.json on the bg
    // listener. Poll until we see the cancelled status.
    await waitFor(async () => {
      const r = await client.callTool({
        name: 'get_run_status',
        arguments: { run_id: env.run_id },
      });
      return (r.structuredContent as { status: string }).status === 'cancelled';
    });
    const final = await client.callTool({
      name: 'get_run_status',
      arguments: { run_id: env.run_id },
    });
    const f = final.structuredContent as {
      status: string;
      lastError?: string;
      summary?: string;
      prompts: Array<{ turn: number; summary?: string }>;
    };
    expect(f.status).toBe('cancelled');
    // Top-level `summary` carries the cancellation reason text;
    // per-turn `prompts[].summary` is elided from the wire.
    expect(f.summary).toMatch(/lifecycle test/);
    expect(f.prompts[f.prompts.length - 1].summary).toBeUndefined();
    expect(abortObserved).toBe(true);

    await client.close();
    await server.close();
    if (previousFullEnvelope === undefined) {
      delete process.env.CREW_FULL_ENVELOPE;
    } else {
      process.env.CREW_FULL_ENVELOPE = previousFullEnvelope;
    }
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

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// Silence "unused import" for `readFileSync` if test variants change.
void readFileSync;

describe('formatProgressLines (unit)', () => {
  it('prefixes a single-line chunk with the agent id', () => {
    expect(formatProgressLines('codex', 'hello')).toEqual(['[codex] hello']);
  });

  it('does not double-prefix legacy adapter-prefixed chunks', () => {
    expect(formatProgressLines('codex', '[codex] command: started rg foo')).toEqual([
      '[codex] command: started rg foo',
    ]);
  });

  it('drops empty lines and trailing whitespace', () => {
    expect(formatProgressLines('a', '  \nfirst   \n\n   \nsecond\n')).toEqual([
      '[a] first',
      '[a] second',
    ]);
  });

  it('truncates lines longer than 240 chars with an ellipsis', () => {
    const result = formatProgressLines('x', 'a'.repeat(500));
    expect(result).toHaveLength(1);
    expect(result[0].endsWith('…')).toBe(true);
    expect(result[0].length).toBe(240);
  });

  it('truncates without splitting surrogate pairs at the boundary', () => {
    const prefixLen = '[x] '.length;
    const availableBeforeEllipsis = 240 - prefixLen - 1;
    const chunk = `${'a'.repeat(availableBeforeEllipsis - 2)}🚀tail`;
    const result = formatProgressLines('x', chunk);
    expect(result).toHaveLength(1);
    expect(result[0].length).toBe(240);
    expect(result[0]).toContain('🚀…');
    expect(result[0]).not.toContain('\uFFFD');
    expect(hasLoneSurrogate(result[0])).toBe(false);
  });

  it('accounts for a long agent-name prefix in the 240 char budget', () => {
    const result = formatProgressLines('agent-name-'.repeat(20), 'b'.repeat(200));
    expect(result).toHaveLength(1);
    expect(result[0].length).toBeLessThanOrEqual(240);
    expect(result[0].endsWith('…')).toBe(true);
  });

  it('truncates defensively when the prefix alone exceeds the budget', () => {
    const result = formatProgressLines('agent-name-'.repeat(40), 'body');
    expect(result).toHaveLength(1);
    expect(result[0].length).toBe(240);
    expect(result[0]).not.toContain('body');
  });

  it('returns an empty array for a whitespace-only chunk', () => {
    expect(formatProgressLines('a', '\n\n   \n')).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    expect(formatProgressLines('a', 'one\r\ntwo')).toEqual(['[a] one', '[a] two']);
  });

  it('treats lone carriage returns as progress-line delimiters', () => {
    expect(formatProgressLines('spin', 'frame one\rframe two')).toEqual([
      '[spin] frame one',
      '[spin] frame two',
    ]);
  });
});

describe('classifyClient', () => {
  // Substring + lowercase match so future renames of host clients
  // (e.g. "claude-code-cli" → "claude-code-host") still classify.
  it.each<[string | undefined, ReturnType<typeof classifyClient>]>([
    ['claude-code', 'claude-code'],
    ['Claude-Code', 'claude-code'],
    ['claude-code-cli', 'claude-code'],
    ['Claude Code', 'claude-code'],
    ['claude_code', 'claude-code'],
    ['claude', 'claude-code'],
    ['codex', 'codex'],
    ['codex-cli', 'codex'],
    ['Codex CLI', 'codex'],
    ['codex_cli', 'codex'],
    ['CODEX', 'codex'],
    ['gemini', 'gemini'],
    ['gemini-cli', 'gemini'],
    ['Gemini CLI', 'gemini'],
    ['some-future-host', 'unknown'],
    ['', 'unknown'],
    [undefined, 'unknown'],
  ])('classifies %j as %j', (input, expected) => {
    expect(classifyClient(input)).toBe(expected);
  });
});

describe('nextStepSentence', () => {
  // Single source of truth for the "next step" copy that lands in
  // both the structured `summary` and the markdown `- Next:` bullet —
  // these asserts make the contract explicit so a future copy edit
  // can't drift one without the other.
  it('returns the watcher phrasing for claude-code', () => {
    expect(nextStepSentence('claude-code')).toBe(
      'One required action: spawn the crew-wait watcher before ending your turn; user is free to chat.',
    );
  });
  it('returns the dispatch-returns phrasing for codex', () => {
    expect(nextStepSentence('codex')).toBe(
      'End your turn after this dispatch returns; user is free to chat.',
    );
  });
  it('returns the dispatch-returns phrasing for gemini', () => {
    expect(nextStepSentence('gemini')).toBe(
      'End your turn after this dispatch returns; user is free to chat.',
    );
  });
  it('returns a neutral fallback for unknown hosts', () => {
    expect(nextStepSentence('unknown')).toBe(
      'End your turn after dispatch; user is free to chat.',
    );
  });
});
