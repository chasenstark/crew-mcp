import { describe, expect, it, vi } from 'vitest';
import { executePromptToolLoop } from '../../../src/adapters/tool-loop/controller.js';

describe('executePromptToolLoop', () => {
  it('maps aborts during controller decisions to interrupted status', async () => {
    const controller = new AbortController();

    const result = await executePromptToolLoop(
      [],
      [{ role: 'system', content: 'start' }],
      vi.fn(),
      async () => {
        controller.abort('Cancelled by test');
        const error = new Error('Cancelled by test');
        error.name = 'AbortError';
        throw error;
      },
      { signal: controller.signal },
    );

    expect(result.status).toBe('interrupted');
    expect(result.error).toContain('Cancelled by test');
  });
});
