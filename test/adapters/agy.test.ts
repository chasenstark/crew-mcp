import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

const { execa } = await import('execa');
const mockExeca = vi.mocked(execa);

const {
  AgyAdapter,
  AGY_MIN_VERSION,
  parseAgyEnvelope,
  isAgyVersionBelowFloor,
  withAgyWorkspacePreamble,
  withAgyReviewPreamble,
} = await import('../../src/adapters/agy.js');
const { AGY_MODEL_LABELS } = await import('../../src/adapters/agy-models.js');

const VALID_MODEL = 'Gemini 3.1 Pro (High)';

/**
 * Build a SUCCESS `--output-format json` envelope stdout line.
 */
function successEnvelope(overrides?: Record<string, unknown>): string {
  return `${JSON.stringify({
    conversation_id: 'conv-1',
    status: 'SUCCESS',
    response: 'hello from agy',
    duration_seconds: 1.5,
    num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, total_tokens: 15 },
    ...overrides,
  })}\n`;
}

function mockOnce(stdout: string, exitCode = 0, stderr = ''): void {
  mockExeca.mockResolvedValueOnce({ stdout, stderr, exitCode } as never);
}

describe('AgyAdapter', () => {
  let adapter: InstanceType<typeof AgyAdapter>;

  beforeEach(() => {
    adapter = new AgyAdapter();
    vi.clearAllMocks();
  });

  describe('capability flags', () => {
    it('refuses in-place read-only, requires a crew worktree, no OS sandbox', () => {
      expect(adapter.enforcesReadOnly).toBe(false);
      expect(adapter.rejectsReadOnly).toBe(true);
      expect(adapter.requiresCrewWorktree).toBe(true);
      expect(adapter.supportsJsonSchema).toBe(false);
      expect(adapter.filesModifiedReliable).toBe(false);
    });

    it('routes reviews through the ephemeral-worktree dispatch mode', () => {
      expect(adapter.reviewDispatchMode).toBe('ephemeral-worktree');
    });

    it('declares ephemeral-review routing without advertising read-only', () => {
      expect(adapter.strengths).toEqual([
        'bulk-implementation',
        'fast-iteration',
        'long-context',
        'code-review',
      ]);
      expect(adapter.useWhen).toContain('ephemeral_review');
      expect(adapter.useWhen).toMatch(/CANNOT run read_only/);
    });
  });

  describe('ephemeral-review dispatch contract', () => {
    it('swaps in the review preamble on reviewIntent — path pin retained, write contract absent', async () => {
      mockOnce(successEnvelope());
      await adapter.execute({
        prompt: 'review these changes',
        context: { workingDirectory: '/crew/review-wt' },
        constraints: { reviewIntent: true, sandbox: 'workspace-write' },
      });
      const [, , options] = mockExeca.mock.calls[0] as [string, string[], { input?: string }];
      const input = options.input ?? '';
      // Review contract replaces the write contract — never stacked.
      expect(input.startsWith('Crew review contract')).toBe(true);
      expect(input).not.toContain('Crew workspace contract');
      expect(input).not.toContain('ONLY writable workspace root');
      // The absolute worktree-root pin is load-bearing (agy locates files by
      // it) and MUST survive the swap.
      expect(input).toContain('/crew/review-wt');
      expect(input).toMatch(/ABSOLUTE paths/);
      // Findings-only behavioral half.
      expect(input).toMatch(/findings/i);
      expect(input).toMatch(/Do NOT create, edit, or delete/);
      // The user prompt follows the contract.
      expect(input.indexOf('Crew review contract')).toBeLessThan(input.indexOf('review these changes'));
    });

    it('keeps the write preamble when reviewIntent is absent', async () => {
      mockOnce(successEnvelope());
      await adapter.execute({
        prompt: 'implement',
        context: { workingDirectory: '/crew/wt' },
        constraints: { sandbox: 'workspace-write' },
      });
      const [, , options] = mockExeca.mock.calls[0] as [string, string[], { input?: string }];
      expect(options.input?.startsWith('Crew workspace contract')).toBe(true);
      expect(options.input).not.toContain('Crew review contract');
    });

    it('still hard-refuses sandbox read-only even with reviewIntent (ephemeral is workspace-write)', async () => {
      const result = await adapter.execute({
        prompt: 'review',
        context: { workingDirectory: '/crew/wt' },
        constraints: { reviewIntent: true, sandbox: 'read-only' },
      });
      expect(result.status).toBe('error');
      expect(result.output).toContain('cannot run read-only');
      expect(mockExeca).not.toHaveBeenCalled();
    });

    it('withAgyReviewPreamble pins the root and never contains the write instruction', () => {
      const text = withAgyReviewPreamble('prompt body', '/abs/root');
      expect(text).toContain('/abs/root');
      expect(text).toMatch(/ABSOLUTE paths/);
      expect(text).not.toContain('ONLY writable workspace root');
      const writeText = withAgyWorkspacePreamble('prompt body', '/abs/root');
      expect(writeText).toContain('ONLY writable workspace root');
    });
  });

  describe('recognizesModel', () => {
    it('matches the pinned labels EXACTLY', () => {
      for (const label of AGY_MODEL_LABELS) {
        expect(adapter.recognizesModel(label)).toBe(true);
      }
    });

    it('never matches on a substring or a non-agy id', () => {
      // Substrings of real labels must NOT match (the bug a loose regex causes).
      expect(adapter.recognizesModel('Gemini 3.1 Pro')).toBe(false);
      expect(adapter.recognizesModel('Claude Opus 4.6')).toBe(false);
      expect(adapter.recognizesModel('GPT-OSS 120B')).toBe(false);
      // Foreign ids that other adapters own must not be claimed.
      expect(adapter.recognizesModel('claude-opus-4-6')).toBe(false);
      expect(adapter.recognizesModel('gpt-5')).toBe(false);
      expect(adapter.recognizesModel('gemini-3.1-pro')).toBe(false);
      expect(adapter.recognizesModel('')).toBe(false);
    });
  });

  describe('write-mode dispatch contract', () => {
    it('builds the expected argv and delivers the prompt on stdin (no -p, no model/timeout when unset)', async () => {
      mockOnce(successEnvelope());
      const result = await adapter.execute({
        prompt: 'implement the thing',
        context: { workingDirectory: '/crew/wt' },
      });

      expect(result.status).toBe('success');
      const [cmd, args, options] = mockExeca.mock.calls[0] as [string, string[], { input?: string; cwd?: string; reject?: boolean; timeout?: number }];
      expect(cmd).toBe('agy');
      expect(args).toEqual([
        '--output-format', 'json',
        '--add-dir', '/crew/wt',
        '--dangerously-skip-permissions',
      ]);
      expect(args).not.toContain('-p');
      expect(args).not.toContain('--print-timeout');
      // Prompt is delivered on stdin, wrapped in the workspace-contract preamble
      // (never argv). The raw prompt survives verbatim; the preamble pins the
      // worktree root so agy writes with absolute paths instead of escaping.
      expect(options.input).toContain('implement the thing');
      expect(options.input).toContain('/crew/wt');
      expect(options.input?.startsWith('Crew workspace contract')).toBe(true);
      expect(args).not.toContain('implement the thing');
      expect(options.cwd).toBe('/crew/wt');
      expect(options.reject).toBe(false);
      expect(options.timeout).toBeUndefined();
    });

    it('wraps the prompt in a workspace-contract preamble pinning the worktree root', async () => {
      mockOnce(successEnvelope());
      await adapter.execute({
        prompt: 'do the work',
        context: { workingDirectory: '/crew/wt-abc' },
      });
      const [, , options] = mockExeca.mock.calls[0] as [string, string[], { input?: string }];
      const input = options.input ?? '';
      // Pins the exact worktree root and forbids relative paths / scratch escape.
      expect(input).toContain('/crew/wt-abc');
      expect(input).toMatch(/ABSOLUTE paths/);
      expect(input).toMatch(/relative paths/i);
      // Contract comes first; the user prompt follows it (operational policy
      // before the task) so executeWithSchema can still append its JSON
      // instruction after the user prompt.
      expect(input.indexOf('Crew workspace contract')).toBeLessThan(input.indexOf('do the work'));
    });

    it('returns sessionId = conversation_id and surfaces the response + metadata', async () => {
      mockOnce(successEnvelope({ conversation_id: 'conv-xyz', response: 'done', num_turns: 2, duration_seconds: 3 }));
      const result = await adapter.execute({
        prompt: 'go',
        context: { workingDirectory: '/crew/wt' },
      });
      expect(result.output).toBe('done');
      expect(result.sessionId).toBe('conv-xyz');
      expect(result.metadata.numTurns).toBe(2);
      expect(result.metadata.durationMs).toBe(3000);
    });

    it('delivers a leading-dash prompt via stdin so it is never parsed as a flag', async () => {
      mockOnce(successEnvelope());
      await adapter.execute({
        prompt: '--not-a-flag do it',
        context: { workingDirectory: '/crew/wt' },
      });
      const [, args, options] = mockExeca.mock.calls[0] as [string, string[], { input?: string }];
      expect(args).not.toContain('--not-a-flag do it');
      expect(options.input).toContain('--not-a-flag do it');
    });

    it('passes a valid --model label', async () => {
      mockOnce(successEnvelope());
      await adapter.execute({
        prompt: 'go',
        context: { workingDirectory: '/crew/wt' },
        constraints: { model: VALID_MODEL },
      });
      const args = mockExeca.mock.calls[0]?.[1] as string[];
      expect(args.slice(0, 4)).toEqual(['--output-format', 'json', '--model', VALID_MODEL]);
    });

    it('passes --print-timeout when a budget is set, with execa timeout above it', async () => {
      mockOnce(successEnvelope());
      await adapter.execute({
        prompt: 'go',
        context: { workingDirectory: '/crew/wt' },
        constraints: { timeout: 60_000 },
      });
      const [, args, options] = mockExeca.mock.calls[0] as [string, string[], { timeout?: number }];
      const idx = args.indexOf('--print-timeout');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('60s');
      // execa hard timeout must be ABOVE agy's own budget so agy returns a clean
      // ERROR envelope before execa SIGKILLs it.
      expect(options.timeout).toBeGreaterThan(60_000);
    });
  });

  describe('model validation at dispatch', () => {
    it('rejects an unknown model label WITHOUT spawning agy', async () => {
      const result = await adapter.execute({
        prompt: 'go',
        context: { workingDirectory: '/crew/wt' },
        constraints: { model: 'Totally Fake Model 9000' },
      });
      expect(result.status).toBe('error');
      expect(result.output).toContain('Unknown agy model label');
      expect(result.output).toContain(VALID_MODEL); // enumerates known set
      expect(mockExeca).not.toHaveBeenCalled();
    });
  });

  describe('read-only hard reject (defense in depth)', () => {
    it('refuses a read-only dispatch WITHOUT spawning agy', async () => {
      const result = await adapter.execute({
        prompt: 'review this',
        context: { workingDirectory: '/crew/wt' },
        constraints: { sandbox: 'read-only' },
      });
      expect(result.status).toBe('error');
      expect(result.output).toMatch(/cannot run read-only/i);
      expect(result.failure?.kind).not.toBe('process'); // terminal/config, not transient
      expect(mockExeca).not.toHaveBeenCalled();
    });
  });

  describe('strict JSON gating', () => {
    it('treats a status:ERROR envelope (exit 1) as a failure, not empty success', async () => {
      mockOnce(
        `${JSON.stringify({ conversation_id: 'c', status: 'ERROR', response: '', error: 'timeout waiting for response', usage: {} })}\n`,
        1,
      );
      const result = await adapter.execute({
        prompt: 'go',
        context: { workingDirectory: '/crew/wt' },
      });
      expect(result.status).toBe('error');
      expect(result.output).toContain('timeout waiting for response');
      expect(result.failure).toBeDefined();
    });

    it('treats garbled (non-JSON) stdout as a failure, never as an empty response', async () => {
      mockOnce('this is not json at all', 0);
      const result = await adapter.execute({
        prompt: 'go',
        context: { workingDirectory: '/crew/wt' },
      });
      expect(result.status).toBe('error');
    });

    it('treats SUCCESS with an empty response as a failure', async () => {
      mockOnce(successEnvelope({ response: '' }), 0);
      const result = await adapter.execute({
        prompt: 'go',
        context: { workingDirectory: '/crew/wt' },
      });
      expect(result.status).toBe('error');
    });

    it('treats exit 0 with status missing as a failure', async () => {
      mockOnce(`${JSON.stringify({ conversation_id: 'c', response: 'hi' })}\n`, 0);
      const result = await adapter.execute({
        prompt: 'go',
        context: { workingDirectory: '/crew/wt' },
      });
      expect(result.status).toBe('error');
    });
  });

  describe('resume (--conversation) + silent-reset guard', () => {
    it('adds --conversation for a resume and accepts a matching returned id', async () => {
      mockOnce(successEnvelope({ conversation_id: 'conv-1', num_turns: 2 }));
      const result = await adapter.execute({
        prompt: 'continue',
        context: { workingDirectory: '/crew/wt' },
        constraints: { resumeSessionId: 'conv-1' },
      });
      const args = mockExeca.mock.calls[0]?.[1] as string[];
      const idx = args.indexOf('--conversation');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('conv-1');
      expect(result.status).toBe('success');
      expect(result.sessionId).toBe('conv-1');
    });

    it('invalidates a resume when agy returns a DIFFERENT conversation id (silent fresh start)', async () => {
      // agy silently starts a fresh conversation on an unknown/stale id, returning
      // exit 0 / SUCCESS — that would be silent context loss. The guard catches it.
      mockOnce(successEnvelope({ conversation_id: 'a-fresh-different-id' }));
      const result = await adapter.execute({
        prompt: 'continue',
        context: { workingDirectory: '/crew/wt' },
        constraints: { resumeSessionId: 'conv-1' },
      });
      expect(result.status).toBe('error');
      expect(result.output).toMatch(/resume invalidated/i);
      expect(result.failure?.kind).not.toBe('process');
    });
  });

  describe('process failures', () => {
    it('returns a structured error when the process throws', async () => {
      mockExeca.mockRejectedValueOnce(new Error('spawn agy ENOENT'));
      const result = await adapter.execute({
        prompt: 'go',
        context: { workingDirectory: '/crew/wt' },
      });
      expect(result.status).toBe('error');
      expect(result.output).toContain('spawn agy ENOENT');
      expect(result.failure).toBeDefined();
    });
  });

  describe('executeWithSchema', () => {
    it('parses JSON from the response against the schema', async () => {
      mockOnce(successEnvelope({ response: '{"ok":true}' }));
      const result = await adapter.executeWithSchema(
        'return json',
        z.object({ ok: z.boolean() }),
        { workingDirectory: '/crew/wt' },
      );
      expect(result).toEqual({ ok: true });
    });

    it('throws when the underlying dispatch errors', async () => {
      mockOnce(`${JSON.stringify({ status: 'ERROR', response: '', error: 'boom' })}\n`, 1);
      await expect(
        adapter.executeWithSchema('x', z.object({ ok: z.boolean() }), { workingDirectory: '/crew/wt' }),
      ).rejects.toThrow(/boom/);
    });
  });

  describe('health / version', () => {
    it('reports available for a version at or above the floor', async () => {
      mockExeca.mockResolvedValueOnce({ stdout: 'agy 1.0.14', stderr: '', exitCode: 0 } as never);
      const health = await adapter.healthCheck();
      expect(health.available).toBe(true);
      expect(health.version).toBe('1.0.14');
    });

    it('reports unavailable below the version floor', async () => {
      mockExeca.mockResolvedValueOnce({ stdout: 'agy 1.0.12', stderr: '', exitCode: 0 } as never);
      const health = await adapter.healthCheck();
      expect(health.available).toBe(false);
      expect(health.error).toMatch(/below the supported floor/i);
    });

    it('getCliVersionTag returns the tagged version', async () => {
      mockExeca.mockResolvedValueOnce({ stdout: 'agy 1.0.14', stderr: '', exitCode: 0 } as never);
      const tag = await adapter.getCliVersionTag();
      expect(tag).toBe('agy@1.0.14');
    });
  });

  describe('parseAgyEnvelope / version helpers (units)', () => {
    it('parses a clean envelope and returns null for empty/garbled', () => {
      expect(parseAgyEnvelope(successEnvelope())?.status).toBe('SUCCESS');
      expect(parseAgyEnvelope('')).toBeNull();
      expect(parseAgyEnvelope('not json')).toBeNull();
      expect(parseAgyEnvelope('[1,2,3]')).toBeNull(); // array, not an object
    });

    it('isAgyVersionBelowFloor brackets the floor', () => {
      expect(isAgyVersionBelowFloor(null)).toBe(true);
      expect(isAgyVersionBelowFloor({ major: 1, minor: 0, patch: 13 })).toBe(true);
      expect(isAgyVersionBelowFloor({ ...AGY_MIN_VERSION })).toBe(false);
      expect(isAgyVersionBelowFloor({ major: 1, minor: 1, patch: 0 })).toBe(false);
    });

    it('withAgyWorkspacePreamble pins the root, forbids relative paths, and keeps the prompt last', () => {
      const out = withAgyWorkspacePreamble('build the feature', '/crew/runs/abc/worktree');
      // Root appears (twice: as the writable root and the "current directory" alias).
      expect(out.match(/\/crew\/runs\/abc\/worktree/g)?.length).toBeGreaterThanOrEqual(2);
      expect(out).toMatch(/ABSOLUTE paths/);
      expect(out).toMatch(/Do NOT use relative paths/);
      // Original prompt survives verbatim and comes AFTER the contract.
      expect(out).toContain('build the feature');
      expect(out.indexOf('Crew workspace contract')).toBe(0);
      expect(out.indexOf('build the feature')).toBeGreaterThan(out.indexOf('Crew workspace contract'));
    });
  });
});
