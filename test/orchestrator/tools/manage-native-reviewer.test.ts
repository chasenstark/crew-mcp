import { mkdtempSync, rmSync } from 'node:fs';
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
});
