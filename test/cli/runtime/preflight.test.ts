import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, HealthCheckResult } from '../../../src/adapters/types.js';
import type { FullConfig } from '../../../src/workflow/types.js';
import {
  __resetCaptainPresetWarnLatchForTest,
  __resetPreflightWarningLatchForTest,
  assertRequiredAgentsReady,
  checkCaptainPresetReference,
  checkCrewCodexConfigDeprecation,
  collectRequiredAgentNames,
  enforceCaptainModelCompatibility,
} from '../../../src/cli/runtime/preflight.js';
import { logger } from '../../../src/utils/logger.js';

function buildConfig(): FullConfig {
  return {
    workflow: {
      name: 'default',
      execution: { mode: 'judgment' },
      steps: [
        { role: 'coder', agents: ['codex'], action: 'implement' },
        { role: 'judge', agents: ['captain'], action: 'evaluate_review' },
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
  options: { recognizesModel?: (modelId: string) => boolean } = {},
): AgentAdapter {
  return {
    name,
    capabilities: ['analyze'],
    supportsJsonSchema: true,
    execute: vi.fn(),
    executeWithSchema: vi.fn(),
    recognizesModel: options.recognizesModel,
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
      agents: ['gemini-cli'],
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

describe('enforceCaptainModelCompatibility', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('does nothing when captain.model is unset', () => {
    const config = buildConfig();
    const adapter = createAdapter('claude-code', async () => ({ available: true, authenticated: true }), {
      recognizesModel: (m) => m.startsWith('claude-'),
    });

    const result = enforceCaptainModelCompatibility(config, adapter);
    expect(result.warnedModel).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('passes through when the captain adapter recognizes the model', () => {
    const config = buildConfig();
    config.captain.model = 'claude-sonnet-4-7';
    const adapter = createAdapter('claude-code', async () => ({ available: true, authenticated: true }), {
      recognizesModel: (m) => m.startsWith('claude-'),
    });

    const result = enforceCaptainModelCompatibility(config, adapter);
    expect(result.warnedModel).toBeUndefined();
    expect(config.captain.model).toBe('claude-sonnet-4-7');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns and clears the scalar model when the captain adapter does not recognize it', () => {
    const config = buildConfig();
    config.captain.cli = 'codex';
    config.captain.model = 'claude-sonnet-4-7';
    const adapter = createAdapter('codex', async () => ({ available: true, authenticated: true }), {
      recognizesModel: (m) => m.startsWith('gpt-'),
    });

    const result = enforceCaptainModelCompatibility(config, adapter);
    expect(result.warnedModel).toBe('claude-sonnet-4-7');
    expect(config.captain.model).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('drops only the mismatched map entry when given a per-CLI map', () => {
    const config = buildConfig();
    config.captain.cli = 'codex';
    config.captain.model = {
      'claude-code': 'claude-sonnet-4-7',
      codex: 'claude-sonnet-4-7', // intentionally wrong for codex
    };
    const adapter = createAdapter('codex', async () => ({ available: true, authenticated: true }), {
      recognizesModel: (m) => m.startsWith('gpt-'),
    });

    enforceCaptainModelCompatibility(config, adapter);
    const mapAfter = config.captain.model as Record<string, string>;
    expect(mapAfter.codex).toBeUndefined();
    expect(mapAfter['claude-code']).toBe('claude-sonnet-4-7');
  });

  it('passes through when the adapter exposes no recognizesModel', () => {
    const config = buildConfig();
    config.captain.model = 'anything';
    const adapter = createAdapter('claude-code', async () => ({ available: true, authenticated: true }));

    const result = enforceCaptainModelCompatibility(config, adapter);
    expect(result.warnedModel).toBeUndefined();
    expect(config.captain.model).toBe('anything');
  });
});

describe('checkCaptainPresetReference (M5-1)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetCaptainPresetWarnLatchForTest();
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('is silent when captain.preset is absent', () => {
    const config = buildConfig();
    checkCaptainPresetReference(config);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('is silent when captain.preset is declared in presets', () => {
    const config = buildConfig();
    config.captain.preset = 'default';
    config.presets = {
      default: { name: 'default', hint: 'hi' },
    };
    checkCaptainPresetReference(config);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns once when captain.preset references an unknown name', () => {
    const config = buildConfig();
    config.captain.preset = 'nonexistent';
    config.presets = { default: { name: 'default', hint: 'hi' } };
    checkCaptainPresetReference(config);
    checkCaptainPresetReference(config);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/captain\.preset "nonexistent"/);
  });

  it('warns separately for the empty-string case (treated as "no preset")', () => {
    const config = buildConfig();
    config.captain.preset = '';
    config.presets = { default: { name: 'default' } };
    checkCaptainPresetReference(config);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/empty string/);
  });

  it('does not throw when presets is undefined', () => {
    const config = buildConfig();
    config.captain.preset = 'default';
    config.presets = undefined;
    expect(() => checkCaptainPresetReference(config)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('checkCrewCodexConfigDeprecation', () => {
  const originalValue = process.env.CREW_CODEX_CONFIG;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetPreflightWarningLatchForTest();
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (originalValue === undefined) delete process.env.CREW_CODEX_CONFIG;
    else process.env.CREW_CODEX_CONFIG = originalValue;
  });

  it('is silent when CREW_CODEX_CONFIG is unset', () => {
    delete process.env.CREW_CODEX_CONFIG;
    checkCrewCodexConfigDeprecation();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns exactly once per process when set', () => {
    process.env.CREW_CODEX_CONFIG = '/some/path/config.toml';
    checkCrewCodexConfigDeprecation();
    checkCrewCodexConfigDeprecation();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/CREW_CODEX_CONFIG/);
  });

  it('is silent when set to an empty string', () => {
    process.env.CREW_CODEX_CONFIG = '   ';
    checkCrewCodexConfigDeprecation();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
