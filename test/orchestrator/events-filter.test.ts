import { describe, it, expect } from 'vitest';

import {
  filterEventsTailNoise,
  NOISE_PATTERNS,
} from '../../src/orchestrator/events-filter.js';

describe('filterEventsTailNoise', () => {
  describe('codex receipts (dropped)', () => {
    const dropped = [
      '[codex] command: started /bin/zsh -lc "ls"',
      '[codex] command: started /bin/zsh -lc "git diff origin/main..HEAD"',
      '[codex] command: /bin/zsh -lc "ls" (exit 0)',
      '[codex] command: /bin/zsh -lc "git status" (exit 0)',
      '[codex] event: item.started/web_search',
      '[codex] event: item.completed/web_search',
    ];

    it.each(dropped)('drops: %s', (line) => {
      expect(filterEventsTailNoise([line])).toEqual([]);
    });
  });

  describe('codex content + non-zero exits (kept)', () => {
    const kept = [
      '[codex] message: Working on the diff now.',
      '[codex] turn: thread started',
      '[codex] turn: started',
      '[codex] turn: completed',
      // Non-zero exits are signal: a stuck loop or killed process is
      // exactly the situation a captain would want to see in the tail.
      '[codex] command: /bin/zsh -lc "ls /nope" (exit 1)',
      '[codex] command: /bin/zsh -lc "long-task" (exit 137)',
    ];

    it.each(kept)('keeps: %s', (line) => {
      expect(filterEventsTailNoise([line])).toEqual([line]);
    });
  });

  describe('non-codex adapters (untouched)', () => {
    // Claude-code, Gemini, OpenAI-compatible, Generic all stream raw
    // model output via onOutput — no `[adapter] receipt:` shape.
    const kept = [
      'Working on the diff now.',
      '## Findings',
      '- Bullet item with details',
      '1. Numbered list item',
      'Mixed sentence with [brackets] and (parens).',
    ];

    it.each(kept)('keeps non-codex line: %s', (line) => {
      expect(filterEventsTailNoise([line])).toEqual([line]);
    });
  });

  describe('mixed input', () => {
    it('preserves order and only drops matched lines', () => {
      const input = [
        '[codex] turn: started',
        '[codex] command: started /bin/zsh -lc "git status"',
        '[codex] command: /bin/zsh -lc "git status" (exit 0)',
        '[codex] message: Found 3 uncommitted files.',
        '[codex] command: started /bin/zsh -lc "git diff"',
        '[codex] command: /bin/zsh -lc "git diff" (exit 0)',
        '[codex] message: Diff has 12 lines.',
        '[codex] command: started /bin/zsh -lc "test/run.sh"',
        '[codex] command: /bin/zsh -lc "test/run.sh" (exit 1)',
        '[codex] message: Test run failed; investigating.',
        '[codex] turn: completed',
      ];

      expect(filterEventsTailNoise(input)).toEqual([
        '[codex] turn: started',
        '[codex] message: Found 3 uncommitted files.',
        '[codex] message: Diff has 12 lines.',
        // exit 1 kept — non-zero is signal-bearing.
        '[codex] command: /bin/zsh -lc "test/run.sh" (exit 1)',
        '[codex] message: Test run failed; investigating.',
        '[codex] turn: completed',
      ]);
    });

    it('returns an empty array when every line is noise', () => {
      const input = [
        '[codex] command: started /bin/zsh -lc "a"',
        '[codex] command: /bin/zsh -lc "a" (exit 0)',
        '[codex] event: item.started/web_search',
        '[codex] event: item.completed/web_search',
      ];
      expect(filterEventsTailNoise(input)).toEqual([]);
    });

    it('does not mutate the input array', () => {
      const input = [
        '[codex] command: started /bin/zsh -lc "ls"',
        '[codex] message: ok',
      ];
      const snapshot = [...input];
      filterEventsTailNoise(input);
      expect(input).toEqual(snapshot);
    });
  });

  describe('NOISE_PATTERNS', () => {
    it('every rule carries a non-empty reason', () => {
      for (const rule of NOISE_PATTERNS) {
        expect(rule.reason.length).toBeGreaterThan(0);
      }
    });
  });
});
