import { BUILTIN_WORKER_AGENTS } from './agents.js';
import type { FullConfig } from './types.js';

export interface ConfigPathDescriptor {
  path: string;
  examples: string[];
  match: (path: string) => Record<string, string> | null;
  read: (config: FullConfig, params: Record<string, string>) => unknown;
  parse: (
    raw: unknown,
    config: FullConfig,
    params: Record<string, string>,
    path: string,
  ) => unknown;
  write: (config: FullConfig, params: Record<string, string>, value: unknown, path: string) => void;
  options: (config: FullConfig, params: Record<string, string>) => string[];
}

export interface ResolvedConfigPath {
  descriptor: ConfigPathDescriptor;
  params: Record<string, string>;
}

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

function invalidValueMessage(path: string, expected: string, received: unknown, example: string): string {
  const rendered = typeof received === 'string' ? `"${received}"` : JSON.stringify(received);
  return `Invalid value for ${path}: expected ${expected}, received ${rendered}. Example: ${example}`;
}

function parseNonEmptyString(path: string, raw: unknown, example: string): string {
  const normalized = String(raw).trim();
  if (normalized.length === 0) {
    throw new Error(invalidValueMessage(path, 'non-empty string', raw, example));
  }
  return normalized;
}

function parseNonEmptyStringList(path: string, raw: unknown, example: string): string[] {
  const normalize = (values: unknown[]): string[] => {
    const normalized: string[] = [];
    for (const value of values) {
      if (typeof value !== 'string') {
        throw new Error(invalidValueMessage(path, 'array of non-empty strings', raw, example));
      }
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        throw new Error(invalidValueMessage(path, 'array of non-empty strings', raw, example));
      }
      normalized.push(trimmed);
    }
    return uniqueOrdered(normalized);
  };

  if (Array.isArray(raw)) {
    return normalize(raw);
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
      return normalize(parsed);
    } catch {
      throw new Error(
        invalidValueMessage(
          path,
          'JSON array of non-empty strings, comma-delimited values, or []',
          raw,
          example,
        ),
      );
    }
  }

  return normalize(normalized.split(','));
}

function agentDefaultOptions(current: unknown): string[] {
  const known = [...BUILTIN_WORKER_AGENTS].sort();
  if (Array.isArray(current)) return withCurrentOption(known, current.join(','));
  return withCurrentOption(known, current);
}

function ensureWorkflowAgentDefaults(config: FullConfig): NonNullable<FullConfig['workflow']['agentDefaults']> {
  config.workflow.agentDefaults ??= {};
  return config.workflow.agentDefaults;
}

function ensureIterateAgentDefaults(config: FullConfig): NonNullable<NonNullable<FullConfig['workflow']['agentDefaults']>['iterate']> {
  const defaults = ensureWorkflowAgentDefaults(config);
  defaults.iterate ??= {};
  return defaults.iterate;
}

function ensurePanelAgentDefaults(config: FullConfig): NonNullable<NonNullable<FullConfig['workflow']['agentDefaults']>['panel']> {
  const defaults = ensureWorkflowAgentDefaults(config);
  defaults.panel ??= {};
  return defaults.panel;
}

function exactPath(path: string): (candidate: string) => Record<string, string> | null {
  return (candidate: string) => (candidate === path ? {} : null);
}

export const CONFIG_PATH_REGISTRY: ConfigPathDescriptor[] = [
  {
    path: 'workflow.agentDefaults.iterate.implementer',
    examples: ['/config set workflow.agentDefaults.iterate.implementer codex'],
    match: exactPath('workflow.agentDefaults.iterate.implementer'),
    read: (config) => config.workflow.agentDefaults?.iterate?.implementer,
    parse: (raw, _config, _params, path) => parseNonEmptyString(
      path,
      raw,
      '/config set workflow.agentDefaults.iterate.implementer codex',
    ),
    write: (config, _params, value) => {
      ensureIterateAgentDefaults(config).implementer = String(value);
    },
    options: (config) => agentDefaultOptions(
      config.workflow.agentDefaults?.iterate?.implementer,
    ),
  },
  {
    path: 'workflow.agentDefaults.iterate.reviewers',
    examples: ['/config set workflow.agentDefaults.iterate.reviewers \'["claude-code"]\''],
    match: exactPath('workflow.agentDefaults.iterate.reviewers'),
    read: (config) => config.workflow.agentDefaults?.iterate?.reviewers,
    parse: (raw, _config, _params, path) => parseNonEmptyStringList(
      path,
      raw,
      '/config set workflow.agentDefaults.iterate.reviewers \'["claude-code"]\'',
    ),
    write: (config, _params, value) => {
      ensureIterateAgentDefaults(config).reviewers = value as string[];
    },
    options: (config) => agentDefaultOptions(
      config.workflow.agentDefaults?.iterate?.reviewers,
    ),
  },
  {
    path: 'workflow.agentDefaults.iterate.banList',
    examples: ['/config set workflow.agentDefaults.iterate.banList \'["codex"]\''],
    match: exactPath('workflow.agentDefaults.iterate.banList'),
    read: (config) => config.workflow.agentDefaults?.iterate?.banList,
    parse: (raw, _config, _params, path) => parseNonEmptyStringList(
      path,
      raw,
      '/config set workflow.agentDefaults.iterate.banList \'["codex"]\'',
    ),
    write: (config, _params, value) => {
      ensureIterateAgentDefaults(config).banList = value as string[];
    },
    options: (config) => agentDefaultOptions(
      config.workflow.agentDefaults?.iterate?.banList,
    ),
  },
  {
    path: 'workflow.agentDefaults.panel.reviewers',
    examples: ['/config set workflow.agentDefaults.panel.reviewers \'["codex","claude-code"]\''],
    match: exactPath('workflow.agentDefaults.panel.reviewers'),
    read: (config) => config.workflow.agentDefaults?.panel?.reviewers,
    parse: (raw, _config, _params, path) => parseNonEmptyStringList(
      path,
      raw,
      '/config set workflow.agentDefaults.panel.reviewers \'["codex","claude-code"]\'',
    ),
    write: (config, _params, value) => {
      ensurePanelAgentDefaults(config).reviewers = value as string[];
    },
    options: (config) => agentDefaultOptions(
      config.workflow.agentDefaults?.panel?.reviewers,
    ),
  },
  {
    path: 'workflow.agentDefaults.panel.banList',
    examples: ['/config set workflow.agentDefaults.panel.banList \'["codex"]\''],
    match: exactPath('workflow.agentDefaults.panel.banList'),
    read: (config) => config.workflow.agentDefaults?.panel?.banList,
    parse: (raw, _config, _params, path) => parseNonEmptyStringList(
      path,
      raw,
      '/config set workflow.agentDefaults.panel.banList \'["codex"]\'',
    ),
    write: (config, _params, value) => {
      ensurePanelAgentDefaults(config).banList = value as string[];
    },
    options: (config) => agentDefaultOptions(
      config.workflow.agentDefaults?.panel?.banList,
    ),
  },
];

export const SUPPORTED_CONFIG_SET_PATHS = CONFIG_PATH_REGISTRY.map((descriptor) => descriptor.path);

export function resolveConfigPath(path: string): ResolvedConfigPath | null {
  for (const descriptor of CONFIG_PATH_REGISTRY) {
    const params = descriptor.match(path);
    if (params) {
      return { descriptor, params };
    }
  }
  return null;
}

export function configPathHelpLines(): string[] {
  return CONFIG_PATH_REGISTRY.flatMap((descriptor) => descriptor.examples);
}
