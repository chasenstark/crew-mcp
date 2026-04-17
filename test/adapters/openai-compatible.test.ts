import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { OpenAiCompatibleAdapter } = await import('../../src/adapters/openai-compatible.js');

describe('OpenAiCompatibleAdapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds a synthetic assistant tool_calls message before synthetic tool results', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  type: 'tool_call',
                  tool: 'read_file',
                  input: { path: 'src/index.ts' },
                  reasoning: 'Need the file contents first.',
                }),
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'done',
              },
            },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OpenAiCompatibleAdapter({
      name: 'openai-test',
      model: 'qwen-test',
    });

    const result = await adapter.executeWithTools(
      [
        {
          name: 'read_file',
          description: 'Read a file',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
            required: ['path'],
          },
        },
      ],
      [{ role: 'user', content: 'Inspect the file' }],
      async () => ({ output: { contents: 'file body' } }),
      {
        toolNamespace: 'mcp__crew__',
        toolSchemaHash: 'schema-hash',
      },
    );

    expect(result.status).toBe('completed');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const body = JSON.parse(String(secondRequest.body));
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: 'Need the file contents first.',
      tool_calls: [
        {
          id: 'synthetic-1',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'src/index.ts' }),
          },
        },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'synthetic-1',
      content: JSON.stringify({ contents: 'file body' }),
    });
  });

  it('does not issue a fetch when the caller signal is already aborted and timeout wrapping is enabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OpenAiCompatibleAdapter({
      name: 'openai-test',
      model: 'qwen-test',
    });
    const controller = new AbortController();
    controller.abort('Cancelled by test');

    await expect(
      (adapter as any).chatCompletion({
        model: 'qwen-test',
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 5_000,
        signal: controller.signal,
      }),
    ).rejects.toBe('Cancelled by test');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
