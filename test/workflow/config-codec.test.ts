import { describe, expect, it } from 'vitest';
import {
  getDefaultConfig,
  parseWorkflowYaml,
  resolveCaptainModel,
  serializeWorkflowYaml,
} from '../../src/workflow/config-codec.js';
import { AgentId } from '../../src/workflow/agents.js';
import { ModelId } from '../../src/workflow/models.js';
import type { FullConfig } from '../../src/workflow/types.js';

function baseConfig(overrides: Partial<FullConfig['captain']>): FullConfig {
  const base = getDefaultConfig();
  return {
    ...base,
    captain: { ...base.captain, ...overrides },
  };
}

describe('parseWorkflowYaml captain.model shape', () => {
  it('accepts the legacy scalar form', () => {
    const yaml = `
workflow:
  name: default
  execution:
    mode: judgment
  steps: []
  completion:
    strategy: judge_approval
    fallback: max_passes
agents: {}
captain:
  cli: claude-code
  model: claude-sonnet-4-7
error_handling:
  default:
    retry: 1
    fallback: null
    on_exhausted: ask_user
`;
    const parsed = parseWorkflowYaml(yaml);
    expect(parsed.captain.model).toBe(ModelId.CLAUDE_SONNET);
  });

  it('accepts the per-CLI map form and preserves each key', () => {
    const yaml = `
workflow:
  name: default
  execution:
    mode: judgment
  steps: []
  completion:
    strategy: judge_approval
    fallback: max_passes
agents: {}
captain:
  cli: codex
  model:
    claude-code: CLAUDE_SONNET
    codex: GPT
    gemini-cli: QWEN
error_handling:
  default:
    retry: 1
    fallback: null
    on_exhausted: ask_user
`;
    const parsed = parseWorkflowYaml(yaml);
    expect(typeof parsed.captain.model).toBe('object');
    expect(parsed.captain.model).toEqual({
      'claude-code': ModelId.CLAUDE_SONNET,
      codex: ModelId.GPT,
      'gemini-cli': ModelId.QWEN,
    });
  });

  it('rejects unknown CLI keys in the map form', () => {
    const yaml = `
workflow:
  name: default
  execution:
    mode: judgment
  steps: []
  completion:
    strategy: judge_approval
    fallback: max_passes
agents: {}
captain:
  cli: claude-code
  model:
    bogus-cli: some-model
error_handling:
  default:
    retry: 1
    fallback: null
    on_exhausted: ask_user
`;
    expect(() => parseWorkflowYaml(yaml)).toThrow(/captain\.model/i);
  });

  it('rejects non-string values in the map form', () => {
    const yaml = `
workflow:
  name: default
  execution:
    mode: judgment
  steps: []
  completion:
    strategy: judge_approval
    fallback: max_passes
agents: {}
captain:
  cli: claude-code
  model:
    claude-code: 42
error_handling:
  default:
    retry: 1
    fallback: null
    on_exhausted: ask_user
`;
    expect(() => parseWorkflowYaml(yaml)).toThrow();
  });
});

describe('resolveCaptainModel', () => {
  it('returns the scalar as-is', () => {
    expect(resolveCaptainModel({ cli: AgentId.CLAUDE_CODE, model: ModelId.CLAUDE_SONNET }))
      .toBe(ModelId.CLAUDE_SONNET);
  });

  it('picks the map entry matching captain.cli', () => {
    const spec = {
      'claude-code': ModelId.CLAUDE_SONNET,
      codex: ModelId.GPT,
      'gemini-cli': ModelId.QWEN,
    } as const;
    expect(resolveCaptainModel({ cli: AgentId.CLAUDE_CODE, model: { ...spec } }))
      .toBe(ModelId.CLAUDE_SONNET);
    expect(resolveCaptainModel({ cli: AgentId.CODEX, model: { ...spec } }))
      .toBe(ModelId.GPT);
    expect(resolveCaptainModel({ cli: AgentId.GEMINI_CLI, model: { ...spec } }))
      .toBe(ModelId.QWEN);
  });

  it('returns undefined when the map has no entry for the current CLI', () => {
    expect(
      resolveCaptainModel({
        cli: AgentId.GEMINI_CLI,
        model: { 'claude-code': ModelId.CLAUDE_SONNET },
      }),
    ).toBeUndefined();
  });

  it('returns undefined when model is omitted', () => {
    expect(resolveCaptainModel({ cli: AgentId.CLAUDE_CODE })).toBeUndefined();
  });
});

