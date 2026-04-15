import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseWorkflowYaml,
  serializeWorkflowYaml,
  getDefaultConfig,
  mergeConfigs,
  loadWorkflowConfig,
  getGlobalConfigPath,
} from '../../src/workflow/loader.js';
import { AdapterId, AgentId } from '../../src/workflow/agents.js';
import { ModelId } from '../../src/workflow/models.js';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir, homedir } from 'os';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: vi.fn(actual.homedir),
  };
});

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('Workflow Loader', () => {
  it('parses default workflow YAML', () => {
    const yaml = readFileSync(join(__dirname, '../../defaults/workflow.yaml'), 'utf-8');
    const config = parseWorkflowYaml(yaml);

    expect(config.workflow.name).toBe('default');
    expect(config.workflow.execution?.mode).toBe('judgment');
    expect(config.workflow.steps).toHaveLength(4);
    expect(config.workflow.steps[0].role).toBe('coder');
    expect(config.workflow.steps[1].role).toBe('reviewer');
    expect(config.workflow.steps[1].maxPasses).toBe(3);
    expect(config.agents['claude-code']).toBeDefined();
    expect(config.agents['codex']).toBeDefined();
    expect(config.captain.cli).toBe('claude-code');
  });

  it('parses optional model fields for agents and captain', () => {
    const yaml = `
workflow:
  name: model-config
  steps: []
agents:
  claude-code:
    model: ${ModelId.CLAUDE_SONNET}
captain:
  cli: claude-code
  model: ${ModelId.CLAUDE_OPUS}
`;
    const config = parseWorkflowYaml(yaml);
    expect(config.agents['claude-code'].model).toBe(ModelId.CLAUDE_SONNET);
    expect(config.captain.model).toBe(ModelId.CLAUDE_OPUS);
    expect(config.workflow.execution?.mode).toBe('linear');
  });

  it('resolves model aliases in YAML', () => {
    const yaml = `
workflow:
  name: model-aliases
  role_models:
    reviewer: GPT
    fix_review_issues: "\${CLAUDE_OPUS}"
  steps: []
agents:
  claude-code:
    model: CLAUDE_SONNET
captain:
  cli: claude-code
  model: "\${GPT_CODEX}"
`;

    const config = parseWorkflowYaml(yaml);
    expect(config.agents['claude-code'].model).toBe(ModelId.CLAUDE_SONNET);
    expect(config.captain.model).toBe(ModelId.GPT_CODEX);
    expect(config.workflow.roleModels).toEqual({
      reviewer: ModelId.GPT,
      fix_review_issues: ModelId.CLAUDE_OPUS,
    });
  });

  it('throws for unknown model aliases in YAML', () => {
    const yaml = `
workflow:
  name: bad-model-alias
  steps: []
agents:
  codex:
    model: NOT_A_MODEL_ALIAS
`;

    expect(() => parseWorkflowYaml(yaml)).toThrow(/Unknown model alias "NOT_A_MODEL_ALIAS"/);
  });

  it('resolves agent and adapter aliases in YAML', () => {
    const yaml = `
workflow:
  name: agent-aliases
  steps:
    - role: coder
      agent: CODEX
      action: implement
agents:
  CLAUDE_CODE:
    adapter: CLAUDE_CODE
    model: ${ModelId.CLAUDE_SONNET}
  CODEX:
    adapter: CODEX
    model: ${ModelId.GPT_CODEX}
  local:
    adapter: "\${GENERIC}"
    command: ollama
captain:
  cli: "\${CLAUDE_CODE}"
`;

    const config = parseWorkflowYaml(yaml);
    expect(config.workflow.steps[0].agent).toBe(AgentId.CODEX);
    expect(config.agents[AgentId.CLAUDE_CODE]?.adapter).toBe(AdapterId.CLAUDE_CODE);
    expect(config.agents[AgentId.CODEX]?.adapter).toBe(AdapterId.CODEX);
    expect(config.agents.local?.adapter).toBe(AdapterId.GENERIC);
    expect(config.captain.cli).toBe(AgentId.CLAUDE_CODE);
  });

  it('throws for unknown adapter aliases in YAML', () => {
    const yaml = `
workflow:
  name: bad-adapter-alias
  steps: []
agents:
  bad:
    adapter: NOT_A_ADAPTER_ALIAS
`;

    expect(() => parseWorkflowYaml(yaml)).toThrow(/Unknown adapter alias "NOT_A_ADAPTER_ALIAS"/);
  });

  it('parses workflow execution mode', () => {
    const yaml = `
workflow:
  name: execution-mode
  execution:
    mode: judgment
  steps: []
captain:
  cli: claude-code
`;
    const config = parseWorkflowYaml(yaml);
    expect(config.workflow.execution?.mode).toBe('judgment');
  });

  it('parses workflow role_models', () => {
    const yaml = `
workflow:
  name: role-models
  role_models:
    reviewer: ${ModelId.GPT}
    fix_review_issues: ${ModelId.CLAUDE_OPUS}
  steps: []
captain:
  cli: claude-code
`;
    const config = parseWorkflowYaml(yaml);
    expect(config.workflow.roleModels).toEqual({
      reviewer: ModelId.GPT,
      fix_review_issues: ModelId.CLAUDE_OPUS,
    });
  });

  it('parses generic agent command/args/capabilities fields', () => {
    const yaml = `
workflow:
  name: generic-config
  steps: []
agents:
  custom-agent:
    adapter: generic
    command: my-tool
    args: ["--prompt", "{{prompt}}"]
    capabilities: [analyze, review]
captain:
  cli: claude-code
`;
    const config = parseWorkflowYaml(yaml);
    const generic = config.agents['custom-agent'];
    expect(generic.adapter).toBe('generic');
    expect(generic.command).toBe('my-tool');
    expect(generic.args).toEqual(['--prompt', '{{prompt}}']);
    expect(generic.capabilities).toEqual(['analyze', 'review']);
  });

  it('returns default config', () => {
    const config = getDefaultConfig();
    expect(config.workflow.name).toBe('default');
    expect(config.workflow.execution?.mode).toBe('judgment');
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

  it('override agent can set only model without clobbering base agent fields', () => {
    const override = {
      ...getDefaultConfig(),
      agents: {
        'claude-code': { model: ModelId.CLAUDE_SONNET },
      },
    };

    const merged = mergeConfigs(baseConfig, override);

    expect(merged.agents['claude-code'].model).toBe(ModelId.CLAUDE_SONNET);
    expect(merged.agents['claude-code'].adapter).toBe(baseConfig.agents['claude-code'].adapter);
    expect(merged.agents['claude-code'].auth).toBe(baseConfig.agents['claude-code'].auth);
    expect(merged.agents['claude-code'].strengths).toEqual(baseConfig.agents['claude-code'].strengths);
  });

  it('override captain can set model while preserving cli', () => {
    const override = parseWorkflowYaml(`
workflow:
  name: override
  steps: []
captain:
  model: ${ModelId.CLAUDE_SONNET}
`);

    const merged = mergeConfigs(baseConfig, override);
    expect(merged.captain.model).toBe(ModelId.CLAUDE_SONNET);
    expect(merged.captain.cli).toBe(baseConfig.captain.cli);
  });

  it('merges workflow role models with override priority', () => {
    const base = getDefaultConfig();
    base.workflow.roleModels = {
      reviewer: ModelId.GPT_CODEX,
      coder: ModelId.CLAUDE_OPUS,
    };

    const override = getDefaultConfig();
    override.workflow.roleModels = {
      reviewer: ModelId.GPT,
      judge: ModelId.CLAUDE_SONNET,
    };

    const merged = mergeConfigs(base, override);
    expect(merged.workflow.roleModels).toEqual({
      reviewer: ModelId.GPT,
      coder: ModelId.CLAUDE_OPUS,
      judge: ModelId.CLAUDE_SONNET,
    });
  });

  it('serializes workflow role models as role_models', () => {
    const config = getDefaultConfig();
    config.workflow.roleModels = {
      reviewer: ModelId.GPT,
      judge: ModelId.CLAUDE_OPUS,
    };

    const yaml = serializeWorkflowYaml(config);
    expect(yaml).toContain('role_models:');
    expect(yaml).toContain(`reviewer: ${ModelId.GPT}`);
    expect(yaml).toContain(`judge: ${ModelId.CLAUDE_OPUS}`);
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
    expect(path).toContain('.crew');
    expect(path).toMatch(/workflow\.yaml$/);
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
  name: project-workflow
  steps:
    - role: coder
      agent: claude-code
      action: implement
`, 'utf-8');

    const config = loadWorkflowConfig(projectDir);
    expect(config.workflow.name).toBe('project-workflow');
  });

  it('uses global config when no project config exists', () => {
    const fakeHome = join(tmpDir, 'fake-home');
    const globalDir = join(fakeHome, '.crew');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'workflow.yaml'), `
workflow:
  name: global-workflow
  steps:
    - role: coder
      agent: claude-code
      action: implement
`, 'utf-8');

    const emptyProject = join(tmpDir, 'empty-project');
    mkdirSync(emptyProject, { recursive: true });

    const config = loadWorkflowConfig(emptyProject);
    expect(config.workflow.name).toBe('global-workflow');
  });

  it('merges project config over global config', () => {
    // Set up global config with agents
    const fakeHome = join(tmpDir, 'fake-home');
    const globalDir = join(fakeHome, '.crew');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'workflow.yaml'), `
workflow:
  name: global
  steps:
    - role: coder
      agent: claude-code
      action: implement
agents:
  claude-code:
    adapter: claude-code
    auth: subscription
    strengths:
      - implementation
  codex:
    adapter: codex
    auth: subscription
    strengths:
      - review
`, 'utf-8');

    // Set up project config that overrides workflow but not agents
    const projectDir = join(tmpDir, 'merge-project');
    const projectOrchDir = join(projectDir, '.crew');
    mkdirSync(projectOrchDir, { recursive: true });
    writeFileSync(join(projectOrchDir, 'workflow.yaml'), `
workflow:
  name: project-override
  steps:
    - role: reviewer
      agent: codex
      action: review
`, 'utf-8');

    const config = loadWorkflowConfig(projectDir);
    // Project workflow overrides global
    expect(config.workflow.name).toBe('project-override');
    expect(config.workflow.steps).toHaveLength(1);
    expect(config.workflow.steps[0].role).toBe('reviewer');
    // Global agents are preserved via merge
    expect(config.agents['claude-code']).toBeDefined();
    expect(config.agents['codex']).toBeDefined();
  });

  it('returns default config when no configs exist', () => {
    const emptyDir = join(tmpDir, 'empty');
    mkdirSync(emptyDir, { recursive: true });

    const config = loadWorkflowConfig(emptyDir);
    expect(config.workflow.name).toBe('default');
    expect(config.workflow.steps.length).toBeGreaterThan(0);
  });

  it('throws with path context on YAML parse error', () => {
    const projectDir = join(tmpDir, 'bad-yaml');
    const orchestraDir = join(projectDir, '.crew');
    mkdirSync(orchestraDir, { recursive: true });
    writeFileSync(join(orchestraDir, 'workflow.yaml'), `
workflow:
  steps: "not an array"
`, 'utf-8');

    expect(() => loadWorkflowConfig(projectDir)).toThrow(
      /Failed to parse.*\.crew\/workflow\.yaml/,
    );
  });
});
