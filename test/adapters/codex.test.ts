import { vi, describe, it, expect, beforeEach } from 'vitest';
import { readFileSync as realReadFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ModelId } from '../../src/workflow/models.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mock execa at the module level
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

// Mock fs functions used by the adapter
// We need to keep the real readFileSync for loading fixtures, but mock everything
// the adapter uses.
const mockMkdtempSync = vi.fn(() => '/tmp/codex-mock');
const mockWriteFileSync = vi.fn();
const mockExistsSync = vi.fn(() => false);
const mockAdapterReadFileSync = vi.fn();

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdtempSync: (...args: any[]) => mockMkdtempSync(...args),
    writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
    existsSync: (...args: any[]) => mockExistsSync(...args),
    readFileSync: (...args: any[]) => {
      // If called with a path under fixtures, use real fs
      const path = args[0] as string;
      if (typeof path === 'string' && path.includes('fixtures')) {
        return actual.readFileSync(...(args as Parameters<typeof actual.readFileSync>));
      }
      // Otherwise, delegate to mock (adapter reading output files)
      return mockAdapterReadFileSync(...args);
    },
  };
});

// Import after mock setup
const { execa } = await import('execa');
const mockExeca = vi.mocked(execa);

const { CodexAdapter } = await import('../../src/adapters/codex.js');

// Load fixtures using the real readFileSync
const successFixture = realReadFileSync(
  join(__dirname, 'fixtures/codex-success.jsonl'),
  'utf-8',
);
const errorFixture = realReadFileSync(
  join(__dirname, 'fixtures/codex-error.jsonl'),
  'utf-8',
);

