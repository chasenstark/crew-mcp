import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { FullConfig } from './types.js';
import { getDefaultConfig, mergeConfigs, parseWorkflowYaml, serializeWorkflowYaml } from './config-codec.js';

export type ConfigScope = 'project' | 'global';
export const DEFAULT_CONFIG_PROFILE = 'default';

function normalizeProfileName(profile: string): string {
  const normalized = profile.trim();
  if (!normalized) {
    throw new Error('Profile name is required.');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error(`Invalid profile "${profile}". Use only letters, numbers, ".", "_", or "-".`);
  }
  return normalized;
}

export interface ConfigPaths {
  profile: string;
  project: string;
  global: string;
  effective: string | null;
  scopePreference: string;
  profilePreference: string;
  defaultProject: string;
  defaultGlobal: string;
}

export function getProjectConfigPath(cwd: string): string {
  return join(cwd, '.orchestra', 'workflow.yaml');
}

export function getGlobalConfigPath(): string {
  return join(homedir(), '.orchestra', 'workflow.yaml');
}

export function getProjectProfileConfigPath(cwd: string, profile: string): string {
  const normalized = normalizeProfileName(profile);
  if (normalized === DEFAULT_CONFIG_PROFILE) return getProjectConfigPath(cwd);
  return join(cwd, '.orchestra', 'profiles', normalized, 'workflow.yaml');
}

export function getGlobalProfileConfigPath(profile: string): string {
  const normalized = normalizeProfileName(profile);
  if (normalized === DEFAULT_CONFIG_PROFILE) return getGlobalConfigPath();
  return join(homedir(), '.orchestra', 'profiles', normalized, 'workflow.yaml');
}

export function getScopePreferencePath(cwd: string): string {
  return join(cwd, '.orchestra', 'config-scope');
}

export function getProfilePreferencePath(cwd: string): string {
  return join(cwd, '.orchestra', 'config-profile');
}

export function getConfigPaths(cwd: string, options: { profile?: string } = {}): ConfigPaths {
  const profile = normalizeProfileName(options.profile ?? DEFAULT_CONFIG_PROFILE);
  const defaultProject = getProjectConfigPath(cwd);
  const defaultGlobal = getGlobalConfigPath();
  const project = getProjectProfileConfigPath(cwd, profile);
  const global = getGlobalProfileConfigPath(profile);
  const effective = existsSync(project)
    ? project
    : existsSync(global)
      ? global
      : existsSync(defaultProject)
        ? defaultProject
        : existsSync(defaultGlobal)
          ? defaultGlobal
          : null;

  return {
    profile,
    project,
    global,
    effective,
    scopePreference: getScopePreferencePath(cwd),
    profilePreference: getProfilePreferencePath(cwd),
    defaultProject,
    defaultGlobal,
  };
}

function loadConfigByPathWithFallback(
  profilePath: string,
  fallbackPath: string,
): FullConfig | null {
  if (existsSync(profilePath)) return loadRawConfig(profilePath);
  if (profilePath === fallbackPath) return null;
  if (existsSync(fallbackPath)) return loadRawConfig(fallbackPath);
  return null;
}

export function loadConfigByScope(
  scope: ConfigScope,
  cwd: string,
  options: { profile?: string } = {},
): FullConfig | null {
  const profile = normalizeProfileName(options.profile ?? DEFAULT_CONFIG_PROFILE);
  const profilePaths = getConfigPaths(cwd, { profile });
  const defaultPaths = getConfigPaths(cwd, { profile: DEFAULT_CONFIG_PROFILE });
  if (scope === 'project') {
    return loadConfigByPathWithFallback(profilePaths.project, defaultPaths.project);
  }
  return loadConfigByPathWithFallback(profilePaths.global, defaultPaths.global);
}

export function saveConfigByScope(
  scope: ConfigScope,
  cwd: string,
  config: FullConfig,
  options: { profile?: string } = {},
): string {
  const profile = normalizeProfileName(options.profile ?? DEFAULT_CONFIG_PROFILE);
  const paths = getConfigPaths(cwd, { profile });
  const targetPath = scope === 'project' ? paths.project : paths.global;
  atomicWrite(targetPath, serializeWorkflowYaml(config));
  return targetPath;
}

export function loadEffectiveConfig(cwd: string, options: { profile?: string } = {}): FullConfig {
  const profile = normalizeProfileName(options.profile ?? readActiveProfilePreference(cwd) ?? DEFAULT_CONFIG_PROFILE);
  const projectConfig = loadConfigByScope('project', cwd, { profile });
  const globalConfig = loadConfigByScope('global', cwd, { profile });

  if (projectConfig && globalConfig) {
    return mergeConfigs(globalConfig, projectConfig);
  }
  if (projectConfig) {
    return projectConfig;
  }
  if (globalConfig) {
    return globalConfig;
  }
  return getDefaultConfig();
}

export function readActiveProfilePreference(cwd: string): string | null {
  const profilePath = getProfilePreferencePath(cwd);
  if (!existsSync(profilePath)) return null;
  const raw = readFileSync(profilePath, 'utf-8').trim();
  if (!raw) return null;
  try {
    return normalizeProfileName(raw);
  } catch {
    return null;
  }
}

export function saveActiveProfilePreference(cwd: string, profile: string): string {
  const normalizedProfile = normalizeProfileName(profile);
  const profilePath = getProfilePreferencePath(cwd);
  mkdirSync(dirname(profilePath), { recursive: true });
  writeFileSync(profilePath, `${normalizedProfile}\n`, 'utf-8');
  return profilePath;
}

export function readActiveScopePreference(cwd: string): ConfigScope | null {
  const scopePath = getScopePreferencePath(cwd);
  if (!existsSync(scopePath)) return null;
  const raw = readFileSync(scopePath, 'utf-8').trim();
  if (raw === 'project' || raw === 'global') return raw;
  return null;
}

export function saveActiveScopePreference(cwd: string, scope: ConfigScope): string {
  const scopePath = getScopePreferencePath(cwd);
  mkdirSync(dirname(scopePath), { recursive: true });
  writeFileSync(scopePath, `${scope}\n`, 'utf-8');
  return scopePath;
}
function loadRawConfig(configPath: string): FullConfig | null {
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    return parseWorkflowYaml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${configPath}: ${msg}`);
  }
}

function atomicWrite(targetPath: string, contents: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tempPath, contents, 'utf-8');
  renameSync(tempPath, targetPath);
}
