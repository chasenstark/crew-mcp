import { getDefaultConfig } from './config-codec.js';
import type { AgentConfig, FullConfig } from './types.js';
import type { ConfigScope } from './config-repository.js';
import {
  CLAUDE_MODEL_PRESETS,
  CODEX_MODEL_PRESETS,
  ModelId,
  OPENAI_COMPATIBLE_MODEL_PRESETS,
  ORCHESTRATOR_MODEL_PRESETS,
  resolveModelAliasOrThrow,
} from './models.js';
import {
  ADAPTER_PRESETS,
  AdapterId,
  AgentId,
  BUILTIN_WORKER_AGENTS,
  resolveAdapterAlias,
  resolveAdapterAliasOrThrow,
  resolveAgentAlias,
} from './agents.js';
import {
  DEFAULT_CONFIG_PROFILE,
  getConfigPaths,
  loadEffectiveConfig,
  readActiveProfilePreference,
  readActiveScopePreference,
  saveActiveProfilePreference,
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
  activeProfile: string;
  paths: ReturnType<typeof getConfigPaths>;
  effectiveConfig: FullConfig;
}

export interface ConfigSetResult {
  scope: ConfigScope;
  profile: string;
  filePath: string;
  path: string;
  previousValue: unknown;
  nextValue: unknown;
  config: FullConfig;
}

export interface ConfigResetResult {
  scope: ConfigScope;
  profile: string;
  filePath: string;
  config: FullConfig;
}

export interface ConfigAddAgentResult {
  scope: ConfigScope;
  profile: string;
  filePath: string;
  name: string;
  agent: AgentConfig;
  config: FullConfig;
}

export interface ConfigRemoveAgentResult {
  scope: ConfigScope;
  profile: string;
  filePath: string;
  name: string;
  removedAgent: AgentConfig;
  config: FullConfig;
}

export const SUPPORTED_CONFIG_SET_PATHS = [
  'orchestrator.cli',
  'orchestrator.model',
  'workflow.execution.mode',
  'workflow.roleModels.<role>',
  'agents.<name>.adapter',
  'agents.<name>.model',
  'agents.<name>.command',
  'agents.<name>.args',
  'agents.<name>.capabilities',
  'workflow.reviewer.maxPasses',
  'errorHandling.default.retry',
] as const;

const CAPABILITY_PRESETS = [
  'implement',
  'review',
  'refactor',
  'test',
  'document',
  'analyze',
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

function withCurrentOption(options: readonly string[], current: unknown): string[] {
  if (current === undefined || current === null) return [...options];
  const asString = String(current).trim();
  if (!asString) return [...options];
  if (options.includes(asString)) return [...options];
  return [...options, asString];
}

function modelPresetsForAdapterType(adapterType: string): readonly string[] {
  if (adapterType === AdapterId.CLAUDE_CODE) return CLAUDE_MODEL_PRESETS;
  if (adapterType === AdapterId.CODEX) return CODEX_MODEL_PRESETS;
  if (adapterType === AdapterId.OPENAI_COMPATIBLE) return [...OPENAI_COMPATIBLE_MODEL_PRESETS];
  return [];
}

function modelPresetsForAgent(config: FullConfig, agentName: string): string[] {
  const agent = config.agents[agentName];
  if (!agent) return [];
  const adapterType = agent.adapter ?? agentName;
  return withCurrentOption(modelPresetsForAdapterType(adapterType), agent.model);
}

function modelPresetsForRole(config: FullConfig, role: string): string[] {
  const candidates: string[] = [];
  for (const step of config.workflow.steps) {
    if (step.role !== role && step.action !== role) continue;
    if (step.agent === AgentId.ORCHESTRATOR) {
      candidates.push(...ORCHESTRATOR_MODEL_PRESETS);
      continue;
    }
    candidates.push(...modelPresetsForAgent(config, step.agent));
  }

  if (candidates.length === 0) {
    if (role === 'judge') {
      candidates.push(...ORCHESTRATOR_MODEL_PRESETS);
    } else {
      candidates.push(...CLAUDE_MODEL_PRESETS, ...CODEX_MODEL_PRESETS);
    }
  }
  return uniqueOrdered(candidates);
}

export function getConfigValueOptions(config: FullConfig, path: string): string[] {
  if (path === 'orchestrator.cli') {
    const otherAgents = Object.keys(config.agents)
      .filter((name) => !BUILTIN_WORKER_AGENTS.includes(name as AgentId))
      .sort();
    const options = uniqueOrdered([
      ...BUILTIN_WORKER_AGENTS,
      ...otherAgents,
    ]);
    return withCurrentOption(options, config.orchestrator.cli);
  }

  if (path === 'orchestrator.model') {
    return withCurrentOption(ORCHESTRATOR_MODEL_PRESETS, config.orchestrator.model);
  }

  if (path === 'workflow.execution.mode') {
    const presets = ['linear', 'judgment'];
    return withCurrentOption(presets, config.workflow.execution?.mode ?? 'linear');
  }

  const roleMatch = /^workflow\.roleModels\.([^.]+)$/.exec(path);
  if (roleMatch) {
    const role = roleMatch[1];
    return withCurrentOption(
      modelPresetsForRole(config, role),
      config.workflow.roleModels?.[role],
    );
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

  const agentMatch = /^agents\.([^.]+)\.(adapter|model|capabilities)$/.exec(path);
  if (!agentMatch) return [];
  const agentName = agentMatch[1];
  const field = agentMatch[2];
  const agent = config.agents[agentName];
  if (!agent) return [];

  if (field === 'adapter') {
    const adapterType = agent.adapter ?? agentName;
    return withCurrentOption(ADAPTER_PRESETS, adapterType);
  }

  if (field === 'capabilities') {
    const current = (agent.capabilities ?? []).join(',');
    return withCurrentOption(CAPABILITY_PRESETS, current);
  }

  return withCurrentOption(modelPresetsForAgent(config, agentName), agent.model);
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
      `  /config set orchestrator.cli ${AgentId.CODEX}`,
      '  /config set workflow.execution.mode judgment',
      `  /config set workflow.roleModels.reviewer ${ModelId.GPT}`,
      `  /config set agents.local-gemma.adapter ${AdapterId.GENERIC}`,
      '  /config set agents.local-gemma.command ollama',
      '  /config set agents.local-gemma.args run,gemma4:latest,{{prompt}}',
      '  /config set agents.local-gemma.capabilities implement,review',
      `  /config set agents.codex.model ${ModelId.GPT_CODEX}`,
      '  /config set workflow.reviewer.maxPasses 3',
    ].join('\n'),
  );
}

