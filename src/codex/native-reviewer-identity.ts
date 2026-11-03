import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { z } from 'zod';

import {
  openCodexAppServerSession,
  type CodexModelRpcSession,
} from '../adapters/codex-models.js';
import { CREW_MCP_VERSION } from '../cli/version.js';

const LOOKUP_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 50;
const MAX_PAGES = 8;
const MAX_THREADS = 400;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_CURSOR_LENGTH = 4096;

export const nativeReviewerTaskNameSchema = z.string().max(256)
  .regex(/^\/root(?:\/[a-z0-9_]+)+$/, 'Expected a canonical native reviewer task path');

export function isCanonicalNativeReviewerTaskName(value: unknown): value is string {
  return nativeReviewerTaskNameSchema.safeParse(value).success;
}

export interface NativeReviewerTaskIdentityInput {
  readonly repoRoot: string;
  /** Supplied by trusted MCP request metadata, never by the task-name caller. */
  readonly threadId: string;
  readonly taskName: string;
}

export interface NativeReviewerTaskIdentityOptions {
  readonly openSession?: () => Promise<CodexModelRpcSession>;
  /** May shorten the fixed lookup budget, primarily for tests. */
  readonly timeoutMs?: number;
}

export class NativeReviewerIdentityError extends Error {
  constructor() {
    super('Native reviewer identity could not be verified; keep the turn open and join the native reviewer directly');
    this.name = 'NativeReviewerIdentityError';
  }
}

interface ThreadIdentity {
  readonly id: string;
  readonly cwd: string;
  readonly ephemeral: boolean;
  readonly parentId?: string;
  readonly sourceParentId?: string;
  readonly taskName?: string;
}

