import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
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
// The adapter writes its result to a temp file, then reads that file via
// fs/promises.readFile. Keep fixture loading on real fs.
const mockMkdtemp = vi.fn(() => '/tmp/codex-mock');
const mockAdapterReadFile = vi.fn();

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    mkdtemp: async (...args: any[]) => mockMkdtemp(...args),
    readFile: async (...args: any[]) => mockAdapterReadFile(...args),
    rm: async () => undefined,
  };
});

// Import after mock setup
const { execa } = await import('execa');
const mockExeca = vi.mocked(execa);

const { CodexAdapter } = await import('../../src/adapters/codex.js');
const { logger } = await import('../../src/utils/logger.js');
const { REDACTED_RUN_TOKEN } = await import('../../src/utils/redaction.js');

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
  stderrChunks = [],
  exitCode = 0,
}: {
  chunks: string[];
  stderrChunks?: string[];
  exitCode?: number;
}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const fullStdout = chunks.join('');
  const subprocess = new Promise((resolve) => {
    let stdoutEnded = false;
    let stderrEnded = false;
    const resolveIfDone = () => {
      if (!stdoutEnded || !stderrEnded) return;
      resolve({
        stdout: undefined,
        stderr: undefined,
        exitCode,
      });
    };
    stdout.once('end', () => {
      stdoutEnded = true;
      resolveIfDone();
    });
    stderr.once('end', () => {
      stderrEnded = true;
      resolveIfDone();
    });

    queueMicrotask(() => {
      for (const chunk of chunks) stdout.write(chunk);
      stdout.end();
      for (const chunk of stderrChunks) stderr.write(chunk);
      stderr.end();
    });
  }) as Promise<any> & { stdout: PassThrough; stderr: PassThrough };

  subprocess.stdout = stdout;
  subprocess.stderr = stderr;
  return subprocess;
}

