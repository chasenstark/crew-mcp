import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, HealthCheckResult } from '../../../src/adapters/types.js';
import type { FullConfig } from '../../../src/workflow/types.js';
import { collectRequiredAgentNames, assertRequiredAgentsReady } from '../../../src/cli/runtime/preflight.js';

function buildConfig(): FullConfig {
  return {
    workflow: {
      name: 'default',
      execution: { mode: 'judgment' },
      steps: [
        { role: 'coder', agent: 'codex', action: 'implement' },
        { role: 'judge', agent: 'captain', action: 'evaluate_review' },
      ],
      completion: { strategy: 'judge_approval', fallback: 'max_passes' },
    },
    agents: {
      'codex': { adapter: 'codex' },
      'claude-code': { adapter: 'claude-code' },
    },
    captain: { cli: 'claude-code' },
    errorHandling: {
      default: {
        retry: 1,
        fallback: null,
        onExhausted: 'ask_user',
      },
    },
  };
}

function createAdapter(
  name: string,
  healthCheck: () => Promise<HealthCheckResult>,
): AgentAdapter {
  return {
    name,
    capabilities: ['analyze'],
    supportsJsonSchema: true,
    execute: vi.fn(),
    executeWithSchema: vi.fn(),
    healthCheck,
  };
}

describe('preflight runtime checks', () => {
  it('collects captain + configured agents + workflow step agents without captain pseudo-agent', () => {
    const names = collectRequiredAgentNames(buildConfig());
    expect(new Set(names)).toEqual(new Set(['claude-code', 'codex']));
    expect(names).not.toContain('captain');
  });

  it('passes when all required adapters are available and authenticated', async () => {
    const codexHealth = vi.fn(async () => ({ available: true, authenticated: true }));
    const claudeHealth = vi.fn(async () => ({ available: true, authenticated: true }));
    const registry = {
      get(name: string) {
        if (name === 'codex') return createAdapter('codex', codexHealth);
        if (name === 'claude-code') return createAdapter('claude-code', claudeHealth);
        return undefined;
      },
    };

    await expect(assertRequiredAgentsReady(registry, buildConfig())).resolves.toBeUndefined();
    expect(codexHealth).toHaveBeenCalledTimes(1);
    expect(claudeHealth).toHaveBeenCalledTimes(1);
  });

  it('fails fast with captain-auth detail when captain is not authenticated', async () => {
    const registry = {
      get(name: string) {
        if (name === 'codex') {
          return createAdapter(
            'codex',
            async () => ({ available: true, authenticated: true }),
          );
        }
        if (name === 'claude-code') {
          return createAdapter(
            'claude-code',
            async () => ({ available: true, authenticated: false, error: 'Not logged in' }),
          );
        }
        return undefined;
      },
    };

    await expect(assertRequiredAgentsReady(registry, buildConfig())).rejects.toThrow(
      'claude-code (captain): not authenticated: Not logged in',
    );
  });

  it('fails when a required workflow agent adapter is missing', async () => {
    const config = buildConfig();
    config.workflow.steps.push({
      role: 'reviewer',
      agent: 'gemini-cli',
      action: 'review',
    });

    const registry = {
      get(name: string) {
        if (name === 'codex' || name === 'claude-code') {
          return createAdapter(name, async () => ({ available: true, authenticated: true }));
        }
        return undefined;
      },
    };

    await expect(assertRequiredAgentsReady(registry, config)).rejects.toThrow(
      'gemini-cli: adapter is not registered',
    );
  });
});