function parseScope(scope: string): ConfigScope {
  if (scope === 'project' || scope === 'global') return scope;
  throw new Error(`Invalid scope "${scope}". Expected "project" or "global".`);
}

function parseProfile(profile: string): string {
  const normalized = profile.trim();
  if (!normalized) {
    throw new Error('Profile name is required.');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error(`Invalid profile "${profile}". Use only letters, numbers, ".", "_", or "-".`);
  }
  return normalized;
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

function parseDelimitedStringList(path: string, raw: unknown, example: string): string[] {
  if (Array.isArray(raw)) {
    const values = raw
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0);
    return uniqueOrdered(values);
  }

  const normalized = String(raw).trim();
  if (!normalized) {
    throw new Error(invalidValueMessage(path, 'comma-separated list of strings or []', raw, example));
  }
  if (normalized === '[]') return [];

  if (normalized.startsWith('[')) {
    try {
      const parsed = JSON.parse(normalized);
      if (!Array.isArray(parsed)) {
        throw new Error('not array');
      }
      const values = parsed
        .map((value) => String(value).trim())
        .filter((value) => value.length > 0);
      return uniqueOrdered(values);
    } catch {
      throw new Error(
        invalidValueMessage(
          path,
          'JSON array of strings, comma-delimited values, or []',
          raw,
          example,
        ),
      );
    }
  }

  const values = normalized
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (values.length === 0) {
    throw new Error(
      invalidValueMessage(path, 'comma-separated list of strings or []', raw, example),
    );
  }
  return uniqueOrdered(values);
}

