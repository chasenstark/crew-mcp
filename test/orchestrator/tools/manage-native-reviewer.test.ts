import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  manageNativeReviewerInputSchema,
  manageNativeReviewerToolHandler,
} from '../../../src/orchestrator/tools/manage-native-reviewer.js';

describe('manage_native_reviewer', () => {
  const threadId = '019f5d0f-a60c-7d53-9f35-2036d92d71ec';
  const agentId = '019f5d0f-a60c-7d53-9f35-2036d92d71ed';
  let crewHome: string;
  let projectRoot: string;

  beforeEach(() => {
    crewHome = mkdtempSync(join(tmpdir(), 'crew-native-tool-home-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'crew-native-tool-repo-'));
  });

  afterEach(() => {
    rmSync(crewHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('registers against the parent thread supplied by trusted request metadata', async () => {
    const result = await manageNativeReviewerToolHandler({
      operation: 'register',
      agent_id: agentId,
      panel_id: 'panel-1',
    }, {
      _meta: {
        threadId,
        'x-codex-turn-metadata': { thread_id: threadId },
      },
      sendNotification: vi.fn(),
    }, {
      crewHome,
      projectRoot,
      getClientKind: () => 'codex',
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      operation: 'register',
      agent_id: agentId,
      panel_id: 'panel-1',
      state: 'registered',
      action: 'registered',
      mutation_authority: 'none',
    });
  });

  it('refuses missing or conflicting thread metadata and non-Codex hosts', async () => {
    const args = { operation: 'status' as const, agent_id: agentId };
    const deps = { crewHome, projectRoot, getClientKind: () => 'codex' as const };
    const missing = await manageNativeReviewerToolHandler(args, {
      sendNotification: vi.fn(),
    }, deps);
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain('trusted MCP request metadata');

    const conflicting = await manageNativeReviewerToolHandler(args, {
      _meta: {
        threadId,
        'x-codex-turn-metadata': {
          thread_id: '019f5d0f-a60c-7d53-9f35-2036d92d71ee',
        },
      },
      sendNotification: vi.fn(),
    }, deps);
    expect(conflicting.isError).toBe(true);
    expect(conflicting.content[0]?.text).toContain('conflicting Codex thread ids');

    const wrongHost = await manageNativeReviewerToolHandler(args, {
      _meta: { threadId },
      sendNotification: vi.fn(),
    }, {
      ...deps,
      getClientKind: () => 'claude-code',
    });
    expect(wrongHost.isError).toBe(true);
    expect(wrongHost.content[0]?.text).toContain('only to a supported Codex host');

    const oldCodex = await manageNativeReviewerToolHandler(args, {
      _meta: { threadId },
      sendNotification: vi.fn(),
    }, {
      ...deps,
      supportsNativeReviewerWake: () => false,
    });
    expect(oldCodex.isError).toBe(true);
    expect(oldCodex.content[0]?.text).toContain('requires Codex 0.149+ queue support');
  });

  it('keeps the lifecycle schema strict', () => {
    expect(manageNativeReviewerInputSchema.safeParse({
      operation: 'resolve',
      agent_id: agentId,
    }).success).toBe(true);
    expect(manageNativeReviewerInputSchema.safeParse({
      operation: 'resolve',
      agent_id: agentId,
      thread_id: threadId,
    }).success).toBe(false);
  });

  it('resolves a task name once and uses the returned UUID for the lifecycle', async () => {
    const resolveTaskIdentity = vi.fn().mockResolvedValue(agentId);
    const deps = { crewHome, projectRoot, getClientKind: () => 'codex' as const, resolveTaskIdentity };
    const extra = { _meta: { threadId }, sendNotification: vi.fn() };
    const registered = await manageNativeReviewerToolHandler({
      operation: 'register', task_name: '/root/reviewer', panel_id: 'panel-1',
    }, extra, deps);
    expect(resolveTaskIdentity).toHaveBeenCalledExactlyOnceWith({
      repoRoot: projectRoot, threadId, taskName: '/root/reviewer',
    });
    expect(registered.structuredContent).toMatchObject({
      operation: 'register', agent_id: agentId, state: 'registered', panel_id: 'panel-1',
    });
    for (const operation of ['status', 'resolve'] as const) {
      const result = await manageNativeReviewerToolHandler({ operation, agent_id: agentId }, extra, deps);
      expect(result.structuredContent).toMatchObject({
        agent_id: agentId, state: operation === 'status' ? 'registered' : 'resolved',
      });
    }
    expect(resolveTaskIdentity).toHaveBeenCalledTimes(1);
  });

  it('fails lookup without writing wake state or exposing provider content', async () => {
    const resolveTaskIdentity = vi.fn().mockRejectedValue(new Error('private provider preview'));
    const result = await manageNativeReviewerToolHandler({
      operation: 'register', task_name: '/root/reviewer',
    }, { _meta: { threadId }, sendNotification: vi.fn() }, {
      crewHome, projectRoot, getClientKind: () => 'codex', resolveTaskIdentity,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('join this reviewer through native tools');
    expect(JSON.stringify(result)).not.toContain('private provider preview');
    expect(readdirSync(crewHome)).toEqual([]);
  });

  it.each([
    { operation: 'register' },
    { operation: 'register', agent_id: agentId, task_name: '/root/reviewer' },
    { operation: 'status', task_name: '/root/reviewer' },
    { operation: 'resolve', task_name: '/root/reviewer' },
    { operation: 'register', task_name: 'reviewer' },
    { operation: 'register', task_name: '/root/../reviewer' },
    { operation: 'register', task_name: '/root/reviewer', thread_id: threadId },
  ])('rejects invalid identity at both schema and handler boundaries: %j', async (args) => {
    expect(manageNativeReviewerInputSchema.safeParse(args).success).toBe(false);
    const resolveTaskIdentity = vi.fn();
    const result = await manageNativeReviewerToolHandler(
      args as Parameters<typeof manageNativeReviewerToolHandler>[0],
      { _meta: { threadId }, sendNotification: vi.fn() },
      { crewHome, projectRoot, getClientKind: () => 'codex', resolveTaskIdentity },
    );
    expect(result.isError).toBe(true);
    expect(resolveTaskIdentity).not.toHaveBeenCalled();
    expect(readdirSync(crewHome)).toEqual([]);
  });

  it('does not look up task names without trusted parent metadata', async () => {
    const resolveTaskIdentity = vi.fn();
    const result = await manageNativeReviewerToolHandler({
      operation: 'register', task_name: '/root/reviewer',
    }, { sendNotification: vi.fn() }, {
      crewHome, projectRoot, getClientKind: () => 'codex', resolveTaskIdentity,
    });
    expect(result.isError).toBe(true);
    expect(resolveTaskIdentity).not.toHaveBeenCalled();
    expect(readdirSync(crewHome)).toEqual([]);
  });

  it.each([threadId, threadId.toUpperCase()])('rejects the parent UUID as a reviewer without writing state: %s', async (parentId) => {
    const result = await manageNativeReviewerToolHandler({
      operation: 'register', agent_id: parentId,
    }, { _meta: { threadId }, sendNotification: vi.fn() }, {
      crewHome, projectRoot, getClientKind: () => 'codex',
    });
    expect(result.isError).toBe(true);
    expect(readdirSync(crewHome)).toEqual([]);
  });
});
