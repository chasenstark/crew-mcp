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

  it('declares read-only as advisory because Gemini CLI does not enforce crew sandboxes', () => {
    expect(adapter.enforcesReadOnly).toBe(false);
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

  it('delivers the composed prompt via stdin, not argv', async () => {
    const composedPrompt = '## Peer messages\n\nforwarded context\nactual task';
    mockExeca.mockResolvedValueOnce({
      stdout: `${JSON.stringify({ type: 'result', content: 'ok' })}\n`,
      stderr: '',
      exitCode: 0,
    } as any);

    await adapter.execute({
      prompt: composedPrompt,
      context: { workingDirectory: '/tmp/project' },
    });

    const [, args, options] = mockExeca.mock.calls[0] as [string, string[], { input?: string }];
    // Gemini runs headless on `--output-format json`; the prompt must not be
    // a positional or post-`--` argv token (Gemini would never see it).
    expect(args).toEqual(['--output-format', 'json']);
    expect(args).not.toContain('--');
    expect(args).not.toContain(composedPrompt);
    expect(options.input).toBe(composedPrompt);
  });

  it('delivers a leading-dash prompt via stdin so it is never parsed as a flag', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: `${JSON.stringify({ type: 'result', content: 'ok' })}\n`,
      stderr: '',
      exitCode: 0,
    } as any);

    await adapter.execute({
      prompt: '-not-a-gemini-flag',
      context: { workingDirectory: '/tmp/project' },
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'gemini',
      ['--output-format', 'json'],
      expect.objectContaining({
        cwd: '/tmp/project',
        input: '-not-a-gemini-flag',
        reject: false,
      }),
    );
  });

  it('delivers a prompt that would exceed the argv byte budget via stdin', async () => {
    const largePrompt = 'x'.repeat(129 * 1024);
    mockExeca.mockResolvedValueOnce({
      stdout: `${JSON.stringify({ type: 'result', content: 'ok' })}\n`,
      stderr: '',
      exitCode: 0,
    } as any);

    const result = await adapter.execute({
      prompt: largePrompt,
      context: { workingDirectory: '/tmp/project' },
    });

    // stdin has no argv byte limit, so a large prompt is delivered, not rejected.
    expect(mockExeca).toHaveBeenCalledTimes(1);
    const [, args, options] = mockExeca.mock.calls[0] as [string, string[], { input?: string }];
    expect(args).toEqual(['--output-format', 'json']);
    expect(options.input).toBe(largePrompt);
    expect(result.status).toBe('success');
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
      ['--output-format', 'json', '--model', 'gemini-2.5-pro'],
      expect.objectContaining({
        cwd: '/tmp/project',
        input: 'test',
        reject: false,
      }),
    );
  });

  it('passes --model through executeWithSchema', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: `${JSON.stringify({ response: '{"ok":true}' })}\n`,
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
    ]);
    expect((callArgs?.[2] as { input?: string }).input).toContain('return json');
  });

  it('does not replay the full transcript inline when resuming a provider session', async () => {
    mockExeca
      .mockResolvedValueOnce({
        stdout: 'gemini-cli 0.20.1',
        stderr: '',
        exitCode: 0,
      } as any)
      .mockResolvedValueOnce({
        stdout: [
          JSON.stringify({ type: 'init', session_id: 'session-2' }),
          JSON.stringify({
            type: 'message',
            role: 'assistant',
            content: JSON.stringify({
              type: 'finish',
              output: 'done',
              reasoning: 'workflow complete',
            }),
          }),
          JSON.stringify({ type: 'result' }),
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      } as any);

    const result = await adapter.executeWithTools(
      [
        {
          name: 'run_decompose',
          description: 'decompose request',
          inputSchema: { type: 'object' },
        },
      ],
      [{ role: 'assistant', content: 'prior transcript should not be replayed inline' }],
      vi.fn(async () => ({ output: { ok: true } })),
      {
        workingDirectory: '/tmp/project',
        providerSession: {
          provider: 'gemini',
          transport: 'stateful-resume',
          sessionId: 'session-1',
          toolNamespace: 'mcp__crew__',
          toolSchemaHash: 'abc',
          startedAt: new Date().toISOString(),
        },
        toolNamespace: 'mcp__crew__',
        toolSchemaHash: 'abc',
      },
    );

    expect(result.status).toBe('completed');
    const args = mockExeca.mock.calls[1]?.[1] as string[];
    expect(args).toContain('--resume');
    // With --prompt the prompt is at index args.indexOf('--prompt') + 1.
    const promptIndex = args.indexOf('--prompt');
    expect(promptIndex).toBeGreaterThan(-1);
    const prompt = args[promptIndex + 1] ?? '';
    expect(prompt).toContain('provider resume session already contains prior turns');
    expect(prompt).not.toContain('prior transcript should not be replayed inline');
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
