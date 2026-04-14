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
    tmpRoot = join(tmpdir(), `orchestrator-config-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    expect(paths.project).toBe(join(cwd, '.orchestra', 'workflow.yaml'));
    expect(paths.global).toBe(join(tmpRoot, 'home', '.orchestra', 'workflow.yaml'));
    expect(paths.effective).toBeNull();
  });

  it('saves and loads scoped config', () => {
    const config = getDefaultConfig();
    config.workflow.name = 'repo-test';

    const filePath = saveConfigByScope('project', cwd, config);
    expect(existsSync(filePath)).toBe(true);

    const loaded = loadConfigByScope('project', cwd);
    expect(loaded?.workflow.name).toBe('repo-test');

    const dirEntries = readdirSync(join(cwd, '.orchestra'));
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
    global.orchestrator.model = 'global-model';
    saveConfigByScope('global', cwd, global);

    const project = getDefaultConfig();
    project.workflow.name = 'project';
    project.errorHandling.default.retry = 3;
    project.orchestrator.model = undefined;
    saveConfigByScope('project', cwd, project);

    const effective = loadEffectiveConfig(cwd);
    expect(effective.workflow.name).toBe('project');
    expect(effective.orchestrator.model).toBe('global-model');
    expect(effective.errorHandling.default.retry).toBe(3);
  });

  it('falls back to default profile config when named profile file is missing', () => {
    const project = getDefaultConfig();
    project.workflow.name = 'default-profile-project';
    saveConfigByScope('project', cwd, project);

    const loaded = loadConfigByScope('project', cwd, { profile: 'missing-profile' });
    expect(loaded?.workflow.name).toBe('default-profile-project');
  });

  it('throws with path context on parse failures', () => {
    const projectConfigDir = join(cwd, '.orchestra');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'workflow.yaml'), 'workflow:\n  steps: "bad"', 'utf-8');

    expect(() => loadEffectiveConfig(cwd)).toThrow(/Failed to parse .*workflow\.yaml/);
  });

  it('reads and writes active scope preference', () => {
    expect(readActiveScopePreference(cwd)).toBeNull();
    const scopeFile = saveActiveScopePreference(cwd, 'global');
    expect(scopeFile).toBe(join(cwd, '.orchestra', 'config-scope'));
    expect(readActiveScopePreference(cwd)).toBe('global');
  });

  it('reads and writes active profile preference', () => {
    expect(readActiveProfilePreference(cwd)).toBeNull();
    const profileFile = saveActiveProfilePreference(cwd, 'codex-first');
    expect(profileFile).toBe(getProfilePreferencePath(cwd));
    expect(readActiveProfilePreference(cwd)).toBe('codex-first');
  });

  it('exposes global config path under homedir', () => {
    expect(getGlobalConfigPath()).toBe(join(tmpRoot, 'home', '.orchestra', 'workflow.yaml'));
  });

  it('exposes profile config paths under project and home directories', () => {
    expect(getProjectProfileConfigPath(cwd, 'claude-first'))
      .toBe(join(cwd, '.orchestra', 'profiles', 'claude-first', 'workflow.yaml'));
    expect(getGlobalProfileConfigPath('claude-first'))
      .toBe(join(tmpRoot, 'home', '.orchestra', 'profiles', 'claude-first', 'workflow.yaml'));
  });
});
