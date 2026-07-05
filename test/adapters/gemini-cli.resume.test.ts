import { describe, expect, it } from 'vitest';
import { buildGeminiResumeArgs, isVersionBelowFloor } from '../../src/adapters/gemini-cli.js';

describe('buildGeminiResumeArgs', () => {
  it('emits seed-turn args with positional prompt when no sessionId', () => {
    expect(buildGeminiResumeArgs(undefined, 'hello')).toEqual([
      '-o',
      'stream-json',
      'hello',
    ]);
  });

  it('emits resume-turn args with --prompt when a sessionId is present', () => {
    expect(buildGeminiResumeArgs('uuid-1', 'prime after 5?')).toEqual([
      '-o',
      'stream-json',
      '--resume',
      'uuid-1',
      '--prompt',
      'prime after 5?',
    ]);
  });

  it('never places the prompt before --resume', () => {
    const args = buildGeminiResumeArgs('uuid-1', 'hi');
    const resumeIndex = args.indexOf('--resume');
    const promptFlagIndex = args.indexOf('--prompt');
    expect(resumeIndex).toBeLessThan(promptFlagIndex);
  });
});

describe('isVersionBelowFloor', () => {
  it('returns true when the parsed version is null (unparseable)', () => {
    expect(isVersionBelowFloor(null)).toBe(true);
  });

  it('rejects versions below 0.20.0', () => {
    expect(isVersionBelowFloor({ major: 0, minor: 16, patch: 0 })).toBe(true);
    expect(isVersionBelowFloor({ major: 0, minor: 19, patch: 99 })).toBe(true);
  });

  it('accepts 0.20.0 and above', () => {
    expect(isVersionBelowFloor({ major: 0, minor: 20, patch: 0 })).toBe(false);
    expect(isVersionBelowFloor({ major: 0, minor: 21, patch: 0 })).toBe(false);
    expect(isVersionBelowFloor({ major: 1, minor: 0, patch: 0 })).toBe(false);
  });
});
