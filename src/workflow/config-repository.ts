import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { FullConfig } from './types.js';
import { getDefaultConfig, mergeConfigs, parseWorkflowYaml, serializeWorkflowYaml } from './config-codec.js';

export type ConfigScope = 'project' | 'global';

export interface ConfigPaths {
  project: string;
  global: string;
  effective: string | null;
  scopePreference: string;
}

export function getProjectConfigPath(cwd: string): string {
  return join(cwd, '.orchestra', 'workflow.yaml');
}

export function getGlobalConfigPath(): string {
  return join(homedir(), '.orchestra', 'workflow.yaml');
}

export function getScopePreferencePath(cwd: string): string {
  return join(cwd, '.orchestra', 'config-scope');
}

export function getConfigPaths(cwd: string): ConfigPaths {
  const project = getProjectConfigPath(cwd);
  const global = getGlobalConfigPath();
  const effective = existsSync(project)
    ? project
    : existsSync(global)
      ? global
      : null;

  return {
    project,
    global,
    effective,
    scopePreference: getScopePreferencePath(cwd),
  };
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

export function loadConfigByScope(scope: ConfigScope, cwd: string): FullConfig | null {
  const paths = getConfigPaths(cwd);
  const targetPath = scope === 'project' ? paths.project : paths.global;
  return loadRawConfig(targetPath);
}

export function saveConfigByScope(scope: ConfigScope, cwd: string, config: FullConfig): string {
  const paths = getConfigPaths(cwd);
  const targetPath = scope === 'project' ? paths.project : paths.global;
  atomicWrite(targetPath, serializeWorkflowYaml(config));
  return targetPath;
}

export function loadEffectiveConfig(cwd: string): FullConfig {
  const paths = getConfigPaths(cwd);
  const projectConfig = loadRawConfig(paths.project);
  const globalConfig = loadRawConfig(paths.global);

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
