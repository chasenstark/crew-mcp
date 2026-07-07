import { describe, expect, it } from 'vitest';
import {
  getDefaultConfig,
  mergeConfigs,
  parseWorkflowYaml,
  serializeWorkflowYaml,
} from '../../src/workflow/config-codec.js';

describe('code-defined defaults', () => {
  it('is the minimal agent-defaults-only surface', () => {
    expect(getDefaultConfig()).toEqual({ workflow: {} });
  });

  it('returns a fresh clone on every call', () => {
    const first = getDefaultConfig();
    first.workflow.agentDefaults = { iterate: { implementer: 'codex' } };
    expect(getDefaultConfig().workflow.agentDefaults).toBeUndefined();
  });
});

describe('serializeWorkflowYaml', () => {
  it('serializes an empty config to just the workflow key', () => {
    expect(serializeWorkflowYaml(getDefaultConfig())).toBe('workflow: {}\n');
  });

  it('writes snake_case agent_defaults/ban_list keys', () => {
    const config = getDefaultConfig();
    config.workflow.agentDefaults = {
      iterate: { implementer: 'codex', banList: ['agy'] },
    };
    const yaml = serializeWorkflowYaml(config);
    expect(yaml).toContain('agent_defaults:');
    expect(yaml).toContain('ban_list:');
    expect(yaml).not.toContain('banList');
  });

  it('omits empty iterate/panel groups', () => {
    const config = getDefaultConfig();
    config.workflow.agentDefaults = { iterate: {}, panel: {} };
    expect(serializeWorkflowYaml(config)).toBe('workflow: {}\n');
  });
});

describe('parseWorkflowYaml', () => {
  it('round-trips a fully-populated agentDefaults block', () => {
    const config = getDefaultConfig();
    config.workflow.agentDefaults = {
      iterate: {
        implementer: 'codex',
        reviewers: ['claude-code', 'agy'],
        banList: ['codex'],
      },
      panel: {
        reviewers: ['codex', 'claude-code'],
        banList: ['agy'],
      },
    };
    expect(parseWorkflowYaml(serializeWorkflowYaml(config))).toEqual(config);
  });

  it('ignores unknown top-level and workflow-level keys', () => {
    const config = parseWorkflowYaml(`
workflow:
  name: legacy
  steps: []
  completion:
    strategy: manual
    fallback: manual
captain:
  cli: claude-code
agents:
  codex:
    adapter: codex
error_handling:
  default:
    retry: 1
`);
    expect(config).toEqual({ workflow: {} });
  });

  it('rejects non-string agent default values', () => {
    expect(() => parseWorkflowYaml(`
workflow:
  agent_defaults:
    panel:
      ban_list: [1, 2]
`)).toThrow(/must be a string/);
  });
});

describe('mergeConfigs', () => {
  it('override fields win within each group; missing fields inherit', () => {
    const base = getDefaultConfig();
    base.workflow.agentDefaults = {
      iterate: { implementer: 'codex', reviewers: ['agy'] },
    };
    const override = getDefaultConfig();
    override.workflow.agentDefaults = {
      iterate: { reviewers: ['claude-code'] },
      panel: { reviewers: ['codex'] },
    };

    expect(mergeConfigs(base, override).workflow.agentDefaults).toEqual({
      iterate: { implementer: 'codex', reviewers: ['claude-code'] },
      panel: { reviewers: ['codex'] },
    });
  });
});
