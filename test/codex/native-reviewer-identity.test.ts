import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodexModelRpcSession } from '../../src/adapters/codex-models.js';
import {
  isCanonicalNativeReviewerTaskName,
  nativeReviewerTaskNameSchema,
  NativeReviewerIdentityError,
  resolveNativeReviewerTaskIdentity,
} from '../../src/codex/native-reviewer-identity.js';

const PARENT = '01a19cd0-595f-7553-ab1b-879b07e658ab';
const CHILD = '01a19cd0-6f1c-7e30-80c4-e2ffd28add6d';
const OTHER = '01a19cd0-6f1c-7e30-80c4-e2ffd28add6e';
const TASK = '/root/reviewer';
const SECRET = 'PRIVATE_PROVIDER_PREVIEW_SENTINEL';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('native reviewer task identity', () => {
  let root: string;
  let repoRoot: string;
  let otherRepo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-native-identity-'));
    repoRoot = realpathSync(mkdtempSync(join(root, 'repo-')));
    otherRepo = realpathSync(mkdtempSync(join(root, 'other-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function parent() {
    return { id: PARENT, cwd: repoRoot, ephemeral: false, turns: [] };
  }

  function child(overrides: Record<string, unknown> = {}) {
    return {
      id: CHILD,
      cwd: repoRoot,
      ephemeral: false,
      turns: [],
      parentThreadId: null,
      source: { subAgent: { thread_spawn: {
        parent_thread_id: PARENT,
        agent_path: TASK,
        depth: 1,
      } } },
      ...overrides,
    };
  }

  function source(parentId: string = PARENT, taskName: unknown = TASK) {
    return { subAgent: { thread_spawn: {
      parent_thread_id: parentId,
      agent_path: taskName,
      depth: 1,
    } } };
  }

  function harness(options: {
    list?: (params: Record<string, unknown>) => unknown | Promise<unknown>;
    read?: (id: string) => unknown | Promise<unknown>;
    initialize?: () => unknown | Promise<unknown>;
  } = {}) {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'initialize') return options.initialize?.() ?? {};
      if (method === 'thread/list') {
        return options.list?.(params) ?? { data: params.archived ? [] : [child()], nextCursor: null };
      }
      if (method === 'thread/read') {
        return options.read?.(params.threadId as string)
          ?? { thread: params.threadId === PARENT ? parent() : child({ parentThreadId: PARENT }) };
      }
      throw new Error('Unexpected RPC');
    });
    const notify = vi.fn();
    const close = vi.fn(async () => undefined);
    const session: CodexModelRpcSession = { request, notify, close };
    const openSession = vi.fn(async () => session);
    const lookup = () => resolveNativeReviewerTaskIdentity({ repoRoot, threadId: PARENT, taskName: TASK }, { openSession });
    return { session, request, notify, close, openSession, lookup };
  }

  it.each([false, true])('resolves one %s-archived child using only complete metadata queries', async (archived) => {
    const h = harness({ list: (params) => ({ data: params.archived === archived ? [child()] : [] }) });
    await expect(h.lookup()).resolves.toBe(CHILD);
    expect(h.notify).toHaveBeenCalledWith('initialized', {});
    expect(h.request).toHaveBeenCalledWith('initialize', {
      clientInfo: expect.objectContaining({ name: 'crew_mcp_native_reviewer_identity' }),
    });
    expect(h.request.mock.calls.map(([method]) => method)).toEqual([
      'initialize', 'thread/read', 'thread/list', 'thread/list', 'thread/read',
    ]);
    for (const state of [false, true]) {
      expect(h.request).toHaveBeenCalledWith('thread/list', {
        cwd: repoRoot,
        archived: state,
        sourceKinds: ['subAgentThreadSpawn'],
        modelProviders: [],
        useStateDbOnly: true,
        limit: 50,
      });
    }
    for (const id of [PARENT, CHILD]) {
      expect(h.request).toHaveBeenCalledWith('thread/read', { threadId: id, includeTurns: false });
    }
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('canonicalizes the trusted repository before listing', async () => {
    const alias = join(root, 'alias');
    symlinkSync(repoRoot, alias, 'dir');
    const h = harness();
    await expect(resolveNativeReviewerTaskIdentity({ repoRoot: alias, threadId: PARENT, taskName: TASK }, { openSession: h.openSession }))
      .resolves.toBe(CHILD);
    expect(h.request).toHaveBeenCalledWith('thread/list', expect.objectContaining({ cwd: repoRoot }));
  });

  it.each([
    '/root/reviewer', '/root/review_2', '/root/worker/nested_reviewer',
  ])('accepts canonical task path %s', (taskName) => {
    expect(nativeReviewerTaskNameSchema.safeParse(taskName).success).toBe(true);
    expect(isCanonicalNativeReviewerTaskName(taskName)).toBe(true);
  });

  it.each([
    '', '/root', 'reviewer', 'root/reviewer', '/root//reviewer', '/root/reviewer/',
    '/root/../reviewer', '/root/Reviewer', '/root/a-b', '/root/a b', '/root/a\n',
    `/root/${'a'.repeat(256)}`,
  ])('rejects noncanonical task path %j before opening a session', async (taskName) => {
    const h = harness();
    await expect(resolveNativeReviewerTaskIdentity({ repoRoot, threadId: PARENT, taskName }, { openSession: h.openSession }))
      .rejects.toBeInstanceOf(NativeReviewerIdentityError);
    expect(h.openSession).not.toHaveBeenCalled();
  });

  it.each(['wrong-parent', 'wrong-path', 'wrong-repo', 'self'])('does not resolve a %s candidate', async (variant) => {
    const row = child(variant === 'wrong-parent' ? { source: source(OTHER) }
      : variant === 'wrong-path' ? { source: source(PARENT, '/root/other') }
        : variant === 'wrong-repo' ? { cwd: otherRepo } : { id: PARENT });
    const h = harness({ list: () => ({ data: [row], nextCursor: null }) });
    await expect(h.lookup()).rejects.toBeInstanceOf(NativeReviewerIdentityError);
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('ignores well-formed unrelated children without using nicknames, previews or titles', async () => {
    const h = harness({ list: (params) => ({ data: params.archived ? [] : [
      child({ id: OTHER, source: source(OTHER), name: TASK, agentNickname: TASK, preview: SECRET }),
      child({ preview: SECRET }),
    ] }) });
    await expect(h.lookup()).resolves.toBe(CHILD);
  });

  it('rejects a mis-scoped repository row even when its parent is unrelated', async () => {
    const h = harness({ list: () => ({ data: [
      child(), child({ id: OTHER, cwd: otherRepo, source: source(OTHER) }),
    ] }) });
    await expect(h.lookup()).rejects.toBeInstanceOf(NativeReviewerIdentityError);
  });

  it.each(['different-id', 'same-id'])('refuses %s duplicate paths across active and archived state', async (variant) => {
    const h = harness({ list: (params) => ({ data: [child({ id: params.archived && variant === 'different-id' ? OTHER : CHILD })] }) });
    await expect(h.lookup()).rejects.toBeInstanceOf(NativeReviewerIdentityError);
    expect(h.request.mock.calls.filter(([method]) => method === 'thread/list')).toHaveLength(2);
    expect(h.request).not.toHaveBeenCalledWith('thread/read', { threadId: CHILD, includeTurns: false });
  });

  it('exhausts pagination even after finding a candidate', async () => {
    const h = harness({ list: (params) => {
      if (params.archived) return { data: [] };
      return params.cursor === undefined
        ? { data: [child()], nextCursor: 'next' }
        : { data: [child({ id: OTHER, source: source(PARENT, '/root/another') })], nextCursor: null };
    } });
    await expect(h.lookup()).resolves.toBe(CHILD);
    expect(h.request).toHaveBeenCalledWith('thread/list', expect.objectContaining({ cursor: 'next', archived: false }));
  });

  it('rejects repeated cursors before looping', async () => {
    const h = harness({ list: () => ({ data: [], nextCursor: 'repeat' }) });
    await expect(h.lookup()).rejects.toBeInstanceOf(NativeReviewerIdentityError);
    expect(h.request.mock.calls.filter(([method]) => method === 'thread/list')).toHaveLength(2);
  });

  it('refuses incomplete enumeration at the total page cap', async () => {
    let cursor = 0;
    const h = harness({ list: () => ({ data: [], nextCursor: `page-${++cursor}` }) });
    await expect(h.lookup()).rejects.toBeInstanceOf(NativeReviewerIdentityError);
    expect(h.request.mock.calls.filter(([method]) => method === 'thread/list')).toHaveLength(8);
  });

  it.each([
    null, {}, { data: null }, { data: [], nextCursor: 2 }, { data: [], nextCursor: '' },
    { data: [], nextCursor: 'x'.repeat(4097) },
  ])('fails closed on malformed list result %j', async (result) => {
    const h = harness({ list: () => Promise.resolve(result) });
    await expect(h.lookup()).rejects.toBeInstanceOf(NativeReviewerIdentityError);
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('bounds oversized pages and total response bytes', async () => {
    const oversized = harness({ list: () => ({ data: Array.from({ length: 51 }, () => child()) }) });
    await expect(oversized.lookup()).rejects.toBeInstanceOf(NativeReviewerIdentityError);
    const bytes = harness({ list: () => ({ data: [child({ preview: SECRET.repeat(30_000) })] }) });
    await expect(bytes.lookup()).rejects.toBeInstanceOf(NativeReviewerIdentityError);
    expect(bytes.close).toHaveBeenCalledOnce();
  });

  it.each(['path', 'lineage', 'parent-conflict', 'ephemeral', 'transcript', 'id', 'depth'])('refuses missing/invalid candidate metadata: %s', async (variant) => {
    const row = child(variant === 'path' ? { source: source(PARENT, null) }
      : variant === 'lineage' ? { source: {} }
        : variant === 'parent-conflict' ? { parentThreadId: OTHER }
          : variant === 'ephemeral' ? { ephemeral: true }
            : variant === 'transcript' ? { turns: [{ preview: SECRET }] }
              : variant === 'id' ? { id: 'not-a-uuid' }
                : { source: { subAgent: { thread_spawn: { parent_thread_id: PARENT, agent_path: TASK } } } });
    const h = harness({ list: () => ({ data: [row] }) });
    await expect(h.lookup()).rejects.toBeInstanceOf(NativeReviewerIdentityError);
  });

  it.each(['id', 'path', 'parent', 'repo', 'top-parent', 'ephemeral'])('rechecks changed %s on metadata-only child readback', async (variant) => {
    const changed = child(variant === 'id' ? { id: OTHER }
      : variant === 'path' ? { source: source(PARENT, '/root/replacement') }
        : variant === 'parent' ? { source: source(OTHER) }
          : variant === 'repo' ? { cwd: otherRepo }
            : variant === 'top-parent' ? { parentThreadId: OTHER } : { ephemeral: true });
    const h = harness({ read: (id) => ({ thread: id === PARENT ? parent() : changed }) });
    await expect(h.lookup()).rejects.toBeInstanceOf(NativeReviewerIdentityError);
  });

  it('requires the trusted parent to exist in the expected repository before listing', async () => {
    const h = harness({ read: () => ({ thread: { ...parent(), cwd: otherRepo } }) });
    await expect(h.lookup()).rejects.toBeInstanceOf(NativeReviewerIdentityError);
    expect(h.request.mock.calls.some(([method]) => method === 'thread/list')).toBe(false);
  });

  it('does not expose provider errors, previews or causes', async () => {
    const h = harness({ list: () => { throw new Error(`Unsupported public method: ${SECRET}`); } });
    const error = await h.lookup().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(NativeReviewerIdentityError);
    expect(String(error)).toContain('join the native reviewer directly');
    expect(String(error)).not.toContain(SECRET);
    expect((error as Error).cause).toBeUndefined();
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('times out the whole lookup and closes a stalled session without later RPCs', async () => {
    const stalled = deferred<unknown>();
    const h = harness({ initialize: () => stalled.promise });
    await expect(resolveNativeReviewerTaskIdentity({ repoRoot, threadId: PARENT, taskName: TASK }, {
      openSession: h.openSession,
      timeoutMs: 25,
    })).rejects.toBeInstanceOf(NativeReviewerIdentityError);
    expect(h.close).toHaveBeenCalledOnce();
    stalled.resolve({});
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('closes a session whose opener resolves after the wall timeout', async () => {
    const opened = deferred<CodexModelRpcSession>();
    const h = harness();
    const openSession = vi.fn(() => opened.promise);
    await expect(resolveNativeReviewerTaskIdentity({ repoRoot, threadId: PARENT, taskName: TASK }, {
      openSession,
      timeoutMs: 25,
    })).rejects.toBeInstanceOf(NativeReviewerIdentityError);
    expect(openSession).toHaveBeenCalledOnce();
    opened.resolve(h.session);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.request).not.toHaveBeenCalled();
  });
});
