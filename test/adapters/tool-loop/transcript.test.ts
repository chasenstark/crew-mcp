import { describe, expect, it } from 'vitest';
import { buildDecisionPrompt } from '../../../src/adapters/tool-loop/transcript.js';

describe('buildDecisionPrompt', () => {
  it('omits inline transcript when resuming from a provider session', () => {
    const prompt = buildDecisionPrompt(
      [{ name: 'run_decompose', description: 'decompose', inputSchema: { type: 'object' } }],
      [{ role: 'user', content: 'long prior transcript that should not be replayed' }],
      { continueFromSession: true },
    );

    expect(prompt).toContain('provider resume session already contains prior turns');
    expect(prompt).not.toContain('long prior transcript that should not be replayed');
  });
});