describe('CodexAdapter', () => {
  let adapter: InstanceType<typeof CodexAdapter>;
  const dispatchMcpEnv = {
    CREW_RUN_ID: 'codex-run-123',
    CREW_RUN_TOKEN: 'a'.repeat(64),
  };

  beforeEach(() => {
    adapter = new CodexAdapter();
    vi.clearAllMocks();
    delete process.env.CREW_HEALTHCHECK_TTL_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CREW_HEALTHCHECK_TTL_MS;
  });

  describe('properties', () => {
    it('has correct name', () => {
      expect(adapter.name).toBe('codex');
    });

    it('supports json schema', () => {
      expect(adapter.supportsJsonSchema).toBe(true);
    });

    it('exposes captain capabilities without the retired tool-loop path', () => {
      expect(adapter.captainCapabilities?.supportsStructuredDecisions).toBe(true);
      expect(adapter.captainCapabilities?.supportsPauseForUserInput).toBe(false);
    });

    it('declares default strengths', () => {
      expect(adapter.strengths).toEqual([
        'fast-iteration',
        'autonomous-loops',
        'bulk-implementation',
      ]);
    });

    it('declares useWhen routing guidance', () => {
      expect(adapter.useWhen).toBe(
        'Prefer for well-scoped implementation and long unattended loops — fast at churning through mechanical changes.',
      );
    });

    it('declares defaultEffort = "medium" (mirrors codex CLI default)', () => {
      expect(adapter.defaultEffort).toBe('medium');
    });

    it('declares supportedEfforts excluding "max" so the resolver clamps it down', () => {
      // Codex 0.130 rejects `max` with `unknown variant ..., expected
      // one of none, minimal, low, medium, high, xhigh`. The canonical
      // EffortLevel includes `max`; declaring the supported subset lets
      // resolveEffectiveEffort clamp captain-provided `max` to `xhigh`
      // before it reaches the CLI.
      expect(adapter.supportedEfforts).toEqual(['low', 'medium', 'high', 'xhigh']);
      expect(adapter.supportedEfforts).not.toContain('max');
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

  describe('execute', () => {
    it('passes the composed prompt through codex exec stdin', async () => {
      const composedPrompt = '## Peer messages\n\nforwarded context\nactual task';
      mockExeca.mockResolvedValueOnce({
        stdout: `${JSON.stringify({ type: 'agent_message', text: 'ok' })}\n`,
        stderr: '',
        exitCode: 0,
      } as any);

      await adapter.execute({
        prompt: composedPrompt,
        context: { workingDirectory: '/tmp/project' },
      });

      const args = mockExeca.mock.calls[0]?.[1] as string[];
      expect(args[0]).toBe('exec');
      expect(args).not.toContain('mcp_servers.crew.env.CREW_RUN_ID="codex-run-123"');
      expect(args).not.toContain(`mcp_servers.crew.env.CREW_RUN_TOKEN="${dispatchMcpEnv.CREW_RUN_TOKEN}"`);
      expect(args).not.toContain('mcp_servers.crew.tools.send_message.approval_mode="approve"');
      expect(args).not.toContain(composedPrompt);
      expect(mockExeca.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
        buffer: false,
        input: composedPrompt,
      }));
    });

    it('appends per-dispatch crew MCP env as TOML overrides on fresh exec', async () => {
      expect(dispatchMcpEnv.CREW_RUN_TOKEN).toMatch(/^[0-9a-f]{64}$/);
      mockExeca.mockResolvedValueOnce({
        stdout: [
          '{"type":"thread.started","thread_id":"thread-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}',
          '{"type":"turn.completed","turn_id":"turn-1"}',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      } as any);

      await adapter.execute({
        prompt: 'Do work',
        dispatchMcpEnv,
        context: { workingDirectory: '/tmp/project' },
      });

      const args = mockExeca.mock.calls[0]?.[1] as string[];
      const tokenOverride = `mcp_servers.crew.env.CREW_RUN_TOKEN="${dispatchMcpEnv.CREW_RUN_TOKEN}"`;
      expect(args).toEqual([
        'exec',
        '--json',
        '--skip-git-repo-check',
        '-o',
        '/tmp/codex-mock/output.json',
        '-c',
        'mcp_servers.crew.env.CREW_RUN_ID="codex-run-123"',
        '-c',
        tokenOverride,
        '-c',
        'mcp_servers.crew.tools.send_message.approval_mode="approve"',
      ]);
      expect(tokenOverride).not.toContain('\\');
    });

    it('redacts dispatch run tokens from spawn-error results and logs', async () => {
      const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      mockExeca.mockImplementationOnce(() => {
        throw new Error(
          `spawn ENOENT: codex exec -c mcp_servers.crew.env.CREW_RUN_TOKEN="${dispatchMcpEnv.CREW_RUN_TOKEN}"`,
        );
      });

      try {
        const result = await adapter.execute({
          prompt: 'Do work',
          dispatchMcpEnv,
          context: { workingDirectory: '/tmp/project' },
        });

        const resultText = JSON.stringify(result);
        expect(resultText).not.toContain(dispatchMcpEnv.CREW_RUN_TOKEN);
        expect(resultText).toContain(REDACTED_RUN_TOKEN);
        expect(result.output).not.toContain(dispatchMcpEnv.CREW_RUN_TOKEN);
        expect(result.failure?.rawSignal).not.toContain(dispatchMcpEnv.CREW_RUN_TOKEN);
        expect(JSON.stringify(result.metadata.rawEvents)).not.toContain(dispatchMcpEnv.CREW_RUN_TOKEN);

        const logText = JSON.stringify(loggerSpy.mock.calls);
        expect(logText).not.toContain(dispatchMcpEnv.CREW_RUN_TOKEN);
        expect(logText).toContain(REDACTED_RUN_TOKEN);
      } finally {
        loggerSpy.mockRestore();
      }
    });

    it('captures thread id and resumes with codex exec resume', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: [
          '{"type":"thread.started","thread_id":"thread-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"continued"}}',
          '{"type":"turn.completed","turn_id":"turn-1"}',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      } as any);

      const result = await adapter.execute({
        prompt: 'Continue',
        context: { workingDirectory: '/tmp/project' },
        constraints: { resumeSessionId: 'thread-1' },
      });

      const args = mockExeca.mock.calls[0]?.[1] as string[];
      expect(args.slice(0, 2)).toEqual(['exec', 'resume']);
      expect(args.slice(-2)).toEqual(['thread-1', '-']);
      expect(result.status).toBe('success');
      expect(result.output).toBe('continued');
      expect(result.sessionId).toBe('thread-1');
    });

    it('appends per-dispatch crew MCP env before the resume session positional', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: [
          '{"type":"thread.started","thread_id":"thread-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"continued"}}',
          '{"type":"turn.completed","turn_id":"turn-1"}',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      } as any);

      await adapter.execute({
        prompt: 'Continue',
        dispatchMcpEnv,
        context: { workingDirectory: '/tmp/project' },
        constraints: { resumeSessionId: 'thread-1' },
      });

      const args = mockExeca.mock.calls[0]?.[1] as string[];
      expect(args).toEqual([
        'exec',
        'resume',
        '--json',
        '--skip-git-repo-check',
        '-o',
        '/tmp/codex-mock/output.json',
        '-c',
        'mcp_servers.crew.env.CREW_RUN_ID="codex-run-123"',
        '-c',
        `mcp_servers.crew.env.CREW_RUN_TOKEN="${dispatchMcpEnv.CREW_RUN_TOKEN}"`,
        '-c',
        'mcp_servers.crew.tools.send_message.approval_mode="approve"',
        'thread-1',
        '-',
      ]);
    });

    it('passes sandbox as a config override when resuming', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: [
          '{"type":"thread.started","thread_id":"thread-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"continued"}}',
          '{"type":"turn.completed","turn_id":"turn-1"}',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      } as any);

      await adapter.execute({
        prompt: 'Continue',
        context: { workingDirectory: '/tmp/project' },
        constraints: {
          resumeSessionId: 'thread-1',
          sandbox: 'workspace-write',
          model: ModelId.GPT_MINI,
          effort: 'high',
          writablePaths: ['/repo/.git/worktrees/run-a'],
          networkAccess: true,
        },
      });

      const args = mockExeca.mock.calls[0]?.[1] as string[];
      expect(args).toEqual([
        'exec',
        'resume',
        '--json',
        '--skip-git-repo-check',
        '-o',
        '/tmp/codex-mock/output.json',
        '--model',
        ModelId.GPT_MINI,
        '-c',
        'model_reasoning_effort="high"',
        '-c',
        'sandbox_mode="workspace-write"',
        '-c',
        'sandbox_workspace_write.writable_roots=["/repo/.git/worktrees/run-a"]',
        '-c',
        'sandbox_workspace_write.network_access=true',
        'thread-1',
        '-',
      ]);
      expect(args).not.toContain('--sandbox');
    });

    it('reports exit code and streamed stderr when resume returns no thread id', async () => {
      mockExeca.mockReturnValueOnce(createStreamingCodexProcess({
        chunks: [],
        stderrChunks: ["error: unexpected argument '--sandbox' found\n"],
        exitCode: 2,
      }) as any);

      const result = await adapter.execute({
        prompt: 'Continue',
        context: { workingDirectory: '/tmp/project' },
        constraints: { resumeSessionId: 'thread-1' },
      });

      expect(result.status).toBe('error');
      expect(result.output).toContain('resume_id_missing:');
      expect(result.output).toContain('Subprocess exit code: 2.');
      expect(result.output).toContain("error: unexpected argument '--sandbox' found");
      expect(result.failure).toMatchObject({
        providerCode: 'resume_id_missing',
        confidence: 'high',
        recommendation: 'ask_user',
      });
      expect(result.failure?.rawSignal).toContain('Subprocess exit code: 2.');
      expect(result.failure?.rawSignal).toContain("error: unexpected argument '--sandbox' found");
    });

    it('treats a different resumed codex thread id as context loss', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: [
          '{"type":"thread.started","thread_id":"fresh-thread"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"fresh"}}',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      } as any);

      const result = await adapter.execute({
        prompt: 'Continue',
        context: { workingDirectory: '/tmp/project' },
        constraints: { resumeSessionId: 'thread-1' },
      });

      expect(result.status).toBe('error');
      expect(result.output).toContain('codex resume invalidated');
      expect(result.failure?.providerCode).toBe('resume_invalidated');
      expect(result.sessionId).toBe('fresh-thread');
    });

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

    it('computes terminal output from the incremental stream reducer under buffer:false', async () => {
      mockExeca.mockReturnValueOnce(createStreamingCodexProcess({
        chunks: [
          '{"type":"thread.started","thread_id":"thread-123"}\n{"type":"item.completed","item":{"type":"file_change","path":"src/foo.ts","action":"modified"}}\n',
          '{"type":"item.completed","item":{"type":"agent_message","text":"streamed final"}}\n',
        ],
      }) as any);

      const progress: string[] = [];
      const result = await adapter.execute({
        prompt: 'Modify files',
        context: { workingDirectory: '/tmp/project' },
        onOutput: (chunk) => progress.push(chunk),
      });

      expect(mockExeca.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ buffer: false }));
      expect(result.status).toBe('success');
      expect(result.output).toBe('streamed final');
      expect(result.filesModified).toEqual(['src/foo.ts']);
      expect(result.sessionId).toBe('thread-123');
      expect(progress.some((line) => line.includes('file: modified src/foo.ts'))).toBe(true);
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

    it('classifies provider-coded parsed quota error events', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: [
          JSON.stringify({
            type: 'error',
            message: 'Request failed with provider code insufficient_quota',
            code: 'insufficient_quota',
          }),
        ].join('\n'),
        stderr: '',
        exitCode: 1,
      } as any);

      const result = await adapter.execute({
        prompt: 'Do something',
        context: { workingDirectory: '/tmp/project' },
      });

      expect(result.status).toBe('error');
      expect(result.failure).toMatchObject({
        kind: 'quota_exhausted',
        confidence: 'high',
        providerCode: 'insufficient_quota',
        recommendation: 'reroute',
      });
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

    it('classifies stderr-only quota failures with low confidence', async () => {
      mockExeca.mockReturnValueOnce(createStreamingCodexProcess({
        chunks: [],
        stderrChunks: ['insufficient_quota: monthly quota exhausted'],
        exitCode: 1,
      }) as any);

      const result = await adapter.execute({
        prompt: 'Do something',
        context: { workingDirectory: '/tmp/project' },
      });

      expect(result.status).toBe('error');
      expect(result.output).toContain('insufficient_quota');
      expect(result.failure).toMatchObject({
        kind: 'quota_exhausted',
        confidence: 'low',
        recommendation: 'reroute',
      });
    });

    it('returns error when codex exits nonzero after emitting parseable JSONL', async () => {
      mockExeca.mockReturnValueOnce(createStreamingCodexProcess({
        chunks: [successFixture],
        stderrChunks: ['process failed after partial work'],
        exitCode: 17,
      }) as any);

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

      mockAdapterReadFile.mockReturnValueOnce('Output from file');

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
      expect(onOutput).toHaveBeenCalledWith('message: Final streamed chunk');
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

    it('translates effort constraint to -c model_reasoning_effort=...', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: successFixture,
        stderr: '',
        exitCode: 0,
      } as any);

      await adapter.execute({
        prompt: 'Triage build failure',
        context: { workingDirectory: '/tmp/project' },
        constraints: { effort: 'high' },
      });

      const cliArgs = mockExeca.mock.calls[0][1] as string[];
      // -c flag is paired with the key=value override; both must be present
      // and adjacent so codex parses them together.
      const cIdx = cliArgs.indexOf('-c');
      expect(cIdx).toBeGreaterThan(-1);
      expect(cliArgs[cIdx + 1]).toBe('model_reasoning_effort="high"');
    });

    it('omits -c model_reasoning_effort when effort is undefined', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: successFixture,
        stderr: '',
        exitCode: 0,
      } as any);

      await adapter.execute({
        prompt: 'Plain run',
        context: { workingDirectory: '/tmp/project' },
        constraints: {},
      });

      const cliArgs = mockExeca.mock.calls[0][1] as string[];
      expect(cliArgs.some((a) => a.startsWith('model_reasoning_effort'))).toBe(false);
    });

    it('passes --sandbox when sandbox constraint is set for fresh dispatches', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: successFixture,
        stderr: '',
        exitCode: 0,
      } as any);

      await adapter.execute({
        prompt: 'Run with relaxed sandbox',
        context: { workingDirectory: '/tmp/project' },
        constraints: { sandbox: 'workspace-write' },
      });

      const cliArgs = mockExeca.mock.calls[0][1] as string[];
      expect(cliArgs).toEqual([
        'exec',
        '--json',
        '--skip-git-repo-check',
        '-o',
        '/tmp/codex-mock/output.json',
        '--sandbox',
        'workspace-write',
      ]);
    });

    it('passes -c sandbox_workspace_write.network_access=true when networkAccess is true', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: successFixture,
        stderr: '',
        exitCode: 0,
      } as any);

      await adapter.execute({
        prompt: 'Run that needs localhost',
        context: { workingDirectory: '/tmp/project' },
        constraints: { networkAccess: true },
      });

      const cliArgs = mockExeca.mock.calls[0][1] as string[];
      expect(cliArgs).toContain('sandbox_workspace_write.network_access=true');
    });

    it('passes a single -c writable_roots config override (TOML array) for writablePaths', async () => {
      // Bug fix 2026-05: codex's `--add-dir` adds paths via the
      // `additional_writable_root` runtime-approval channel, which
      // doesn't auto-approve in non-interactive `codex exec` — git
      // commit failed on `index.lock` in linked worktrees because the
      // gitdir grant was silently rejected. The fix is to set
      // `sandbox_workspace_write.writable_roots` via `-c` so the path
      // is in the seatbelt profile from the start. We also must NOT
      // emit `--add-dir` (it's redundant and can be misleading in
      // logs).
      mockExeca.mockResolvedValueOnce({
        stdout: successFixture,
        stderr: '',
        exitCode: 0,
      } as any);

      await adapter.execute({
        prompt: 'Run that commits in a linked worktree',
        context: { workingDirectory: '/tmp/project' },
        constraints: {
          sandbox: 'workspace-write',
          writablePaths: [
            '/repo/.git/worktrees/run-a',
            '   ',
            '/repo/.git/objects',
            '/repo/.git/refs/heads/crew-run',
          ],
        },
      });

      const cliArgs = mockExeca.mock.calls[0][1] as string[];
      // Single `-c sandbox_workspace_write.writable_roots=[...]` pair,
      // empty/whitespace entries filtered out, paths preserved in
      // input order, JSON-encoded as a TOML-compatible string array.
      const overridePairs = cliArgs
        .map((arg, idx) => [arg, cliArgs[idx + 1]] as const)
        .filter(([arg, val]) => arg === '-c' && val?.startsWith('sandbox_workspace_write.writable_roots='));
      expect(overridePairs).toHaveLength(1);
      expect(overridePairs[0][1]).toBe(
        'sandbox_workspace_write.writable_roots=["/repo/.git/worktrees/run-a","/repo/.git/objects","/repo/.git/refs/heads/crew-run"]',
      );
      // No --add-dir flags should remain — the legacy approach was
      // observed to silently fail on paths outside cwd.
      expect(cliArgs).not.toContain('--add-dir');
    });

    it('omits the writable_roots override entirely when writablePaths is empty', async () => {
      // Empty/missing list → no `-c` for writable_roots. We don't
      // want to emit `writable_roots=[]` because that would *clear*
      // the default and forbid even cwd-implicit behaviors codex
      // might rely on.
      mockExeca.mockResolvedValueOnce({
        stdout: successFixture,
        stderr: '',
        exitCode: 0,
      } as any);

      await adapter.execute({
        prompt: 'No writable paths',
        context: { workingDirectory: '/tmp/project' },
        constraints: {
          sandbox: 'workspace-write',
          writablePaths: ['   ', ''],
        },
      });

      const cliArgs = mockExeca.mock.calls[0][1] as string[];
      const writableRootsPair = cliArgs.find(
        (arg) => typeof arg === 'string' && arg.startsWith('sandbox_workspace_write.writable_roots='),
      );
      expect(writableRootsPair).toBeUndefined();
      expect(cliArgs).not.toContain('--add-dir');
    });

    it('omits sandbox + network overrides when constraints leave them unset', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: successFixture,
        stderr: '',
        exitCode: 0,
      } as any);

      await adapter.execute({
        prompt: 'Plain run',
        context: { workingDirectory: '/tmp/project' },
        constraints: {},
      });

      const cliArgs = mockExeca.mock.calls[0][1] as string[];
      expect(cliArgs).not.toContain('--sandbox');
      expect(cliArgs.some((a) => a.includes('network_access'))).toBe(false);
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

    it('caches successful health checks within the TTL', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-10T00:00:00.000Z'));
      mockExeca.mockResolvedValueOnce({
        stdout: 'codex-cli 0.121.0',
        stderr: '',
        exitCode: 0,
      } as any);

      const first = await adapter.healthCheck();
      const second = await adapter.healthCheck();

      expect(first.available).toBe(true);
      expect(second.version).toBe('0.121.0');
      expect(mockExeca).toHaveBeenCalledTimes(1);
    });

    it('expires successful health checks after the TTL', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-10T00:00:00.000Z'));
      mockExeca
        .mockResolvedValueOnce({
          stdout: 'codex-cli 0.121.0',
          stderr: '',
          exitCode: 0,
        } as any)
        .mockResolvedValueOnce({
          stdout: 'codex-cli 0.122.0',
          stderr: '',
          exitCode: 0,
        } as any);

      await adapter.healthCheck();
      // Success TTL is 5 minutes; one tick past it must re-probe.
      vi.setSystemTime(new Date('2026-05-10T00:05:00.001Z'));
      const result = await adapter.healthCheck();

      expect(result.version).toBe('0.122.0');
      expect(mockExeca).toHaveBeenCalledTimes(2);
    });

    it('bypasses the cache when refresh is requested', async () => {
      mockExeca
        .mockResolvedValueOnce({
          stdout: 'codex-cli 0.121.0',
          stderr: '',
          exitCode: 0,
        } as any)
        .mockResolvedValueOnce({
          stdout: 'codex-cli 0.122.0',
          stderr: '',
          exitCode: 0,
        } as any);

      await adapter.healthCheck();
      const result = await adapter.healthCheck({ refresh: true });

      expect(result.version).toBe('0.122.0');
      expect(mockExeca).toHaveBeenCalledTimes(2);
    });

    it('caches failed health checks briefly', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-10T00:00:00.000Z'));
      mockExeca
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValueOnce({
          stdout: 'codex-cli 0.121.0',
          stderr: '',
          exitCode: 0,
        } as any);

      const first = await adapter.healthCheck();
      const second = await adapter.healthCheck();
      vi.setSystemTime(new Date('2026-05-10T00:00:05.001Z'));
      const third = await adapter.healthCheck();

      expect(first.available).toBe(false);
      expect(second.available).toBe(false);
      expect(third.available).toBe(true);
      expect(mockExeca).toHaveBeenCalledTimes(2);
    });

    it('disables health-check caching when CREW_HEALTHCHECK_TTL_MS is 0', async () => {
      process.env.CREW_HEALTHCHECK_TTL_MS = '0';
      mockExeca
        .mockResolvedValueOnce({
          stdout: 'codex-cli 0.121.0',
          stderr: '',
          exitCode: 0,
        } as any)
        .mockResolvedValueOnce({
          stdout: 'codex-cli 0.122.0',
          stderr: '',
          exitCode: 0,
        } as any);

      await adapter.healthCheck();
      const result = await adapter.healthCheck();

      expect(result.version).toBe('0.122.0');
      expect(mockExeca).toHaveBeenCalledTimes(2);
    });
  });
});
