import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractFileChanges,
  findError,
  formatEventForStream,
  getLastAgentMessage,
  parseJsonl,
  type CodexEvent,
} from '../../src/adapters/codex.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf-8');
}

describe('codex parser (live 0.121.0 item.completed envelope)', () => {
  describe('getLastAgentMessage', () => {
    it('returns the text of the last agent_message item.completed event', () => {
      const { events } = parseJsonl(loadFixture('codex-live-0.121.jsonl'));
      expect(getLastAgentMessage(events)).toBe(
        'Renamed the variable across src/. Two files were modified and one was created.',
      );
    });

    it('ignores unrelated item.completed types', () => {
      const events: CodexEvent[] = [
        { type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } },
        { type: 'item.completed', item: { type: 'file_change', path: 'src/a.ts', action: 'modified' } },
      ];
      expect(getLastAgentMessage(events)).toBe('');
    });

    it('ignores legacy flat envelopes (old 0.120 and earlier shape)', () => {
      const legacy: CodexEvent[] = [
        { type: 'item.agent_message', content: 'stale shape' } as unknown as CodexEvent,
      ];
      expect(getLastAgentMessage(legacy)).toBe('');
    });

    it('returns the most recent agent message when several are present', () => {
      const events: CodexEvent[] = [
        { type: 'item.completed', item: { type: 'agent_message', text: 'first' } },
        { type: 'item.completed', item: { type: 'agent_message', text: 'second' } },
      ];
      expect(getLastAgentMessage(events)).toBe('second');
    });
  });

  describe('extractFileChanges', () => {
    it('collects file_change paths and drops action=none entries', () => {
      const { events } = parseJsonl(loadFixture('codex-live-0.121.jsonl'));
      expect(extractFileChanges(events)).toEqual(['src/foo.ts', 'src/bar.ts']);
    });

    it('ignores file_change events missing a path string', () => {
      const events: CodexEvent[] = [
        { type: 'item.completed', item: { type: 'file_change', action: 'modified' } },
        { type: 'item.completed', item: { type: 'file_change', path: 'kept.ts', action: 'modified' } },
      ];
      expect(extractFileChanges(events)).toEqual(['kept.ts']);
    });
  });

  describe('formatEventForStream', () => {
    it('returns the raw text for agent_message items', () => {
      const event: CodexEvent = {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'hello' },
      };
      expect(formatEventForStream(event)).toBe('hello');
    });

    it('wraps reasoning text with a gutter glyph', () => {
      const event: CodexEvent = {
        type: 'item.completed',
        item: { type: 'reasoning', text: 'thinking out loud' },
      };
      expect(formatEventForStream(event)).toBe('\u2502 thinking out loud\n');
    });

    it('suppresses meta events (thread.started, turn.*)', () => {
      expect(formatEventForStream({ type: 'thread.started', thread_id: 't1' })).toBe('');
      expect(formatEventForStream({ type: 'turn.completed', turn_id: 'tn1' })).toBe('');
    });
  });

  describe('findError', () => {
    it('detects top-level error events', () => {
      const events: CodexEvent[] = [
        { type: 'error', message: 'auth failed' },
      ];
      expect(findError(events)).toBe('auth failed');
    });

    it('detects turn.failed events with a reason', () => {
      const events: CodexEvent[] = [
        { type: 'turn.failed', reason: 'timeout' },
      ];
      expect(findError(events)).toBe('Turn failed: timeout');
    });

    it('returns undefined when the turn completed successfully', () => {
      const { events } = parseJsonl(loadFixture('codex-live-0.121.jsonl'));
      expect(findError(events)).toBeUndefined();
    });
  });

  describe('end-to-end on the live fixture', () => {
    it('parses every non-blank line without dropping any', () => {
      const fixture = loadFixture('codex-live-0.121.jsonl');
      const { events, droppedLines } = parseJsonl(fixture);
      expect(droppedLines).toBe(0);
      // Expect one event per non-blank line.
      const nonBlankLines = fixture.split('\n').filter((line) => line.trim().length > 0);
      expect(events.length).toBe(nonBlankLines.length);
    });
  });
});
