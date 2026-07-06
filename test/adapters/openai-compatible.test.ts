import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { OpenAiCompatibleAdapter } = await import('../../src/adapters/openai-compatible.js');

describe('OpenAiCompatibleAdapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('classifies loopback api bases as unmetered and cloud or malformed bases as metered', () => {
    expect(new OpenAiCompatibleAdapter({
      name: 'local-test',
      apiBase: 'http://localhost:11434/v1',
    }).unmetered).toBe(true);
    expect(new OpenAiCompatibleAdapter({
      name: 'cloud-test',
      apiBase: 'https://api.openai.com/v1',
    }).unmetered).toBe(false);
    expect(new OpenAiCompatibleAdapter({
      name: 'malformed-test',
      apiBase: 'not a url',
    }).unmetered).toBe(false);
  });

  it('passes the composed prompt as the user chat message', async () => {
    const composedPrompt = '## Peer messages\n\nforwarded context\nactual task';
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OpenAiCompatibleAdapter({
      name: 'openai-test',
      model: 'qwen-test',
    });

    await adapter.execute({
      prompt: composedPrompt,
      context: { workingDirectory: '/tmp/project' },
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.messages).toEqual([{ role: 'user', content: composedPrompt }]);
  });

  it('ignores dispatchMcpEnv instead of sending MCP env in the HTTP request', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OpenAiCompatibleAdapter({
      name: 'openai-test',
      model: 'qwen-test',
    });

    await adapter.execute({
      prompt: 'run task',
      dispatchMcpEnv: {
        CREW_RUN_ID: 'openai-run-123',
        CREW_RUN_TOKEN: 'e'.repeat(64),
      },
      context: { workingDirectory: '/tmp/project' },
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const requestText = JSON.stringify({
      headers: request.headers,
      body: JSON.parse(String(request.body)),
    });
    expect(requestText).not.toContain('CREW_RUN_TOKEN');
    expect(requestText).not.toContain('openai-run-123');
    expect(requestText).not.toContain('e'.repeat(64));
  });

  it('returns a typed rate-limit failure for HTTP 429', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '30' : null) },
      text: async () => 'rate limit reached',
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OpenAiCompatibleAdapter({
      name: 'openai-test',
      model: 'qwen-test',
    });

    const result = await adapter.execute({
      prompt: 'hello',
      context: { workingDirectory: '/tmp/project' },
    });

    expect(result.status).toBe('error');
    expect(result.failure).toMatchObject({
      kind: 'rate_limited',
      confidence: 'high',
      providerCode: '429',
      retryAfterSeconds: 30,
      recommendation: 'backoff',
    });
  });

  it('returns a typed transient failure for HTTP 503', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
      headers: { get: () => null },
      text: async () => 'service unavailable',
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OpenAiCompatibleAdapter({
      name: 'openai-test',
      model: 'qwen-test',
    });

    const result = await adapter.execute({
      prompt: 'hello',
      context: { workingDirectory: '/tmp/project' },
    });

    expect(result.status).toBe('error');
    expect(result.failure).toMatchObject({
      kind: 'transient',
      confidence: 'high',
      providerCode: '503',
      recommendation: 'backoff',
    });
  });

  it('rethrows an already-aborted caller signal instead of returning failure:transient', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OpenAiCompatibleAdapter({
      name: 'openai-test',
      model: 'qwen-test',
    });
    const controller = new AbortController();
    controller.abort('Cancelled by test');

    await expect(adapter.execute({
      prompt: 'hello',
      context: { workingDirectory: '/tmp/project' },
      constraints: { signal: controller.signal },
    })).rejects.toBe('Cancelled by test');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rethrows AbortError instead of returning failure:transient', async () => {
    const abortError = new Error('The operation was aborted.');
    abortError.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(abortError));

    const adapter = new OpenAiCompatibleAdapter({
      name: 'openai-test',
      model: 'qwen-test',
    });

    await expect(adapter.execute({
      prompt: 'hello',
      context: { workingDirectory: '/tmp/project' },
    })).rejects.toBe(abortError);
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

  it('arms a default HTTP timeout and composes it with caller cancellation', async () => {
    vi.useFakeTimers();
    vi.stubEnv('CREW_OPENAI_COMPATIBLE_TIMEOUT_MS', '5000');
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason);
        });
      }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OpenAiCompatibleAdapter({
      name: 'openai-test',
      model: 'qwen-test',
    });

    const resultP = adapter.execute({
      prompt: 'hello',
      context: { workingDirectory: '/tmp/project' },
    });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultP;

    expect(result.status).toBe('error');
    expect(result.output).toContain('OpenAI-compatible request timed out');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    const cancelledP = adapter.execute({
      prompt: 'hello',
      context: { workingDirectory: '/tmp/project' },
      constraints: { signal: controller.signal },
    });
    controller.abort('caller cancelled');
    await expect(cancelledP).rejects.toBe('caller cancelled');
  });
});
