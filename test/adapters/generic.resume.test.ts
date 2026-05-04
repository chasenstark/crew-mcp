// generic adapter resume portability test (M1.5-13).
//
// The GenericAdapter is a leaf-agent adapter; it does NOT implement
// executeWithTools and is not a captain adapter. This test documents the
// invariant so that future changes which try to route captain work through
// a generic agent fail loudly with a readable error.

import { describe, expect, it } from 'vitest';

const { GenericAdapter } = await import('../../src/adapters/generic.js');

describe('GenericAdapter resume portability (M1.5-13)', () => {
  it('advertises supportsToolLoop=false — cannot act as captain', () => {
    const adapter = new GenericAdapter({
      name: 'local-cli',
      command: 'echo',
      argsTemplate: ['{{prompt}}'],
      strengths: [],
    });
    expect(adapter.captainCapabilities.supportsToolLoop).toBe(false);
  });

  it('has no executeWithTools method (captain-adapter API is optional)', () => {
    const adapter = new GenericAdapter({
      name: 'local-cli',
      command: 'echo',
      argsTemplate: ['{{prompt}}'],
      strengths: [],
    });
    expect((adapter as unknown as { executeWithTools?: unknown }).executeWithTools).toBeUndefined();
  });

  it('has no getCliVersionTag method (adapter does not participate in resume)', () => {
    const adapter = new GenericAdapter({
      name: 'local-cli',
      command: 'echo',
      argsTemplate: ['{{prompt}}'],
      strengths: [],
    });
    expect((adapter as unknown as { getCliVersionTag?: unknown }).getCliVersionTag).toBeUndefined();
  });
});
