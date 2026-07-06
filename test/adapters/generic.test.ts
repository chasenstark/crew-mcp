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
        reject: false,
      }),
    );
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
