import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import {
  AgentId,
  resolveAdapterAliasOrThrow,
  resolveAgentAlias,
} from './agents.js';
import type {
  AgentConfig,
  CaptainModelMap,
  CaptainModelSpec,
  FullConfig,
  IterateAgentDefaultsConfig,
  PanelAgentDefaultsConfig,
  PresetConfig,
  WorkflowAgentDefaultsConfig,
  WorkflowConfig,
} from './types.js';
import { resolveModelAliasOrThrow } from './models.js';

const CAPTAIN_CLI_KEYS: readonly ('claude-code' | 'codex' | 'gemini-cli')[] = [
  'claude-code',
  'codex',
  'gemini-cli',
];

/**
 * Resolves the captain model spec to the single model string that should be
 * used for the currently-configured captain CLI. Returns `undefined` when no
 * model is specified for that CLI; callers let the captain's default kick in.
 */
export function resolveCaptainModel(captain: FullConfig['captain']): string | undefined {
  const spec = captain.model;
  if (spec === undefined) return undefined;
  if (typeof spec === 'string') return spec;
  const key = captain.cli as keyof CaptainModelMap;
  return spec[key];
}

function parseCaptainModelSpec(raw: unknown): CaptainModelSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    return resolveModelAliasOrThrow(raw, 'captain.model');
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('captain.model must be a string or a per-CLI object map');
  }

  const map: CaptainModelMap = {};
  const input = raw as Record<string, unknown>;
  for (const rawKey of Object.keys(input)) {
    const aliasKey = resolveAgentAlias(rawKey);
    if (!CAPTAIN_CLI_KEYS.includes(aliasKey as typeof CAPTAIN_CLI_KEYS[number])) {
      throw new Error(
        `Unknown captain.model key "${rawKey}". Supported keys: ${CAPTAIN_CLI_KEYS.join(', ')}`,
      );
    }
    const value = input[rawKey];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      throw new Error(`captain.model.${rawKey} must be a string`);
    }
    map[aliasKey as keyof CaptainModelMap] = resolveModelAliasOrThrow(value, `captain.model.${rawKey}`);
  }
  return map;
}

