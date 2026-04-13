import { vi, describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mock execa at the module level
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

// Import after mock setup
const { execa } = await import('execa');
const mockExeca = vi.mocked(execa);

const { ClaudeCodeAdapter } = await import('../../src/adapters/claude-code.js');

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

    it('has all capabilities', () => {
      expect(adapter.capabilities).toEqual([
        'implement',
        'review',
        'refactor',
        'test',
        'document',
        'analyze',
      ]);
    });
  });

  describe('execute', () => {
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
          'Test prompt',
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
        }),
      );
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

    it('passes --json-schema flag', async () => {
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
      expect(callArgs[0]).toBe('claude');
      expect(callArgs[1]).toContain('--json-schema');
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
      ).rejects.toThrow('Claude returned no structured_output and result is not valid JSON');
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

    it('returns not authenticated when auth check fails', async () => {
      // First call: --version succeeds
      mockExeca.mockResolvedValueOnce({
        stdout: 'claude 1.0.12',
        stderr: '',
        exitCode: 0,
      } as any);

      // Second call: auth fails
      mockExeca.mockResolvedValueOnce({
        stdout: '',
        stderr: 'Not authenticated',
        exitCode: 1,
      } as any);

      const result = await adapter.healthCheck();

      expect(result.available).toBe(true);
      expect(result.version).toBe('claude 1.0.12');
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain('Not authenticated');
    });
  });
});
