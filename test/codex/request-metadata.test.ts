import { describe, expect, it } from 'vitest';

import { resolveCodexThreadIdFromRequestMeta } from '../../src/codex/request-metadata.js';

const THREAD_ID = '01a02a12-5441-7ca3-b2b3-fa09c9c6b26d';

describe('Codex MCP request metadata', () => {
  it('accepts matching top-level and turn-metadata thread ids', () => {
    expect(resolveCodexThreadIdFromRequestMeta({
      threadId: THREAD_ID,
      'x-codex-turn-metadata': { thread_id: THREAD_ID },
    })).toEqual({ threadId: THREAD_ID });
  });

  it('accepts either Codex thread metadata shape independently', () => {
    expect(resolveCodexThreadIdFromRequestMeta({ threadId: THREAD_ID }))
      .toEqual({ threadId: THREAD_ID });
    expect(resolveCodexThreadIdFromRequestMeta({
      'x-codex-turn-metadata': { thread_id: THREAD_ID },
    })).toEqual({ threadId: THREAD_ID });
  });

  it('refuses invalid or conflicting request metadata', () => {
    expect(resolveCodexThreadIdFromRequestMeta({ threadId: 'not-a-thread' }))
      .toEqual({ reason: 'invalid _meta.threadId' });
    expect(resolveCodexThreadIdFromRequestMeta({
      threadId: THREAD_ID,
      'x-codex-turn-metadata': {
        thread_id: '01a02a12-5441-7ca3-b2b3-fa09c9c6b26e',
      },
    })).toEqual({ reason: 'conflicting Codex thread ids in MCP request metadata' });
  });
});
