import { describe, expect, it } from 'vitest';
import { parseSingleJsonResponse } from '../../src/adapters/gemini-cli.js';

describe('gemini parser (-o json)', () => {
  describe('parseSingleJsonResponse', () => {
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
});
