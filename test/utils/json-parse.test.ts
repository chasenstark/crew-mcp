import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { extractJson } from '../../src/utils/json-parse.js';

describe('extractJson', () => {
  it('parses plain JSON object', () => {
    expect(extractJson('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });

  it('parses JSON from markdown code fences', () => {
    const input = '```json\n{"task":"implement","ok":true}\n```';
    expect(extractJson(input)).toEqual({ task: 'implement', ok: true });
  });

  it('extracts JSON object from surrounding text', () => {
    const input = 'Here is the result:\n{"items":[1,2,3],"meta":{"done":true}}\nThanks.';
    expect(extractJson(input)).toEqual({
      items: [1, 2, 3],
      meta: { done: true },
    });
  });

  it('extracts JSON array from surrounding text', () => {
    const input = 'prefix text\n[{"id":"task-1"},{"id":"task-2"}]\nsuffix text';
    expect(extractJson(input)).toEqual([{ id: 'task-1' }, { id: 'task-2' }]);
  });

  it('throws when no JSON can be extracted', () => {
    expect(() => extractJson('not json at all')).toThrow(/Could not extract JSON/);
  });

  it('rejects large truncated brace-heavy output without quadratic delimiter parsing', () => {
    const input = `prefix\n${'{'.repeat(1024 * 1024)}\ntruncated`;
    const startedAt = performance.now();

    expect(() => extractJson(input)).toThrow(/Could not extract JSON/);

    expect(performance.now() - startedAt).toBeLessThan(1000);
  });
});
