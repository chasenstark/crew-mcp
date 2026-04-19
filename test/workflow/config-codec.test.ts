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