describe('serializeWorkflowYaml captain.model round-trip', () => {
  it('round-trips the legacy scalar form', () => {
    const config = baseConfig({ cli: AgentId.CLAUDE_CODE, model: ModelId.CLAUDE_SONNET });
    const yaml = serializeWorkflowYaml(config);
    const parsed = parseWorkflowYaml(yaml);
    expect(parsed.captain.model).toBe(ModelId.CLAUDE_SONNET);
  });

  it('round-trips the per-CLI map form', () => {
    const config = baseConfig({
      cli: AgentId.CODEX,
      model: {
        'claude-code': ModelId.CLAUDE_SONNET,
        codex: ModelId.GPT,
      },
    });
    const yaml = serializeWorkflowYaml(config);
    const parsed = parseWorkflowYaml(yaml);
    expect(parsed.captain.model).toEqual({
      'claude-code': ModelId.CLAUDE_SONNET,
      codex: ModelId.GPT,
    });
  });

  it('omits captain.model when neither form is populated', () => {
    const config = baseConfig({ cli: AgentId.CLAUDE_CODE, model: undefined });
    const yaml = serializeWorkflowYaml(config);
    const captainSection = yaml.match(/captain:\s*\n([\s\S]*?)(?:\n\S|$)/);
    expect(captainSection).not.toBeNull();
    expect(captainSection![1]).not.toMatch(/model:/);
  });
});

describe('defaults/workflow.yaml ships the per-CLI map', () => {
  it('produces a map with entries for every built-in captain', () => {
    const config = getDefaultConfig();
    expect(typeof config.captain.model).toBe('object');
    const map = config.captain.model as Record<string, string>;
    expect(map['claude-code']).toBeDefined();
    expect(map['codex']).toBeDefined();
    expect(map['gemini-cli']).toBeDefined();
  });
});

describe('parseWorkflowYaml captain.preset + presets', () => {
  it('accepts configs without preset/presets (legacy roundtrip)', () => {
    const yaml = `
workflow:
  name: default
  execution:
    mode: judgment
  steps: []
  completion:
    strategy: judge_approval
    fallback: max_passes
agents: {}
captain:
  cli: claude-code
error_handling:
  default:
    retry: 1
    fallback: null
    on_exhausted: ask_user
`;
    const parsed = parseWorkflowYaml(yaml);
    expect(parsed.captain.preset).toBeUndefined();
    expect(parsed.presets).toBeUndefined();
  });

  it('parses a full preset + captain.preset reference', () => {
    const yaml = `
workflow:
  name: default
  execution:
    mode: judgment
  steps: []
  completion:
    strategy: judge_approval
    fallback: max_passes
agents: {}
captain:
  cli: claude-code
  preset: default
presets:
  default:
    description: The default preset
    hint: |
      prefer running a review
      call finish when done
error_handling:
  default:
    retry: 1
    fallback: null
    on_exhausted: ask_user
`;
    const parsed = parseWorkflowYaml(yaml);
    expect(parsed.captain.preset).toBe('default');
    expect(parsed.presets?.default?.description).toBe('The default preset');
    expect(parsed.presets?.default?.hint).toContain('prefer running a review');
  });

  it('defaults/workflow.yaml ships captain.preset: default with a hint', () => {
    const config = getDefaultConfig();
    expect(config.captain.preset).toBe('default');
    expect(config.presets?.default).toBeDefined();
    expect(config.presets?.default?.hint).toBeTruthy();
  });

  it('defaults/workflow.yaml ships thorough-review + read-only built-ins (M5-3)', () => {
    const config = getDefaultConfig();
    expect(config.presets?.['thorough-review']).toBeDefined();
    expect(config.presets?.['thorough-review']?.hint).toBeTruthy();
    expect(config.presets?.['thorough-review']?.suggestedAgentRoles).toEqual([
      'reviewer',
      'security',
      'tests',
    ]);
    expect(config.presets?.['read-only']).toBeDefined();
    expect(config.presets?.['read-only']?.hint).toBeTruthy();
    expect(config.presets?.['read-only']?.suggestedAgentRoles).toEqual([
      'analyst',
      'reviewer',
    ]);
    // The active preset is still the `default` one; M5-3 ships the built-ins
    // but doesn't flip the default.
    expect(config.captain.preset).toBe('default');
  });
});

