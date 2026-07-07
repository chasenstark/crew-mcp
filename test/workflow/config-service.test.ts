import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { loadConfigByScope, saveConfigByScope } from '../../src/workflow/config-repository.js';
import {
  applyConfigPatch,
  getConfigProfile,
  getConfigValueOptions,
  getConfigScope,
  setConfigValue,
  showConfig,
  unsetConfigValue,
} from '../../src/workflow/config-service.js';
import { getDefaultConfig } from '../../src/workflow/config-codec.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: vi.fn(actual.homedir),
  };
});

/**
 * A v0.1-era workflow.yaml with every retired block. The parser must
 * ignore everything except workflow.agent_defaults, and a subsequent
 * `config set` must not copy the retired blocks anywhere.
 */
const LEGACY_YAML = `workflow:
  name: default
  execution:
    mode: judgment
  steps:
    - role: coder
      agents: [codex, claude-code]
      action: implement
  role_models:
    reviewer: sonnet
  agent_defaults:
    panel:
      reviewers: [claude-code]
  completion:
    strategy: manual
    fallback: manual
agents:
  codex:
    adapter: codex
    model: gpt-5.3-codex
captain:
  cli: claude-code
  preset: default
presets:
  default:
    hint: default
error_handling:
  default:
    retry: 1
    fallback: null
    on_exhausted: ask_user
`;

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

  it('defaults active profile to default', () => {
    expect(getConfigProfile(cwd)).toBe('default');
  });

  it('throws for unsupported patch path', () => {
    expect(() =>
      applyConfigPatch(getDefaultConfig(), { path: 'captain.cli', value: 'codex' }),
    ).toThrow(/Unsupported config path/);
    expect(() =>
      setConfigValue(cwd, 'workflow.reviewer.maxPasses', '3'),
    ).toThrow(/Unsupported config path/);
  });

  it('round-trips workflow agentDefaults through config set/show', () => {
    setConfigValue(cwd, 'workflow.agentDefaults.iterate.implementer', 'codex');
    setConfigValue(cwd, 'workflow.agentDefaults.iterate.reviewers', '["claude-code"]');
    setConfigValue(cwd, 'workflow.agentDefaults.iterate.banList', '["agy"]');
    setConfigValue(cwd, 'workflow.agentDefaults.panel.reviewers', '["codex","claude-code"]');

    const shown = showConfig(cwd);
    expect(shown.effectiveConfig.workflow.agentDefaults).toEqual({
      iterate: {
        implementer: 'codex',
        reviewers: ['claude-code'],
        banList: ['agy'],
      },
      panel: {
        reviewers: ['codex', 'claude-code'],
      },
    });
    const projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.workflow.agentDefaults?.iterate?.implementer).toBe('codex');
  });

  it('rejects agentDefaults reviewer and banList collisions', () => {
    setConfigValue(cwd, 'workflow.agentDefaults.panel.reviewers', '["codex","claude-code"]');
    expect(() =>
      setConfigValue(cwd, 'workflow.agentDefaults.panel.banList', '["codex"]'),
    ).toThrow(/workflow\.agentDefaults\.panel\.banList/);
  });

  it('rejects empty agentDefaults ids', () => {
    expect(() =>
      setConfigValue(cwd, 'workflow.agentDefaults.iterate.implementer', ''),
    ).toThrow(/non-empty string/);
    expect(() =>
      setConfigValue(cwd, 'workflow.agentDefaults.iterate.reviewers', '[""]'),
    ).toThrow(/non-empty strings/);
  });

  it('allows partial agentDefaults population', () => {
    setConfigValue(cwd, 'workflow.agentDefaults.panel.banList', '["agy"]');
    const shown = showConfig(cwd);
    expect(shown.effectiveConfig.workflow.agentDefaults).toEqual({
      panel: {
        banList: ['agy'],
      },
    });
  });

  it('unsets agentDefaults values and prunes empty containers', () => {
    setConfigValue(cwd, 'workflow.agentDefaults.iterate.implementer', 'codex');
    const result = unsetConfigValue(cwd, 'workflow.agentDefaults.iterate.implementer');
    expect(result.nextValue).toBeUndefined();
    const projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.workflow.agentDefaults).toBeUndefined();
  });

  it('supports cycling with "next"/"prev" through agent options', () => {
    const options = getConfigValueOptions(
      getDefaultConfig(),
      'workflow.agentDefaults.iterate.implementer',
    );
    expect(options).toEqual(['agy', 'claude-code', 'codex']);

    const first = setConfigValue(cwd, 'workflow.agentDefaults.iterate.implementer', 'next');
    expect(first.nextValue).toBe('agy');
    const second = setConfigValue(cwd, 'workflow.agentDefaults.iterate.implementer', 'next');
    expect(second.nextValue).toBe('claude-code');
    const back = setConfigValue(cwd, 'workflow.agentDefaults.iterate.implementer', 'prev');
    expect(back.nextValue).toBe('agy');
  });

  it('parses a legacy v0.1 workflow.yaml, reading only agent_defaults', () => {
    mkdirSync(join(cwd, '.crew'), { recursive: true });
    writeFileSync(join(cwd, '.crew', 'workflow.yaml'), LEGACY_YAML, 'utf-8');

    const shown = showConfig(cwd);
    expect(shown.effectiveConfig).toEqual({
      workflow: {
        agentDefaults: { panel: { reviewers: ['claude-code'] } },
      },
    });
  });

  it('first project config set does not copy global legacy workflow surfaces', () => {
    const globalDir = join(tmpRoot, 'home', '.crew');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'workflow.yaml'), LEGACY_YAML, 'utf-8');

    setConfigValue(cwd, 'workflow.agentDefaults.iterate.implementer', 'codex');

    const projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig).toEqual({
      workflow: {
        agentDefaults: { iterate: { implementer: 'codex' } },
      },
    });

    const shown = showConfig(cwd);
    expect(shown.effectiveConfig.workflow.agentDefaults).toEqual({
      iterate: { implementer: 'codex' },
      panel: { reviewers: ['claude-code'] },
    });
  });

  it('shows effective config and paths', () => {
    setConfigValue(cwd, 'workflow.agentDefaults.iterate.implementer', 'codex');
    const shown = showConfig(cwd);
    expect(shown.activeScope).toBe('project');
    expect(shown.activeProfile).toBe('default');
    expect(shown.effectiveConfig.workflow.agentDefaults?.iterate?.implementer).toBe('codex');
    expect(shown.paths.project).toContain('.crew/workflow.yaml');
  });

  it('writes to explicit profile when provided', () => {
    const result = setConfigValue(
      cwd,
      'workflow.agentDefaults.iterate.implementer',
      'codex',
      { profile: 'codex-first' },
    );
    expect(result.profile).toBe('codex-first');

    const profileConfig = loadConfigByScope('project', cwd, { profile: 'codex-first' });
    expect(profileConfig?.workflow.agentDefaults?.iterate?.implementer).toBe('codex');

    const defaultConfig = loadConfigByScope('project', cwd);
    expect(defaultConfig).toBeNull();
  });

  it('writes to active profile when no profile option is provided', () => {
    // The active-profile preference file is user-managed now that the v0.1
    // `config profile` command surface is retired; stage it directly.
    mkdirSync(join(cwd, '.crew'), { recursive: true });
    writeFileSync(join(cwd, '.crew', 'config-profile'), 'claude-first\n', 'utf-8');
    const result = setConfigValue(cwd, 'workflow.agentDefaults.iterate.implementer', 'codex');
    expect(result.profile).toBe('claude-first');

    const activeProfileConfig = loadConfigByScope('project', cwd, { profile: 'claude-first' });
    expect(activeProfileConfig?.workflow.agentDefaults?.iterate?.implementer).toBe('codex');
  });

  it('saveConfigByScope round-trips through the repository', () => {
    const config = getDefaultConfig();
    config.workflow.agentDefaults = { iterate: { implementer: 'codex' } };
    saveConfigByScope('project', cwd, config);
    expect(loadConfigByScope('project', cwd)).toEqual(config);
  });
});
