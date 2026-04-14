import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseWorkflowYaml, getDefaultConfig, mergeConfigs, loadWorkflowConfig, getGlobalConfigPath } from '../../src/workflow/loader.js';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('Workflow Loader', () => {
  it('parses default workflow YAML', () => {
    const yaml = readFileSync(join(__dirname, '../../defaults/workflow.yaml'), 'utf-8');
    const config = parseWorkflowYaml(yaml);

    expect(config.workflow.name).toBe('default');
    expect(config.workflow.steps).toHaveLength(4);
    expect(config.workflow.steps[0].role).toBe('coder');
    expect(config.workflow.steps[1].role).toBe('reviewer');
    expect(config.workflow.steps[1].maxPasses).toBe(3);
    expect(config.agents['claude-code']).toBeDefined();
    expect(config.agents['codex']).toBeDefined();
    expect(config.orchestrator.cli).toBe('claude-code');
  });

  it('returns default config', () => {
    const config = getDefaultConfig();
    expect(config.workflow.name).toBe('default');
    expect(config.workflow.steps.length).toBeGreaterThan(0);
  });

  it('handles minimal YAML', () => {
    const yaml = 'workflow:\n  name: minimal\n  steps: []';
    const config = parseWorkflowYaml(yaml);
    expect(config.workflow.name).toBe('minimal');
    expect(config.workflow.steps).toEqual([]);
  });
});

describe('mergeConfigs', () => {
  const baseConfig = getDefaultConfig();

  it('override agents merge with base agents', () => {
    const override = {
      ...getDefaultConfig(),
      agents: {
        'custom-agent': { adapter: 'custom', auth: 'api-key', strengths: ['analysis'] },
      },
    };

    const merged = mergeConfigs(baseConfig, override);

    // Base agents are preserved
    expect(merged.agents['claude-code']).toBeDefined();
    expect(merged.agents['codex']).toBeDefined();
    // Override agent is added
    expect(merged.agents['custom-agent']).toEqual({
      adapter: 'custom',
      auth: 'api-key',
      strengths: ['analysis'],
    });
  });

  it('override agent replaces base agent with same key', () => {
    const override = {
      ...getDefaultConfig(),
      agents: {
        'claude-code': { adapter: 'claude-code', auth: 'api-key', strengths: ['security'] },
      },
    };

    const merged = mergeConfigs(baseConfig, override);

    expect(merged.agents['claude-code'].strengths).toEqual(['security']);
    // codex from base is preserved
    expect(merged.agents['codex']).toBeDefined();
  });

  it('override steps replace base steps entirely', () => {
    const override = {
      ...getDefaultConfig(),
      workflow: {
        name: 'custom',
        steps: [{ role: 'coder', agent: 'claude-code', action: 'implement' }],
        completion: { strategy: 'simple', fallback: 'none' },
      },
    };

    const merged = mergeConfigs(baseConfig, override);

    expect(merged.workflow.steps).toHaveLength(1);
    expect(merged.workflow.steps[0].role).toBe('coder');
  });

  it('empty override steps fall back to base steps', () => {
    const override = {
      ...getDefaultConfig(),
      workflow: {
        name: 'custom',
        steps: [],
        completion: { strategy: 'simple', fallback: 'none' },
      },
    };

    const merged = mergeConfigs(baseConfig, override);

    // Base steps are used since override has empty array
    expect(merged.workflow.steps).toEqual(baseConfig.workflow.steps);
  });

  it('errorHandling fields merge at field level', () => {
    const override = {
      ...getDefaultConfig(),
      errorHandling: {
        default: { retry: 5, fallback: null, onExhausted: 'ask_user' },
      },
    };

    const merged = mergeConfigs(baseConfig, override);

    expect(merged.errorHandling.default.retry).toBe(5);
    expect(merged.errorHandling.default.onExhausted).toBe('ask_user');
  });
});

describe('getGlobalConfigPath', () => {
  it('returns path under home directory', () => {
    const path = getGlobalConfigPath();
    expect(path).toContain('.orchestra');
    expect(path).toMatch(/workflow\.yaml$/);
  });
});

describe('loadWorkflowConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `orchestrator-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('uses project config when present', () => {
    const projectDir = join(tmpDir, 'project');
    const orchestraDir = join(projectDir, '.orchestra');
    mkdirSync(orchestraDir, { recursive: true });
    writeFileSync(join(orchestraDir, 'workflow.yaml'), `
workflow:
  name: project-workflow
  steps:
    - role: coder
      agent: claude-code
      action: implement
`, 'utf-8');

    const config = loadWorkflowConfig(projectDir);
    expect(config.workflow.name).toBe('project-workflow');
  });

  it('returns default config when no configs exist', () => {
    const emptyDir = join(tmpDir, 'empty');
    mkdirSync(emptyDir, { recursive: true });

    // Mock getGlobalConfigPath to return a non-existent path
    // Since loadWorkflowConfig uses the real homedir, we test the fallback
    // by pointing to a project dir with no .orchestra/
    const config = loadWorkflowConfig(emptyDir);
    expect(config.workflow.name).toBe('default');
    expect(config.workflow.steps.length).toBeGreaterThan(0);
  });

  it('throws with path context on YAML parse error', () => {
    const projectDir = join(tmpDir, 'bad-yaml');
    const orchestraDir = join(projectDir, '.orchestra');
    mkdirSync(orchestraDir, { recursive: true });
    writeFileSync(join(orchestraDir, 'workflow.yaml'), `
workflow:
  steps: "not an array"
`, 'utf-8');

    expect(() => loadWorkflowConfig(projectDir)).toThrow(
      /Failed to parse.*\.orchestra\/workflow\.yaml/,
    );
  });
});
