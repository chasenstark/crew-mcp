import { getDefaultConfig } from './config-codec.js';
import type { FullConfig } from './types.js';
import type { ConfigScope } from './config-repository.js';
import {
  getConfigPaths,
  loadEffectiveConfig,
  readActiveScopePreference,
  saveActiveScopePreference,
  saveConfigByScope,
} from './config-repository.js';
import { validateConfig } from './config-validation.js';

export interface ConfigPatch {
  path: string;
  value: unknown;
}

export interface ConfigShowResult {
  activeScope: ConfigScope;
  paths: ReturnType<typeof getConfigPaths>;
  effectiveConfig: FullConfig;
}

export interface ConfigSetResult {
  scope: ConfigScope;
  filePath: string;
  path: string;
  previousValue: unknown;
  nextValue: unknown;
  config: FullConfig;
}

export interface ConfigResetResult {
  scope: ConfigScope;
  filePath: string;
  config: FullConfig;
}

export const SUPPORTED_CONFIG_SET_PATHS = [
  'orchestrator.cli',
  'orchestrator.model',
  'agents.<name>.model',
  'workflow.reviewer.maxPasses',
  'errorHandling.default.retry',
] as const;

const CLAUDE_MODEL_PRESETS = [
  'claude-sonnet-4-5',
  'claude-opus-4-6',
];

const CODEX_MODEL_PRESETS = [
  'gpt-5.4',
  'gpt-5.3-codex',
  'gpt-5.4-mini',
];

const ORCHESTRATOR_MODEL_PRESETS = [
  'claude-sonnet-4-5',
  'claude-opus-4-6',
  'gpt-5.4',
  'gpt-5.3-codex',
];

function uniqueOrdered(values: string[]): string[] {
  const deduped = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || deduped.has(normalized)) continue;
    deduped.add(normalized);
    result.push(normalized);
  }
  return result;
}

function withCurrentOption(options: string[], current: unknown): string[] {
  if (current === undefined || current === null) return options;
  const asString = String(current).trim();
  if (!asString) return options;
  if (options.includes(asString)) return options;
  return [...options, asString];
}

export function getConfigValueOptions(config: FullConfig, path: string): string[] {
  if (path === 'orchestrator.cli') {
    const otherAgents = Object.keys(config.agents)
      .filter((name) => name !== 'claude-code' && name !== 'codex')
      .sort();
    const options = uniqueOrdered([
      'claude-code',
      'codex',
      ...otherAgents,
    ]);
    return withCurrentOption(options, config.orchestrator.cli);
  }

  if (path === 'orchestrator.model') {
    return withCurrentOption(ORCHESTRATOR_MODEL_PRESETS, config.orchestrator.model);
  }

  if (path === 'workflow.reviewer.maxPasses') {
    const reviewerIndex = readReviewStepIndex(config);
    if (reviewerIndex < 0) return [];
    const reviewerStep = config.workflow.steps[reviewerIndex];
    const presets = ['1', '2', '3', '4', '5'];
    return withCurrentOption(presets, reviewerStep?.maxPasses);
  }

  if (path === 'errorHandling.default.retry') {
    const presets = ['0', '1', '2', '3', '4'];
    return withCurrentOption(presets, config.errorHandling.default.retry);
  }

  const agentMatch = /^agents\.([^.]+)\.model$/.exec(path);
  if (!agentMatch) return [];
  const agentName = agentMatch[1];
  const agent = config.agents[agentName];
  if (!agent) return [];

  const adapterType = agent.adapter ?? agentName;
  let presets: string[] = [];
  if (adapterType === 'claude-code') {
    presets = CLAUDE_MODEL_PRESETS;
  } else if (adapterType === 'codex') {
    presets = CODEX_MODEL_PRESETS;
  }
  return withCurrentOption(presets, agent.model);
}

function invalidValueMessage(path: string, expected: string, received: unknown, example: string): string {
  const rendered = typeof received === 'string' ? `"${received}"` : JSON.stringify(received);
  return `Invalid value for ${path}: expected ${expected}, received ${rendered}. Example: ${example}`;
}

function unsupportedPathError(path: string): Error {
  return new Error(
    [
      `Unsupported config path "${path}".`,
      `Supported paths: ${SUPPORTED_CONFIG_SET_PATHS.join(', ')}`,
      'Examples:',
      '  /config set orchestrator.cli codex',
      '  /config set agents.codex.model gpt-5.3-codex',
      '  /config set workflow.reviewer.maxPasses 3',
    ].join('\n'),
  );
}

function parseScope(scope: string): ConfigScope {
  if (scope === 'project' || scope === 'global') return scope;
  throw new Error(`Invalid scope "${scope}". Expected "project" or "global".`);
}

function parseInteger(path: string, raw: unknown, min: number, example: string): number {
  const value = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  const normalized = typeof raw === 'number' ? String(raw) : String(raw).trim();
  const isStrictInteger = /^-?\d+$/.test(normalized);
  if (!isStrictInteger || !Number.isInteger(value) || value < min) {
    throw new Error(invalidValueMessage(path, `integer >= ${min}`, raw, example));
  }
  return value;
}

function parseNonEmptyString(path: string, raw: unknown, example: string): string {
  const normalized = String(raw).trim();
  if (normalized.length === 0) {
    throw new Error(invalidValueMessage(path, 'non-empty string', raw, example));
  }
  return normalized;
}

function readReviewStepIndex(config: FullConfig): number {
  const roleMatch = config.workflow.steps.findIndex((step) => step.role === 'reviewer');
  if (roleMatch >= 0) return roleMatch;
  const actionMatch = config.workflow.steps.findIndex((step) => step.action === 'review');
  if (actionMatch >= 0) return actionMatch;
  return config.workflow.steps.findIndex((step) => step.role.toLowerCase().includes('review'));
}