function serializeCaptainModelSpec(spec: CaptainModelSpec | undefined): unknown {
  if (spec === undefined) return undefined;
  if (typeof spec === 'string') return spec;
  const keys = Object.keys(spec).filter((key) => spec[key as keyof CaptainModelMap] !== undefined);
  if (keys.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = spec[key as keyof CaptainModelMap];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function omitUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function mergeIterateAgentDefaults(
  base: IterateAgentDefaultsConfig | undefined,
  override: IterateAgentDefaultsConfig | undefined,
): IterateAgentDefaultsConfig | undefined {
  const merged = {
    ...(base ?? {}),
    ...(override ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergePanelAgentDefaults(
  base: PanelAgentDefaultsConfig | undefined,
  override: PanelAgentDefaultsConfig | undefined,
): PanelAgentDefaultsConfig | undefined {
  const merged = {
    ...(base ?? {}),
    ...(override ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeAgentDefaults(
  base: WorkflowAgentDefaultsConfig | undefined,
  override: WorkflowAgentDefaultsConfig | undefined,
): WorkflowAgentDefaultsConfig | undefined {
  const iterate = mergeIterateAgentDefaults(base?.iterate, override?.iterate);
  const panel = mergePanelAgentDefaults(base?.panel, override?.panel);
  const merged = {
    ...(iterate ? { iterate } : {}),
    ...(panel ? { panel } : {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function parseOptionalAgentId(raw: unknown, path: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new Error(`${path} must be a string`);
  }
  return raw;
}

function parseOptionalAgentIdList(raw: unknown, path: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`${path} must be an array of strings`);
  }
  return raw.map((value, index) => {
    if (typeof value !== 'string') {
      throw new Error(`${path}[${index}] must be a string`);
    }
    return value;
  });
}

function parseAgentDefaults(raw: unknown): WorkflowAgentDefaultsConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  const root = asObject(raw);
  const iterateRoot = asObject(root.iterate);
  const panelRoot = asObject(root.panel);
  const iterate = omitUndefined({
    implementer: parseOptionalAgentId(
      iterateRoot.implementer,
      'workflow.agent_defaults.iterate.implementer',
    ),
    reviewers: parseOptionalAgentIdList(
      iterateRoot.reviewers,
      'workflow.agent_defaults.iterate.reviewers',
    ),
    banList: parseOptionalAgentIdList(
      iterateRoot.ban_list ?? iterateRoot.banList,
      'workflow.agent_defaults.iterate.ban_list',
    ),
  }) as unknown as IterateAgentDefaultsConfig;
  const panel = omitUndefined({
    reviewers: parseOptionalAgentIdList(
      panelRoot.reviewers,
      'workflow.agent_defaults.panel.reviewers',
    ),
    banList: parseOptionalAgentIdList(
      panelRoot.ban_list ?? panelRoot.banList,
      'workflow.agent_defaults.panel.ban_list',
    ),
  }) as unknown as PanelAgentDefaultsConfig;

  const out = {
    ...(Object.keys(iterate).length > 0 ? { iterate } : {}),
    ...(Object.keys(panel).length > 0 ? { panel } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function serializeAgentDefaults(
  defaults: WorkflowAgentDefaultsConfig | undefined,
): unknown {
  if (!defaults) return undefined;
  const iterate = defaults.iterate
    ? omitUndefined({
        implementer: defaults.iterate.implementer,
        reviewers: defaults.iterate.reviewers,
        ban_list: defaults.iterate.banList,
      })
    : undefined;
  const panel = defaults.panel
    ? omitUndefined({
        reviewers: defaults.panel.reviewers,
        ban_list: defaults.panel.banList,
      })
    : undefined;
  const out = omitUndefined({
    iterate: iterate && Object.keys(iterate).length > 0 ? iterate : undefined,
    panel: panel && Object.keys(panel).length > 0 ? panel : undefined,
  });
  return Object.keys(out).length > 0 ? out : undefined;
}

export function mergeConfigs(base: FullConfig, override: FullConfig): FullConfig {
  const mergedAgents: Record<string, AgentConfig> = { ...base.agents };
  for (const [name, agentOverride] of Object.entries(override.agents)) {
    mergedAgents[name] = {
      ...(base.agents[name] ?? {}),
      ...agentOverride,
    };
  }

  const mergedRoleModels = {
    ...(base.workflow.roleModels ?? {}),
    ...(override.workflow.roleModels ?? {}),
  };

  const mergedPresets: Record<string, PresetConfig> = {
    ...(base.presets ?? {}),
  };
  for (const [name, overridePreset] of Object.entries(override.presets ?? {})) {
    mergedPresets[name] = {
      ...(base.presets?.[name] ?? {}),
      ...overridePreset,
    };
  }

  return {
    workflow: {
      name: override.workflow.name ?? base.workflow.name,
      execution: override.workflow.execution ?? base.workflow.execution,
      steps: override.workflow.steps.length > 0
        ? override.workflow.steps
        : base.workflow.steps,
      roleModels: Object.keys(mergedRoleModels).length > 0 ? mergedRoleModels : undefined,
      agentDefaults: mergeAgentDefaults(
        base.workflow.agentDefaults,
        override.workflow.agentDefaults,
      ),
      completion: override.workflow.completion ?? base.workflow.completion,
    },
    agents: mergedAgents,
    captain: {
      cli: override.captain?.cli ?? base.captain.cli,
      model: override.captain?.model ?? base.captain.model,
      preset: override.captain?.preset ?? base.captain.preset,
    },
    presets: Object.keys(mergedPresets).length > 0 ? mergedPresets : undefined,
    errorHandling: {
      default: {
        ...base.errorHandling.default,
        ...override.errorHandling.default,
      },
    },
  };
}

export function parseWorkflowYaml(yamlContent: string): FullConfig {
  const parsed = asObject(YAML.parse(yamlContent));
  const parsedWorkflow = asObject(parsed.workflow);
  // M4-4: parsedWorkflow.execution is no longer read — judgment is the
  // only supported mode and the result is hard-coded below. Legacy YAML
  // with `execution: { mode: linear }` is accepted and silently coerced.
  const parsedCompletion = asObject(parsedWorkflow.completion);
  const parsedRoleModels = asObject(parsedWorkflow.role_models);
  const parsedAgentDefaults = parseAgentDefaults(
    parsedWorkflow.agent_defaults ?? parsedWorkflow.agentDefaults,
  );
  const parsedErrorHandling = asObject(parsed.error_handling);
  const parsedErrorDefault = asObject(parsedErrorHandling.default);
  const parsedAgentsRoot = asObject(parsed.agents);

  const steps = parsedWorkflow.steps;
  if (steps !== undefined && !Array.isArray(steps)) {
    throw new Error('workflow.steps must be an array');
  }

  const parsedAgents = Object.entries(parsedAgentsRoot).reduce<Record<string, AgentConfig>>(
    (acc, [rawName, value]) => {
      const name = resolveAgentAlias(rawName);
      if (acc[name]) {
        throw new Error(`Duplicate agent key after alias resolution: "${name}"`);
      }
      if (!value || typeof value !== 'object') {
        acc[name] = {};
        return acc;
      }
      const raw = value as Record<string, unknown>;
      // Accept either `strengths` (canonical) or legacy `capabilities`
      // for backward-compat with v1 configs already on disk. The legacy
      // path is removed once we cut v0.3 — see future-direction doc.
      const strengthsRaw = Array.isArray(raw.strengths)
        ? raw.strengths
        : Array.isArray(raw.capabilities)
          ? raw.capabilities
          : undefined;
      const strengths = strengthsRaw
        ? strengthsRaw.filter((s): s is string => typeof s === 'string')
        : undefined;
      const args = Array.isArray(raw.args)
        ? raw.args.filter((a): a is string => typeof a === 'string')
        : undefined;

      acc[name] = {
        adapter: typeof raw.adapter === 'string'
          ? resolveAdapterAliasOrThrow(raw.adapter, `agents.${name}.adapter`)
          : undefined,
        auth: typeof raw.auth === 'string' ? raw.auth : undefined,
        strengths,
        model: typeof raw.model === 'string'
          ? resolveModelAliasOrThrow(raw.model, `agents.${name}.model`)
          : undefined,
        command: typeof raw.command === 'string' ? raw.command : undefined,
        args,
        apiBase: typeof raw.api_base === 'string'
          ? raw.api_base
          : typeof raw.apiBase === 'string'
            ? raw.apiBase
            : undefined,
        apiKey: typeof raw.api_key === 'string'
          ? raw.api_key
          : typeof raw.apiKey === 'string'
            ? raw.apiKey
            : undefined,
      };
      return acc;
    },
    {},
  );
  const roleModels = Object.entries(parsedRoleModels).reduce<Record<string, string>>((acc, [key, value]) => {
    if (typeof value === 'string') {
      acc[key] = resolveModelAliasOrThrow(value, `workflow.role_models.${key}`);
    }
    return acc;
  }, {});

  const rawCaptain = asObject(parsed.captain);
  const rawPresets = asObject(parsed.presets);

  const parsedPresets = Object.entries(rawPresets).reduce<Record<string, PresetConfig>>(
    (acc, [rawName, value]) => {
      const name = typeof rawName === 'string' ? rawName : String(rawName);
      if (!value || typeof value !== 'object') {
        acc[name] = { name };
        return acc;
      }
      const raw = value as Record<string, unknown>;
      const rawRolesValue = (raw as { suggestedAgentRoles?: unknown; suggested_agent_roles?: unknown });
      const rawRoles = rawRolesValue.suggestedAgentRoles ?? rawRolesValue.suggested_agent_roles;
      const suggestedAgentRoles = Array.isArray(rawRoles)
        ? rawRoles.filter((r): r is string => typeof r === 'string' && r.length > 0)
        : undefined;
      acc[name] = {
        name,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        hint: typeof raw.hint === 'string' ? raw.hint : undefined,
        suggestedAgentRoles: suggestedAgentRoles && suggestedAgentRoles.length > 0
          ? suggestedAgentRoles
          : undefined,
      };
      return acc;
    },
    {},
  );

  const toWorkflowStep = (rawStep: unknown): WorkflowConfig['steps'][number] => {
    const step = asObject(rawStep);

    // Steps now declare a list of candidate agents (preference order). The
    // captain treats this as a hint, not a contract. We accept the new
    // `agents: [...]` form only — there's no backward-compatible scalar
    // fallback per the M5 config rework.
    const rawAgents = step.agents;
    if (!Array.isArray(rawAgents) || rawAgents.length === 0) {
      throw new Error(
        'workflow.steps[*].agents must be a non-empty list of agent names. ' +
        'The legacy scalar `agent: <name>` form is no longer supported — ' +
        'use `agents: [<name>]` (one or more candidates).',
      );
    }
    const agents = rawAgents
      .filter((value): value is string => typeof value === 'string')
      .map((name) => resolveAgentAlias(name));
    if (agents.length === 0) {
      throw new Error(
        'workflow.steps[*].agents must contain at least one string agent name.',
      );
    }

    return {
      role: typeof step.role === 'string' ? step.role : 'coder',
      agents,
      action: typeof step.action === 'string' ? step.action : 'implement',
      maxPasses: typeof step.max_passes === 'number' ? step.max_passes : undefined,
      condition: typeof step.condition === 'string' ? step.condition : undefined,
      criteria: Array.isArray(step.criteria)
        ? step.criteria.filter((c): c is string => typeof c === 'string')
        : undefined,
    };
  };

  return {
    workflow: {
      name: typeof parsedWorkflow.name === 'string' ? parsedWorkflow.name : 'default',
      execution: {
        // M4-4: judgment is the only supported mode; legacy 'linear' YAML
        // values are coerced to 'judgment' so old workflow.yaml files keep
        // loading without error. The v4→v5 state-file reader remains the
        // hard gate for the executionMode: 'linear' state-file case.
        mode: 'judgment',
      },
      steps: Array.isArray(parsedWorkflow.steps)
        ? parsedWorkflow.steps.map(toWorkflowStep)
        : [],
      roleModels: Object.keys(roleModels).length > 0
        ? roleModels
        : undefined,
      agentDefaults: parsedAgentDefaults,
      completion: {
        strategy: typeof parsedCompletion.strategy === 'string' ? parsedCompletion.strategy : 'judge_approval',
        fallback: typeof parsedCompletion.fallback === 'string' ? parsedCompletion.fallback : 'max_passes',
      },
    },
    agents: parsedAgents,
    captain: {
      cli: typeof rawCaptain.cli === 'string'
        ? resolveAgentAlias(rawCaptain.cli)
        : AgentId.CLAUDE_CODE,
      model: parseCaptainModelSpec(rawCaptain.model),
      preset: typeof rawCaptain.preset === 'string' ? rawCaptain.preset : undefined,
    },
    presets: Object.keys(parsedPresets).length > 0 ? parsedPresets : undefined,
    errorHandling: {
      default: {
        retry: typeof parsedErrorDefault.retry === 'number' ? parsedErrorDefault.retry : 1,
        fallback: typeof parsedErrorDefault.fallback === 'string' || parsedErrorDefault.fallback === null
          ? parsedErrorDefault.fallback as string | null
          : null,
        onExhausted: typeof parsedErrorDefault.on_exhausted === 'string'
          ? parsedErrorDefault.on_exhausted
          : 'ask_user',
      },
    },
  };
}

export function serializeWorkflowYaml(config: FullConfig): string {
  const yamlObject = {
    workflow: {
      name: config.workflow.name,
      execution: {
        mode: config.workflow.execution?.mode ?? 'linear',
      },
      steps: config.workflow.steps.map((step) => omitUndefined({
        role: step.role,
        agents: step.agents,
        action: step.action,
        max_passes: step.maxPasses,
        condition: step.condition,
        criteria: step.criteria,
      })),
      role_models: config.workflow.roleModels && Object.keys(config.workflow.roleModels).length > 0
        ? config.workflow.roleModels
        : undefined,
      agent_defaults: serializeAgentDefaults(config.workflow.agentDefaults),
      completion: {
        strategy: config.workflow.completion.strategy,
        fallback: config.workflow.completion.fallback,
      },
    },
    agents: Object.fromEntries(
      Object.entries(config.agents).map(([name, agent]) => [
        name,
        omitUndefined({
          adapter: agent.adapter,
          auth: agent.auth,
          strengths: agent.strengths,
          model: agent.model,
          command: agent.command,
          args: agent.args,
          api_base: agent.apiBase,
          api_key: agent.apiKey,
        }),
      ]),
    ),
    captain: omitUndefined({
      cli: config.captain.cli,
      model: serializeCaptainModelSpec(config.captain.model),
      preset: config.captain.preset,
    }),
    presets: config.presets && Object.keys(config.presets).length > 0
      ? Object.fromEntries(
          Object.entries(config.presets).map(([name, preset]) => [
            name,
            omitUndefined({
              description: preset.description,
              hint: preset.hint,
              suggested_agent_roles:
                preset.suggestedAgentRoles && preset.suggestedAgentRoles.length > 0
                  ? preset.suggestedAgentRoles
                  : undefined,
            }),
          ]),
        )
      : undefined,
    error_handling: {
      default: {
        retry: config.errorHandling.default.retry,
        fallback: config.errorHandling.default.fallback,
        on_exhausted: config.errorHandling.default.onExhausted,
      },
    },
  };

  return YAML.stringify(yamlObject, {
    lineWidth: 0,
  });
}

function resolveDefaultWorkflowTemplatePath(): string {
  const baseDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(baseDir, '../../defaults/workflow.yaml'),
    join(baseDir, '../defaults/workflow.yaml'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error('Could not locate defaults/workflow.yaml');
}

export function getDefaultWorkflowYamlTemplate(): string {
  return readFileSync(resolveDefaultWorkflowTemplatePath(), 'utf-8');
}

export function getDefaultConfig(): FullConfig {
  return parseWorkflowYaml(getDefaultWorkflowYamlTemplate());
}
