import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CREW_MCP_VERSION } from '../../src/cli/version.js';

describe('CREW_MCP_VERSION', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ) as { version?: unknown };

    expect(CREW_MCP_VERSION).toBe(pkg.version);
  });
});
