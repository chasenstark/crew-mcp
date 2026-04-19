import { describe, expect, it } from 'vitest';
import { buildCodexResumeArgs } from '../../src/adapters/codex.js';
import { toCodexConfigOverrides } from '../../src/captain/mcp-registration.js';

describe('buildCodexResumeArgs', () => {
  const prompt = 'Say hi.';

  it('emits the seed-turn shape when no session exists', () => {
    expect(buildCodexResumeArgs({}, prompt)).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      prompt,
    ]);
  });

  it('uses the resume subcommand when sessionId is present', () => {
    expect(buildCodexResumeArgs({ sessionId: 'abc-123' }, prompt)).toEqual([
      'exec',
      'resume',
      'abc-123',
      '--json',
      '--skip-git-repo-check',
      prompt,
    ]);
  });

  it('prefers sessionId over threadId when both are present', () => {
    expect(
      buildCodexResumeArgs({ sessionId: 'session-x', threadId: 'thread-y' }, prompt),
    ).toEqual([
      'exec',
      'resume',
      'session-x',
      '--json',
      '--skip-git-repo-check',
      prompt,
    ]);
  });

  it('falls back to threadId when only threadId is set', () => {
    expect(buildCodexResumeArgs({ threadId: 'thread-only' }, prompt)).toEqual([
      'exec',
      'resume',
      'thread-only',
      '--json',
      '--skip-git-repo-check',
      prompt,
    ]);
  });

  it('places --skip-git-repo-check before the prompt in both shapes', () => {
    const seedArgs = buildCodexResumeArgs({}, prompt);
    const seedSkipIndex = seedArgs.indexOf('--skip-git-repo-check');
    const seedPromptIndex = seedArgs.indexOf(prompt);
    expect(seedSkipIndex).toBeGreaterThan(-1);
    expect(seedPromptIndex).toBeGreaterThan(seedSkipIndex);

    const resumeArgs = buildCodexResumeArgs({ sessionId: 'sid' }, prompt);
    const resumeSkipIndex = resumeArgs.indexOf('--skip-git-repo-check');
    const resumePromptIndex = resumeArgs.indexOf(prompt);
    expect(resumeSkipIndex).toBeGreaterThan(-1);
    expect(resumePromptIndex).toBeGreaterThan(resumeSkipIndex);
  });

  it('appends -c override flags after the prompt', () => {
    const args = buildCodexResumeArgs({ sessionId: 'sid' }, prompt, [
      '-c',
      'mcp_servers.crew.command="/bin/crew-mcp"',
      '-c',
      'mcp_servers.crew.cwd="/tmp/crew"',
    ]);
    expect(args).toEqual([
      'exec',
      'resume',
      'sid',
      '--json',
      '--skip-git-repo-check',
      prompt,
      '-c',
      'mcp_servers.crew.command="/bin/crew-mcp"',
      '-c',
      'mcp_servers.crew.cwd="/tmp/crew"',
    ]);
  });

  it('does not inject --config from any env var (CREW_CODEX_CONFIG is advisory only)', () => {
    const args = buildCodexResumeArgs({ sessionId: 'sid' }, prompt);
    expect(args).not.toContain('--config');
  });

  it('threads a real catalog through toCodexConfigOverrides into the argv (M3-8)', () => {
    const overrides = toCodexConfigOverrides({
      mcpServers: [{ name: 'crew', command: '/bin/crew-mcp', args: ['--namespace', 'mcp__crew__'] }],
    });
    const args = buildCodexResumeArgs({ sessionId: 'sid' }, prompt, overrides);
    expect(args).toEqual([
      'exec',
      'resume',
      'sid',
      '--json',
      '--skip-git-repo-check',
      prompt,
      '-c',
      'mcp_servers.crew.command="/bin/crew-mcp"',
      '-c',
      'mcp_servers.crew.args=["--namespace", "mcp__crew__"]',
    ]);
  });
});
