import { describe, expect, it } from 'vitest';
import {
  extractStreamJsonAssistantText,
  extractStreamJsonSessionId,
  isGeminiDeprecationNotice,
  isInvalidSessionStderr,
  parseSingleJsonResponse,
  parseStreamJsonEvents,
  type GeminiEvent,
} from '../../src/adapters/gemini-cli.js';

describe('gemini parser (0.20+ stream-json + -o json)', () => {
  describe('parseSingleJsonResponse (-o json)', () => {
    it('returns the response string from a single JSON object', () => {
      const stdout = JSON.stringify({ response: 'hello', stats: { input_tokens: 6 } });
      expect(parseSingleJsonResponse(stdout)).toBe('hello');
    });

    it('returns empty string when response is missing', () => {
      expect(parseSingleJsonResponse('{"stats":{}}')).toBe('');
    });

    it('returns empty string on invalid JSON', () => {
      expect(parseSingleJsonResponse('not-json')).toBe('');
    });

    it('returns empty string on array root', () => {
      expect(parseSingleJsonResponse('[1,2]')).toBe('');
    });

    it('returns empty string on empty stdout', () => {
      expect(parseSingleJsonResponse('')).toBe('');
    });
  });

  describe('parseStreamJsonEvents (-o stream-json)', () => {
    it('splits newline-delimited events and drops blank lines', () => {
      const stdout = [
        JSON.stringify({ type: 'init', session_id: 'uuid-1' }),
        '',
        JSON.stringify({ type: 'message', role: 'assistant', content: 'hi' }),
        JSON.stringify({ type: 'result' }),
      ].join('\n');

      const events = parseStreamJsonEvents(stdout);
      expect(events).toHaveLength(3);
      expect(events[0]).toEqual({ type: 'init', session_id: 'uuid-1' });
      expect(events[1]).toEqual({ type: 'message', role: 'assistant', content: 'hi' });
      expect(events[2]).toEqual({ type: 'result' });
    });

    it('drops non-object JSON lines (numbers, strings, arrays, null)', () => {
      const stdout = ['123', '"hi"', '[1,2]', 'null', JSON.stringify({ type: 'init', session_id: 's' })].join('\n');
      const events = parseStreamJsonEvents(stdout);
      expect(events).toHaveLength(1);
      expect(events[0].session_id).toBe('s');
    });
  });

  describe('extractStreamJsonSessionId', () => {
    it('returns the init event session_id', () => {
      const events: GeminiEvent[] = [
        { type: 'init', session_id: 'uuid-init' },
        { type: 'message', role: 'assistant', content: 'hi' },
      ];
      expect(extractStreamJsonSessionId(events)).toBe('uuid-init');
    });

    it('falls back to any event that carries a session_id', () => {
      const events: GeminiEvent[] = [
        { type: 'message', session_id: 'from-message', content: 'hi' },
      ];
      expect(extractStreamJsonSessionId(events)).toBe('from-message');
    });

    it('returns undefined when no session_id is present', () => {
      const events: GeminiEvent[] = [{ type: 'message', content: 'hi' }];
      expect(extractStreamJsonSessionId(events)).toBeUndefined();
    });
  });

  describe('extractStreamJsonAssistantText', () => {
    it('concatenates assistant message content', () => {
      const events: GeminiEvent[] = [
        { type: 'init', session_id: 's' },
        { type: 'message', role: 'assistant', content: 'hello' },
        { type: 'message', role: 'assistant', content: ' world' },
      ];
      expect(extractStreamJsonAssistantText(events)).toBe('hello world');
    });

    it('joins delta chunks into a single string', () => {
      const events: GeminiEvent[] = [
        { type: 'init', session_id: 's' },
        { type: 'message', role: 'assistant', delta: 'he' },
        { type: 'message', role: 'assistant', delta: 'llo' },
      ];
      expect(extractStreamJsonAssistantText(events)).toBe('hello');
    });

    it('prefers content over delta on the same event', () => {
      const events: GeminiEvent[] = [
        { type: 'message', role: 'assistant', content: 'final', delta: 'partial' },
      ];
      expect(extractStreamJsonAssistantText(events)).toBe('final');
    });

    it('filters the --prompt deprecation notice that Gemini emits on resume', () => {
      const events: GeminiEvent[] = [
        { type: 'init', session_id: 's' },
        {
          type: 'message',
          role: 'assistant',
          content: 'The --prompt (-p) flag has been deprecated. Please use positional argument instead.',
        },
        { type: 'message', role: 'assistant', content: '17' },
        { type: 'result' },
      ];
      expect(extractStreamJsonAssistantText(events)).toBe('17');
    });

    it('skips user-role messages', () => {
      const events: GeminiEvent[] = [
        { type: 'message', role: 'user', content: 'should not appear' },
        { type: 'message', role: 'assistant', content: 'assistant speaking' },
      ];
      expect(extractStreamJsonAssistantText(events)).toBe('assistant speaking');
    });

    it('returns empty string when no assistant text is present', () => {
      const events: GeminiEvent[] = [
        { type: 'init', session_id: 's' },
        { type: 'result' },
      ];
      expect(extractStreamJsonAssistantText(events)).toBe('');
    });
  });

  describe('isGeminiDeprecationNotice', () => {
    it('matches the canonical message', () => {
      expect(
        isGeminiDeprecationNotice('The --prompt (-p) flag has been deprecated and will be removed.'),
      ).toBe(true);
    });

    it('does not match arbitrary other content', () => {
      expect(isGeminiDeprecationNotice('hello world')).toBe(false);
      expect(isGeminiDeprecationNotice(undefined)).toBe(false);
    });
  });

  describe('isInvalidSessionStderr', () => {
    it('detects the upstream "Invalid session identifier" message', () => {
      expect(isInvalidSessionStderr('Error: Invalid session identifier')).toBe(true);
      expect(isInvalidSessionStderr('invalid session identifier (case-insensitive)')).toBe(true);
    });

    it('returns false on unrelated stderr', () => {
      expect(isInvalidSessionStderr('Auth token expired')).toBe(false);
      expect(isInvalidSessionStderr('')).toBe(false);
    });
  });
});