function fail(): never {
  throw new NativeReviewerIdentityError();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function uuid(value: unknown): string {
  const result = z.string().uuid().safeParse(value);
  if (!result.success) fail();
  return result.data;
}

function parseThread(value: unknown, requireSource: boolean): ThreadIdentity {
  const thread = object(value);
  const id = uuid(thread.id);
  if (typeof thread.cwd !== 'string' || !isAbsolute(thread.cwd)) fail();
  if (typeof thread.ephemeral !== 'boolean') fail();
  // A metadata query must not silently grow into transcript hydration.
  if (!Array.isArray(thread.turns) || thread.turns.length !== 0) fail();
  const parentId = thread.parentThreadId == null ? undefined : uuid(thread.parentThreadId);
  let sourceParentId: string | undefined;
  let taskName: string | undefined;
  if (requireSource) {
    const source = object(thread.source);
    const subAgent = object(source.subAgent);
    const spawned = object(subAgent.thread_spawn);
    sourceParentId = uuid(spawned.parent_thread_id);
    if (!Number.isInteger(spawned.depth) || (spawned.depth as number) < 1) fail();
    if (spawned.agent_path != null) {
      if (!isCanonicalNativeReviewerTaskName(spawned.agent_path)) fail();
      taskName = spawned.agent_path;
    }
    if (parentId !== undefined && parentId !== sourceParentId) fail();
  }
  return {
    id,
    cwd: thread.cwd,
    ephemeral: thread.ephemeral,
    ...(parentId !== undefined ? { parentId } : {}),
    ...(sourceParentId !== undefined ? { sourceParentId } : {}),
    ...(taskName !== undefined ? { taskName } : {}),
  };
}

/** Resolve identity from public metadata only; never resume a thread or start a turn. */
export async function resolveNativeReviewerTaskIdentity(
  input: NativeReviewerTaskIdentityInput,
  options: NativeReviewerTaskIdentityOptions = {},
): Promise<string> {
  if (!isCanonicalNativeReviewerTaskName(input.taskName)) fail();
  uuid(input.threadId);
  if (!isAbsolute(input.repoRoot)) fail();
  const timeoutMs = options.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > LOOKUP_TIMEOUT_MS) fail();

  let session: CodexModelRpcSession | undefined;
  let expired = false;
  let timer: NodeJS.Timeout | undefined;
  let responseBytes = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new NativeReviewerIdentityError());
    }, timeoutMs);
  });
  const checkActive = () => { if (expired) fail(); };
  const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    checkActive();
    const response = await session!.request(method, params);
    checkActive();
    const encoded = JSON.stringify(response);
    if (encoded === undefined) fail();
    responseBytes += Buffer.byteLength(encoded, 'utf8');
    if (responseBytes > MAX_RESPONSE_BYTES) fail();
    return response;
  };
  const canonicalCwd = async (cwd: string): Promise<string> => {
    const result = await realpath(cwd);
    checkActive();
    return result;
  };
  const lookup = async (): Promise<string> => {
    const repoRoot = await canonicalCwd(input.repoRoot);
    const opened = await (options.openSession ?? openCodexAppServerSession)();
    // An injected/slow opener can finish after the wall deadline. It still owns
    // a process, so close it here rather than lose it after Promise.race settles.
    if (expired) {
      await opened.close().catch(() => undefined);
      fail();
    }
    session = opened;
    await request('initialize', {
      clientInfo: {
        name: 'crew_mcp_native_reviewer_identity',
        title: 'Crew native reviewer identity',
        version: CREW_MCP_VERSION,
      },
      // Active child threads require the experimental relationship filter.
      capabilities: { experimentalApi: true },
    });
    session.notify('initialized', {});

    const parentResponse = object(await request('thread/read', {
      threadId: input.threadId,
      includeTurns: false,
    }));
    const parent = parseThread(parentResponse.thread, false);
    if (parent.id !== input.threadId || parent.ephemeral
      || await canonicalCwd(parent.cwd) !== repoRoot) fail();

    let pages = 0;
    let threads = 0;
    let candidate: string | undefined;
    const seenIds = new Set<string>();
    for (const archived of [false, true]) {
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      for (;;) {
        if (++pages > MAX_PAGES) fail();
        const page = object(await request('thread/list', {
          cwd: repoRoot,
          parentThreadId: input.threadId,
          archived,
          sourceKinds: ['subAgentThreadSpawn'],
          modelProviders: [],
          useStateDbOnly: true,
          limit: PAGE_SIZE,
          ...(cursor !== undefined ? { cursor } : {}),
        }));
        if (!Array.isArray(page.data) || page.data.length > PAGE_SIZE) fail();
        threads += page.data.length;
        if (threads > MAX_THREADS) fail();
        for (const row of page.data) {
          const child = parseThread(row, true);
          // Duplicate records can mean a moving/inconsistent pagination view.
          // Even the same id crossing archive states is not a complete snapshot.
          if (seenIds.has(child.id)) fail();
          seenIds.add(child.id);
          // Treat a provider filter mismatch as an incomplete/untrusted view,
          // even if that row would not otherwise match the requested child.
          if (await canonicalCwd(child.cwd) !== repoRoot) fail();
          if (child.sourceParentId !== input.threadId) fail();
          // Missing path on a child of this parent prevents proving uniqueness.
          if (child.taskName === undefined || child.ephemeral) fail();
          if (child.taskName !== input.taskName) continue;
          if (child.id === input.threadId) fail();
          if (candidate !== undefined) fail();
          candidate = child.id;
        }
        // Optional/null means exhausted per the stable schema. Other values,
        // including an empty string or a repeated cursor, are not completion.
        if (page.nextCursor == null) break;
        if (typeof page.nextCursor !== 'string' || page.nextCursor.length === 0
          || page.nextCursor.length > MAX_CURSOR_LENGTH || seenCursors.has(page.nextCursor)) fail();
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
    }
    if (candidate === undefined) fail();
    const response = object(await request('thread/read', {
      threadId: candidate,
      includeTurns: false,
    }));
    const child = parseThread(response.thread, true);
    if (child.id !== candidate || child.id === input.threadId || child.ephemeral
      || child.sourceParentId !== input.threadId || child.taskName !== input.taskName
      || await canonicalCwd(child.cwd) !== repoRoot) fail();
    return child.id;
  };

  try {
    return await Promise.race([lookup(), timeout]);
  } catch {
    // RPC errors may contain private stderr, previews or provider payloads.
    // Return a fixed actionable error, with no original error/cause attached.
    throw new NativeReviewerIdentityError();
  } finally {
    expired = true;
    if (timer !== undefined) clearTimeout(timer);
    if (session !== undefined) await session.close().catch(() => undefined);
  }
}
