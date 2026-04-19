import { getDefaultConfig, resolveCaptainModel } from './config-codec.js';
import type { AgentConfig, FullConfig } from './types.js';
import type { ConfigScope } from './config-repository.js';
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
import {
  configPathHelpLines,
  resolveConfigPath,
  SUPPORTED_CONFIG_SET_PATHS,
} from './config-path-registry.js';
import { validateConfig } from './config-validation.js';
import { AdapterId, AgentId, resolveAdapterAlias } from './agents.js';
import { normalizeProfileName, parseConfigScope } from './config-normalization.js';
import { isModelCompatibleWithAdapter, modelPresetsForAdapter } from './models.js';

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

export { SUPPORTED_CONFIG_SET_PATHS };

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

function unsupportedPathError(path: string): Error {
  const examples = configPathHelpLines().map((line) => `  ${line}`).join('\n');
  return new Error(
    [
      `Unsupported config path "${path}".`,
      `Supported paths: ${SUPPORTED_CONFIG_SET_PATHS.join(', ')}`,
      'Examples:',
      examples,
    ].join('\n'),
  );
}

function parseScope(scope: string): ConfigScope {
  return parseConfigScope(scope);
}

function parseProfile(profile: string): string {
  return normalizeProfileName(profile);
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

function normalizeCycleDirection(raw: unknown): 'next' | 'prev' | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'next' || normalized === 'n') return 'next';
  if (normalized === 'prev' || normalized === 'previous' || normalized === 'p') return 'prev';
  return null;
}

function readConfigValue(config: FullConfig, path: string): unknown {
  const resolved = resolveConfigPath(path);
  if (!resolved) return undefined;
  return resolved.descriptor.read(config, resolved.params);
}

function resolveCaptainAdapterType(config: FullConfig): string | undefined {
  const captainAgent = config.agents[config.captain.cli];
  return captainAgent?.adapter ?? config.captain.cli;
}

function firstCompatibleModel(adapterType: string | undefined): string | undefined {
  return modelPresetsForAdapter(adapterType)[0];
}

function roleTargetsCaptain(config: FullConfig, role: string): boolean {
  if (role === 'judge') {
    return true;
  }
  return config.workflow.steps.some(
    (step) => (step.role === role || step.action === role) && step.agent === AgentId.CAPTAIN,
  );
}

function normalizeIncompatibleModels(config: FullConfig): void {
  const captainAdapterType = resolveCaptainAdapterType(config);
  const resolvedCaptainModel = resolveCaptainModel(config.captain);
  if (!isModelCompatibleWithAdapter(captainAdapterType, resolvedCaptainModel)) {
    const replacement = firstCompatibleModel(captainAdapterType);
    const current = config.captain.model;
    if (current && typeof current === 'object') {
      // Preserve the map shape; only overwrite the current CLI's entry.
      const key = config.captain.cli as keyof typeof current;
      config.captain.model = replacement === undefined
        ? { ...current, [key]: undefined }
        : { ...current, [key]: replacement };
    } else {
      config.captain.model = replacement;
    }
  }

  const normalizedCaptainModel = resolveCaptainModel(config.captain);
  for (const [role, model] of Object.entries(config.workflow.roleModels ?? {})) {
    if (!roleTargetsCaptain(config, role)) {
      continue;
    }
    if (!isModelCompatibleWithAdapter(captainAdapterType, model)) {
      config.workflow.roleModels![role] =
        normalizedCaptainModel ?? firstCompatibleModel(captainAdapterType) ?? model;
    }
  }

  for (const [name, agent] of Object.entries(config.agents)) {
    const adapterType = agent.adapter ?? name;
    if (!isModelCompatibleWithAdapter(adapterType, agent.model)) {
      agent.model = firstCompatibleModel(adapterType);
    }
  }
}

export function getConfigValueOptions(config: FullConfig, path: string): string[] {
  const resolved = resolveConfigPath(path);
  if (!resolved) return [];
  return resolved.descriptor.options(config, resolved.params);
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
  const resolved = resolveConfigPath(path);
  if (!resolved) throw unsupportedPathError(path);

  const resolvedValue = resolveConfigInput(next, path, patch.value);
  const parsedValue = resolved.descriptor.parse(resolvedValue, next, resolved.params, path);
  resolved.descriptor.write(next, resolved.params, parsedValue, path);
  normalizeIncompatibleModels(next);
  return next;
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
  if (current.captain.cli === name) {
    throw new Error(
      `Cannot remove agent "${name}" because captain.cli is set to it. Set captain.cli first.`,
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
