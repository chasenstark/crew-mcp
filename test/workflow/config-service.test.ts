import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { AdapterId, AgentId } from '../../src/workflow/agents.js';
import { getDefaultConfig, resolveCaptainModel } from '../../src/workflow/config-codec.js';
import { ModelId } from '../../src/workflow/models.js';
import { loadConfigByScope, readActiveProfilePreference } from '../../src/workflow/config-repository.js';
import {
  addAgent,
  applyConfigPatch,
  copyConfigProfile,
  createConfigProfile,
  deleteConfigProfile,
  getConfigProfile,
  getConfigProfileSummary,
  getConfigValueOptions,
  getConfigScope,
  listConfigProfiles,
  removeAgent,
  resetConfig,
  selectConfigProfile,
  setConfigProfile,
  setConfigScope,
  setConfigValue,
  showConfig,
} from '../../src/workflow/config-service.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: vi.fn(actual.homedir),
  };
});

describe('config-service', () => {
  const mockedHomedir = vi.mocked(homedir);
  let tmpRoot: string;
  let cwd: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `captain-config-service-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cwd = join(tmpRoot, 'project');
    mkdirSync(cwd, { recursive: true });
    mockedHomedir.mockReturnValue(join(tmpRoot, 'home'));
  });

  afterEach(() => {
    mockedHomedir.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('defaults active scope to project', () => {
    expect(getConfigScope(cwd)).toBe('project');
  });

  it('persists active scope preference', () => {
    const result = setConfigScope(cwd, 'global');
    expect(result.scope).toBe('global');
    expect(getConfigScope(cwd)).toBe('global');
  });

  it('defaults active profile to default', () => {
    expect(getConfigProfile(cwd)).toBe('default');
  });

  it('persists active profile preference', () => {
    const result = setConfigProfile(cwd, 'codex-first');
    expect(result.profile).toBe('codex-first');
    expect(getConfigProfile(cwd)).toBe('codex-first');
  });

  it('creates, lists, selects, copies, and deletes crew profiles', () => {
    setConfigValue(cwd, 'captain.cli', 'codex');
    setConfigValue(cwd, 'captain.model', ModelId.GPT_CODEX);

    const created = createConfigProfile(cwd, 'codex-first', { from: 'current' });
    expect(created.profile).toBe('codex-first');
    expect(created.scope).toBe('project');

    let profiles = listConfigProfiles(cwd);
    expect(profiles.map((profile) => profile.name)).toEqual(['default', 'codex-first']);
    expect(profiles.find((profile) => profile.name === 'codex-first')?.captainCli).toBe('codex');

    const selected = selectConfigProfile(cwd, 'codex-first');
    expect(selected.profile).toBe('codex-first');
    expect(readActiveProfilePreference(cwd)).toBe('codex-first');

    const copied = copyConfigProfile(cwd, 'codex-first', 'codex-copy');
    expect(copied.profile).toBe('codex-copy');
    expect(loadConfigByScope('project', cwd, { profile: 'codex-copy' })?.captain.cli).toBe('codex');

    const deleted = deleteConfigProfile(cwd, 'codex-first');
    expect(deleted.activeProfile).toBe('default');
    expect(readActiveProfilePreference(cwd)).toBe('default');
    profiles = listConfigProfiles(cwd);
    expect(profiles.map((profile) => profile.name)).toEqual(['default', 'codex-copy']);
  });

  it('rejects selecting or copying missing profiles', () => {
    expect(() => selectConfigProfile(cwd, 'missing')).toThrow(/does not exist/);
    expect(() => copyConfigProfile(cwd, 'missing', 'copy')).toThrow(/does not exist/);
  });

  it('rejects deleting the default profile', () => {
    expect(() => deleteConfigProfile(cwd, 'default')).toThrow(/default profile cannot be deleted/);
  });

  it('shows profile details for a saved crew profile', () => {
    createConfigProfile(cwd, 'review-heavy', { from: 'default' });
    const summary = getConfigProfileSummary(cwd, 'review-heavy');
    expect(summary.name).toBe('review-heavy');
    expect(summary.projectExists).toBe(true);
    expect(summary.captainCli).toBe(AgentId.CLAUDE_CODE);
  });

  it('applies patch for workflow reviewer max passes', () => {
    const next = applyConfigPatch(getDefaultConfig(), {
      path: 'workflow.reviewer.maxPasses',
      value: '5',
    });
    expect(next.workflow.steps.find((step) => step.role === 'reviewer')?.maxPasses).toBe(5);
  });

  it('applies patch for workflow execution mode', () => {
    const next = applyConfigPatch(getDefaultConfig(), {
      path: 'workflow.execution.mode',
      value: 'judgment',
    });
    expect(next.workflow.execution?.mode).toBe('judgment');
  });

  it('applies reviewer max passes to review action step when role name is custom', () => {
    const config = getDefaultConfig();
    const reviewer = config.workflow.steps.find((step) => step.role === 'reviewer');
    if (reviewer) reviewer.role = 'qa';

    const next = applyConfigPatch(config, {
      path: 'workflow.reviewer.maxPasses',
      value: '4',
    });

    const reviewStep = next.workflow.steps.find((step) => step.action === 'review');
    expect(reviewStep?.maxPasses).toBe(4);
  });

  it('throws for unsupported patch path', () => {
    expect(() =>
      applyConfigPatch(getDefaultConfig(), {
        path: 'workflow.name',
        value: 'new-name',
      }),
    ).toThrow(/Unsupported config path/);
  });

  it('sets a config value in active scope', () => {
    setConfigScope(cwd, 'global');
    const result = setConfigValue(cwd, 'errorHandling.default.retry', '4');
    expect(result.scope).toBe('global');
    expect(result.profile).toBe('default');
    expect(result.nextValue).toBe(4);

    const globalConfig = loadConfigByScope('global', cwd);
    expect(globalConfig?.errorHandling.default.retry).toBe(4);
  });

  it('can set agent model', () => {
    const result = setConfigValue(cwd, 'agents.codex.model', ModelId.GPT);
    expect(result.nextValue).toBe(ModelId.GPT);
    const projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.agents.codex.model).toBe(ModelId.GPT);
  });

  it('resolves model aliases when setting model paths', () => {
    const captainResult = setConfigValue(cwd, 'captain.model', 'CLAUDE_OPUS');
    expect(captainResult.nextValue).toBe(ModelId.CLAUDE_OPUS);

    const roleResult = setConfigValue(cwd, 'workflow.roleModels.reviewer', '${GPT_CODEX}');
    expect(roleResult.nextValue).toBe(ModelId.GPT_CODEX);

    const agentResult = setConfigValue(cwd, 'agents.codex.model', 'GPT_MINI');
    expect(agentResult.nextValue).toBe(ModelId.GPT_MINI);
  });

  it('resolves agent and adapter aliases when setting config paths', () => {
    const cliResult = setConfigValue(cwd, 'captain.cli', '${CODEX}');
    expect(cliResult.nextValue).toBe(AgentId.CODEX);
    const captainModelResult = setConfigValue(cwd, 'captain.model', ModelId.GPT_CODEX);
    expect(captainModelResult.nextValue).toBe(ModelId.GPT_CODEX);

    addAgent(cwd, 'local-gemma', { adapter: AdapterId.GENERIC, command: 'ollama' });
    const adapterResult = setConfigValue(cwd, 'agents.local-gemma.adapter', 'OPENAI_COMPATIBLE');
    expect(adapterResult.nextValue).toBe(AdapterId.OPENAI_COMPATIBLE);
  });

  it('rejects unknown model aliases when setting model paths', () => {
    expect(() =>
      setConfigValue(cwd, 'captain.model', 'NOT_A_MODEL_ALIAS'),
    ).toThrow(/Unknown model alias/);
  });

  it('rejects unknown adapter aliases when setting adapter paths', () => {
    addAgent(cwd, 'local-gemma', { adapter: AdapterId.GENERIC, command: 'ollama' });
    expect(() =>
      setConfigValue(cwd, 'agents.local-gemma.adapter', 'NOT_A_ADAPTER_ALIAS'),
    ).toThrow(/Unknown adapter alias/);
  });

  it('can set generic agent fields', () => {
    addAgent(cwd, 'local-gemma', { adapter: 'generic', command: 'ollama' });

    setConfigValue(cwd, 'agents.local-gemma.args', 'run,gemma4:latest,{{prompt}}');
    setConfigValue(cwd, 'agents.local-gemma.capabilities', 'implement,review');

    const projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.agents['local-gemma'].args).toEqual(['run', 'gemma4:latest', '{{prompt}}']);
    expect(projectConfig?.agents['local-gemma'].capabilities).toEqual(['implement', 'review']);
  });

  it('supports cycling with "next" for model fields', () => {
    const result = setConfigValue(cwd, 'captain.model', 'next');
    expect(typeof result.nextValue).toBe('string');
    expect(result.nextValue).toBe(ModelId.CLAUDE_OPUS);
  });

  it('supports cycling with "next" for role model fields', () => {
    const result = setConfigValue(cwd, 'workflow.roleModels.reviewer', 'next');
    expect(result.nextValue).toBe(ModelId.CLAUDE_SONNET);
    const projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.workflow.roleModels?.reviewer).toBe(ModelId.CLAUDE_SONNET);
  });

  it('supports cycling with "prev" for numeric fields', () => {
    const result = setConfigValue(cwd, 'errorHandling.default.retry', 'prev');
    expect(result.nextValue).toBe(0);
  });

  it('returns preset options for supported fields', () => {
    const options = getConfigValueOptions(getDefaultConfig(), 'workflow.reviewer.maxPasses');
    expect(options).toEqual(['1', '2', '3', '4', '5']);
  });

  it('returns preset options for workflow execution mode (post-M4: judgment-only)', () => {
    const options = getConfigValueOptions(getDefaultConfig(), 'workflow.execution.mode');
    expect(options).toEqual(['judgment']);
  });

  it('returns adapter options for agent adapter path', () => {
    const options = getConfigValueOptions(getDefaultConfig(), 'agents.codex.adapter');
    expect(options).toContain('generic');
    expect(options).toContain('codex');
  });

  it('returns captain model options constrained to the captain adapter', () => {
    const options = getConfigValueOptions(getDefaultConfig(), 'captain.model');
    expect(options).toContain(ModelId.CLAUDE_SONNET);
    expect(options).toContain(ModelId.CLAUDE_OPUS);
    expect(options).not.toContain(ModelId.GPT);
    expect(options).not.toContain(ModelId.GPT_CODEX);
  });

  describe('captain.preset (M5-5a)', () => {
    it('sets the preset via /config set captain.preset', () => {
      const result = setConfigValue(cwd, 'captain.preset', 'thorough-review');
      expect(result.nextValue).toBe('thorough-review');
      const projectConfig = loadConfigByScope('project', cwd);
      expect(projectConfig?.captain.preset).toBe('thorough-review');
    });

    it('rejects the empty string (matches parseNonEmptyString)', () => {
      expect(() =>
        setConfigValue(cwd, 'captain.preset', ''),
      ).toThrow(/non-empty string/);
    });

    it('rejects unknown preset names at parse time', () => {
      expect(() =>
        setConfigValue(cwd, 'captain.preset', 'bogus-preset-name'),
      ).toThrow(/declared preset/);
    });

    it('options enumerate declared presets from defaults', () => {
      const options = getConfigValueOptions(getDefaultConfig(), 'captain.preset');
      expect(options).toContain('default');
      expect(options).toContain('thorough-review');
      expect(options).toContain('read-only');
    });
  });

  it('does not rewrite arbitrary openai-compatible models during unrelated edits', () => {
    addAgent(cwd, 'local-llama', {
      adapter: AdapterId.OPENAI_COMPATIBLE,
      model: 'llama3.2',
      apiBase: 'http://127.0.0.1:11434/v1',
    });

    setConfigValue(cwd, 'errorHandling.default.retry', '2');

    const projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.agents['local-llama'].model).toBe('llama3.2');
  });

  it('returns role-model options spanning every candidate agent on the matching steps', () => {
    // Steps now declare `agents: [...]` — multiple candidates per role. The
    // role-model option list surfaces presets from EVERY candidate's adapter
    // so the user can pick a CODEX-flavored model for a step that accepts
    // both CLAUDE_CODE and CODEX. Tests that asserted single-adapter scoping
    // pre-M5 were tracking the old singular `agent:` shape.
    const reviewerOptions = getConfigValueOptions(getDefaultConfig(), 'workflow.roleModels.reviewer');
    expect(reviewerOptions).toContain(ModelId.CLAUDE_SONNET);
    expect(reviewerOptions).toContain(ModelId.CLAUDE_OPUS);
    expect(reviewerOptions).toContain(ModelId.GPT_CODEX); // candidate CODEX surfaces its presets

    const judgeOptions = getConfigValueOptions(getDefaultConfig(), 'workflow.roleModels.judge');
    expect(judgeOptions).toContain(ModelId.CLAUDE_SONNET);
    expect(judgeOptions).toContain(ModelId.CLAUDE_OPUS);
    // Judge step has agents: [CAPTAIN] only, so its options stay scoped to
    // the captain's adapter type — no GPT presets here.
    expect(judgeOptions).not.toContain(ModelId.GPT_CODEX);

    const fixOptions = getConfigValueOptions(getDefaultConfig(), 'workflow.roleModels.fix_review_issues');
    expect(fixOptions).toContain(ModelId.GPT);
    expect(fixOptions).toContain(ModelId.GPT_CODEX);
  });

  it('returns no reviewer presets when no review step exists', () => {
    const config = getDefaultConfig();
    config.workflow.steps = config.workflow.steps.filter(
      (step) => step.role !== 'reviewer' && step.action !== 'review',
    );
    const options = getConfigValueOptions(config, 'workflow.reviewer.maxPasses');
    expect(options).toEqual([]);
  });

  it('rejects invalid integer values', () => {
    expect(() =>
      setConfigValue(cwd, 'workflow.reviewer.maxPasses', '0'),
    ).toThrow(/expected integer >= 1/);
  });

  it('rejects invalid execution mode values (post-M4: only judgment)', () => {
    expect(() =>
      setConfigValue(cwd, 'workflow.execution.mode', 'nonexistent'),
    ).toThrow(/'judgment' \(linear mode was retired/);
    // Legacy callers trying to re-introduce linear mode hit the same error.
    expect(() =>
      setConfigValue(cwd, 'workflow.execution.mode', 'linear'),
    ).toThrow(/'judgment' \(linear mode was retired/);
  });

  it('rejects unknown agent model path', () => {
    expect(() =>
      setConfigValue(cwd, 'agents.unknown.model', 'foo'),
    ).toThrow(/unknown agent "unknown"/i);
  });

  it('rejects unknown role-model keys', () => {
    expect(() =>
      setConfigValue(cwd, 'workflow.roleModels.unknownRole', ModelId.GPT),
    ).toThrow(/workflow\.roleModels\.unknownRole/);
  });

  it('adds and removes a custom agent', () => {
    const addResult = addAgent(cwd, 'local-gemma', {
      adapter: 'generic',
      command: 'ollama',
      capabilities: ['analyze'],
    });
    expect(addResult.agent.command).toBe('ollama');
    expect(loadConfigByScope('project', cwd)?.agents['local-gemma']).toBeDefined();

    const removeResult = removeAgent(cwd, 'local-gemma');
    expect(removeResult.name).toBe('local-gemma');
    expect(loadConfigByScope('project', cwd)?.agents['local-gemma']).toBeUndefined();
  });

  it('prevents removing agent referenced by captain.cli', () => {
    expect(() => removeAgent(cwd, 'claude-code')).toThrow(/captain\.cli/i);
  });

  it('rejects reviewer max passes when no review step exists', () => {
    const config = getDefaultConfig();
    config.workflow.steps = config.workflow.steps.filter(
      (step) => step.role !== 'reviewer' && step.action !== 'review',
    );
    expect(() =>
      applyConfigPatch(config, { path: 'workflow.reviewer.maxPasses', value: '3' }),
    ).toThrow(/no review step exists/i);
  });

  it('resets scoped config to defaults', () => {
    setConfigValue(cwd, 'errorHandling.default.retry', '9');
    const result = resetConfig(cwd);
    expect(result.scope).toBe('project');
    expect(result.config.errorHandling.default.retry).toBe(1);
    const projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.errorHandling.default.retry).toBe(1);
  });

  it('shows effective config and paths', () => {
    setConfigValue(cwd, 'captain.cli', 'codex');
    setConfigValue(cwd, 'captain.model', ModelId.GPT_CODEX);
    const shown = showConfig(cwd);
    expect(shown.activeScope).toBe('project');
    expect(shown.activeProfile).toBe('default');
    expect(shown.effectiveConfig.captain.cli).toBe('codex');
    expect(shown.paths.project).toContain('.crew/workflow.yaml');
  });

  it('writes to explicit profile when provided', () => {
    const result = setConfigValue(cwd, 'captain.cli', 'codex', { profile: 'codex-first' });
    expect(result.profile).toBe('codex-first');
    setConfigValue(cwd, 'captain.model', ModelId.GPT_CODEX, { profile: 'codex-first' });

    const profileConfig = loadConfigByScope('project', cwd, { profile: 'codex-first' });
    expect(profileConfig?.captain.cli).toBe('codex');
    expect(resolveCaptainModel(profileConfig!.captain)).toBe(ModelId.GPT_CODEX);

    const defaultConfig = loadConfigByScope('project', cwd);
    expect(defaultConfig).toBeNull();
  });

  it('writes to active profile when no profile option is provided', () => {
    setConfigProfile(cwd, 'claude-first');
    const result = setConfigValue(cwd, 'captain.cli', 'codex');
    expect(result.profile).toBe('claude-first');
    setConfigValue(cwd, 'captain.model', ModelId.GPT_CODEX);

    const activeProfileConfig = loadConfigByScope('project', cwd, { profile: 'claude-first' });
    expect(activeProfileConfig?.captain.cli).toBe('codex');
    expect(resolveCaptainModel(activeProfileConfig!.captain)).toBe(ModelId.GPT_CODEX);
  });
});
