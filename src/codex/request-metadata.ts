import { validateCodexThreadId } from './app-server-bridge.js';

export interface CodexMcpRequestMeta {
  readonly threadId?: unknown;
  readonly 'x-codex-turn-metadata'?: unknown;
}

export interface CodexThreadIdResolution {
  readonly threadId?: string;
  readonly reason?: string;
}

/**
 * Resolve the current Codex thread from per-call MCP request metadata.
 *
 * Codex 0.149+ attaches the thread both as `_meta.threadId` and as
 * `_meta["x-codex-turn-metadata"].thread_id`. The duplicated values are a
 * useful integrity check: refuse conflicting request metadata instead of
 * enqueueing a wake onto an ambiguous thread.
 */
export function resolveCodexThreadIdFromRequestMeta(
  meta: CodexMcpRequestMeta | undefined,
): CodexThreadIdResolution {
  if (meta === undefined) return {};

  const topLevel = validatedThreadId(meta.threadId, '_meta.threadId');
  if (topLevel.reason !== undefined) return topLevel;

  const turnMetadata = meta['x-codex-turn-metadata'];
  if (
    turnMetadata !== undefined
    && (turnMetadata === null || typeof turnMetadata !== 'object' || Array.isArray(turnMetadata))
  ) {
    return { reason: 'invalid _meta["x-codex-turn-metadata"]' };
  }
  const nested = validatedThreadId(
    turnMetadata === undefined
      ? undefined
      : (turnMetadata as Record<string, unknown>).thread_id,
    '_meta["x-codex-turn-metadata"].thread_id',
  );
  if (nested.reason !== undefined) return nested;

  if (
    topLevel.threadId !== undefined
    && nested.threadId !== undefined
    && topLevel.threadId !== nested.threadId
  ) {
    return { reason: 'conflicting Codex thread ids in MCP request metadata' };
  }

  return { threadId: topLevel.threadId ?? nested.threadId };
}

function validatedThreadId(
  value: unknown,
  source: string,
): CodexThreadIdResolution {
  if (value === undefined) return {};
  if (typeof value !== 'string') return { reason: `invalid ${source}` };
  try {
    validateCodexThreadId(value);
    return { threadId: value };
  } catch {
    return { reason: `invalid ${source}` };
  }
}
