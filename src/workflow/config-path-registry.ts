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
  OPENAI_COMPATIBLE_MODEL_PRESETS,
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
    if (step.agent === AgentId.CAPTAIN) {
      candidates.push(...modelPresetsForCaptain(config));
      continue;
    }
    candidates.push(...modelPresetsForAgent(config, step.agent));
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
      config.captain.model = String(value);
    },
    options: (config) => modelPresetsForCaptain(config),
  },
  {
    path: 'workflow.execution.mode',
    examples: ['/config set workflow.execution.mode judgment'],
    match: exactPath('workflow.execution.mode'),
    read: (config) => config.workflow.execution?.mode ?? 'linear',
    parse: (raw, _config, _params, path) => {
      const mode = parseNonEmptyString(path, raw, '/config set workflow.execution.mode judgment').toLowerCase();
      if (mode !== 'linear' && mode !== 'judgment') {
        throw new Error(
          invalidValueMessage(
            path,
            'one of: linear, judgment',
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
    options: (config) => withCurrentOption(['linear', 'judgment'], config.workflow.execution?.mode ?? 'linear'),
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
    path: 'agents.<name>.capabilities',
    examples: ['/config set agents.local-gemma.capabilities implement,review'],
    match: regexPath(/^agents\.(?<name>[^.]+)\.capabilities$/),
    read: (config, params) => config.agents[params.name]?.capabilities,
    parse: (raw, config, params, path) => {
      if (!config.agents[params.name]) {
        throw new Error(
          `Invalid value for ${path}: unknown agent "${params.name}". Example: /config add-agent ${params.name} generic`,
        );
      }
      return parseDelimitedStringList(
        path,
        raw,
        `/config set agents.${params.name}.capabilities implement,review`,
      );
    },
    write: (config, params, value) => {
      config.agents[params.name].capabilities = value as string[];
    },
    options: (config, params) => {
      const agent = config.agents[params.name];
      if (!agent) return [];
      const current = (agent.capabilities ?? []).join(',');
      return withCurrentOption(CAPABILITY_PRESETS, current);
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
