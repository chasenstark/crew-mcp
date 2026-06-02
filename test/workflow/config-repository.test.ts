import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import {
  DEFAULT_CONFIG_PROFILE,
  getConfigPaths,
  getGlobalConfigPath,
  getGlobalProfileConfigPath,
  getProfilePreferencePath,
  getProjectProfileConfigPath,
  loadConfigByScope,
  loadEffectiveConfig,
  readActiveProfilePreference,
  readActiveScopePreference,
  saveActiveProfilePreference,
  saveActiveScopePreference,
  saveConfigByScope,
} from '../../src/workflow/config-repository.js';
import { getDefaultConfig } from '../../src/workflow/config-codec.js';
import { ModelId } from '../../src/workflow/models.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: vi.fn(actual.homedir),
  };
});

describe('config-repository', () => {
  const mockedHomedir = vi.mocked(homedir);
  let tmpRoot: string;
  let cwd: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `captain-config-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cwd = join(tmpRoot, 'project');
    mkdirSync(cwd, { recursive: true });
    mockedHomedir.mockReturnValue(join(tmpRoot, 'home'));
  });

  afterEach(() => {
    mockedHomedir.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns project/global/effective paths', () => {
    const paths = getConfigPaths(cwd);
    expect(paths.profile).toBe(DEFAULT_CONFIG_PROFILE);
    expect(paths.project).toBe(join(cwd, '.crew', 'workflow.yaml'));
    expect(paths.global).toBe(join(tmpRoot, 'home', '.crew', 'workflow.yaml'));
    expect(paths.effective).toBeNull();
  });

  it('saves and loads scoped config', () => {
    const config = getDefaultConfig();
    config.workflow.name = 'repo-test';

    const filePath = saveConfigByScope('project', cwd, config);
    expect(existsSync(filePath)).toBe(true);

    const loaded = loadConfigByScope('project', cwd);
    expect(loaded?.workflow.name).toBe('repo-test');

    const dirEntries = readdirSync(join(cwd, '.crew'));
    expect(dirEntries.some((entry) => entry.startsWith('workflow.yaml.tmp-'))).toBe(false);
  });

  it('saves and loads scoped config for a named profile', () => {
    const config = getDefaultConfig();
    config.workflow.name = 'codex-first';

    const filePath = saveConfigByScope('project', cwd, config, { profile: 'codex-first' });
    expect(filePath).toBe(getProjectProfileConfigPath(cwd, 'codex-first'));
    expect(existsSync(filePath)).toBe(true);

    const loaded = loadConfigByScope('project', cwd, { profile: 'codex-first' });
    expect(loaded?.workflow.name).toBe('codex-first');
  });

  it('loads effective config by merging project over global', () => {
    const global = getDefaultConfig();
    global.workflow.name = 'global';
    global.captain.model = 'global-model';
    saveConfigByScope('global', cwd, global);

    const project = getDefaultConfig();
    project.workflow.name = 'project';
    project.errorHandling.default.retry = 3;
    project.captain.model = undefined;
    saveConfigByScope('project', cwd, project);

    const effective = loadEffectiveConfig(cwd);
    expect(effective.workflow.name).toBe('project');
    expect(effective.captain.model).toBe('global-model');
    expect(effective.errorHandling.default.retry).toBe(3);
  });

  it('project defaults clear global legacy workflow surfaces while inheriting agent defaults', () => {
    const global = getDefaultConfig();
    global.workflow.steps = [
      { role: 'coder', agents: ['codex'], action: 'implement' },
    ];
    global.workflow.roleModels = { coder: ModelId.GPT_CODEX };
    global.workflow.completion = { strategy: 'judge_approval', fallback: 'max_passes' };
    global.workflow.agentDefaults = { panel: { reviewers: ['claude-code'] } };
    global.agents = {
      codex: { adapter: 'codex', model: ModelId.GPT_CODEX },
    };
    global.captain.model = ModelId.CLAUDE_SONNET;
    global.captain.preset = 'default';
    global.presets = { default: { hint: 'legacy hint' } };
    global.errorHandling.default.retry = 7;
    saveConfigByScope('global', cwd, global);

    const project = getDefaultConfig();
    project.workflow.name = 'project';
    saveConfigByScope('project', cwd, project);

    const effective = loadEffectiveConfig(cwd);
    expect(effective.workflow.name).toBe('project');
    expect(effective.workflow.steps).toEqual([]);
    expect(effective.workflow.roleModels).toBeUndefined();
    expect(effective.workflow.completion).toEqual({ strategy: 'manual', fallback: 'manual' });
    expect(effective.workflow.agentDefaults).toEqual({ panel: { reviewers: ['claude-code'] } });
    expect(effective.agents).toEqual({});
    expect(effective.captain.model).toBe(ModelId.CLAUDE_SONNET);
    expect(effective.captain.preset).toBeUndefined();
    expect(effective.presets).toBeUndefined();
    expect(effective.errorHandling.default.retry).toBe(1);
  });

  it('falls back to default profile config when named profile file is missing', () => {
    const project = getDefaultConfig();
    project.workflow.name = 'default-profile-project';
    saveConfigByScope('project', cwd, project);

    const loaded = loadConfigByScope('project', cwd, { profile: 'missing-profile' });
    expect(loaded?.workflow.name).toBe('default-profile-project');
  });

  it('throws with path context on parse failures', () => {
    const projectConfigDir = join(cwd, '.crew');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'workflow.yaml'), 'workflow:\n  steps: "bad"', 'utf-8');

    expect(() => loadEffectiveConfig(cwd)).toThrow(/Failed to parse .*workflow\.yaml/);
  });

  it('reads and writes active scope preference', () => {
    expect(readActiveScopePreference(cwd)).toBeNull();
    const scopeFile = saveActiveScopePreference(cwd, 'global');
    expect(scopeFile).toBe(join(cwd, '.crew', 'config-scope'));
    expect(readActiveScopePreference(cwd)).toBe('global');
  });

  it('reads and writes active profile preference', () => {
    expect(readActiveProfilePreference(cwd)).toBeNull();
    const profileFile = saveActiveProfilePreference(cwd, 'codex-first');
    expect(profileFile).toBe(getProfilePreferencePath(cwd));
    expect(readActiveProfilePreference(cwd)).toBe('codex-first');
  });

  it('exposes global config path under homedir', () => {
    expect(getGlobalConfigPath()).toBe(join(tmpRoot, 'home', '.crew', 'workflow.yaml'));
  });

  it('exposes profile config paths under project and home directories', () => {
    expect(getProjectProfileConfigPath(cwd, 'claude-first'))
      .toBe(join(cwd, '.crew', 'profiles', 'claude-first', 'workflow.yaml'));
    expect(getGlobalProfileConfigPath('claude-first'))
      .toBe(join(tmpRoot, 'home', '.crew', 'profiles', 'claude-first', 'workflow.yaml'));
  });
});
