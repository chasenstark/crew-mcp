import { describe, expect, it } from 'vitest';

import { makeRunId, slugifyRunIdPart } from '../../src/orchestrator/run-id.js';

/**
 * Mirror of WorktreeManager.toRunToken (private). The whole human-readable
 * run-ID scheme rests on `toRunToken(id) === id`, because the worktree
 * allocator keys on `toRunToken(runId)` while RunStateStore joins the raw
 * `runId` into the same `.crew/runs/` directory. If they diverge, a run's
 * worktree and its state.json land in different folders.
 */
function toRunToken(runId: string): string {
  const normalized = runId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'run';
}

describe('slugifyRunIdPart', () => {
  it('strips leading filler words and leads with the meaningful verb/noun', () => {
    expect(slugifyRunIdPart('Can you refactor the auth token flow')).toBe('refactor-auth-token');
  });

  it('caps length and never leaves a trailing dash', () => {
    const slug = slugifyRunIdPart('supercalifragilistic expialidocious onomatopoeia', {
      maxWords: 3,
      maxLen: 20,
    });
    expect(slug.length).toBeLessThanOrEqual(20);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('returns empty when the text has no alphanumerics', () => {
    expect(slugifyRunIdPart('!!! ??? ...')).toBe('');
  });

  it('falls back to unfiltered words when every word is a stopword', () => {
    expect(slugifyRunIdPart('the it is')).toBe('the-it-is');
  });
});

describe('makeRunId', () => {
  it('produces a self-describing <agent>-<task>-<hex> id', () => {
    const id = makeRunId('codex', 'Refactor the auth token flow');
    expect(id).toMatch(/^codex-refactor-auth-token-[0-9a-f]{8}$/);
  });

  it('preserves a kebab-case agent id like claude-code', () => {
    const id = makeRunId('claude-code', 'add tests');
    expect(id).toMatch(/^claude-code-add-tests-[0-9a-f]{8}$/);
  });

  it('omits the task slug entirely for a blank/garbage prompt', () => {
    const id = makeRunId('gemini-cli', '!!!');
    expect(id).toMatch(/^gemini-cli-[0-9a-f]{8}$/);
  });

  it('is unique across calls even with identical agent + prompt', () => {
    const a = makeRunId('codex', 'same task');
    const b = makeRunId('codex', 'same task');
    expect(a).not.toBe(b);
  });

  it('is stable under toRunToken and encodeURIComponent (the load-bearing invariant)', () => {
    for (const [agent, prompt] of [
      ['codex', 'Refactor the auth token flow'],
      ['claude-code', 'Fix the   flaky   serve.test.ts timing'],
      ['gemini-cli', 'UPPER CASE & Symbols!! in $$ prompt'],
      ['agent', ''],
    ] as const) {
      const id = makeRunId(agent, prompt);
      expect(toRunToken(id)).toBe(id);
      expect(encodeURIComponent(id)).toBe(id);
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]*[0-9a-f]$/);
    }
  });
});
