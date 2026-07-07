import { getDefaultConfig } from './config-codec.js';
import type { FullConfig } from './types.js';
import type { ConfigScope } from './config-repository.js';
import {
  DEFAULT_CONFIG_PROFILE,
  getConfigPaths,
  loadConfigByScope,
  loadEffectiveConfig,
  readActiveProfilePreference,
  readActiveScopePreference,
  saveConfigByScope,
} from './config-repository.js';
import {
  configPathHelpLines,
  resolveConfigPath,
  SUPPORTED_CONFIG_SET_PATHS,
} from './config-path-registry.js';
import { validateConfig } from './config-validation.js';
import { normalizeProfileName, parseConfigScope } from './config-normalization.js';

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

export interface ConfigUnsetResult {
  scope: ConfigScope;
  profile: string;
  filePath: string;
  path: string;
  previousValue: unknown;
  nextValue: unknown;
  config: FullConfig;
}

export { SUPPORTED_CONFIG_SET_PATHS };

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
  return next;
}

function pruneAgentDefaults(config: FullConfig): void {
  const defaults = config.workflow.agentDefaults;
  if (!defaults) return;
  if (defaults.iterate && Object.keys(defaults.iterate).length === 0) {
    delete defaults.iterate;
  }
  if (defaults.panel && Object.keys(defaults.panel).length === 0) {
    delete defaults.panel;
  }
  if (Object.keys(defaults).length === 0) {
    delete config.workflow.agentDefaults;
  }
}

function deleteConfigValue(config: FullConfig, path: string): void {
  switch (path) {
    case 'workflow.agentDefaults.iterate.implementer':
      if (config.workflow.agentDefaults?.iterate) {
        delete config.workflow.agentDefaults.iterate.implementer;
      }
      break;
    case 'workflow.agentDefaults.iterate.reviewers':
      if (config.workflow.agentDefaults?.iterate) {
        delete config.workflow.agentDefaults.iterate.reviewers;
      }
      break;
    case 'workflow.agentDefaults.iterate.banList':
      if (config.workflow.agentDefaults?.iterate) {
        delete config.workflow.agentDefaults.iterate.banList;
      }
      break;
    case 'workflow.agentDefaults.panel.reviewers':
      if (config.workflow.agentDefaults?.panel) {
        delete config.workflow.agentDefaults.panel.reviewers;
      }
      break;
    case 'workflow.agentDefaults.panel.banList':
      if (config.workflow.agentDefaults?.panel) {
        delete config.workflow.agentDefaults.panel.banList;
      }
      break;
    default:
      throw unsupportedPathError(path);
  }
  pruneAgentDefaults(config);
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

function loadScopedConfigForWrite(scope: ConfigScope, cwd: string, profile: string): FullConfig {
  return loadConfigByScope(scope, cwd, { profile }) ?? getDefaultConfig();
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
  const effective = loadEffectiveConfig(cwd, { profile });
  const current = loadScopedConfigForWrite(scope, cwd, profile);
  const previousValue = readConfigValue(effective, path);
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

export function unsetConfigValue(
  cwd: string,
  path: string,
  options: { scope?: ConfigScope; profile?: string } = {},
): ConfigUnsetResult {
  const scope = options.scope ? parseScope(options.scope) : getConfigScope(cwd);
  const profile = options.profile ? parseProfile(options.profile) : getConfigProfile(cwd);
  const effective = loadEffectiveConfig(cwd, { profile });
  const current = loadScopedConfigForWrite(scope, cwd, profile);
  const previousValue = readConfigValue(effective, path);
  const next = structuredClone(current);
  deleteConfigValue(next, path.trim());

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