function normalizeCycleDirection(raw: unknown): 'next' | 'prev' | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'next' || normalized === 'n') return 'next';
  if (normalized === 'prev' || normalized === 'previous' || normalized === 'p') return 'prev';
  return null;
}

function resolveConfigInput(config: FullConfig, path: string, rawValue: unknown): unknown {
  const direction = normalizeCycleDirection(rawValue);
  if (!direction) return rawValue;

  const options = getConfigValueOptions(config, path);
  if (options.length === 0) {
    throw new Error(
      `No preset options are available for ${path}. Provide an explicit value instead of "${rawValue}".`,
    );
  }

  const currentRaw = readConfigValue(config, path);
  const currentValue = currentRaw === undefined || currentRaw === null
    ? ''
    : String(currentRaw);
  const currentIndex = options.indexOf(currentValue);

  if (direction === 'next') {
    if (currentIndex < 0) return options[0];
    return options[(currentIndex + 1) % options.length];
  }

  if (currentIndex < 0) return options[options.length - 1];
  return options[(currentIndex - 1 + options.length) % options.length];
}

export function applyConfigPatch(config: FullConfig, patch: ConfigPatch): FullConfig {
  const next = structuredClone(config);
  const path = patch.path.trim();
  const resolvedValue = resolveConfigInput(next, path, patch.value);

  if (path === 'orchestrator.cli') {
    next.orchestrator.cli = parseNonEmptyString(
      path,
      resolvedValue,
      '/config set orchestrator.cli codex',
    );
    return next;
  }

  if (path === 'orchestrator.model') {
    next.orchestrator.model = parseNonEmptyString(
      path,
      resolvedValue,
      '/config set orchestrator.model claude-sonnet-4-5',
    );
    return next;
  }

  if (path === 'workflow.reviewer.maxPasses') {
    const reviewerIndex = readReviewStepIndex(next);
    if (reviewerIndex < 0) {
      throw new Error(
        'Cannot set workflow.reviewer.maxPasses: no review step exists in workflow.steps (role="reviewer" or action="review").',
      );
    }
    next.workflow.steps[reviewerIndex].maxPasses = parseInteger(
      path,
      resolvedValue,
      1,
      '/config set workflow.reviewer.maxPasses 3',
    );
    return next;
  }

  if (path === 'errorHandling.default.retry') {
    next.errorHandling.default.retry = parseInteger(
      path,
      resolvedValue,
      0,
      '/config set errorHandling.default.retry 1',
    );
    return next;
  }

  const agentMatch = /^agents\.([^.]+)\.model$/.exec(path);
  if (agentMatch) {
    const agentName = agentMatch[1];
    if (!next.agents[agentName]) {
      throw new Error(
        `Invalid value for ${path}: unknown agent "${agentName}". Example: /config set agents.codex.model gpt-5.3-codex`,
      );
    }
    next.agents[agentName].model = parseNonEmptyString(
      path,
      resolvedValue,
      `/config set agents.${agentName}.model gpt-5.3-codex`,
    );
    return next;
  }

  throw unsupportedPathError(path);
}

function readConfigValue(config: FullConfig, path: string): unknown {
  if (path === 'orchestrator.cli') return config.orchestrator.cli;
  if (path === 'orchestrator.model') return config.orchestrator.model;
  if (path === 'workflow.reviewer.maxPasses') {
    const reviewerIndex = readReviewStepIndex(config);
    const reviewer = reviewerIndex >= 0 ? config.workflow.steps[reviewerIndex] : undefined;
    return reviewer?.maxPasses;
  }
  if (path === 'errorHandling.default.retry') return config.errorHandling.default.retry;

  const agentMatch = /^agents\.([^.]+)\.model$/.exec(path);
  if (agentMatch) {
    return config.agents[agentMatch[1]]?.model;
  }
  return undefined;
}

function validateConfigOrThrow(config: FullConfig): void {
  const diagnostics = validateConfig(config);
  if (diagnostics.length > 0) {
    throw new Error(diagnostics[0].message);
  }
}

export function getConfigScope(cwd: string): ConfigScope {
  return readActiveScopePreference(cwd) ?? 'project';
}

export function setConfigScope(cwd: string, scope: ConfigScope): { scope: ConfigScope; scopePath: string } {
  const normalizedScope = parseScope(scope);
  const scopePath = saveActiveScopePreference(cwd, normalizedScope);
  return { scope: normalizedScope, scopePath };
}

export function showConfig(cwd: string): ConfigShowResult {
  return {
    activeScope: getConfigScope(cwd),
    paths: getConfigPaths(cwd),
    effectiveConfig: loadEffectiveConfig(cwd),
  };
}

export function setConfigValue(
  cwd: string,
  path: string,
  rawValue: unknown,
  options: { scope?: ConfigScope } = {},
): ConfigSetResult {
  const scope = options.scope ? parseScope(options.scope) : getConfigScope(cwd);
  const current = loadEffectiveConfig(cwd);
  const previousValue = readConfigValue(current, path);
  const next = applyConfigPatch(current, { path, value: rawValue });

  validateConfigOrThrow(next);
  const filePath = saveConfigByScope(scope, cwd, next);

  return {
    scope,
    filePath,
    path,
    previousValue,
    nextValue: readConfigValue(next, path),
    config: next,
  };
}

export function resetConfig(
  cwd: string,
  options: { scope?: ConfigScope } = {},
): ConfigResetResult {
  const scope = options.scope ? parseScope(options.scope) : getConfigScope(cwd);
  const config = getDefaultConfig();
  validateConfigOrThrow(config);
  const filePath = saveConfigByScope(scope, cwd, config);
  return { scope, filePath, config };
}