describe('CodexAdapter', () => {
  let adapter: InstanceType<typeof CodexAdapter>;

  beforeEach(() => {
    adapter = new CodexAdapter();
    vi.clearAllMocks();
    // Reset default for existsSync
    mockExistsSync.mockReturnValue(false);
  });

  describe('properties', () => {
    it('has correct name', () => {
      expect(adapter.name).toBe('codex');
    });

    it('supports json schema', () => {
      expect(adapter.supportsJsonSchema).toBe(true);
    });

    it('advertises native tool-loop support for captain mode', () => {
      expect(adapter.captainCapabilities?.supportsToolLoop).toBe(true);
      expect(adapter.captainCapabilities?.supportsStructuredDecisions).toBe(true);
      expect(adapter.captainCapabilities?.supportsPauseForUserInput).toBe(true);
    });

    it('has expected capabilities', () => {
      expect(adapter.capabilities).toContain('implement');
      expect(adapter.capabilities).toContain('review');
      expect(adapter.capabilities).toContain('refactor');
    });
  });

  describe('getCliVersionTag', () => {
    it('extracts semantic version from codex --version output', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: 'codex 0.120.0',
        stderr: '',
        exitCode: 0,
      } as any);

      const tag = await adapter.getCliVersionTag();
      expect(tag).toBe('codex@0.120.0');
    });

    it('falls back to parsing --help when --version does not provide a version', async () => {
      mockExeca
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
        } as any)
        .mockResolvedValueOnce({
          stdout: 'codex v0.121.2',
          stderr: '',
          exitCode: 0,
        } as any);

      const tag = await adapter.getCliVersionTag();
      expect(tag).toBe('codex@0.121.2');
    });
  });

  describe('executeWithTools', () => {
    it('runs tool calls and completes when the controller emits finish', async () => {
      const schemaSpy = vi
        .spyOn(adapter, 'executeWithSchema')
        .mockResolvedValueOnce({
          type: 'tool_call',
          tool: 'run_decompose',
          input: {},
          reasoning: 'decompose first',
        } as any)
        .mockResolvedValueOnce({
          type: 'finish',
          output: 'done',
          reasoning: 'workflow complete',
        } as any);

      const onToolCall = vi.fn(async () => ({ output: { ok: true } }));

      const result = await adapter.executeWithTools(
        [
          {
            name: 'run_decompose',
            description: 'decompose request',
            inputSchema: { type: 'object' },
          },
        ],
        [{ role: 'system', content: 'start' }],
        onToolCall,
      );

      expect(schemaSpy).toHaveBeenCalledTimes(2);
      expect(onToolCall).toHaveBeenCalledTimes(1);
      expect(onToolCall).toHaveBeenCalledWith({ name: 'run_decompose', input: {} });
      expect(result.status).toBe('completed');
      expect(result.output).toBe('done');
      expect(result.transcript.some((message) => message.role === 'tool')).toBe(true);
    });

    it('caps transcript context to avoid unbounded prompt growth', async () => {
      const schemaSpy = vi
        .spyOn(adapter, 'executeWithSchema')
        .mockResolvedValueOnce({
          type: 'finish',
          output: 'done',
          reasoning: 'workflow complete',
        } as any);

      const longContent = 'x'.repeat(3000);
      const manyMessages = Array.from({ length: 30 }, (_, i) => ({
        role: 'assistant' as const,
        content: `${i}:${longContent}`,
      }));

      await adapter.executeWithTools(
        [
          {
            name: 'run_decompose',
            description: 'decompose request',
            inputSchema: { type: 'object' },
          },
        ],
        manyMessages,
        vi.fn(async () => ({ output: { ok: true } })),
      );

      const prompt = schemaSpy.mock.calls[0][0];
      expect(prompt).toContain('omitted 6 earlier transcript messages');
      expect(prompt).not.toContain(`${'x'.repeat(2000)}`);
    });

    it('returns interrupted and skips prompt-loop fallback when signal is already aborted', async () => {
      const executeWithSchemaSpy = vi.spyOn(adapter, 'executeWithSchema');
      vi.spyOn(adapter as any, 'executeWithResumeSession').mockRejectedValueOnce(
        new Error('resume session failed'),
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

  describe('execute', () => {
    it('parses JSONL output successfully', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: successFixture,
        stderr: '',
        exitCode: 0,
      } as any);

      const result = await adapter.execute({
        prompt: 'Review the DatePicker component',
        context: { workingDirectory: '/tmp/project' },
      });

      expect(result.status).toBe('success');
      expect(result.output).toContain('Review Findings');
      expect(result.metadata.rawEvents).toBeDefined();
      expect(Array.isArray(result.metadata.rawEvents)).toBe(true);
    });

    it('extracts file changes from events', async () => {
      // Create JSONL with actual file changes (action != "none")
      const jsonlWithChanges = [
        '{"type":"thread.started","thread_id":"thread_123"}',
        '{"type":"item.file_change","path":"src/foo.ts","action":"modified"}',
        '{"type":"item.file_change","path":"src/bar.ts","action":"created"}',
        '{"type":"item.file_change","path":"src/baz.ts","action":"none"}',
        '{"type":"item.agent_message","content":"Done"}',
        '{"type":"turn.completed","turn_id":"turn_1"}',
      ].join('\n');

      mockExeca.mockResolvedValueOnce({
        stdout: jsonlWithChanges,
        stderr: '',
        exitCode: 0,
      } as any);

      const result = await adapter.execute({
        prompt: 'Modify files',
        context: { workingDirectory: '/tmp/project' },
      });

      // action="none" should be excluded
      expect(result.filesModified).toEqual(['src/foo.ts', 'src/bar.ts']);
    });

    it('handles error events', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: errorFixture,
        stderr: '',
        exitCode: 1,
      } as any);

      const result = await adapter.execute({
        prompt: 'Do something that fails',
        context: { workingDirectory: '/tmp/project' },
      });

      expect(result.status).toBe('error');
      expect(result.output).toContain('Authentication failed');
    });

    it('handles empty stdout', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: '',
        stderr: 'Some error',
        exitCode: 1,
      } as any);

      const result = await adapter.execute({
        prompt: 'Do something',
        context: { workingDirectory: '/tmp/project' },
      });

      expect(result.status).toBe('error');
      expect(result.output).toContain('Some error');
    });

    it('reads output from output file when available', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: successFixture,
        stderr: '',
        exitCode: 0,
      } as any);

      mockExistsSync.mockReturnValue(true);
      mockAdapterReadFileSync.mockReturnValueOnce('Output from file');

      const result = await adapter.execute({
        prompt: 'Do something',
        context: { workingDirectory: '/tmp/project' },
      });

      expect(result.output).toBe('Output from file');
    });

    it('handles process-level errors', async () => {
      mockExeca.mockRejectedValueOnce(new Error('Process killed'));

      const result = await adapter.execute({
        prompt: 'Do something',
        context: { workingDirectory: '/tmp/project' },
      });

      expect(result.status).toBe('error');
      expect(result.metadata.rawEvents).toBeDefined();
    });

    it('passes --model when specified in task constraints', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: successFixture,
        stderr: '',
        exitCode: 0,
      } as any);

      await adapter.execute({
        prompt: 'Review code with model override',
        context: { workingDirectory: '/tmp/project' },
        constraints: { model: ModelId.GPT_MINI },
      });

      const callArgs = mockExeca.mock.calls[0];
      const cliArgs = callArgs[1] as string[];
      expect(cliArgs).toContain('--model');
      expect(cliArgs[cliArgs.indexOf('--model') + 1]).toBe(ModelId.GPT_MINI);
    });
  });

  describe('healthCheck', () => {
    it('returns available when codex --help succeeds', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: 'codex v0.5.2\nUsage: codex [options]',
        stderr: '',
        exitCode: 0,
      } as any);

      const result = await adapter.healthCheck();

      expect(result.available).toBe(true);
      expect(result.version).toBe('0.5.2');
    });

    it('returns unavailable when codex not found', async () => {
      mockExeca.mockRejectedValueOnce(new Error('ENOENT'));

      const result = await adapter.healthCheck();

      expect(result.available).toBe(false);
      expect(result.authenticated).toBe(false);
      expect(result.error).toBe('Codex CLI not found');
    });

    it('returns unavailable when --help fails', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: '',
        stderr: 'unknown command',
        exitCode: 1,
      } as any);

      const result = await adapter.healthCheck();

      expect(result.available).toBe(false);
      expect(result.error).toContain('unknown command');
    });
  });
});
