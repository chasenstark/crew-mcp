import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import {
  getConfigPaths,
  getGlobalConfigPath,
  loadConfigByScope,
  loadEffectiveConfig,
  readActiveScopePreference,
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

  it('exposes global config path under homedir', () => {
    expect(getGlobalConfigPath()).toBe(join(tmpRoot, 'home', '.orchestra', 'workflow.yaml'));
  });
});
