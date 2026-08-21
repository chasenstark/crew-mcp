import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

const { execa } = await import('execa');
const mockExeca = vi.mocked(execa);

const { GenericAdapter } = await import('../../src/adapters/generic.js');

function execaResult(args: {
  stdout: string;
  stderr: string;
  exitCode: number;
}): Awaited<ReturnType<typeof execa>> {
  return args as Awaited<ReturnType<typeof execa>>;
}

describe('GenericAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('advertises unsupported model selection and refuses an explicit pin', async () => {
    const adapter = new GenericAdapter({
      name: 'generic-test',
      command: 'generic-tool',
      argsTemplate: ['--prompt', '{{prompt}}'],
      strengths: [],
    });

    await expect(adapter.listModels()).resolves.toMatchObject({
      support: 'unsupported',
      authoritative: true,
      models: [],
    });
    await expect(adapter.resolveModel('some-model')).resolves.toMatchObject({
      ok: false,
      code: 'model_selection.unsupported',
    });
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it('does not spawn for a cached-only health check', async () => {
    const adapter = new GenericAdapter({
      name: 'generic-test',
      command: 'generic-tool',
      argsTemplate: ['--prompt', '{{prompt}}'],
      strengths: [],
    });

    await expect(adapter.healthCheck({ cachedOnly: true })).rejects.toMatchObject({
      code: 'health_check.cache_miss',
    });
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it('caches unavailable health and refreshes it with a new probe', async () => {
    const adapter = new GenericAdapter({
      name: 'generic-test',
      command: 'generic-tool',
      argsTemplate: ['--prompt', '{{prompt}}'],
      strengths: [],
    });
    mockExeca
      .mockResolvedValueOnce(execaResult({ stdout: '', stderr: '', exitCode: 1 }))
      .mockResolvedValueOnce(execaResult({
        stdout: '/usr/local/bin/generic-tool',
        stderr: '',
        exitCode: 0,
      }));

    const unavailable = await adapter.healthCheck();
    const cachedUnavailable = await adapter.healthCheck({ cachedOnly: true });
    expect(unavailable.available).toBe(false);
    expect(cachedUnavailable).toEqual(unavailable);
    expect(mockExeca).toHaveBeenCalledOnce();

    const refreshed = await adapter.healthCheck({ refresh: true });
    const cachedRefreshed = await adapter.healthCheck({ cachedOnly: true });
    expect(refreshed.available).toBe(true);
    expect(cachedRefreshed).toEqual(refreshed);
    expect(mockExeca).toHaveBeenCalledTimes(2);
  });

  it('passes the composed prompt through the configured argv template', async () => {
    const composedPrompt = '## Peer messages\n\nforwarded context\nactual task';
    mockExeca.mockResolvedValueOnce(execaResult({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    }));

    const adapter = new GenericAdapter({
      name: 'generic-test',
      command: 'generic-tool',
      argsTemplate: ['--prompt', '{{prompt}}'],
      strengths: [],
    });

    await adapter.execute({
      prompt: composedPrompt,
      context: { workingDirectory: '/tmp/project' },
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'generic-tool',
      ['--prompt', composedPrompt],
      expect.objectContaining({
        cwd: '/tmp/project',
        extendEnv: false,
        reject: false,
      }),
    );
    const options = mockExeca.mock.calls[0]?.[2];
    expect(options?.env?.CREW_CODEX_BRIDGE_FILE).toBeUndefined();
    expect(options?.env?.CREW_CODEX_REMOTE_TOKEN).toBeUndefined();
    expect(options?.env?.CODEX_THREAD_ID).toBeUndefined();
  });

  it('ignores dispatchMcpEnv instead of emitting MCP env argv', async () => {
    mockExeca.mockResolvedValueOnce(execaResult({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    }));

    const adapter = new GenericAdapter({
      name: 'generic-test',
      command: 'generic-tool',
      argsTemplate: ['--prompt', '{{prompt}}'],
      strengths: [],
    });

    await adapter.execute({
      prompt: 'run task',
      dispatchMcpEnv: {
        CREW_RUN_ID: 'generic-run-123',
        CREW_RUN_TOKEN: 'd'.repeat(64),
      },
      context: { workingDirectory: '/tmp/project' },
    });

    const args = mockExeca.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(['--prompt', 'run task']);
    expect(args.join('\n')).not.toContain('CREW_RUN_TOKEN');
    expect(args.join('\n')).not.toContain('generic-run-123');
  });

  it('inserts -- before an appended leading-dash prompt', async () => {
    mockExeca.mockResolvedValueOnce(execaResult({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    }));

    const adapter = new GenericAdapter({
      name: 'generic-test',
      command: 'generic-tool',
      argsTemplate: ['run'],
      strengths: [],
    });

    await adapter.execute({
      prompt: '-not-a-flag',
      context: { workingDirectory: '/tmp/project' },
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'generic-tool',
      ['run', '--', '-not-a-flag'],
      expect.objectContaining({ cwd: '/tmp/project' }),
    );
  });

  it('rewrites long-option prompt value templates for leading-dash prompts', async () => {
    mockExeca.mockResolvedValueOnce(execaResult({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    }));

    const adapter = new GenericAdapter({
      name: 'generic-test',
      command: 'generic-tool',
      argsTemplate: ['--prompt', '{{prompt}}'],
      strengths: [],
    });

    await adapter.execute({
      prompt: '-review-this',
      context: { workingDirectory: '/tmp/project' },
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'generic-tool',
      ['--prompt=-review-this'],
      expect.objectContaining({ cwd: '/tmp/project' }),
    );
  });

  it('keeps unrelated boolean flags separate from leading-dash positional prompts', async () => {
    mockExeca.mockResolvedValueOnce(execaResult({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    }));

    const adapter = new GenericAdapter({
      name: 'generic-test',
      command: 'generic-tool',
      argsTemplate: ['--verbose', '{{prompt}}'],
      strengths: [],
    });

    await adapter.execute({
      prompt: '-not-a-flag',
      context: { workingDirectory: '/tmp/project' },
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'generic-tool',
      ['--verbose', '--', '-not-a-flag'],
      expect.objectContaining({ cwd: '/tmp/project' }),
    );
  });

  it('fails fast before spawn when an argv prompt exceeds the byte budget', async () => {
    const adapter = new GenericAdapter({
      name: 'generic-test',
      command: 'generic-tool',
      argsTemplate: ['{{prompt}}'],
      strengths: [],
    });

    const result = await adapter.execute({
      prompt: 'x'.repeat(129 * 1024),
      context: { workingDirectory: '/tmp/project' },
    });

    expect(mockExeca).not.toHaveBeenCalled();
    expect(result.status).toBe('error');
    expect(result.output).toContain('Adapter "generic-test" cannot receive this prompt via argv');
  });

  it('treats nonzero exits with stdout as errors instead of partial success', async () => {
    mockExeca.mockResolvedValueOnce(execaResult({
      stdout: 'partial stdout',
      stderr: 'command failed',
      exitCode: 23,
    }));

    const adapter = new GenericAdapter({
      name: 'generic-test',
      command: 'generic-tool',
      argsTemplate: ['--prompt', '{{prompt}}'],
      strengths: [],
    });

    const result = await adapter.execute({
      prompt: 'run task',
      context: { workingDirectory: '/tmp/project' },
    });

    expect(result.status).toBe('error');
    expect(result.output).toContain('command failed');
    expect(result.output).toContain('partial stdout');
    expect(result.failure).toMatchObject({
      kind: 'process',
      confidence: 'high',
      providerCode: '23',
    });
    expect(result.metadata.rawEvents).toEqual([
      {
        exitCode: 23,
        stdout: 'partial stdout',
        stderr: 'command failed',
      },
    ]);
  });

  it('classifies quota-like nonzero exits for generic adapters', async () => {
    mockExeca.mockResolvedValueOnce(execaResult({
      stdout: '',
      stderr: 'RESOURCE_EXHAUSTED: quota exceeded',
      exitCode: 1,
    }));

    const adapter = new GenericAdapter({
      name: 'generic-test',
      command: 'generic-tool',
      argsTemplate: ['--prompt', '{{prompt}}'],
      strengths: [],
    });

    const result = await adapter.execute({
      prompt: 'run task',
      context: { workingDirectory: '/tmp/project' },
    });

    expect(result.status).toBe('error');
    expect(result.failure).toMatchObject({
      kind: 'quota_exhausted',
      confidence: 'high',
      providerCode: '1',
      recommendation: 'reroute',
    });
  });

  it('bounds multi-megabyte nonzero output before returning or classifying it', async () => {
    const stderr = `GENERIC_FAILURE_HEAD\n${'e'.repeat(2 * 1024 * 1024)}`;
    const stdout = [
      's'.repeat(1024 * 1024),
      'RESOURCE_EXHAUSTED hidden in truncated middle',
      't'.repeat(1024 * 1024),
      'GENERIC_FAILURE_TAIL',
    ].join('\n');
    mockExeca.mockResolvedValueOnce(execaResult({
      stdout,
      stderr,
      exitCode: 23,
    }));

    const adapter = new GenericAdapter({
      name: 'generic-test',
      command: 'generic-tool',
      argsTemplate: ['--prompt', '{{prompt}}'],
      strengths: [],
    });

    const result = await adapter.execute({
      prompt: 'run task',
      context: { workingDirectory: '/tmp/project' },
    });

    expect(result.status).toBe('error');
    expect(result.output).toContain('GENERIC_FAILURE_HEAD');
    expect(result.output).toContain('GENERIC_FAILURE_TAIL');
    expect(result.output).toMatch(/\[\.\.\. \d+ bytes truncated \.\.\.\]/);
    expect(result.output).not.toContain('RESOURCE_EXHAUSTED');
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThan(70 * 1024);
    expect(result.failure?.kind).toBe('process');
  });

  it('classifies thrown process failures', async () => {
    mockExeca.mockRejectedValueOnce(new Error('spawn ENOENT'));

    const adapter = new GenericAdapter({
      name: 'generic-test',
      command: 'generic-tool',
      argsTemplate: ['--prompt', '{{prompt}}'],
      strengths: [],
    });

    const result = await adapter.execute({
      prompt: 'run task',
      context: { workingDirectory: '/tmp/project' },
    });

    expect(result.status).toBe('error');
    expect(result.failure).toMatchObject({
      kind: 'process',
      confidence: 'low',
    });
    expect(result.failure?.rawSignal).toBe('spawn ENOENT');
  });
});
