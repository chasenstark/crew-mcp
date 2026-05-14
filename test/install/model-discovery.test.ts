import { afterEach, describe, expect, it, vi } from 'vitest';

import { listOpenAiCompatibleModels } from '../../src/install/model-discovery.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listOpenAiCompatibleModels', () => {
  it('parses OpenAI-compatible data: [{ id }] model responses', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'gemma4:latest' },
          { id: 'llama-3.2:latest' },
          { id: 'gemma4:latest' },
        ],
      }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      listOpenAiCompatibleModels('http://localhost:11434/v1/', 'ollama'),
    ).resolves.toEqual({
      ok: true,
      models: ['gemma4:latest', 'llama-3.2:latest'],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer ollama' },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('falls back gracefully on malformed JSON shape', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: ['gemma4'] }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await listOpenAiCompatibleModels('http://localhost:11434/v1', undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/data: \[\{ id \}\]/);
    }
  });

  it('returns an HTTP reason for non-200 responses', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await listOpenAiCompatibleModels('http://localhost:11434/v1', 'ollama');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/HTTP 404/);
    }
  });
});
