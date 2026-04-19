/**
 * M4-2 — compression advisory unit tests.
 *
 * Exercises shouldAdviseCompression(session) directly: the helper decides
 * whether the next captain turn's system prompt should append a nudge to
 * call `compress_context`. Two thresholds, both must trigger — a short
 * session with a few large tool_results doesn't need compression; a long
 * session that just compressed also doesn't.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CaptainSession } from '../../src/captain/session.js';
import { shouldAdviseCompression } from '../../src/captain/session-loop.js';

describe('shouldAdviseCompression', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-m4-advisory-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns undefined on an empty session', () => {
    const s = CaptainSession.create({ projectRoot: root });
    expect(shouldAdviseCompression(s)).toBeUndefined();
  });

  it('returns undefined when the session is short regardless of byte size', () => {
    // 10 turns of small messages → below the turn threshold even though
    // compress_context never got called.
    const s = CaptainSession.create({ projectRoot: root });
    for (let i = 0; i < 10; i++) {
      s.appendUserMessage(`u${i}`);
    }
    expect(shouldAdviseCompression(s)).toBeUndefined();
  });

  it('returns undefined when the session is long but small in bytes', () => {
    // 20 turns of tiny messages — crosses turn threshold but not the bytes
    // threshold. Both must trigger together for the advisory to fire.
    const s = CaptainSession.create({ projectRoot: root });
    for (let i = 0; i < 20; i++) {
      s.appendUserMessage('x');
    }
    expect(shouldAdviseCompression(s)).toBeUndefined();
  });

  it('fires when both thresholds trip (long + heavy session, never compressed)', () => {
    const s = CaptainSession.create({ projectRoot: root });
    const padding = 'x'.repeat(10_000);
    for (let i = 0; i < 16; i++) {
      s.appendUserMessage(padding);
    }
    const advisory = shouldAdviseCompression(s);
    expect(advisory).toBeDefined();
    expect(advisory).toContain('compress_context');
  });

  it('resets after a compress_context tool call (does not re-fire immediately)', () => {
    const s = CaptainSession.create({ projectRoot: root });
    const padding = 'x'.repeat(10_000);
    for (let i = 0; i < 16; i++) {
      s.appendUserMessage(padding);
    }
    expect(shouldAdviseCompression(s)).toBeDefined();

    // Simulate the captain calling compress_context.
    s.appendToolCall({ toolCallId: 'c', toolName: 'compress_context', input: {} });
    s.appendToolResult({ toolCallId: 'c', output: { summary: 'ok' }, status: 'success' });

    expect(shouldAdviseCompression(s)).toBeUndefined();
  });

  it('includes a useful turn-count hint in the advisory text', () => {
    const s = CaptainSession.create({ projectRoot: root });
    const padding = 'y'.repeat(10_000);
    for (let i = 0; i < 20; i++) {
      s.appendUserMessage(padding);
    }
    const advisory = shouldAdviseCompression(s);
    // Exact KB value is a rough proxy; assert the shape, not the number.
    expect(advisory).toMatch(/~\d+ KB of history/);
    expect(advisory).toMatch(/compress_context last called: (never|\d+ messages)/);
  });
});
