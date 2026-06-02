import {
  ADAPTER_PRESETS,
  AdapterId,
  AgentId,
  BUILTIN_WORKER_AGENTS,
  resolveAdapterAliasOrThrow,
  resolveAgentAlias,
} from './agents.js';
import {
  CLAUDE_MODEL_PRESETS,
  CODEX_MODEL_PRESETS,
  ModelId,
  modelPresetsForAdapter,
  resolveModelAliasOrThrow,
} from './models.js';
import type { FullConfig } from './types.js';
import { findReviewStepIndex } from './review-step.js';
import { resolveCaptainModel } from './config-codec.js';

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

// Strengths are free-form, but a few common kebab-case tags surface
// as completion suggestions in the wizard / `/config set` UI. The
// list is purely advisory — users can write any string.
const STRENGTH_PRESETS = [
  'careful-reasoning',
  'code-review',
  'documentation',
  'fast-iteration',
  'autonomous-loops',
  'long-context',
  'broad-codebase-triage',
  'multimodal-input',
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

function invalidValueMessage(path: string, expected: string, received: unknown, example: string): string {
  const rendered = typeof received === 'string' ? `"${received}"` : JSON.stringify(received);
  return `Invalid value for ${path}: expected ${expected}, received ${rendered}. Example: ${example}`;
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

function agentDefaultOptions(config: FullConfig, current: unknown): string[] {
  const known = [
    ...Object.keys(config.agents),
    ...BUILTIN_WORKER_AGENTS,
  ].sort();
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

function resolveCaptainAdapterType(config: FullConfig): string | undefined {
  const captainAgent = config.agents[config.captain.cli];
  return captainAgent?.adapter ?? config.captain.cli;
}

function modelPresetsForAgent(config: FullConfig, agentName: string): string[] {
  const agent = config.agents[agentName];
  if (!agent) return [];
  const adapterType = agent.adapter ?? agentName;
  return withCurrentOption(modelPresetsForAdapter(adapterType), agent.model);
}

function modelPresetsForCaptain(config: FullConfig): string[] {
  return withCurrentOption(
    modelPresetsForAdapter(resolveCaptainAdapterType(config)),
    resolveCaptainModel(config.captain),
  );
}

function modelPresetsForRole(config: FullConfig, role: string): string[] {
  const candidates: string[] = [];
  for (const step of config.workflow.steps) {
    if (step.role !== role && step.action !== role) continue;
    // A step can list multiple candidate agents — surface model presets from
    // every candidate so the role-model picker isn't artificially scoped to
    // the first candidate's adapter.
    for (const agent of step.agents) {
      if (agent === AgentId.CAPTAIN) {
        candidates.push(...modelPresetsForCaptain(config));
        continue;
      }
      candidates.push(...modelPresetsForAgent(config, agent));
    }
  }

  if (candidates.length === 0) {
    if (role === 'judge') {
      candidates.push(...modelPresetsForCaptain(config));
    } else {
      candidates.push(...CLAUDE_MODEL_PRESETS, ...CODEX_MODEL_PRESETS);
    }
  }
  return uniqueOrdered(candidates);
}

function exactPath(path: string): (candidate: string) => Record<string, string> | null {
  return (candidate: string) => (candidate === path ? {} : null);
}

function regexPath(regex: RegExp): (candidate: string) => Record<string, string> | null {
  return (candidate: string) => {
    const match = regex.exec(candidate);
    if (!match) return null;
    return match.groups ?? {};
  };
}

export const CONFIG_PATH_REGISTRY: ConfigPathDescriptor[] = [
  {
    path: 'captain.cli',
    examples: [`/config set captain.cli ${AgentId.CODEX}`],
    match: exactPath('captain.cli'),
    read: (config) => config.captain.cli,
    parse: (raw, _config, _params, path) => resolveAgentAlias(
      parseNonEmptyString(path, raw, `/config set captain.cli ${AgentId.CODEX}`),
    ),
    write: (config, _params, value) => {
      config.captain.cli = String(value);
    },
    options: (config) => {
      const otherAgents = Object.keys(config.agents)
        .filter((name) => !BUILTIN_WORKER_AGENTS.includes(name as AgentId))
        .sort();
      const options = uniqueOrdered([
        ...BUILTIN_WORKER_AGENTS,
        ...otherAgents,
      ]);
      return withCurrentOption(options, config.captain.cli);
    },
  },
  {
    path: 'captain.model',
    examples: [`/config set captain.model ${ModelId.CLAUDE_SONNET}`],
    match: exactPath('captain.model'),
    read: (config) => resolveCaptainModel(config.captain),
    parse: (raw, _config, _params, path) => resolveModelAliasOrThrow(
      parseNonEmptyString(path, raw, `/config set captain.model ${ModelId.CLAUDE_SONNET}`),
      path,
    ),
    write: (config, _params, value) => {
      const next = String(value);
      const current = config.captain.model;
      // Preserve the per-CLI map shape when one is already configured so
      // `/config set captain.model X` updates just the current CLI's entry
      // instead of silently wiping the other captains' models.
      if (current && typeof current === 'object') {
        const key = config.captain.cli as keyof typeof current;
        config.captain.model = {
          ...current,
          [key]: next,
        };
        return;
      }
      config.captain.model = next;
    },
    options: (config) => modelPresetsForCaptain(config),
  },
  {
    path: 'captain.preset',
    examples: [
      '/config set captain.preset default',
      '/config set captain.preset thorough-review',
    ],
    match: exactPath('captain.preset'),
    read: (config) => config.captain.preset,
    parse: (raw, config, _params, path) => {
      const parsed = parseNonEmptyString(path, raw, '/config set captain.preset default');
      // Symmetry with the `agents.<name>.*` descriptors, and with the
      // `/preset <name>` slash command: unknown names are rejected at
      // parse time so a user typo doesn't silently persist a broken
      // reference that only surfaces as a preflight warn on the next run.
      const declared = Object.keys(config.presets ?? {});
      if (declared.length > 0 && !declared.includes(parsed)) {
        throw new Error(
          invalidValueMessage(
            path,
            `declared preset (one of: ${declared.sort().join(', ')})`,
            raw,
            '/config set captain.preset default',
          ),
        );
      }
      return parsed;
    },
    write: (config, _params, value) => {
      config.captain.preset = String(value);
    },
    options: (config) => {
      const declared = Object.keys(config.presets ?? {}).sort();
      return withCurrentOption(declared, config.captain.preset);
    },
  },
  {
    path: 'workflow.execution.mode',
    examples: ['/config set workflow.execution.mode judgment'],
    match: exactPath('workflow.execution.mode'),
    read: (config) => config.workflow.execution?.mode ?? 'judgment',
    parse: (raw, _config, _params, path) => {
      const mode = parseNonEmptyString(path, raw, '/config set workflow.execution.mode judgment').toLowerCase();
      if (mode !== 'judgment') {
        // M4-4: linear mode is retired. The v4→v5 migration reader
        // already rejects state files with executionMode: 'linear'; this
        // closes the last door where a user could re-introduce the value
        // through the config surface.
        throw new Error(
          invalidValueMessage(
            path,
            "'judgment' (linear mode was retired in M4)",
            raw,
            '/config set workflow.execution.mode judgment',
          ),
        );
      }
      return mode;
    },
    write: (config, _params, value) => {
      config.workflow.execution = { mode: value as 'linear' | 'judgment' };
    },
    options: (config) => withCurrentOption(['judgment'], config.workflow.execution?.mode ?? 'judgment'),
  },
  {
    path: 'workflow.roleModels.<role>',
    examples: [`/config set workflow.roleModels.reviewer ${ModelId.GPT}`],
    match: regexPath(/^workflow\.roleModels\.(?<role>[^.]+)$/),
    read: (config, params) => config.workflow.roleModels?.[params.role],
    parse: (raw, _config, _params, path) => resolveModelAliasOrThrow(
      parseNonEmptyString(path, raw, `/config set workflow.roleModels.reviewer ${ModelId.GPT}`),
      path,
    ),
    write: (config, params, value) => {
      if (!config.workflow.roleModels) config.workflow.roleModels = {};
      config.workflow.roleModels[params.role] = String(value);
    },
    options: (config, params) => withCurrentOption(
      modelPresetsForRole(config, params.role),
      config.workflow.roleModels?.[params.role],
    ),
  },
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
      config,
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
      config,
      config.workflow.agentDefaults?.iterate?.reviewers,
    ),
  },
  {
    path: 'workflow.agentDefaults.iterate.banList',
    examples: ['/config set workflow.agentDefaults.iterate.banList \'["gemini-cli"]\''],
    match: exactPath('workflow.agentDefaults.iterate.banList'),
    read: (config) => config.workflow.agentDefaults?.iterate?.banList,
    parse: (raw, _config, _params, path) => parseNonEmptyStringList(
      path,
      raw,
      '/config set workflow.agentDefaults.iterate.banList \'["gemini-cli"]\'',
    ),
    write: (config, _params, value) => {
      ensureIterateAgentDefaults(config).banList = value as string[];
    },
    options: (config) => agentDefaultOptions(
      config,
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
      config,
      config.workflow.agentDefaults?.panel?.reviewers,
    ),
  },
  {
    path: 'workflow.agentDefaults.panel.banList',
    examples: ['/config set workflow.agentDefaults.panel.banList \'["gemini-cli"]\''],
    match: exactPath('workflow.agentDefaults.panel.banList'),
    read: (config) => config.workflow.agentDefaults?.panel?.banList,
    parse: (raw, _config, _params, path) => parseNonEmptyStringList(
      path,
      raw,
      '/config set workflow.agentDefaults.panel.banList \'["gemini-cli"]\'',
    ),
    write: (config, _params, value) => {
      ensurePanelAgentDefaults(config).banList = value as string[];
    },
    options: (config) => agentDefaultOptions(
      config,
      config.workflow.agentDefaults?.panel?.banList,
    ),
  },
  {
    path: 'agents.<name>.adapter',
    examples: [`/config set agents.local-gemma.adapter ${AdapterId.GENERIC}`],
    match: regexPath(/^agents\.(?<name>[^.]+)\.adapter$/),
    read: (config, params) => config.agents[params.name]?.adapter,
    parse: (raw, config, params, path) => {
      if (!config.agents[params.name]) {
        throw new Error(
          `Invalid value for ${path}: unknown agent "${params.name}". Example: /config add-agent ${params.name} generic`,
        );
      }
      return resolveAdapterAliasOrThrow(
        parseNonEmptyString(path, raw, `/config set agents.${params.name}.adapter ${AdapterId.GENERIC}`),
        path,
      );
    },
    write: (config, params, value) => {
      config.agents[params.name].adapter = String(value);
    },
    options: (config, params) => {
      const agent = config.agents[params.name];
      if (!agent) return [];
      const adapterType = agent.adapter ?? params.name;
      return withCurrentOption(ADAPTER_PRESETS, adapterType);
    },
  },
  {
    path: 'agents.<name>.model',
    examples: [`/config set agents.codex.model ${ModelId.GPT_CODEX}`],
    match: regexPath(/^agents\.(?<name>[^.]+)\.model$/),
    read: (config, params) => config.agents[params.name]?.model,
    parse: (raw, config, params, path) => {
      if (!config.agents[params.name]) {
        throw new Error(
          `Invalid value for ${path}: unknown agent "${params.name}". Example: /config add-agent ${params.name} generic`,
        );
      }
      return resolveModelAliasOrThrow(
        parseNonEmptyString(path, raw, `/config set agents.${params.name}.model ${ModelId.GPT_CODEX}`),
        path,
      );
    },
    write: (config, params, value) => {
      config.agents[params.name].model = String(value);
    },
    options: (config, params) => {
      const agent = config.agents[params.name];
      if (!agent) return [];
      return withCurrentOption(modelPresetsForAgent(config, params.name), agent.model);
    },
  },
  {
    path: 'agents.<name>.command',
    examples: ['/config set agents.local-gemma.command ollama'],
    match: regexPath(/^agents\.(?<name>[^.]+)\.command$/),
    read: (config, params) => config.agents[params.name]?.command,
    parse: (raw, config, params, path) => {
      if (!config.agents[params.name]) {
        throw new Error(
          `Invalid value for ${path}: unknown agent "${params.name}". Example: /config add-agent ${params.name} generic`,
        );
      }
      return parseNonEmptyString(path, raw, `/config set agents.${params.name}.command ollama`);
    },
    write: (config, params, value) => {
      config.agents[params.name].command = String(value);
    },
    options: () => [],
  },
  {
    path: 'agents.<name>.args',
    examples: ['/config set agents.local-gemma.args run,gemma4:latest,{{prompt}}'],
    match: regexPath(/^agents\.(?<name>[^.]+)\.args$/),
    read: (config, params) => config.agents[params.name]?.args,
    parse: (raw, config, params, path) => {
      if (!config.agents[params.name]) {
        throw new Error(
          `Invalid value for ${path}: unknown agent "${params.name}". Example: /config add-agent ${params.name} generic`,
        );
      }
      return parseDelimitedStringList(
        path,
        raw,
        `/config set agents.${params.name}.args run,gemma4:latest,{{prompt}}`,
      );
    },
    write: (config, params, value) => {
      config.agents[params.name].args = value as string[];
    },
    options: () => [],
  },
  {
    path: 'agents.<name>.strengths',
    examples: ['/config set agents.local-gemma.strengths code-review,fast-iteration'],
    match: regexPath(/^agents\.(?<name>[^.]+)\.strengths$/),
    read: (config, params) => config.agents[params.name]?.strengths,
    parse: (raw, config, params, path) => {
      if (!config.agents[params.name]) {
        throw new Error(
          `Invalid value for ${path}: unknown agent "${params.name}". Example: /config add-agent ${params.name} generic`,
        );
      }
      return parseDelimitedStringList(
        path,
        raw,
        `/config set agents.${params.name}.strengths code-review,documentation`,
      );
    },
    write: (config, params, value) => {
      config.agents[params.name].strengths = value as string[];
    },
    options: (config, params) => {
      const agent = config.agents[params.name];
      if (!agent) return [];
      const current = (agent.strengths ?? []).join(',');
      return withCurrentOption(STRENGTH_PRESETS, current);
    },
  },
  {
    // Per-role candidate-agents list. The captain treats `agents:` as a hint
    // (preference order) so this descriptor lets the user retune the
    // candidate list for a role from `/config set` and the setup wizard
    // alike. Setting applies to EVERY step whose role or action matches —
    // the default workflow has the "coder" role on two steps (implement +
    // fix_review_issues) and we want them to stay in sync.
    path: 'workflow.steps.<role>.agents',
    examples: [
      '/config set workflow.steps.coder.agents codex,claude-code',
      '/config set workflow.steps.reviewer.agents claude-code',
    ],
    match: (path) => {
      const m = path.match(/^workflow\.steps\.([\w-]+)\.agents$/);
      return m ? { role: m[1] } : null;
    },
    read: (config, params) => {
      const step = config.workflow.steps.find(
        (s) => s.role === params.role || s.action === params.role,
      );
      return step?.agents;
    },
    parse: (raw, config, params, path) => {
      const matching = config.workflow.steps.filter(
        (s) => s.role === params.role || s.action === params.role,
      );
      if (matching.length === 0) {
        throw new Error(
          `Cannot set ${path}: no step with role or action "${params.role}". ` +
            'Update workflow.steps first.',
        );
      }
      const example = '/config set workflow.steps.coder.agents codex,claude-code';
      const list = parseDelimitedStringList(path, raw, example);
      if (list.length === 0) {
        throw new Error(
          `${path} must contain at least one agent name (preference order). Got an empty list.`,
        );
      }
      const resolved = list.map((name) => resolveAgentAlias(name));
      const known = new Set<string>([
        ...Object.keys(config.agents),
        ...BUILTIN_WORKER_AGENTS,
        AgentId.CAPTAIN,
      ]);
      for (const name of resolved) {
        if (!known.has(name)) {
          throw new Error(
            `${path} references unknown agent "${name}". ` +
              'Add an `agents:` entry for it first or use a built-in agent name.',
          );
        }
      }
      return uniqueOrdered(resolved);
    },
    write: (config, params, value) => {
      const list = value as string[];
      for (const step of config.workflow.steps) {
        if (step.role === params.role || step.action === params.role) {
          step.agents = [...list];
        }
      }
    },
    options: (config, params) => {
      const step = config.workflow.steps.find(
        (s) => s.role === params.role || s.action === params.role,
      );
      const current = step?.agents ?? [];
      const known = [
        ...Object.keys(config.agents),
        AgentId.CAPTAIN,
      ].sort();
      return withCurrentOption(known, current.join(','));
    },
  },
  {
    path: 'workflow.reviewer.maxPasses',
    examples: ['/config set workflow.reviewer.maxPasses 3'],
    match: exactPath('workflow.reviewer.maxPasses'),
    read: (config) => {
      const reviewerIndex = findReviewStepIndex(config);
      const reviewer = reviewerIndex >= 0 ? config.workflow.steps[reviewerIndex] : undefined;
      return reviewer?.maxPasses;
    },
    parse: (raw, config, _params, path) => {
      if (findReviewStepIndex(config) < 0) {
        throw new Error(
          'Cannot set workflow.reviewer.maxPasses: no review step exists in workflow.steps (role="reviewer" or action="review").',
        );
      }
      return parseInteger(path, raw, 1, '/config set workflow.reviewer.maxPasses 3');
    },
    write: (config, _params, value) => {
      const reviewerIndex = findReviewStepIndex(config);
      if (reviewerIndex < 0) {
        throw new Error(
          'Cannot set workflow.reviewer.maxPasses: no review step exists in workflow.steps (role="reviewer" or action="review").',
        );
      }
      config.workflow.steps[reviewerIndex].maxPasses = value as number;
    },
    options: (config) => {
      const reviewerIndex = findReviewStepIndex(config);
      if (reviewerIndex < 0) return [];
      const reviewerStep = config.workflow.steps[reviewerIndex];
      return withCurrentOption(['1', '2', '3', '4', '5'], reviewerStep?.maxPasses);
    },
  },
  {
    path: 'errorHandling.default.retry',
    examples: ['/config set errorHandling.default.retry 1'],
    match: exactPath('errorHandling.default.retry'),
    read: (config) => config.errorHandling.default.retry,
    parse: (raw, _config, _params, path) => parseInteger(path, raw, 0, '/config set errorHandling.default.retry 1'),
    write: (config, _params, value) => {
      config.errorHandling.default.retry = value as number;
    },
    options: (config) => withCurrentOption(['0', '1', '2', '3', '4'], config.errorHandling.default.retry),
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
