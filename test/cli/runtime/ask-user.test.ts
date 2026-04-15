import { describe, expect, it } from 'vitest';
import { normalizeAskUserPolicy } from '../../../src/cli/runtime/ask-user.js';

describe('normalizeAskUserPolicy', () => {
  it('uses fallback policy when option is not provided', () => {
    expect(normalizeAskUserPolicy(undefined, 'fail')).toBe('fail');
    expect(normalizeAskUserPolicy(undefined, 'prompt')).toBe('prompt');
  });

  it('accepts explicit fail/prompt values', () => {
    expect(normalizeAskUserPolicy('fail', 'prompt')).toBe('fail');
    expect(normalizeAskUserPolicy('prompt', 'fail')).toBe('prompt');
  });

  it('rejects unknown policy values', () => {
    expect(() => normalizeAskUserPolicy('invalid', 'fail')).toThrow(/Invalid --on-ask-user policy/);
  });
});
