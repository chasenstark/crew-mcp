import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGeminiResumeArgs, isVersionBelowFloor } from '../../src/adapters/gemini-cli.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

const { execa } = await import('execa');
const mockExeca = vi.mocked(execa);
const { GeminiCliAdapter } = await import('../../src/adapters/gemini-cli.js');

describe('buildGeminiResumeArgs', () => {
  it('emits seed-turn args with positional prompt when no sessionId', () => {
    expect(buildGeminiResumeArgs(undefined, 'hello')).toEqual([
      '-o',
      'stream-json',
      'hello',
    ]);
  });

  it('emits resume-turn args with --prompt when a sessionId is present', () => {
    expect(buildGeminiResumeArgs('uuid-1', 'prime after 5?')).toEqual([
      '-o',
      'stream-json',
      '--resume',
      'uuid-1',
      '--prompt',
      'prime after 5?',
    ]);
  });

  it('never places the prompt before --resume', () => {
    const args = buildGeminiResumeArgs('uuid-1', 'hi');
    const resumeIndex = args.indexOf('--resume');
    const promptFlagIndex = args.indexOf('--prompt');
    expect(resumeIndex).toBeLessThan(promptFlagIndex);
  });
});

describe('GeminiCliAdapter resume path', () => {
  let adapter: InstanceType<typeof GeminiCliAdapter>;

  beforeEach(() => {
    adapter = new GeminiCliAdapter();
    vi.clearAllMocks();
  });

  it('captures session_id from the init event on the first resume turn', async () => {
    vi.spyOn(adapter, 'getCliVersionTag').mockResolvedValue('gemini-cli@0.20.1');

    const capturedSessionIds: (string | undefined)[] = [];

    mockExeca.mockResolvedValueOnce({
      stdout: [
        JSON.stringify({ type: 'init', session_id: 'captured-session' }),
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
      [{ name: 'run_decompose', description: 'decompose', inputSchema: { type: 'object' } }],
      [{ role: 'user', content: 'start' }],
      vi.fn(async () => ({ output: { ok: true } })),
      {
        workingDirectory: '/tmp/project',
        toolNamespace: 'mcp__crew__',
        toolSchemaHash: 'abc',
        onProviderSession: (session) => {
          capturedSessionIds.push(session.sessionId);
        },
      },
    );

    expect(result.status).toBe('completed');
    expect(capturedSessionIds).toContain('captured-session');
  });

  it('filters the --prompt deprecation assistant message before validating the decision', async () => {
    vi.spyOn(adapter, 'getCliVersionTag').mockResolvedValue('gemini-cli@0.20.1');

    mockExeca.mockResolvedValueOnce({
      stdout: [
        JSON.stringify({ type: 'init', session_id: 's-1' }),
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          content: 'The --prompt (-p) flag has been deprecated.',
        }),
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          content: JSON.stringify({
            type: 'finish',
            output: 'final',
            reasoning: 'complete',
          }),
        }),
        JSON.stringify({ type: 'result' }),
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    } as any);

    const result = await adapter.executeWithTools(
      [{ name: 'noop', description: '', inputSchema: { type: 'object' } }],
      [{ role: 'user', content: 'go' }],
      vi.fn(async () => ({ output: { ok: true } })),
      {
        workingDirectory: '/tmp/project',
        toolNamespace: 'mcp__crew__',
        toolSchemaHash: 'abc',
      },
    );

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.output).toBe('final');
    }
  });
});

describe('isVersionBelowFloor', () => {
  it('returns true when the parsed version is null (unparseable)', () => {
    expect(isVersionBelowFloor(null)).toBe(true);
  });

  it('rejects versions below 0.20.0', () => {
    expect(isVersionBelowFloor({ major: 0, minor: 16, patch: 0 })).toBe(true);
    expect(isVersionBelowFloor({ major: 0, minor: 19, patch: 99 })).toBe(true);
  });

  it('accepts 0.20.0 and above', () => {
    expect(isVersionBelowFloor({ major: 0, minor: 20, patch: 0 })).toBe(false);
    expect(isVersionBelowFloor({ major: 0, minor: 21, patch: 0 })).toBe(false);
    expect(isVersionBelowFloor({ major: 1, minor: 0, patch: 0 })).toBe(false);
  });
});
