import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

const { execa } = await import('execa');
const mockExeca = vi.mocked(execa);

const { GenericAdapter } = await import('../../src/adapters/generic.js');

describe('GenericAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the composed prompt through the configured argv template', async () => {
    const composedPrompt = '## Peer messages\n\nforwarded context\nactual task';
    mockExeca.mockResolvedValueOnce({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    } as any);

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

  it('treats nonzero exits with stdout as errors instead of partial success', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: 'partial stdout',
      stderr: 'command failed',
      exitCode: 23,
    } as any);

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
    expect(result.metadata.rawEvents).toEqual([
      {
        exitCode: 23,
        stdout: 'partial stdout',
        stderr: 'command failed',
      },
    ]);
  });
});