function parseAgentName(raw: string): string {
  const name = raw.trim();
  if (!name) {
    throw new Error('Agent name is required.');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(
      `Invalid agent name "${raw}". Use only letters, numbers, ".", "_", or "-".`,
    );
  }
  return name;
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
    const parsedAgent = parseNonEmptyString(
      path,
      resolvedValue,
      `/config set orchestrator.cli ${AgentId.CODEX}`,
    );
    next.orchestrator.cli = resolveAgentAlias(parsedAgent);
    return next;
  }

  if (path === 'orchestrator.model') {
    const parsedModel = parseNonEmptyString(
      path,
      resolvedValue,
      `/config set orchestrator.model ${ModelId.CLAUDE_SONNET}`,
    );
    next.orchestrator.model = resolveModelAliasOrThrow(parsedModel, path);
    return next;
  }

  if (path === 'workflow.execution.mode') {
    const mode = parseNonEmptyString(
      path,
      resolvedValue,
      '/config set workflow.execution.mode judgment',
    ).toLowerCase();
    if (mode !== 'linear' && mode !== 'judgment') {
      throw new Error(
        invalidValueMessage(
          path,
          'one of: linear, judgment',
          resolvedValue,
          '/config set workflow.execution.mode judgment',
        ),
      );
    }
    next.workflow.execution = { mode };
    return next;
  }

  const roleModelMatch = /^workflow\.roleModels\.([^.]+)$/.exec(path);
  if (roleModelMatch) {
    const role = roleModelMatch[1];
    if (!next.workflow.roleModels) next.workflow.roleModels = {};
    const parsedModel = parseNonEmptyString(
      path,
      resolvedValue,
      `/config set workflow.roleModels.reviewer ${ModelId.GPT}`,
    );
    next.workflow.roleModels[role] = resolveModelAliasOrThrow(parsedModel, path);
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

  const agentMatch = /^agents\.([^.]+)\.(adapter|model|command|args|capabilities)$/.exec(path);
  if (agentMatch) {
    const agentName = agentMatch[1];
    const field = agentMatch[2];
    if (!next.agents[agentName]) {
      throw new Error(
        `Invalid value for ${path}: unknown agent "${agentName}". Example: /config add-agent ${agentName} generic`,
      );
    }
    if (field === 'adapter') {
      const parsedAdapter = parseNonEmptyString(
        path,
        resolvedValue,
        `/config set agents.${agentName}.adapter ${AdapterId.GENERIC}`,
      );
      next.agents[agentName].adapter = resolveAdapterAliasOrThrow(parsedAdapter, path);
      return next;
    }
    if (field === 'model') {
      const parsedModel = parseNonEmptyString(
        path,
        resolvedValue,
        `/config set agents.${agentName}.model ${ModelId.GPT_CODEX}`,
      );
      next.agents[agentName].model = resolveModelAliasOrThrow(parsedModel, path);
      return next;
    }
    if (field === 'command') {
      next.agents[agentName].command = parseNonEmptyString(
        path,
        resolvedValue,
        `/config set agents.${agentName}.command ollama`,
      );
      return next;
    }
    if (field === 'args') {
      next.agents[agentName].args = parseDelimitedStringList(
        path,
        resolvedValue,
        `/config set agents.${agentName}.args run,gemma4:latest,{{prompt}}`,
      );
      return next;
    }
    next.agents[agentName].capabilities = parseDelimitedStringList(
      path,
      resolvedValue,
      `/config set agents.${agentName}.capabilities implement,review`,
    );
    return next;
  }

  throw unsupportedPathError(path);
}

