import { describe, expect, it } from 'vitest';
import { buildGeminiResumeArgs } from '../../src/adapters/gemini-cli.js';

describe('buildGeminiResumeArgs + --allowed-mcp-server-names (M3-8)', () => {
  it('omits the flag when allowedServerNames is absent or empty', () => {
    expect(buildGeminiResumeArgs(undefined, 'hi')).toEqual([
      '-o',
      'stream-json',
      'hi',
    ]);
    expect(buildGeminiResumeArgs(undefined, 'hi', {})).toEqual([
      '-o',
      'stream-json',
      'hi',
    ]);
    expect(
      buildGeminiResumeArgs(undefined, 'hi', { allowedServerNames: [] }),
    ).toEqual(['-o', 'stream-json', 'hi']);
  });

  it('appends the csv flag after stream-json on a seed (no session) call', () => {
    const args = buildGeminiResumeArgs(undefined, 'hi', {
      allowedServerNames: ['crew', 'foo'],
    });
    expect(args).toEqual([
      '-o',
      'stream-json',
      '--allowed-mcp-server-names',
      'crew,foo',
      'hi',
    ]);
  });

  it('appends the csv flag after stream-json on a resume call (prompt stays at tail)', () => {
    const args = buildGeminiResumeArgs('abc-123', 'hi', {
      allowedServerNames: ['crew'],
    });
    expect(args).toEqual([
      '-o',
      'stream-json',
      '--allowed-mcp-server-names',
      'crew',
      '--resume',
      'abc-123',
      '--prompt',
      'hi',
    ]);
  });

  it('serializes multiple allowed names into a single csv string', () => {
    const args = buildGeminiResumeArgs(undefined, 'hi', {
      allowedServerNames: ['a', 'b', 'c'],
    });
    expect(args).toContain('--allowed-mcp-server-names');
    expect(args).toContain('a,b,c');
  });
});
