import { describe, expect, it, vi } from 'vitest';

import { processNativeReviewerHook } from '../../src/cli/native-reviewer-hook.js';

describe('native reviewer hook', () => {
  const sessionId = '019f5d0f-a60c-7d53-9f35-2036d92d71ec';
  const agentId = '019f5d0f-a60c-7d53-9f35-2036d92d71ed';

  it('passes only trusted identity and repository scope to the completion store', async () => {
    const resolveRepoRoot = vi.fn(async () => '/repo');
    const recordCompletion = vi.fn(async () => ({
      state: 'delivered' as const,
      action: 'wake_queued' as const,
    }));
    const raw = JSON.stringify({
      hook_event_name: 'SubagentStop',
      session_id: sessionId,
      turn_id: 'ignored',
      agent_id: agentId,
      cwd: '/repo/subdir',
      last_assistant_message: 'sensitive reviewer output',
    });

    await expect(processNativeReviewerHook(raw, {
      crewHome: '/crew',
      resolveRepoRoot,
      recordCompletion,
    })).resolves.toEqual({ handled: true, action: 'wake_queued' });
    expect(resolveRepoRoot).toHaveBeenCalledWith({ cwd: '/repo/subdir' });
    expect(recordCompletion).toHaveBeenCalledWith({
      crewHome: '/crew',
      repoRoot: '/repo',
      threadId: sessionId,
      agentId,
    });
    expect(JSON.stringify(recordCompletion.mock.calls)).not.toContain('sensitive reviewer output');
  });

  it('fails closed for non-events, malformed input, and missing absolute cwd', async () => {
    const recordCompletion = vi.fn();
    const deps = { recordCompletion };
    await expect(processNativeReviewerHook('{', deps)).resolves.toMatchObject({ handled: false });
    await expect(processNativeReviewerHook(JSON.stringify({
      hook_event_name: 'AfterTool',
    }), deps)).resolves.toMatchObject({ handled: false });
    await expect(processNativeReviewerHook(JSON.stringify({
      hook_event_name: 'SubagentStop',
      session_id: sessionId,
      agent_id: agentId,
      cwd: 'relative',
    }), deps)).resolves.toMatchObject({ handled: false });
    expect(recordCompletion).not.toHaveBeenCalled();
  });

  it('rejects hook input larger than 64 KiB without parsing reviewer content', async () => {
    const recordCompletion = vi.fn();
    const outcome = await processNativeReviewerHook('x'.repeat((64 * 1_024) + 1), {
      recordCompletion,
    });
    expect(outcome).toEqual({
      handled: false,
      reason: 'hook input exceeded 64 KiB',
    });
    expect(recordCompletion).not.toHaveBeenCalled();
  });
});
