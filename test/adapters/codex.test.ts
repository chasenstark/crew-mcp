import { vi, describe, it, expect, beforeEach } from 'vitest';
import { readFileSync as realReadFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PassThrough } from 'stream';
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

function createStreamingCodexProcess({
  chunks,
  stderr = '',
  exitCode = 0,
}: {
  chunks: string[];
  stderr?: string;
  exitCode?: number;
}) {
  const stdout = new PassThrough();
  const fullStdout = chunks.join('');
  const subprocess = new Promise((resolve) => {
    stdout.once('end', () => {
      resolve({
        stdout: fullStdout,
        stderr,
        exitCode,
      });
    });

    queueMicrotask(() => {
      if (chunks.length === 0) {
        stdout.end();
        return;
      }

      for (const chunk of chunks.slice(0, -1)) {
        stdout.write(chunk);
      }
      stdout.end(chunks[chunks.length - 1]);
    });
  }) as Promise<any> & { stdout: PassThrough };

  subprocess.stdout = stdout;
  return subprocess;
}

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

    it('exposes captain capabilities including native tool-loop support', () => {
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

    it('returns undefined when --version exits non-zero', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: '',
        stderr: 'command not found',
        exitCode: 127,
      } as any);

      const tag = await adapter.getCliVersionTag();
      expect(tag).toBeUndefined();
    });

    it('returns undefined when --version emits output without a version match', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      } as any);

      const tag = await adapter.getCliVersionTag();
      expect(tag).toBeUndefined();
    });
  });

  describe('executeWithTools', () => {
    it('runs tool calls and completes when the controller emits finish', async () => {
      // executeWithTools now routes through the codex-private
      // executeDecisionTurn (which adds thread-continuity via
      // `codex exec resume <id>` on follow-up inner turns). Mock that
      // helper to return scripted decisions + a stable thread id.
      const schemaSpy = vi
        .spyOn(adapter as any, 'executeDecisionTurn')
        .mockResolvedValueOnce({
          decision: {
            type: 'tool_call',
            tool: 'run_decompose',
            input: JSON.stringify({}),
            reasoning: 'decompose first',
            output: null,
            error: null,
          },
          threadId: 'thread-1',
        })
        .mockResolvedValueOnce({
          decision: {
            type: 'finish',
            output: 'done',
            reasoning: 'workflow complete',
            tool: null,
            input: null,
            error: null,
          },
          threadId: 'thread-1',
        });

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
      const decisionSpy = vi
        .spyOn(adapter as any, 'executeDecisionTurn')
        .mockResolvedValueOnce({
          decision: {
            type: 'finish',
            output: 'done',
            reasoning: 'workflow complete',
            tool: null,
            input: null,
            error: null,
          },
          threadId: 'thread-1',
        });

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

      const prompt = decisionSpy.mock.calls[0][0];
      expect(prompt).toContain('omitted 6 earlier transcript messages');
      expect(prompt).not.toContain(`${'x'.repeat(2000)}`);
    });

    it('passes a windowed transcript to executeDecisionTurn when the input transcript is long', async () => {
      // Post-option-A: executeWithTools routes through executeWithPromptLoop
      // which calls executeDecisionTurn per inner turn. This test asserts
      // that buildDecisionPrompt's transcript window is still applied when
      // the adapter's entry point receives a long message log.
      vi.spyOn(adapter, 'getCliVersionTag').mockResolvedValue('codex@0.120.0');
      const executeWithSchemaSpy = vi
        .spyOn(adapter as any, 'executeDecisionTurn')
        .mockResolvedValueOnce({
          decision: {
            type: 'finish',
            output: 'done',
            reasoning: 'workflow complete',
            tool: null,
            input: null,
            error: null,
          },
          threadId: 'thread-1',
        });

      const longContent = 'x'.repeat(3000);
      const manyMessages = Array.from({ length: 30 }, (_, i) => ({
        role: 'assistant' as const,
        content: `message-${String(i).padStart(2, '0')}-${longContent}`,
      }));

      const result = await adapter.executeWithTools(
        [
          {
            name: 'run_decompose',
            description: 'decompose request',
            inputSchema: { type: 'object' },
          },
        ],
        manyMessages,
        vi.fn(async () => ({ output: { ok: true } })),
        {
          workingDirectory: '/tmp/project',
          toolNamespace: 'mcp__crew__',
          toolSchemaHash: 'abc',
        },
      );

      expect(result.status).toBe('completed');
      expect(executeWithSchemaSpy).toHaveBeenCalled();
      const prompt = executeWithSchemaSpy.mock.calls[0][0] as string;
      expect(prompt).toContain('omitted 6 earlier transcript messages');
      expect(prompt).not.toContain('message-00-');
      expect(prompt).toContain('message-29-');
    });

    it('returns interrupted and skips executeDecisionTurn when signal is already aborted', async () => {
      // Post-option-A: the abort-before-fallback invariant still holds via
      // executePromptToolLoop's top-of-loop signal check — if the signal is
      // already aborted when the loop starts, the decision call never fires.
      const executeWithSchemaSpy = vi.spyOn(adapter as any, 'executeDecisionTurn');

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

    it('omits --output-schema on resumed decision turns', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: [
          '{"type":"thread.started","thread_id":"thread-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"type\\":\\"finish\\",\\"output\\":\\"done\\"}"}}',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      } as any);
      mockExistsSync.mockReturnValue(true);
      mockAdapterReadFileSync.mockReturnValueOnce('{"type":"finish","output":"done"}');

      const result = await (adapter as any).executeDecisionTurn('Choose next step.', {
        threadId: 'thread-1',
        workingDirectory: '/tmp/project',
      });

      const cliArgs = mockExeca.mock.calls[0][1] as string[];
      expect(cliArgs).toEqual([
        'exec',
        'resume',
        '--json',
        '--skip-git-repo-check',
        '--ignore-rules',
        '--output-last-message',
        '/tmp/codex-mock/output.json',
        'thread-1',
        'Choose next step.',
      ]);
      expect(cliArgs).not.toContain('--output-schema');
      expect(result.decision).toMatchObject({
        type: 'finish',
        output: 'done',
      });
      expect(result.threadId).toBe('thread-1');
    });

    it('uses read-only isolated flags on structured seed decision turns', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: '{"type":"thread.started","thread_id":"thread-1"}',
        stderr: '',
        exitCode: 0,
      } as any);
      mockExistsSync.mockReturnValue(true);
      mockAdapterReadFileSync.mockReturnValueOnce('{"type":"finish","output":"done"}');

      await (adapter as any).executeDecisionTurn('Choose next step.', {
        workingDirectory: '/tmp/project',
      });

      const cliArgs = mockExeca.mock.calls[0][1] as string[];
      expect(cliArgs).toContain('--output-schema');
      expect(cliArgs).toContain('--ignore-rules');
      expect(cliArgs.slice(cliArgs.indexOf('--sandbox'), cliArgs.indexOf('--sandbox') + 2)).toEqual([
        '--sandbox',
        'read-only',
      ]);
      expect(cliArgs).not.toContain('resume');
    });

    it('falls back to JSONL assistant decision when Codex skips the output file', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: [
          '{"type":"thread.started","thread_id":"thread-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"type\\":\\"finish\\",\\"output\\":\\"done from jsonl\\"}"}}',
        ].join('\n'),
        stderr: 'Reading additional input from stdin...',
        exitCode: 0,
      } as any);
      mockExistsSync.mockReturnValue(false);

      const result = await (adapter as any).executeDecisionTurn('Choose next step.', {
        workingDirectory: '/tmp/project',
      });

      expect(result.decision).toMatchObject({
        type: 'finish',
        output: 'done from jsonl',
      });
      expect(result.threadId).toBe('thread-1');
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
        '{"type":"item.completed","item":{"type":"file_change","path":"src/foo.ts","action":"modified"}}',
        '{"type":"item.completed","item":{"type":"file_change","path":"src/bar.ts","action":"created"}}',
        '{"type":"item.completed","item":{"type":"file_change","path":"src/baz.ts","action":"none"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}',
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

    it('treats non-object JSONL lines as dropped instead of events', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: [
          '123',
          '"assistant"',
          'null',
          '{"type":"item.completed","item":{"type":"agent_message","text":"Valid event"}}',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      } as any);

      const result = await adapter.execute({
        prompt: 'Handle mixed JSONL',
        context: { workingDirectory: '/tmp/project' },
      });

      expect(result.status).toBe('success');
      expect(result.output).toBe('Valid event');
      expect(result.metadata.droppedLines).toBe(3);
      expect(result.metadata.rawEvents).toEqual([
        { type: 'item.completed', item: { type: 'agent_message', text: 'Valid event' } },
      ]);
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

    it('returns error when codex exits nonzero after emitting parseable JSONL', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: successFixture,
        stderr: 'process failed after partial work',
        exitCode: 17,
      } as any);

      const result = await adapter.execute({
        prompt: 'Do something that partially succeeds then fails',
        context: { workingDirectory: '/tmp/project' },
      });

      expect(result.status).toBe('error');
      expect(result.output).toContain('process failed after partial work');
      expect(result.metadata.rawEvents).toBeDefined();
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

    it('flushes the final unterminated streamed JSONL line', async () => {
      mockExeca.mockReturnValueOnce(createStreamingCodexProcess({
        chunks: ['{"type":"item.completed","item":{"type":"agent_message","text":"Final streamed chunk"}}'],
      }) as any);

      const onOutput = vi.fn();
      const result = await adapter.execute({
        prompt: 'Stream a response',
        context: { workingDirectory: '/tmp/project' },
        onOutput,
      });

      expect(result.status).toBe('success');
      expect(onOutput).toHaveBeenCalledTimes(1);
      expect(onOutput).toHaveBeenCalledWith('Final streamed chunk');
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
    it('returns available when codex --version succeeds', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: 'codex-cli 0.121.0',
        stderr: '',
        exitCode: 0,
      } as any);

      const result = await adapter.healthCheck();

      expect(result.available).toBe(true);
      expect(result.version).toBe('0.121.0');
    });

    it('returns unavailable when codex not found', async () => {
      mockExeca.mockRejectedValueOnce(new Error('ENOENT'));

      const result = await adapter.healthCheck();

      expect(result.available).toBe(false);
      expect(result.authenticated).toBe(false);
      expect(result.error).toBe('Codex CLI not found');
    });

    it('returns unavailable when --version fails', async () => {
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
