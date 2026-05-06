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
    it('formats top-level lifecycle and error events as semantic lines', () => {
      expect(formatEventForStream({ type: 'thread.started', thread_id: 't1' })).toBe(
        '[codex] turn: thread started',
      );
      expect(formatEventForStream({ type: 'turn.started' })).toBe('[codex] turn: started');
      expect(formatEventForStream({ type: 'turn.completed' })).toBe('[codex] turn: completed');
      expect(formatEventForStream({ type: 'turn.failed', reason: 'timeout' })).toBe(
        '[codex] turn: failed (timeout)',
      );
      expect(formatEventForStream({ type: 'error', message: 'auth failed' })).toBe(
        '[codex] error: auth failed',
      );
    });

    it('treats turn_id as optional for 0.128 lifecycle events', () => {
      expect(formatEventForStream({ type: 'turn.started' })).toBe('[codex] turn: started');
      expect(formatEventForStream({ type: 'turn.completed' })).toBe('[codex] turn: completed');
    });

    it('formats completed item envelopes as semantic lines', () => {
      expect(formatEventForStream({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'hello' },
      })).toBe('[codex] message: hello');
      expect(formatEventForStream({
        type: 'item.completed',
        item: { type: 'reasoning', text: 'thinking out loud' },
      })).toBe('[codex] reasoning: thinking out loud');
      expect(formatEventForStream({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'grep -n oldName src/', exit_code: 0 },
      })).toBe('[codex] command: grep -n oldName src/ (exit 0)');
      expect(formatEventForStream({
        type: 'item.completed',
        item: { type: 'file_change', path: 'src/foo.ts', action: 'modified' },
      })).toBe('[codex] file: modified src/foo.ts');
      expect(formatEventForStream({
        type: 'item.completed',
        item: { type: 'file_change', path: 'src/baz.ts', action: 'none' },
      })).toBe('[codex] file: no change src/baz.ts');
    });

    it('emits separate command start and command completion lines', () => {
      const command = "/bin/zsh -lc \"sed -n '1,220p' README.md\"";
      expect(formatEventForStream({
        type: 'item.started',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command,
          exit_code: null,
          status: 'in_progress',
        },
      })).toBe(`[codex] command: started ${command}`);
      expect(formatEventForStream({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command,
          exit_code: 0,
          status: 'completed',
        },
      })).toBe(`[codex] command: ${command} (exit 0)`);
    });

    it('uses bounded fallback lines for unknown events', () => {
      expect(formatEventForStream({ type: 'session.paused' })).toBe(
        '[codex] event: session.paused',
      );
      expect(formatEventForStream({
        type: 'item.completed',
        item: { type: 'unknown_item' },
      })).toBe('[codex] event: item.completed/unknown_item');
      expect(formatEventForStream({} as CodexEvent)).toBe('[codex] event: unknown');
    });

    it('isolates unexpected event objects that throw during formatting', () => {
      const event = Object.defineProperty({}, 'type', {
        get() {
          throw new Error('bad event');
        },
      }) as CodexEvent;
      expect(formatEventForStream(event)).toBe('[codex] event: unknown');
    });

    it('truncates extra-long summaries with the [codex] prefix included in the cap', () => {
      const line = formatEventForStream({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'x'.repeat(500) },
      });
      expect(line.startsWith('[codex] message: ')).toBe(true);
      expect(line.length).toBeLessThanOrEqual(240);
      expect(line).toMatch(/\.\.\.$/);
    });

    it('formats every event in the live 0.128 fixture without empty stream gaps', () => {
      const { events } = parseJsonl(loadFixture('codex-live-0.128.0.jsonl'));
      expect(events.map(formatEventForStream)).toEqual([
        '[codex] turn: thread started',
        '[codex] turn: started',
        '[codex] message: I’ll read the repository README and pull out the project’s purpose at a high level.',
        '[codex] command: started /bin/zsh -lc "sed -n \'1,220p\' README.md"',
        '[codex] command: /bin/zsh -lc "sed -n \'1,220p\' README.md" (exit 0)',
        '[codex] message: - `crew-mcp` is a pre-release MCP server plus “captain” skill for turning existing AI coding CLIs like Claude Code, Codex, and Gemini into multi-agent orchestrators. - It provides orchestration tools and a playbook while...',
        '[codex] turn: completed',
      ]);
      expect(events.map(formatEventForStream).every((line) => line.length > 0)).toBe(true);
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

    it('parses every non-blank 0.128 line without dropping any', () => {
      const fixture = loadFixture('codex-live-0.128.0.jsonl');
      const { events, droppedLines } = parseJsonl(fixture);
      expect(droppedLines).toBe(0);
      const nonBlankLines = fixture.split('\n').filter((line) => line.trim().length > 0);
      expect(events.length).toBe(nonBlankLines.length);
    });

    it('isolates malformed JSONL lines while keeping valid events', () => {
      const { events, droppedLines } = parseJsonl([
        '{"type":"turn.started"}',
        '{"type":',
        '{"type":"turn.completed"}',
      ].join('\n'));
      expect(droppedLines).toBe(1);
      expect(events.map(formatEventForStream)).toEqual([
        '[codex] turn: started',
        '[codex] turn: completed',
      ]);
    });
  });
});
