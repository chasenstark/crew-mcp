import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { getDefaultConfig } from '../../src/workflow/config-codec.js';
import { loadConfigByScope } from '../../src/workflow/config-repository.js';
import {
  applyConfigPatch,
  getConfigValueOptions,
  getConfigScope,
  resetConfig,
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
    tmpRoot = join(tmpdir(), `orchestrator-config-service-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  it('applies patch for workflow reviewer max passes', () => {
    const next = applyConfigPatch(getDefaultConfig(), {
      path: 'workflow.reviewer.maxPasses',
      value: '5',
    });
    expect(next.workflow.steps.find((step) => step.role === 'reviewer')?.maxPasses).toBe(5);
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
    expect(result.nextValue).toBe(4);

    const globalConfig = loadConfigByScope('global', cwd);
    expect(globalConfig?.errorHandling.default.retry).toBe(4);
  });

  it('can set agent model', () => {
    const result = setConfigValue(cwd, 'agents.codex.model', 'gpt-5.4');
    expect(result.nextValue).toBe('gpt-5.4');
    const projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.agents.codex.model).toBe('gpt-5.4');
  });

  it('supports cycling with "next" for model fields', () => {
    const result = setConfigValue(cwd, 'orchestrator.model', 'next');
    expect(typeof result.nextValue).toBe('string');
    expect(result.nextValue).toBe('claude-opus-4-6');
  });

  it('supports cycling with "prev" for numeric fields', () => {
    const result = setConfigValue(cwd, 'errorHandling.default.retry', 'prev');
    expect(result.nextValue).toBe(0);
  });

  it('returns preset options for supported fields', () => {
    const options = getConfigValueOptions(getDefaultConfig(), 'workflow.reviewer.maxPasses');
    expect(options).toEqual(['1', '2', '3', '4', '5']);
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

  it('rejects unknown agent model path', () => {
    expect(() =>
      setConfigValue(cwd, 'agents.unknown.model', 'foo'),
    ).toThrow(/unknown agent "unknown"/i);
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
    setConfigValue(cwd, 'orchestrator.cli', 'codex');
    const shown = showConfig(cwd);
    expect(shown.activeScope).toBe('project');
    expect(shown.effectiveConfig.orchestrator.cli).toBe('codex');
    expect(shown.paths.project).toContain('.orchestra/workflow.yaml');
  });
});
