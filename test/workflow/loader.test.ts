import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDefaultConfig, loadWorkflowConfig } from '../../src/workflow/loader.js';
import {
  parseWorkflowYaml,
  serializeWorkflowYaml,
  mergeConfigs,
} from '../../src/workflow/config-codec.js';
import { getGlobalConfigPath } from '../../src/workflow/config-repository.js';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: vi.fn(actual.homedir),
  };
});

describe('Workflow Loader', () => {
  it('serializes and parses code-defined defaults', () => {
    const yaml = serializeWorkflowYaml(getDefaultConfig());
    const config = parseWorkflowYaml(yaml);
    expect(config).toEqual({ workflow: {} });
  });

  it('round-trips agent defaults through serialize/parse', () => {
    const config = getDefaultConfig();
    config.workflow.agentDefaults = {
      iterate: {
        implementer: 'codex',
        reviewers: ['claude-code'],
        banList: ['agy'],
      },
      panel: {
        reviewers: ['codex', 'claude-code'],
      },
    };

    const yaml = serializeWorkflowYaml(config);
    expect(yaml).toContain('agent_defaults');
    expect(yaml).toContain('ban_list');
    expect(parseWorkflowYaml(yaml)).toEqual(config);
  });

  it('accepts camelCase agentDefaults/banList keys too (defensive)', () => {
    const config = parseWorkflowYaml(`
workflow:
  agentDefaults:
    iterate:
      implementer: codex
      banList: [agy]
`);
    expect(config.workflow.agentDefaults).toEqual({
      iterate: { implementer: 'codex', banList: ['agy'] },
    });
  });

  it('ignores retired v0.1 blocks (steps, agents, captain, presets, error_handling)', () => {
    const config = parseWorkflowYaml(`
workflow:
  name: legacy
  execution:
    mode: linear
  steps:
    - role: coder
      agents: [codex]
      action: implement
  role_models:
    reviewer: sonnet
  completion:
    strategy: manual
    fallback: manual
agents:
  codex:
    adapter: codex
captain:
  cli: claude-code
presets:
  default:
    hint: default
error_handling:
  default:
    retry: 2
`);
    expect(config).toEqual({ workflow: {} });
  });

  it('rejects malformed agent_defaults values', () => {
    expect(() => parseWorkflowYaml(`
workflow:
  agent_defaults:
    iterate:
      reviewers: not-a-list
`)).toThrow(/must be an array of strings/);
    expect(() => parseWorkflowYaml(`
workflow:
  agent_defaults:
    iterate:
      implementer: [not-a-string]
`)).toThrow(/must be a string/);
  });

  it('returns default config', () => {
    expect(getDefaultConfig()).toEqual({ workflow: {} });
  });

  it('handles minimal YAML', () => {
    expect(parseWorkflowYaml('workflow: {}\n')).toEqual({ workflow: {} });
    expect(parseWorkflowYaml('')).toEqual({ workflow: {} });
  });
});

describe('mergeConfigs', () => {
  it('merges agent defaults field-by-field within iterate/panel', () => {
    const base = getDefaultConfig();
    base.workflow.agentDefaults = {
      iterate: { implementer: 'codex', banList: ['agy'] },
      panel: { reviewers: ['codex'] },
    };
    const override = getDefaultConfig();
    override.workflow.agentDefaults = {
      iterate: { implementer: 'claude-code' },
    };

    const merged = mergeConfigs(base, override);
    expect(merged.workflow.agentDefaults).toEqual({
      iterate: { implementer: 'claude-code', banList: ['agy'] },
      panel: { reviewers: ['codex'] },
    });
  });

  it('drops agentDefaults entirely when neither side has any', () => {
    const merged = mergeConfigs(getDefaultConfig(), getDefaultConfig());
    expect(merged.workflow.agentDefaults).toBeUndefined();
  });
});

describe('getGlobalConfigPath', () => {
  it('returns path under home directory', () => {
    expect(getGlobalConfigPath()).toContain('.crew/workflow.yaml');
  });
});

describe('loadWorkflowConfig', () => {
  let tmpDir: string;
  const mockedHomedir = vi.mocked(homedir);

  beforeEach(() => {
    tmpDir = join(tmpdir(), `captain-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    // Point homedir to a clean temp dir so real ~/.crew doesn't interfere
    mockedHomedir.mockReturnValue(join(tmpDir, 'fake-home'));
  });

  afterEach(() => {
    mockedHomedir.mockRestore();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('uses project config when present', () => {
    const projectDir = join(tmpDir, 'project');
    const orchestraDir = join(projectDir, '.crew');
    mkdirSync(orchestraDir, { recursive: true });
    writeFileSync(join(orchestraDir, 'workflow.yaml'), `
workflow:
  agent_defaults:
    iterate:
      implementer: codex
`, 'utf-8');

    const config = loadWorkflowConfig(projectDir);
    expect(config.workflow.agentDefaults?.iterate?.implementer).toBe('codex');
  });

  it('uses global config when no project config exists', () => {
    const fakeHome = join(tmpDir, 'fake-home');
    const globalDir = join(fakeHome, '.crew');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'workflow.yaml'), `
workflow:
  agent_defaults:
    panel:
      reviewers: [claude-code]
`, 'utf-8');

    const emptyProject = join(tmpDir, 'empty-project');
    mkdirSync(emptyProject, { recursive: true });

    const config = loadWorkflowConfig(emptyProject);
    expect(config.workflow.agentDefaults?.panel?.reviewers).toEqual(['claude-code']);
  });

  it('merges project config over global config', () => {
    const fakeHome = join(tmpDir, 'fake-home');
    const globalDir = join(fakeHome, '.crew');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'workflow.yaml'), `
workflow:
  agent_defaults:
    iterate:
      implementer: codex
      ban_list: [agy]
`, 'utf-8');

    const projectDir = join(tmpDir, 'merge-project');
    const projectOrchDir = join(projectDir, '.crew');
    mkdirSync(projectOrchDir, { recursive: true });
    writeFileSync(join(projectOrchDir, 'workflow.yaml'), `
workflow:
  agent_defaults:
    iterate:
      implementer: claude-code
`, 'utf-8');

    const config = loadWorkflowConfig(projectDir);
    expect(config.workflow.agentDefaults).toEqual({
      iterate: { implementer: 'claude-code', banList: ['agy'] },
    });
  });

  it('returns default config when no configs exist', () => {
    const emptyDir = join(tmpDir, 'empty');
    mkdirSync(emptyDir, { recursive: true });

    const config = loadWorkflowConfig(emptyDir);
    expect(config).toEqual({ workflow: {} });
  });

  it('throws with path context on YAML parse error', () => {
    const projectDir = join(tmpDir, 'bad-yaml');
    const orchestraDir = join(projectDir, '.crew');
    mkdirSync(orchestraDir, { recursive: true });
    writeFileSync(join(orchestraDir, 'workflow.yaml'), `
workflow:
  agent_defaults:
    iterate:
      reviewers: "not an array"
`, 'utf-8');

    expect(() => loadWorkflowConfig(projectDir)).toThrow(
      /Failed to parse.*\.crew\/workflow\.yaml/,
    );
  });
});
