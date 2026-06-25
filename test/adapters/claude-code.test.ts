import { vi, describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { PassThrough, Readable, Writable } from 'stream';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { ModelId } from '../../src/workflow/models.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mock execa at the module level
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

// Import after mock setup
const { execa } = await import('execa');
const mockExeca = vi.mocked(execa);

const { ClaudeCodeAdapter } = await import('../../src/adapters/claude-code.js');
const { logger } = await import('../../src/utils/logger.js');

// Load fixtures
const successFixture = readFileSync(
  join(__dirname, 'fixtures/claude-success.json'),
  'utf-8',
);
const errorFixture = readFileSync(
  join(__dirname, 'fixtures/claude-error.json'),
  'utf-8',
);
const structuredFixture = readFileSync(
  join(__dirname, 'fixtures/claude-structured.json'),
  'utf-8',
);

class ErroringWritable extends Writable {
  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.emit('error', new Error('EPIPE'));
    callback();
  }
}

describe('ClaudeCodeAdapter', () => {
  let adapter: InstanceType<typeof ClaudeCodeAdapter>;

  beforeEach(() => {
    adapter = new ClaudeCodeAdapter();
    vi.clearAllMocks();
  });

  describe('properties', () => {
    it('has correct name', () => {
      expect(adapter.name).toBe('claude-code');
    });

    it('supports json schema', () => {
      expect(adapter.supportsJsonSchema).toBe(true);
    });

    it('recognizes Claude CLI model aliases and full model IDs', () => {
      expect(adapter.recognizesModel(ModelId.CLAUDE_SONNET)).toBe(true);
      expect(adapter.recognizesModel(ModelId.CLAUDE_OPUS)).toBe(true);
      expect(adapter.recognizesModel('claude-sonnet-4-7')).toBe(true);
      expect(adapter.recognizesModel(ModelId.GPT)).toBe(false);
    });

    it('exposes captain capabilities (structured decisions and native tool-loop support)', () => {
      expect(adapter.captainCapabilities?.supportsToolLoop).toBe(true);
      expect(adapter.captainCapabilities?.supportsStructuredDecisions).toBe(true);
      expect(adapter.captainCapabilities?.supportsPauseForUserInput).toBe(true);
    });

    it('declares default strengths', () => {
      expect(adapter.strengths).toEqual([
        'deep-reasoning',
        'code-review',
        'refactoring',
        'technical-writing',
      ]);
    });

    it('declares useWhen routing guidance', () => {
      expect(adapter.useWhen).toBe(
        'Prefer when correctness and judgment matter most — reviews, careful refactors, specs, and writing. The most rigorous, not the fastest.',
      );
    });

    it('omits defaultEffort (no native reasoning-effort knob today)', () => {
      // Wiring is staged: the per-machine agents.json still accepts
      // an effort value for claude-code, but the adapter currently
      // ignores it. When/if the CLI gains a thinking-budget flag,
      // declare defaultEffort here and translate in execute().
      expect(adapter.defaultEffort).toBeUndefined();
    });
  });

  describe('getCliVersionTag', () => {
    it('extracts semantic version from --version output', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: 'claude-code 2.1.108',
        stderr: '',
        exitCode: 0,
      } as any);

      const tag = await adapter.getCliVersionTag();
      expect(tag).toBe('claude-code@2.1.108');
    });
  });

  describe('execute', () => {
    it('passes the composed prompt through claude stdin', async () => {
      const composedPrompt = '## Peer messages\n\nforwarded context\nactual task';
      mockExeca.mockResolvedValueOnce({
        stdout: successFixture,
        stderr: '',
        exitCode: 0,
      } as any);

      await adapter.execute({
        prompt: composedPrompt,
        context: { workingDirectory: '/tmp/project' },
      });

      const args = mockExeca.mock.calls[0]?.[1] as string[];
      expect(args[0]).toBe('-p');
      expect(args[1]).toBe('-');
      expect(args).not.toContain(composedPrompt);
      expect(mockExeca.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
        input: composedPrompt,
      }));
    });

    it('handles a large prompt over stdin without argv byte-guard failure', async () => {
      const largePrompt = 'x'.repeat(150 * 1024);
      mockExeca.mockResolvedValueOnce({
        stdout: successFixture,
        stderr: '',
        exitCode: 0,
      } as any);

      const result = await adapter.execute({
        prompt: largePrompt,
        context: { workingDirectory: '/tmp/project' },
      });

      expect(result.status).toBe('success');
      const args = mockExeca.mock.calls[0]?.[1] as string[];
      expect(args).not.toContain(largePrompt);
      expect(mockExeca.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
        input: largePrompt,
      }));
    });

    it('parses successful JSON output', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: successFixture,
        stderr: '',
        exitCode: 0,
      } as any);

      const result = await adapter.execute({
        prompt: 'Create a DatePicker component',
        context: { workingDirectory: '/tmp/project' },
      });

      expect(result.status).toBe('success');
      expect(result.output).toContain('DatePicker');
      expect(result.sessionId).toBe('session-abc-123-def-456');
      expect(result.metadata.costUsd).toBe(0.087);
      expect(result.metadata.durationMs).toBe(45200);
      expect(result.metadata.numTurns).toBe(8);
      expect(result.filesModified).toEqual([
        'src/components/DatePicker/DatePicker.tsx',
        'src/components/DatePicker/DatePicker.test.tsx',
        'src/components/DatePicker/index.ts',
      ]);
    });

    it('handles error responses', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: errorFixture,
        stderr: '',
        exitCode: 0,
      } as any);

      const result = await adapter.execute({
        prompt: 'Read nonexistent file',
        context: { workingDirectory: '/tmp/project' },
      });

      expect(result.status).toBe('error');
      expect(result.output).toContain('Unable to read the file');
      expect(result.sessionId).toBe('session-err-789');
      expect(result.metadata.costUsd).toBe(0.003);
    });

    it('classifies provider-coded rate-limit errors', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: JSON.stringify({
          type: 'result',
          subtype: 'error',
          is_error: true,
          result: 'too many requests',
          session_id: 'session-rate-limit',
          api_error_status: 429,
          terminal_reason: 'rate_limited',
        }),
        stderr: '',
        exitCode: 0,
      } as any);

      const result = await adapter.execute({
        prompt: 'Do something',
        context: { workingDirectory: '/tmp/project' },
      });

      expect(result.status).toBe('error');
      expect(result.failure).toMatchObject({
        kind: 'rate_limited',
        confidence: 'high',
        providerCode: '429',
        recommendation: 'backoff',
      });
    });

    it('handles CLI crash with empty stdout and non-zero exit', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: '',
        stderr: 'Segmentation fault',
        exitCode: 139,
      } as any);

      const result = await adapter.execute({
        prompt: 'Do something',
        context: { workingDirectory: '/tmp/project' },
      });

      expect(result.status).toBe('error');
      expect(result.output).toContain('Segmentation fault');
      expect(result.filesModified).toEqual([]);
    });

    it('handles timeout when execa rejects', async () => {
      const timeoutError = new Error('Timed out');
      timeoutError.name = 'TimeoutError';
      mockExeca.mockRejectedValueOnce(timeoutError);

      const result = await adapter.execute({
        prompt: 'Long running task',
        context: { workingDirectory: '/tmp/project' },
        constraints: { timeout: 1000 },
      });

      expect(result.status).toBe('error');
      expect(result.metadata.rawEvents).toBeDefined();
    });

    it('preserves partial streaming output when the process throws after emitting stdout', async () => {
      const streamingError = Object.assign(new Error('Timed out'), {
        stdout: JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Partial assistant output' }],
          },
        }),
        stderr: 'deadline exceeded',
      });
      mockExeca.mockRejectedValueOnce(streamingError);

      const result = await adapter.execute({
        prompt: 'Long running task',
        context: { workingDirectory: '/tmp/project' },
        onOutput: vi.fn(),
      });

      expect(result.status).toBe('error');
      expect(result.output).toContain('Partial assistant output');
      expect(result.metadata.rawEvents?.[0]).toMatchObject({
        error: 'Timed out',
        rawStderr: 'deadline exceeded',
      });
    });

    it('does not crash when execa returns undefined stdout (cancellation edge case)', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: undefined,
        stderr: undefined,
        exitCode: 143,
      } as any);

      const result = await adapter.execute({
        prompt: 'Do something',
        context: { workingDirectory: '/tmp/project' },
      });

      expect(result.status).toBe('error');
    });

    it('handles JSON parse errors', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: 'not valid json {{{',
        stderr: '',
        exitCode: 0,
      } as any);

      const result = await adapter.execute({
        prompt: 'Do something',
        context: { workingDirectory: '/tmp/project' },
      });

      expect(result.status).toBe('error');
      expect(result.metadata.rawEvents).toBeDefined();
    });

    it('passes correct CLI flags including --max-turns', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: successFixture,
        stderr: '',
        exitCode: 0,
      } as any);

      await adapter.execute({
        prompt: 'Test prompt',
        context: { workingDirectory: '/tmp/project' },
        constraints: { maxTurns: 5, timeout: 60000 },
      });

      expect(mockExeca).toHaveBeenCalledWith(
        'claude',
        [
          '-p',
          '-',
          '--output-format',
          'json',
          '--dangerously-skip-permissions',
          '--max-turns',
          '5',
        ],
        expect.objectContaining({
          cwd: '/tmp/project',
          timeout: 60000,
          reject: false,
          input: 'Test prompt',
        }),
      );
    });

    it('passes --model when specified in task constraints', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: successFixture,
        stderr: '',
        exitCode: 0,
      } as any);

      await adapter.execute({
        prompt: 'Test model override',
        context: { workingDirectory: '/tmp/project' },
        constraints: { model: ModelId.CLAUDE_SONNET },
      });

      const callArgs = mockExeca.mock.calls[0];
      const cliArgs = callArgs[1] as string[];
      expect(cliArgs).toContain('--model');
      expect(cliArgs[cliArgs.indexOf('--model') + 1]).toBe(ModelId.CLAUDE_SONNET);
    });
  });

  describe('executeWithSchema', () => {
    it('returns validated structured output', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: structuredFixture,
        stderr: '',
        exitCode: 0,
      } as any);

      const TaskSchema = z.object({
        reasoning: z.string(),
        tasks: z.array(
          z.object({
            id: z.string(),
            description: z.string(),
          }),
        ),
        suggestedOrder: z.array(z.string()),
      });

      const result = await adapter.executeWithSchema(
        'Plan the implementation',
        TaskSchema,
        { workingDirectory: '/tmp/project' },
      );

      expect(result.reasoning).toBe(
        'Single component with clear implementation and review phases.',
      );
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].id).toBe('task-1');
      expect(result.suggestedOrder).toEqual(['task-1']);
    });

    it('passes --json-schema, --system-prompt, and --tools flags for isolation', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: structuredFixture,
        stderr: '',
        exitCode: 0,
      } as any);

      const schema = z.object({
        reasoning: z.string(),
        tasks: z.array(z.object({ id: z.string(), description: z.string() })),
        suggestedOrder: z.array(z.string()),
      });

      await adapter.executeWithSchema('Plan tasks', schema);

      const callArgs = mockExeca.mock.calls[0];
      const cliArgs = callArgs[1] as string[];
      expect(callArgs[0]).toBe('claude');
      expect(cliArgs).toContain('--json-schema');
      expect(cliArgs).toContain('--system-prompt');
      expect(cliArgs).toContain('--tools');
      // Tools should be disabled (empty string)
      expect(cliArgs[cliArgs.indexOf('--tools') + 1]).toBe('');
      expect(cliArgs).not.toContain('--bare');
    });

    it('produces valid JSON schema with type field', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: structuredFixture,
        stderr: '',
        exitCode: 0,
      } as any);

      const schema = z.object({
        reasoning: z.string(),
        tasks: z.array(z.object({ id: z.string(), description: z.string() })),
        suggestedOrder: z.array(z.string()),
      });

      await adapter.executeWithSchema('Plan tasks', schema);

      const callArgs = mockExeca.mock.calls[0];
      const schemaIndex = (callArgs[1] as string[]).indexOf('--json-schema');
      const jsonSchemaArg = (callArgs[1] as string[])[schemaIndex + 1];
      const parsed = JSON.parse(jsonSchemaArg);
      expect(parsed.type).toBe('object');
      expect(parsed.properties).toBeDefined();
      expect(parsed.properties.reasoning).toEqual({ type: 'string' });
      expect(parsed.properties.tasks.type).toBe('array');
    });

    it('throws on error response', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: errorFixture,
        stderr: '',
        exitCode: 0,
      } as any);

      const schema = z.object({ result: z.string() });

      await expect(
        adapter.executeWithSchema('Do something', schema),
      ).rejects.toThrow('Claude returned an error');
    });

    it('falls back to parsing result when structured_output is missing', async () => {
      const responseWithoutStructured = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: JSON.stringify({
          reasoning: 'Fallback path works.',
          tasks: [{ id: 'task-1', description: 'Test fallback' }],
          suggestedOrder: ['task-1'],
        }),
        session_id: 'session-fallback',
        is_error: false,
      });

      mockExeca.mockResolvedValueOnce({
        stdout: responseWithoutStructured,
        stderr: '',
        exitCode: 0,
      } as any);

      const TaskSchema = z.object({
        reasoning: z.string(),
        tasks: z.array(
          z.object({ id: z.string(), description: z.string() }),
        ),
        suggestedOrder: z.array(z.string()),
      });

      const result = await adapter.executeWithSchema(
        'Plan tasks',
        TaskSchema,
      );

      expect(result.reasoning).toBe('Fallback path works.');
      expect(result.tasks[0].id).toBe('task-1');
    });

    it('throws descriptive error when neither structured_output nor result has JSON', async () => {
      const responseNoJson = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'Here is some plain text, not JSON at all.',
        session_id: 'session-nojson',
        is_error: false,
      });

      mockExeca.mockResolvedValueOnce({
        stdout: responseNoJson,
        stderr: '',
        exitCode: 0,
      } as any);

      const schema = z.object({ value: z.string() });

      await expect(
        adapter.executeWithSchema('Do something', schema),
      ).rejects.toThrow('Claude returned no structured_output and could not extract JSON from result');
    });

    it('throws when stdout is empty', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: '',
        stderr: 'crash',
        exitCode: 1,
      } as any);

      const schema = z.object({ result: z.string() });

      await expect(
        adapter.executeWithSchema('Do something', schema),
      ).rejects.toThrow('Claude CLI returned no output');
    });

    it('passes --model in executeWithSchema when provided', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: structuredFixture,
        stderr: '',
        exitCode: 0,
      } as any);

      const schema = z.object({
        reasoning: z.string(),
        tasks: z.array(z.object({ id: z.string(), description: z.string() })),
        suggestedOrder: z.array(z.string()),
      });

      await adapter.executeWithSchema('Plan tasks', schema, {
        model: ModelId.CLAUDE_SONNET,
      });

      const callArgs = mockExeca.mock.calls[0];
      const cliArgs = callArgs[1] as string[];
      expect(cliArgs).toContain('--model');
      expect(cliArgs[cliArgs.indexOf('--model') + 1]).toBe(ModelId.CLAUDE_SONNET);
    });
  });

  describe('executeWithTools', () => {
    it('falls back from the latest transcript after stream-session failure', async () => {
      const executeWithSchemaSpy = vi
        .spyOn(adapter, 'executeWithSchema')
        .mockResolvedValueOnce({
          type: 'finish',
          output: 'done',
          reasoning: 'workflow complete',
        } as any);

      vi.spyOn(adapter as any, 'executeWithStreamSession').mockImplementationOnce(
        async (_tools: any, messages: any, _onToolCall: any, context: any) => {
          context.onTranscriptUpdate?.([
            ...messages,
            {
              role: 'assistant',
              content: JSON.stringify({
                type: 'tool_call',
                tool: 'run_decompose',
                input: {},
              }),
            },
            {
              role: 'tool',
              name: 'run_decompose',
              content: JSON.stringify({ ok: true }),
            },
          ]);
          throw new Error('stream path failed');
        },
      );

      const result = await adapter.executeWithTools(
        [
          {
            name: 'run_decompose',
            description: 'decompose request',
            inputSchema: { type: 'object' },
          },
        ],
        [{ role: 'system', content: 'start' }],
        vi.fn(async () => ({ output: { ok: true } })),
        {
          toolNamespace: 'mcp__crew__',
          toolSchemaHash: 'abc',
        },
      );

      expect(result.status).toBe('completed');
      expect(executeWithSchemaSpy).toHaveBeenCalledTimes(1);
      const fallbackPrompt = executeWithSchemaSpy.mock.calls[0][0];
      expect(fallbackPrompt).toContain('"tool":"run_decompose"');
      expect(fallbackPrompt).toContain('"ok":true');
    });

    it('returns interrupted and skips prompt-loop fallback when signal is already aborted', async () => {
      const executeWithSchemaSpy = vi.spyOn(adapter, 'executeWithSchema');
      vi.spyOn(adapter as any, 'executeWithStreamSession').mockRejectedValueOnce(
        new Error('stateful path failed'),
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

    it('handles stream-session stdin errors during prompt writes', async () => {
      vi.spyOn(adapter, 'getCliVersionTag').mockResolvedValueOnce('claude-code@2.1.108');
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const stdin = new ErroringWritable();
      const subprocess = Object.assign(
        Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
        {
          stdin,
          stdout: Readable.from([
            `${JSON.stringify({
              type: 'assistant',
              message: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      type: 'finish',
                      output: 'done',
                      reasoning: 'workflow complete',
                    }),
                  },
                ],
              },
            })}\n`,
            `${JSON.stringify({ type: 'result' })}\n`,
          ]),
          stderr: new PassThrough(),
          on: vi.fn(),
          once: vi.fn(),
          off: vi.fn(),
        },
      );
      mockExeca.mockReturnValueOnce(subprocess as any);

      const result = await (adapter as any).executeWithStreamSession(
        [],
        [{ role: 'system', content: 'start' }],
        vi.fn(async () => ({ output: { ok: true } })),
        {
          workingDirectory: '/tmp/project',
          toolNamespace: 'mcp__crew__',
          toolSchemaHash: 'abc',
        },
      );

      expect(result.status).toBe('completed');
      expect(result.output).toBe('done');
      expect(warnSpy).toHaveBeenCalledWith(
        '[adapter:claude-code] stdin error',
        expect.objectContaining({ message: 'EPIPE' }),
      );
      warnSpy.mockRestore();
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
  });

  describe('healthCheck', () => {
    it('returns available when version and auth succeed', async () => {
      // First call: --version
      mockExeca.mockResolvedValueOnce({
        stdout: 'claude 1.0.12',
        stderr: '',
        exitCode: 0,
      } as any);

      // Second call: auth check
      mockExeca.mockResolvedValueOnce({
        stdout: '{"type":"result","subtype":"success","result":"OK","is_error":false}',
        stderr: '',
        exitCode: 0,
      } as any);

      const result = await adapter.healthCheck();

      expect(result.available).toBe(true);
      expect(result.authenticated).toBe(true);
      expect(result.version).toBe('claude 1.0.12');
    });

    it('returns unavailable when CLI not found', async () => {
      mockExeca.mockRejectedValueOnce(new Error('ENOENT'));

      const result = await adapter.healthCheck();

      expect(result.available).toBe(false);
      expect(result.authenticated).toBe(false);
      expect(result.error).toBe('Claude CLI not found');
    });

    it('returns not authenticated when auth check fails and prefers stdout error payload', async () => {
      // First call: --version succeeds
      mockExeca.mockResolvedValueOnce({
        stdout: 'claude 1.0.12',
        stderr: '',
        exitCode: 0,
      } as any);

      // Second call: auth fails with warning in stderr and real error in JSON stdout
      mockExeca.mockResolvedValueOnce({
        stdout: '{"type":"result","subtype":"error","result":"Not logged in · Please run /login","is_error":true}',
        stderr: 'Warning: no stdin data received in 3s',
        exitCode: 1,
      } as any);

      const result = await adapter.healthCheck();

      expect(result.available).toBe(true);
      expect(result.version).toBe('claude 1.0.12');
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain('Not logged in');

      const authCheckCall = mockExeca.mock.calls[1];
      expect(authCheckCall[2]).toEqual(expect.objectContaining({ stdin: 'ignore' }));
    });
  });
});
