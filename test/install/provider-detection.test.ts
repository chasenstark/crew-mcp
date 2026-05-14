import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  detectLmStudio,
  detectOllama,
  LM_STUDIO_DEFAULT_API_BASE,
  OLLAMA_DEFAULT_URL,
} from '../../src/install/provider-detection.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provider detection', () => {
  it('marks Ollama reachable when the default endpoint returns 200', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(detectOllama()).resolves.toEqual({
      reachable: true,
      url: OLLAMA_DEFAULT_URL,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      OLLAMA_DEFAULT_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('marks LM Studio unreachable on 404', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await detectLmStudio();
    expect(result.reachable).toBe(false);
    expect(result.url).toBe(LM_STUDIO_DEFAULT_API_BASE);
    expect(result.reason).toMatch(/HTTP 404/);
  });

  it('returns a timeout-style failure when the probe aborts', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted by test')));
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await detectOllama({ timeoutMs: 1 });
    expect(result.reachable).toBe(false);
    expect(result.reason).toMatch(/aborted by test/);
  });
});
