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
    config.workflow.agentDefaults = { iterate: { implementer: 'repo-test' } };

    const filePath = saveConfigByScope('project', cwd, config);
    expect(existsSync(filePath)).toBe(true);

    const loaded = loadConfigByScope('project', cwd);
    expect(loaded?.workflow.agentDefaults?.iterate?.implementer).toBe('repo-test');

    const dirEntries = readdirSync(join(cwd, '.crew'));
    expect(dirEntries.some((entry) => entry.startsWith('workflow.yaml.tmp-'))).toBe(false);
  });

  it('saves and loads scoped config for a named profile', () => {
    const config = getDefaultConfig();
    config.workflow.agentDefaults = { iterate: { implementer: 'codex' } };

    const filePath = saveConfigByScope('project', cwd, config, { profile: 'codex-first' });
    expect(filePath).toBe(getProjectProfileConfigPath(cwd, 'codex-first'));
    expect(existsSync(filePath)).toBe(true);

    const loaded = loadConfigByScope('project', cwd, { profile: 'codex-first' });
    expect(loaded?.workflow.agentDefaults?.iterate?.implementer).toBe('codex');
  });

  it('loads effective config by merging project over global', () => {
    const global = getDefaultConfig();
    global.workflow.agentDefaults = {
      iterate: { implementer: 'codex', banList: ['agy'] },
    };
    saveConfigByScope('global', cwd, global);

    const project = getDefaultConfig();
    project.workflow.agentDefaults = { iterate: { implementer: 'claude-code' } };
    saveConfigByScope('project', cwd, project);

    const effective = loadEffectiveConfig(cwd);
    expect(effective.workflow.agentDefaults).toEqual({
      iterate: { implementer: 'claude-code', banList: ['agy'] },
    });
  });

  it('falls back to default profile config when named profile file is missing', () => {
    const project = getDefaultConfig();
    project.workflow.agentDefaults = { iterate: { implementer: 'codex' } };
    saveConfigByScope('project', cwd, project);

    const loaded = loadConfigByScope('project', cwd, { profile: 'missing-profile' });
    expect(loaded?.workflow.agentDefaults?.iterate?.implementer).toBe('codex');
  });

  it('throws with path context on parse failures', () => {
    const projectConfigDir = join(cwd, '.crew');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(projectConfigDir, 'workflow.yaml'),
      'workflow:\n  agent_defaults:\n    iterate:\n      reviewers: "bad"',
      'utf-8',
    );

    expect(() => loadEffectiveConfig(cwd)).toThrow(/Failed to parse .*workflow\.yaml/);
  });

  it('reads a user-managed active scope preference file', () => {
    expect(readActiveScopePreference(cwd)).toBeNull();
    mkdirSync(join(cwd, '.crew'), { recursive: true });
    writeFileSync(join(cwd, '.crew', 'config-scope'), 'global\n', 'utf-8');
    expect(readActiveScopePreference(cwd)).toBe('global');
  });

  it('reads a user-managed active profile preference file', () => {
    expect(readActiveProfilePreference(cwd)).toBeNull();
    mkdirSync(join(cwd, '.crew'), { recursive: true });
    writeFileSync(getProfilePreferencePath(cwd), 'codex-first\n', 'utf-8');
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
