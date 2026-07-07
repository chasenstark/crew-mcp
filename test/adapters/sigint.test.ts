import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdtempSync: () => '/tmp/crew-sigint-mock',
    writeFileSync: () => undefined,
    rmSync: () => undefined,
    existsSync: () => false,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => actual.readFileSync(...args),
  };
});

const { execa } = await import('execa');
const mockExeca = vi.mocked(execa);

const { CodexAdapter } = await import('../../src/adapters/codex.js');
const { ClaudeCodeAdapter } = await import('../../src/adapters/claude-code.js');

function abortedController(reason = 'Cancelled by test'): AbortController {
  const controller = new AbortController();
  controller.abort(reason);
  return controller;
}

describe('adapter cancellation plumbing (CI, mock subprocess)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('CodexAdapter.execute', () => {
    it('forwards the AbortSignal to execa as cancelSignal', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      } as any);

      const adapter = new CodexAdapter();
      const controller = new AbortController();

      await adapter.execute({
        prompt: 'hi',
        context: { workingDirectory: '/tmp/project' },
        constraints: { signal: controller.signal },
      });

      const call = mockExeca.mock.calls[0];
      expect(call).toBeDefined();
      const options = call![2] as { cancelSignal?: AbortSignal };
      expect(options.cancelSignal).toBe(controller.signal);
    });

    it('returns an error result when the subprocess rejects on cancel', async () => {
      mockExeca.mockRejectedValueOnce(
        Object.assign(new Error('Command was killed with SIGTERM'), {
          isCanceled: true,
        }),
      );

      const adapter = new CodexAdapter();
      const result = await adapter.execute({
        prompt: 'hi',
        context: { workingDirectory: '/tmp/project' },
        constraints: { signal: abortedController().signal },
      });

      expect(result.status).toBe('error');
      // Codex records the cancel error in metadata.rawEvents[0].error.
      const rawEvents = result.metadata.rawEvents as Array<{ error?: string }> | undefined;
      expect(rawEvents?.[0]?.error).toMatch(/SIGTERM/);
    });
  });

  describe('ClaudeCodeAdapter.execute', () => {
    it('forwards the AbortSignal to execa when a model override is set', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      } as any);

      const adapter = new ClaudeCodeAdapter();
      const controller = new AbortController();

      await adapter.execute({
        prompt: 'hi',
        context: { workingDirectory: '/tmp/project' },
        constraints: { signal: controller.signal, model: 'claude-sonnet-4-7' },
      });

      const call = mockExeca.mock.calls.at(-1);
      expect(call).toBeDefined();
      const options = call![2] as { cancelSignal?: AbortSignal };
      expect(options.cancelSignal).toBe(controller.signal);
    });
  });
});
