import { describe, expect, it, vi } from 'vitest';

import type { AgentAdapter } from '../../../src/adapters/types.js';
import { resolveContinuationModelSelection } from '../../../src/orchestrator/tools/continue-run.js';

function adapter(): AgentAdapter {
  return {
    name: 'codex',
    strengths: [],
    supportsJsonSchema: true,
    modelSelectionSupport: 'provider-validated',
    resolveModel: vi.fn(async (requested) => requested === 'bad'
      ? {
          ok: false,
          code: 'model_selection.unknown' as const,
          message: 'unknown bad',
        }
      : {
          ok: true,
          argument: requested,
          displayName: requested.toUpperCase(),
          validation: 'catalog' as const,
        }),
    execute: async () => ({
      output: '',
      filesModified: [],
      status: 'success',
      metadata: {},
    }),
    healthCheck: async () => ({ available: true, authenticated: true }),
  };
}

describe('continuation model selection', () => {
  it('uses an explicit per-call model and validates it', async () => {
    await expect(resolveContinuationModelSelection({
      adapter: adapter(),
      explicitModel: 'gpt-new',
      priorPrompts: [{
        turn: 1,
        modelSelection: {
          source: 'per_call',
          requestedModel: 'gpt-old',
          modelArgument: 'gpt-old',
          validation: 'catalog',
        },
      }],
      agentPrefs: { codex: { model: 'pref' } },
    })).resolves.toMatchObject({
      ok: true,
      record: { source: 'per_call', modelArgument: 'gpt-new' },
    });
  });

  it('inherits the preceding non-default argument without rediscovery', async () => {
    const target = adapter();
    await expect(resolveContinuationModelSelection({
      adapter: target,
      explicitModel: undefined,
      priorPrompts: [{
        turn: 2,
        modelSelection: {
          source: 'agent_default',
          requestedModel: 'gpt-sticky',
          modelArgument: 'gpt-sticky',
          displayName: 'Sticky',
          validation: 'catalog',
          observedModel: 'provider-observed',
        },
      }],
      agentPrefs: { codex: { model: 'changed-pref' } },
    })).resolves.toEqual({
      ok: true,
      record: {
        source: 'inherited',
        requestedModel: 'gpt-sticky',
        modelArgument: 'gpt-sticky',
        displayName: 'Sticky',
        validation: 'catalog',
        inheritedFromTurn: 2,
      },
    });
    expect(target.resolveModel).not.toHaveBeenCalled();
  });

  it('keeps CLI default sticky instead of picking up a new preference', async () => {
    const target = adapter();
    await expect(resolveContinuationModelSelection({
      adapter: target,
      explicitModel: undefined,
      priorPrompts: [{
        turn: 1,
        modelSelection: { source: 'cli_default', validation: 'cli_default' },
      }],
      agentPrefs: { codex: { model: 'new-pref' } },
    })).resolves.toEqual({
      ok: true,
      record: { source: 'cli_default', validation: 'cli_default' },
    });
    expect(target.resolveModel).not.toHaveBeenCalled();
  });

  it('uses current preferences only for legacy turns with no audit record', async () => {
    await expect(resolveContinuationModelSelection({
      adapter: adapter(),
      explicitModel: undefined,
      priorPrompts: [{ turn: 1 }],
      agentPrefs: { codex: { model: 'legacy-pref' } },
    })).resolves.toMatchObject({
      ok: true,
      record: { source: 'agent_default', modelArgument: 'legacy-pref' },
    });
  });

  it('returns the provider resolution error for an explicit invalid pin', async () => {
    await expect(resolveContinuationModelSelection({
      adapter: adapter(),
      explicitModel: 'bad',
      priorPrompts: [{ turn: 1 }],
      agentPrefs: {},
    })).resolves.toEqual({
      ok: false,
      message: 'model_selection.unknown: unknown bad',
    });
  });
});
