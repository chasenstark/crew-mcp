import { describe, expect, it } from 'vitest';
import {
  buildCliVersionTag,
  isCliVersionCompatible,
  parseCliVersionTag,
} from '../src/provider-session.js';

describe('provider-session version compatibility', () => {
  it('parses cli version tags', () => {
    const parsed = parseCliVersionTag('claude-code@2.1.108');
    expect(parsed).toEqual({
      name: 'claude-code',
      version: {
        major: 2,
        minor: 1,
        patch: 108,
        raw: '2.1.108',
      },
    });
  });

  it('requires exact match for pre-1.0 CLIs', () => {
    const previous = buildCliVersionTag('codex', '0.120.0');
    const same = buildCliVersionTag('codex', '0.120.0');
    const differentPatch = buildCliVersionTag('codex', '0.120.1');

    expect(isCliVersionCompatible(previous, same)).toBe(true);
    expect(isCliVersionCompatible(previous, differentPatch)).toBe(false);
  });

  it('allows patch drift on post-1.0 CLIs but enforces major/minor', () => {
    const previous = buildCliVersionTag('claude-code', '2.1.108');
    const newPatch = buildCliVersionTag('claude-code', '2.1.202');
    const newMinor = buildCliVersionTag('claude-code', '2.2.0');

    expect(isCliVersionCompatible(previous, newPatch)).toBe(true);
    expect(isCliVersionCompatible(previous, newMinor)).toBe(false);
  });

  it('rejects mismatched cli names', () => {
    const previous = buildCliVersionTag('claude-code', '2.1.108');
    const detected = buildCliVersionTag('codex', '2.1.108');

    expect(isCliVersionCompatible(previous, detected)).toBe(false);
  });
});
