// openai-compatible adapter resume portability test (M1.5-13).
//
// This adapter doesn't support native stateful-resume; its transport is
// always 'prefix-cached'. The test documents the fallback-to-replay behavior:
// every turn, the FULL message history (including tool_result entries from
// prior turns) is sent to the API. There is no session ID in the provider
// response that the session loop should capture; the captain session's
// providerSessionRef will always be undefined for this adapter.

import { beforeEach, describe, expect, it, vi } from 'vitest';

global.fetch = vi.fn() as any;
const mockFetch = global.fetch as unknown as ReturnType<typeof vi.fn>;

const { OpenAiCompatibleAdapter } = await import('../../src/adapters/openai-compatible.js');

describe('OpenAiCompatibleAdapter resume portability (M1.5-13)', () => {
  let adapter: InstanceType<typeof OpenAiCompatibleAdapter>;

  beforeEach(() => {
    adapter = new OpenAiCompatibleAdapter({
      name: 'test-openai',
      model: 'test-model',
      apiBase: 'http://localhost:8080',
      apiKey: 'test',
    });
    vi.clearAllMocks();
  });

  it('reports transport="prefix-cached" on every turn (no native resume)', async () => {
    // Mock a one-turn chat completion that returns a tool_loop finish message.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                type: 'finish',
                output: 'done',
                reasoning: 'ok',
              }),
            },
          },
        ],
      }),
    } as any);

    const captured: { transport?: string; sessionId?: string } = {};
    await adapter.executeWithTools(
      [{ name: 'run_decompose', description: 'd', inputSchema: { type: 'object' } }],
      [{ role: 'user', content: 'start' }],
      vi.fn(async () => ({ output: { ok: true } })),
      {
        workingDirectory: '/tmp',
        toolNamespace: 'mcp__crew__',
        toolSchemaHash: 'abc',
        onProviderSession: (session) => {
          captured.transport = session.transport;
          captured.sessionId = session.sessionId;
        },
      },
    );

    expect(captured.transport).toBe('prefix-cached');
    expect(captured.sessionId).toBeUndefined();
  });

  it('falls through to replay regardless of an incoming providerSession', async () => {
    // Session loop might pass a providerSession with a stale transport; the
    // adapter must ignore the sessionId (it has no stateful resume) and
    // always replay prefix-cached.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                type: 'finish',
                output: 'replay-ok',
                reasoning: 'ok',
              }),
            },
          },
        ],
      }),
    } as any);

    const captured: { transport?: string } = {};
    await adapter.executeWithTools(
      [{ name: 'run_decompose', description: 'd', inputSchema: { type: 'object' } }],
      [
        { role: 'user', content: 'first prompt' },
        { role: 'assistant', content: 'prior reply' },
        { role: 'user', content: 'now do the thing' },
      ],
      vi.fn(async () => ({ output: { ok: true } })),
      {
        workingDirectory: '/tmp',
        toolNamespace: 'mcp__crew__',
        toolSchemaHash: 'abc',
        providerSession: {
          provider: 'local',
          transport: 'stateful-resume',
          sessionId: 'wishful-sid',
          toolNamespace: 'mcp__crew__',
          toolSchemaHash: 'abc',
          startedAt: '2026-04-19T00:00:00.000Z',
        },
        onProviderSession: (session) => {
          captured.transport = session.transport;
        },
      },
    );

    expect(captured.transport).toBe('prefix-cached');
  });
});