function readConfigValue(config: FullConfig, path: string): unknown {
  if (path === 'orchestrator.cli') return config.orchestrator.cli;
  if (path === 'orchestrator.model') return config.orchestrator.model;
  if (path === 'workflow.execution.mode') return config.workflow.execution?.mode ?? 'linear';
  const roleModelMatch = /^workflow\.roleModels\.([^.]+)$/.exec(path);
  if (roleModelMatch) {
    return config.workflow.roleModels?.[roleModelMatch[1]];
  }
  if (path === 'workflow.reviewer.maxPasses') {
    const reviewerIndex = readReviewStepIndex(config);
    const reviewer = reviewerIndex >= 0 ? config.workflow.steps[reviewerIndex] : undefined;
    return reviewer?.maxPasses;
  }
  if (path === 'errorHandling.default.retry') return config.errorHandling.default.retry;

  const agentMatch = /^agents\.([^.]+)\.(adapter|model|command|args|capabilities)$/.exec(path);
  if (agentMatch) {
    const agent = config.agents[agentMatch[1]];
    const field = agentMatch[2];
    if (!agent) return undefined;
    if (field === 'adapter') return agent.adapter;
    if (field === 'model') return agent.model;
    if (field === 'command') return agent.command;
    if (field === 'args') return agent.args;
    return agent.capabilities;
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

export function getConfigProfile(cwd: string): string {
  return readActiveProfilePreference(cwd) ?? DEFAULT_CONFIG_PROFILE;
}

export function setConfigScope(cwd: string, scope: ConfigScope): { scope: ConfigScope; scopePath: string } {
  const normalizedScope = parseScope(scope);
  const scopePath = saveActiveScopePreference(cwd, normalizedScope);
  return { scope: normalizedScope, scopePath };
}

export function setConfigProfile(cwd: string, profile: string): { profile: string; profilePath: string } {
  const normalizedProfile = parseProfile(profile);
  const profilePath = saveActiveProfilePreference(cwd, normalizedProfile);
  return { profile: normalizedProfile, profilePath };
}

export function showConfig(cwd: string, options: { profile?: string } = {}): ConfigShowResult {
  const activeProfile = options.profile ? parseProfile(options.profile) : getConfigProfile(cwd);
  return {
    activeScope: getConfigScope(cwd),
    activeProfile,
    paths: getConfigPaths(cwd, { profile: activeProfile }),
    effectiveConfig: loadEffectiveConfig(cwd, { profile: activeProfile }),
  };
}

export function setConfigValue(
  cwd: string,
  path: string,
  rawValue: unknown,
  options: { scope?: ConfigScope; profile?: string } = {},
): ConfigSetResult {
  const scope = options.scope ? parseScope(options.scope) : getConfigScope(cwd);
  const profile = options.profile ? parseProfile(options.profile) : getConfigProfile(cwd);
  const current = loadEffectiveConfig(cwd, { profile });
  const previousValue = readConfigValue(current, path);
  const next = applyConfigPatch(current, { path, value: rawValue });

  validateConfigOrThrow(next);
  const filePath = saveConfigByScope(scope, cwd, next, { profile });

  return {
    scope,
    profile,
    filePath,
    path,
    previousValue,
    nextValue: readConfigValue(next, path),
    config: next,
  };
}

export function addAgent(
  cwd: string,
  nameRaw: string,
  options: {
    adapter?: string;
    model?: string;
    command?: string;
    args?: string[];
    capabilities?: string[];
    scope?: ConfigScope;
    profile?: string;
  } = {},
): ConfigAddAgentResult {
  const name = parseAgentName(nameRaw);
  const scope = options.scope ? parseScope(options.scope) : getConfigScope(cwd);
  const profile = options.profile ? parseProfile(options.profile) : getConfigProfile(cwd);
  const current = loadEffectiveConfig(cwd, { profile });

  if (current.agents[name]) {
    throw new Error(`Agent "${name}" already exists.`);
  }

  const adapter = resolveAdapterAlias(options.adapter?.trim() || AdapterId.GENERIC);
  const model = options.model?.trim();
  const command = options.command?.trim();
  const args = options.args
    ?.map((value) => value.trim())
    .filter((value) => value.length > 0);
  const capabilities = options.capabilities
    ?.map((value) => value.trim())
    .filter((value) => value.length > 0);

  const agent: AgentConfig = {
    adapter,
  };
  if (model) agent.model = model;
  if (command) {
    agent.command = command;
  } else if (adapter === AdapterId.GENERIC) {
    agent.command = name;
  }
  if (args && args.length > 0) agent.args = uniqueOrdered(args);
  if (capabilities && capabilities.length > 0) agent.capabilities = uniqueOrdered(capabilities);

  const next = structuredClone(current);
  next.agents[name] = agent;

  validateConfigOrThrow(next);
  const filePath = saveConfigByScope(scope, cwd, next, { profile });
  return {
    scope,
    profile,
    filePath,
    name,
    agent,
    config: next,
  };
}

export function removeAgent(
  cwd: string,
  nameRaw: string,
  options: { scope?: ConfigScope; profile?: string } = {},
): ConfigRemoveAgentResult {
  const name = parseAgentName(nameRaw);
  const scope = options.scope ? parseScope(options.scope) : getConfigScope(cwd);
  const profile = options.profile ? parseProfile(options.profile) : getConfigProfile(cwd);
  const current = loadEffectiveConfig(cwd, { profile });
  const existing = current.agents[name];
  if (!existing) {
    throw new Error(`Agent "${name}" does not exist.`);
  }
  if (current.orchestrator.cli === name) {
    throw new Error(
      `Cannot remove agent "${name}" because orchestrator.cli is set to it. Set orchestrator.cli first.`,
    );
  }
  const referencedSteps = current.workflow.steps.filter((step) => step.agent === name);
  if (referencedSteps.length > 0) {
    throw new Error(
      `Cannot remove agent "${name}" because workflow.steps reference it (${referencedSteps.length} step${referencedSteps.length === 1 ? '' : 's'}). Update workflow first.`,
    );
  }

  const next = structuredClone(current);
  delete next.agents[name];

  validateConfigOrThrow(next);
  const filePath = saveConfigByScope(scope, cwd, next, { profile });
  return {
    scope,
    profile,
    filePath,
    name,
    removedAgent: existing,
    config: next,
  };
}

export function resetConfig(
  cwd: string,
  options: { scope?: ConfigScope; profile?: string } = {},
): ConfigResetResult {
  const scope = options.scope ? parseScope(options.scope) : getConfigScope(cwd);
  const profile = options.profile ? parseProfile(options.profile) : getConfigProfile(cwd);
  const config = getDefaultConfig();
  validateConfigOrThrow(config);
  const filePath = saveConfigByScope(scope, cwd, config, { profile });
  return { scope, profile, filePath, config };
}
