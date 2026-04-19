import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { dispatchAnalyzeOutput } from '../../../src/captain/tools/analyze-output.js';
import type { AgentAdapter } from '../../../src/adapters/types.js';

function makeAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    name: 'fake-captain',
    capabilities: ['analyze'],
    supportsJsonSchema: true,
    execute: async () => ({
      output: '',
      filesModified: [],
      status: 'success',
      metadata: {},
    }),
    executeWithSchema: async <T extends z.ZodType>(_prompt: string, _schema: T) =>
      ({
        status: 'success',
        summary: 'it worked',
        filesModified: [{ path: 'README.md', action: 'modified' }],
        decisions: ['fixed a typo'],
        concerns: [],
        needsHumanAttention: false,
      }) as z.infer<T>,
    healthCheck: async () => ({ available: true, authenticated: true }),
    ...overrides,
  };
}

describe('dispatchAnalyzeOutput', () => {
  it('wraps an agent output into a synthesized TaskResult and forwards it to ingest', async () => {
    const out = await dispatchAnalyzeOutput(
      {
        task_description: 'fix typo in README.md line 10',
        agent_output: 'fixed the typo',
        files_modified: ['README.md'],
      },
      { captain: makeAdapter() },
    );
    expect(out.status).toBe('success');
    expect(out.summary).toBe('it worked');
  });

  it('treats missing files_modified as an empty list', async () => {
    const out = await dispatchAnalyzeOutput(
      { task_description: 'x', agent_output: 'did nothing observable' },
      { captain: makeAdapter() },
    );
    expect(out.filesModified).toBeDefined();
  });
});
