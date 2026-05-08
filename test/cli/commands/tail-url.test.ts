import { describe, expect, it } from 'vitest';

import { crewTailUrl } from '../../../src/cli/commands/tail-url.js';

describe('crewTailUrl', () => {
  it('encodes custom-scheme tail links with literal path separators', () => {
    const path = '/tmp/crew #run?leaf/unicode-π/events.log';
    const url = crewTailUrl(path);

    expect(url).toBe('crew-tail:///tmp/crew%20%23run%3Fleaf/unicode-%CF%80/events.log');

    const parsed = new URL(url);
    expect(parsed.protocol).toBe('crew-tail:');
    expect(parsed.search).toBe('');
    expect(parsed.hash).toBe('');
    expect(decodeURIComponent(parsed.pathname)).toBe(path);
  });

  // The AppleScript .app itself is intentionally verified manually:
  // install it, click a crew-tail:// dispatch link, and confirm Terminal
  // opens running `tail -F <events.log>`.
});
