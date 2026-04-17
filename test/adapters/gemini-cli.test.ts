import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

const { execa } = await import('execa');
const mockExeca = vi.mocked(execa);

const { GeminiCliAdapter } = await import('../../src/adapters/gemini-cli.js');

describe('GeminiCliAdapter', () => {
  let adapter: InstanceType<typeof GeminiCliAdapter>;

  beforeEach(() => {
    adapter = new GeminiCliAdapter();
    vi.clearAllMocks();
  });

  it('advertises native tool-loop support', () => {
    expect(adapter.captainCapabilities.supportsToolLoop).toBe(true);
  });

  it('extracts semantic version tag', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: 'gemini-cli 1.2.3',
      stderr: '',
      exitCode: 0,
    } as any);

    const tag = await adapter.getCliVersionTag();
    expect(tag).toBe('gemini-cli@1.2.3');
  });

  it('maps non-zero execute exit codes to error status', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({ type: 'result', content: 'failed' }),
      stderr: 'failure',
      exitCode: 1,
    } as any);

    const result = await adapter.execute({
      prompt: 'test',
      context: { workingDirectory: '/tmp/project' },
    });

    expect(result.status).toBe('error');
  });

  it('passes --model when specified in execute constraints', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: `${JSON.stringify({ type: 'result', content: 'ok' })}\n`,
      stderr: '',
      exitCode: 0,
    } as any);

    await adapter.execute({
      prompt: 'test',
      context: { workingDirectory: '/tmp/project' },
      constraints: { model: 'gemini-2.5-pro' },
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'gemini',
      ['--output-format', 'json', '--model', 'gemini-2.5-pro', 'test'],
      expect.objectContaining({
        cwd: '/tmp/project',
        reject: false,
      }),
    );
  });

  it('passes --model through executeWithSchema', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: `${JSON.stringify({ content: '{"ok":true}' })}\n`,
      stderr: '',
      exitCode: 0,
    } as any);

    const result = await adapter.executeWithSchema(
      'return json',
      z.object({ ok: z.boolean() }),
      {
        workingDirectory: '/tmp/project',
        model: 'gemini-2.5-flash',
      },
    );

    expect(result).toEqual({ ok: true });
    const callArgs = mockExeca.mock.calls[0];
    expect(callArgs?.[1]).toEqual([
      '--output-format',
      'json',
      '--model',
      'gemini-2.5-flash',
      expect.stringContaining('return json'),
    ]);
  });

  it('returns structured error results when the gemini process rejects', async () => {
    mockExeca.mockRejectedValueOnce(new Error('spawn failed'));

    const result = await adapter.execute({
      prompt: 'test',
      context: { workingDirectory: '/tmp/project' },
    });

    expect(result.status).toBe('error');
    expect(result.output).toContain('spawn failed');
    expect(result.metadata.rawEvents).toEqual([
      expect.objectContaining({
        error: 'spawn failed',
      }),
    ]);
  });

  it('returns interrupted and skips fallback prompt loop when signal is already aborted', async () => {
    const executeWithSchemaSpy = vi.spyOn(adapter, 'executeWithSchema');
    vi.spyOn(adapter as any, 'executeWithResumeSession').mockRejectedValueOnce(
      new Error('resume path failed'),
    );

    const controller = new AbortController();
    controller.abort('Cancelled by test');

    const result = await adapter.executeWithTools(
      [],
      [{ role: 'system', content: 'test' }],
      vi.fn(async () => ({ output: { ok: true } })),
      {
        signal: controller.signal,
        toolNamespace: 'mcp__crew__',
        toolSchemaHash: 'abc',
      },
    );

    expect(result.status).toBe('interrupted');
    expect(executeWithSchemaSpy).not.toHaveBeenCalled();
  });
});