describe('serializeWorkflowYaml preset roundtrip', () => {
  it('roundtrips captain.preset + presets', () => {
    const base = getDefaultConfig();
    const config: FullConfig = {
      ...base,
      captain: { ...base.captain, preset: 'custom' },
      presets: {
        ...(base.presets ?? {}),
        custom: { description: 'x', hint: 'do the thing' },
      },
    };
    const yaml = serializeWorkflowYaml(config);
    const parsed = parseWorkflowYaml(yaml);
    expect(parsed.captain.preset).toBe('custom');
    expect(parsed.presets?.custom?.hint).toBe('do the thing');
    expect(parsed.presets?.custom?.description).toBe('x');
  });

  it('roundtrips suggestedAgentRoles (M5-2 schema extension)', () => {
    const base = getDefaultConfig();
    const config: FullConfig = {
      ...base,
      captain: { ...base.captain, preset: 'thorough-review' },
      presets: {
        ...(base.presets ?? {}),
        'thorough-review': {
          description: 'fan out',
          hint: 'review twice',
          suggestedAgentRoles: ['reviewer', 'security', 'tests'],
        },
      },
    };
    const yaml = serializeWorkflowYaml(config);
    // Uses snake_case on disk (matches the rest of the YAML surface).
    expect(yaml).toMatch(/suggested_agent_roles:\s*\n\s*- reviewer/);
    const parsed = parseWorkflowYaml(yaml);
    expect(parsed.presets?.['thorough-review']?.suggestedAgentRoles).toEqual([
      'reviewer',
      'security',
      'tests',
    ]);
  });

  it('drops non-string suggestedAgentRoles entries silently', () => {
    const yaml = `
workflow:
  name: default
  execution:
    mode: judgment
  steps: []
  completion:
    strategy: judge_approval
    fallback: max_passes
agents: {}
captain:
  cli: claude-code
  preset: mixed
presets:
  mixed:
    hint: hi
    suggested_agent_roles:
      - reviewer
      - 42
      - null
      - security
error_handling:
  default:
    retry: 1
    fallback: null
    on_exhausted: ask_user
`;
    const parsed = parseWorkflowYaml(yaml);
    expect(parsed.presets?.mixed?.suggestedAgentRoles).toEqual(['reviewer', 'security']);
  });

  it('accepts camelCase suggestedAgentRoles too (defensive)', () => {
    const yaml = `
workflow:
  name: default
  execution:
    mode: judgment
  steps: []
  completion:
    strategy: judge_approval
    fallback: max_passes
agents: {}
captain:
  cli: claude-code
  preset: camel
presets:
  camel:
    hint: hi
    suggestedAgentRoles: [analyst, reviewer]
error_handling:
  default:
    retry: 1
    fallback: null
    on_exhausted: ask_user
`;
    const parsed = parseWorkflowYaml(yaml);
    expect(parsed.presets?.camel?.suggestedAgentRoles).toEqual(['analyst', 'reviewer']);
  });

  it('omits captain.preset + presets when absent', () => {
    const base = getDefaultConfig();
    const config: FullConfig = {
      ...base,
      captain: { ...base.captain, preset: undefined },
      presets: undefined,
    };
    const yaml = serializeWorkflowYaml(config);
    expect(yaml).not.toMatch(/preset:/);
    expect(yaml).not.toMatch(/^presets:/m);
  });
});
