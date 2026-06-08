import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

// Partial fs mock: real implementations by default (so the policy file is
// actually written + readable), but writeFileSync is a spy-able vi.fn so the
// fail-closed test can force a write failure.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

const { execa } = await import('execa');
const mockExeca = vi.mocked(execa);

const { GeminiCliAdapter, GEMINI_READ_ONLY_DENIED_TOOLS, renderReadOnlyPolicyToml } =
  await import('../../src/adapters/gemini-cli.js');

/**
 * Extracts the `--policy <path>` argument from a recorded execa argv, or
 * undefined when the flag is absent.
 */
function policyPathFromArgs(args: string[]): string | undefined {
  const idx = args.indexOf('--policy');
  return idx >= 0 ? args[idx + 1] : undefined;
}

describe('GeminiCliAdapter', () => {
  let adapter: InstanceType<typeof GeminiCliAdapter>;

  beforeEach(() => {
    adapter = new GeminiCliAdapter();
    vi.clearAllMocks();
  });

  it('advertises native tool-loop support', () => {
    expect(adapter.captainCapabilities.supportsToolLoop).toBe(true);
  });

  it('reports enforcesReadOnly=false because tool-policy denial is not an OS filesystem sandbox', () => {
    // Gemini enforces read-only at the tool level (a per-run --policy deny),
    // not via a kernel sandbox. enforcesReadOnly specifically means the
    // latter, so it stays false and the dirty-tree probe + advisory remain.
    expect(adapter.enforcesReadOnly).toBe(false);
  });

  it('renders a deny policy covering exactly the known mutating tools', () => {
    const toml = renderReadOnlyPolicyToml();
    for (const tool of GEMINI_READ_ONLY_DENIED_TOOLS) {
      expect(toml).toContain(`toolName = "${tool}"`);
    }
    // Every rule denies at a priority high enough to beat user/global allows.
    const denyCount = (toml.match(/decision = "deny"/g) ?? []).length;
    expect(denyCount).toBe(GEMINI_READ_ONLY_DENIED_TOOLS.length);
    expect(toml).toContain('priority = 999');
    expect(GEMINI_READ_ONLY_DENIED_TOOLS).toContain('run_shell_command');
  });

  it('injects --policy on read-only dispatches and writes a real deny-policy file', async () => {
    // Capture the policy file's on-disk state DURING the call: the adapter
    // cleans up its temp dir in a finally block, so a post-call existsSync
    // would always be false. This also guards the packaging landmine — the
    // path must resolve to a real file the CLI can read, not a phantom path.
    let policyExistedAtCallTime = false;
    let policyContents = '';
    let observedArgs: string[] = [];
    let observedEnv: Record<string, string> | undefined;
    mockExeca.mockImplementationOnce(((_cmd: string, args: string[], options: {
      env?: Record<string, string>;
    }) => {
      observedArgs = args;
      observedEnv = options.env;
      const policyPath = policyPathFromArgs(args);
      if (policyPath && existsSync(policyPath)) {
        policyExistedAtCallTime = true;
        policyContents = readFileSync(policyPath, 'utf-8');
      }
      return Promise.resolve({
        stdout: `${JSON.stringify({ response: 'reviewed' })}\n`,
        stderr: '',
        exitCode: 0,
      });
    }) as never);

    const result = await adapter.execute({
      prompt: 'review only',
      context: { workingDirectory: '/tmp/project' },
      constraints: { sandbox: 'read-only' },
    });

    expect(result.status).toBe('success');
    expect(observedArgs).toContain('--policy');
    expect(policyExistedAtCallTime).toBe(true);
    expect(policyContents).toContain('toolName = "write_file"');
    expect(policyContents).toContain('toolName = "run_shell_command"');
    expect(policyContents).toContain('toolName = "save_memory"');
    // Trust is NOT auto-granted from read-only alone. The env var is set
    // EXPLICITLY to 'false' (not omitted) so an inherited true can't leak.
    expect(observedEnv?.GEMINI_CLI_TRUST_WORKSPACE).toBe('false');
  });

  it('forces GEMINI_CLI_TRUST_WORKSPACE=false on an untrusted read-only run even if inherited true', async () => {
    // Regression for the inherited-env bypass: a captain process that exported
    // GEMINI_CLI_TRUST_WORKSPACE=true must NOT leak trust into a read-only run
    // the dispatch layer computed as untrusted (trustWorkspace absent/false).
    const prev = process.env.GEMINI_CLI_TRUST_WORKSPACE;
    process.env.GEMINI_CLI_TRUST_WORKSPACE = 'true';
    let observedEnv: Record<string, string> | undefined;
    mockExeca.mockImplementationOnce(((_cmd: string, _args: string[], options: {
      env?: Record<string, string>;
    }) => {
      observedEnv = options.env;
      return Promise.resolve({
        stdout: `${JSON.stringify({ response: 'ok' })}\n`,
        stderr: '',
        exitCode: 0,
      });
    }) as never);
    try {
      await adapter.execute({
        prompt: 'review only',
        context: { workingDirectory: '/tmp/project' },
        constraints: { sandbox: 'read-only' },
      });
      // Explicit override to 'false' (gemini reads the var as === 'true').
      expect(observedEnv?.GEMINI_CLI_TRUST_WORKSPACE).toBe('false');
    } finally {
      if (prev === undefined) delete process.env.GEMINI_CLI_TRUST_WORKSPACE;
      else process.env.GEMINI_CLI_TRUST_WORKSPACE = prev;
    }
  });

  it('sets the workspace-trust env only when trustWorkspace is set (crew-controlled path)', async () => {
    let observedEnv: Record<string, string> | undefined;
    let observedArgs: string[] = [];
    mockExeca.mockImplementationOnce(((_cmd: string, args: string[], options: {
      env?: Record<string, string>;
    }) => {
      observedArgs = args;
      observedEnv = options.env;
      return Promise.resolve({
        stdout: `${JSON.stringify({ response: 'reviewed' })}\n`,
        stderr: '',
        exitCode: 0,
      });
    }) as never);

    await adapter.execute({
      prompt: 'review only',
      context: { workingDirectory: '/tmp/project' },
      constraints: { sandbox: 'read-only', trustWorkspace: true },
    });

    expect(observedArgs).toContain('--policy');
    expect(observedEnv?.GEMINI_CLI_TRUST_WORKSPACE).toBe('true');
  });

  it('fails closed (no spawn) when the policy file cannot be written', async () => {
    const fs = await import('fs');
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const result = await adapter.execute({
      prompt: 'review only',
      context: { workingDirectory: '/tmp/project' },
      constraints: { sandbox: 'read-only' },
    });

    expect(result.status).toBe('error');
    expect(result.output).toContain('Failed to write Gemini read-only policy file');
    // Must NOT have spawned gemini without the deny policy.
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it('cleans up the policy temp file after a read-only dispatch', async () => {
    let policyPath: string | undefined;
    mockExeca.mockImplementationOnce(((_cmd: string, args: string[]) => {
      policyPath = policyPathFromArgs(args);
      return Promise.resolve({
        stdout: `${JSON.stringify({ response: 'ok' })}\n`,
        stderr: '',
        exitCode: 0,
      });
    }) as never);

    await adapter.execute({
      prompt: 'review only',
      context: { workingDirectory: '/tmp/project' },
      constraints: { sandbox: 'read-only' },
    });

    expect(policyPath).toBeDefined();
    expect(existsSync(policyPath!)).toBe(false);
  });

  it('does NOT inject --policy or the trust env when the dispatch is not read-only', async () => {
    let observedArgs: string[] = [];
    let observedEnv: Record<string, string> | undefined;
    mockExeca.mockImplementationOnce(((_cmd: string, args: string[], options: {
      env?: Record<string, string>;
    }) => {
      observedArgs = args;
      observedEnv = options.env;
      return Promise.resolve({
        stdout: `${JSON.stringify({ response: 'ok' })}\n`,
        stderr: '',
        exitCode: 0,
      });
    }) as never);

    await adapter.execute({
      prompt: 'implement',
      context: { workingDirectory: '/tmp/project' },
      constraints: { sandbox: 'workspace-write' },
    });

    expect(observedArgs).toEqual(['--output-format', 'json']);
    expect(observedArgs).not.toContain('--policy');
    expect(observedEnv?.GEMINI_CLI_TRUST_WORKSPACE).toBeUndefined();
  });

  it('extracts semantic version tag', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: 'gemini-cli 1.2.3',
      stderr: '',
      exitCode: 0,
    } as any);

    const tag = await adapter.getCliVersionTag();
    expect(tag).toBe('gemini-cli@1.2.3');
  });

  it('maps non-zero execute exit codes to error status', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({ type: 'result', content: 'failed' }),
      stderr: 'failure',
      exitCode: 1,
    } as any);

    const result = await adapter.execute({
      prompt: 'test',
      context: { workingDirectory: '/tmp/project' },
    });

    expect(result.status).toBe('error');
  });

  it('delivers the composed prompt via stdin, not argv', async () => {
    const composedPrompt = '## Peer messages\n\nforwarded context\nactual task';
    mockExeca.mockResolvedValueOnce({
      stdout: `${JSON.stringify({ type: 'result', content: 'ok' })}\n`,
      stderr: '',
      exitCode: 0,
    } as any);

    await adapter.execute({
      prompt: composedPrompt,
      context: { workingDirectory: '/tmp/project' },
    });

    const [, args, options] = mockExeca.mock.calls[0] as [string, string[], { input?: string }];
    // Gemini runs headless on `--output-format json`; the prompt must not be
    // a positional or post-`--` argv token (Gemini would never see it).
    expect(args).toEqual(['--output-format', 'json']);
    expect(args).not.toContain('--');
    expect(args).not.toContain(composedPrompt);
    expect(options.input).toBe(composedPrompt);
  });

  it('delivers a leading-dash prompt via stdin so it is never parsed as a flag', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: `${JSON.stringify({ type: 'result', content: 'ok' })}\n`,
      stderr: '',
      exitCode: 0,
    } as any);

    await adapter.execute({
      prompt: '-not-a-gemini-flag',
      context: { workingDirectory: '/tmp/project' },
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'gemini',
      ['--output-format', 'json'],
      expect.objectContaining({
        cwd: '/tmp/project',
        input: '-not-a-gemini-flag',
        reject: false,
      }),
    );
  });

  it('delivers a prompt that would exceed the argv byte budget via stdin', async () => {
    const largePrompt = 'x'.repeat(129 * 1024);
    mockExeca.mockResolvedValueOnce({
      stdout: `${JSON.stringify({ type: 'result', content: 'ok' })}\n`,
      stderr: '',
      exitCode: 0,
    } as any);

    const result = await adapter.execute({
      prompt: largePrompt,
      context: { workingDirectory: '/tmp/project' },
    });

    // stdin has no argv byte limit, so a large prompt is delivered, not rejected.
    expect(mockExeca).toHaveBeenCalledTimes(1);
    const [, args, options] = mockExeca.mock.calls[0] as [string, string[], { input?: string }];
    expect(args).toEqual(['--output-format', 'json']);
    expect(options.input).toBe(largePrompt);
    expect(result.status).toBe('success');
  });

  it('passes --model when specified in execute constraints', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: `${JSON.stringify({ type: 'result', content: 'ok' })}\n`,
      stderr: '',
      exitCode: 0,
    } as any);

    await adapter.execute({
      prompt: 'test',
      context: { workingDirectory: '/tmp/project' },
      constraints: { model: 'gemini-2.5-pro' },
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'gemini',
      ['--output-format', 'json', '--model', 'gemini-2.5-pro'],
      expect.objectContaining({
        cwd: '/tmp/project',
        input: 'test',
        reject: false,
      }),
    );
  });

  it('passes --model through executeWithSchema', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: `${JSON.stringify({ response: '{"ok":true}' })}\n`,
      stderr: '',
      exitCode: 0,
    } as any);

    const result = await adapter.executeWithSchema(
      'return json',
      z.object({ ok: z.boolean() }),
      {
        workingDirectory: '/tmp/project',
        model: 'gemini-2.5-flash',
      },
    );

    expect(result).toEqual({ ok: true });
    const callArgs = mockExeca.mock.calls[0];
    expect(callArgs?.[1]).toEqual([
      '--output-format',
      'json',
      '--model',
      'gemini-2.5-flash',
    ]);
    expect((callArgs?.[2] as { input?: string }).input).toContain('return json');
  });

  it('does not replay the full transcript inline when resuming a provider session', async () => {
    mockExeca
      .mockResolvedValueOnce({
        stdout: 'gemini-cli 0.20.1',
        stderr: '',
        exitCode: 0,
      } as any)
      .mockResolvedValueOnce({
        stdout: [
          JSON.stringify({ type: 'init', session_id: 'session-2' }),
          JSON.stringify({
            type: 'message',
            role: 'assistant',
            content: JSON.stringify({
              type: 'finish',
              output: 'done',
              reasoning: 'workflow complete',
            }),
          }),
          JSON.stringify({ type: 'result' }),
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      } as any);

    const result = await adapter.executeWithTools(
      [
        {
          name: 'run_decompose',
          description: 'decompose request',
          inputSchema: { type: 'object' },
        },
      ],
      [{ role: 'assistant', content: 'prior transcript should not be replayed inline' }],
      vi.fn(async () => ({ output: { ok: true } })),
      {
        workingDirectory: '/tmp/project',
        providerSession: {
          provider: 'gemini',
          transport: 'stateful-resume',
          sessionId: 'session-1',
          toolNamespace: 'mcp__crew__',
          toolSchemaHash: 'abc',
          startedAt: new Date().toISOString(),
        },
        toolNamespace: 'mcp__crew__',
        toolSchemaHash: 'abc',
      },
    );

    expect(result.status).toBe('completed');
    const args = mockExeca.mock.calls[1]?.[1] as string[];
    expect(args).toContain('--resume');
    // With --prompt the prompt is at index args.indexOf('--prompt') + 1.
    const promptIndex = args.indexOf('--prompt');
    expect(promptIndex).toBeGreaterThan(-1);
    const prompt = args[promptIndex + 1] ?? '';
    expect(prompt).toContain('provider resume session already contains prior turns');
    expect(prompt).not.toContain('prior transcript should not be replayed inline');
  });

  it('returns structured error results when the gemini process rejects', async () => {
    mockExeca.mockRejectedValueOnce(new Error('spawn failed'));

    const result = await adapter.execute({
      prompt: 'test',
      context: { workingDirectory: '/tmp/project' },
    });

    expect(result.status).toBe('error');
    expect(result.output).toContain('spawn failed');
    expect(result.metadata.rawEvents).toEqual([
      expect.objectContaining({
        error: 'spawn failed',
      }),
    ]);
  });

  it('returns interrupted and skips fallback prompt loop when signal is already aborted', async () => {
    const executeWithSchemaSpy = vi.spyOn(adapter, 'executeWithSchema');
    vi.spyOn(adapter as any, 'executeWithResumeSession').mockRejectedValueOnce(
      new Error('resume path failed'),
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
