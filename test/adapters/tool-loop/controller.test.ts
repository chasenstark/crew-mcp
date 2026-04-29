import { describe, expect, it, vi } from 'vitest';
import { executePromptToolLoop } from '../../../src/adapters/tool-loop/controller.js';

describe('executePromptToolLoop', () => {
  it('stops immediately when a tool result is terminal', async () => {
    const decide = vi
      .fn()
      .mockResolvedValueOnce({
        type: 'tool_call',
        tool: 'finish',
        input: { summary: 'done' },
        reasoning: null,
        output: null,
        error: null,
      });
    const onToolCall = vi.fn().mockResolvedValue({
      output: { status: 'ok', summary: 'done' },
      terminal: true,
      terminalOutput: 'done',
    });

    const result = await executePromptToolLoop(
      [{ name: 'finish', description: 'finish', inputSchema: { type: 'object' } }],
      [{ role: 'system', content: 'start' }],
      onToolCall,
      decide,
    );

    expect(result.status).toBe('completed');
    expect(result.output).toBe('done');
    expect(decide).toHaveBeenCalledTimes(1);
    expect(onToolCall).toHaveBeenCalledTimes(1);
  });

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
