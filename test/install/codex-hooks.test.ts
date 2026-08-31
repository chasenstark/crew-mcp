import { describe, expect, it } from 'vitest';

import {
  hasCodexNativeReviewerHook,
  mergeCodexNativeReviewerHook,
  removeCodexNativeReviewerHook,
} from '../../src/install/codex-hooks.js';

describe('Codex native reviewer hooks', () => {
  const command = 'npx --no-install crew-native-reviewer-hook';

  it('merges idempotently and matches only the exact installed command', () => {
    const once = mergeCodexNativeReviewerHook('', command);
    const twice = mergeCodexNativeReviewerHook(once, command);
    expect(twice).toBe(once);
    expect(hasCodexNativeReviewerHook(once, command)).toBe(true);
    expect(hasCodexNativeReviewerHook(once, 'crew-native-reviewer-hook')).toBe(false);
  });

  it('preserves unrelated root fields, events, and hooks during install and uninstall', () => {
    const existing = JSON.stringify({
      custom: { keep: true },
      hooks: {
        BeforeTool: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit' }] }],
        SubagentStop: [{
          matcher: 'special',
          hooks: [{ type: 'command', command: 'notify-user' }],
        }],
      },
    }, null, 2) + '\n';
    const merged = mergeCodexNativeReviewerHook(existing, command);
    const removed = removeCodexNativeReviewerHook(merged);
    expect(JSON.parse(removed)).toEqual(JSON.parse(existing));
  });

  it('updates a stale Crew-owned command without removing a neighboring hook', () => {
    const existing = JSON.stringify({
      hooks: {
        SubagentStop: [{
          matcher: '.*',
          hooks: [
            { type: 'command', command: '/old/crew-native-reviewer-hook' },
            { type: 'command', command: 'keep-me' },
          ],
        }],
      },
    });
    const merged = mergeCodexNativeReviewerHook(existing, command);
    expect(merged).toContain('keep-me');
    expect(merged).not.toContain('/old/crew-native-reviewer-hook');
    expect(hasCodexNativeReviewerHook(merged, command)).toBe(true);
  });

  it('refuses malformed or structurally incompatible files', () => {
    expect(() => mergeCodexNativeReviewerHook('{', command)).toThrow('invalid JSON');
    expect(() => mergeCodexNativeReviewerHook('{"hooks":[]}', command))
      .toThrow('hooks field must be an object');
    expect(() => mergeCodexNativeReviewerHook(
      '{"hooks":{"SubagentStop":{}}}',
      command,
    )).toThrow('hooks.SubagentStop must be an array');
  });
});
