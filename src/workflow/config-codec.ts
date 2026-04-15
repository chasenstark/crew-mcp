import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import {
  AgentId,
  resolveAdapterAliasOrThrow,
  resolveAgentAlias,
} from './agents.js';
import type { AgentConfig, FullConfig, WorkflowConfig } from './types.js';
import { resolveModelAliasOrThrow } from './models.js';

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

  return {
    workflow: {
      name: override.workflow.name ?? base.workflow.name,
      execution: override.workflow.execution ?? base.workflow.execution,
      steps: override.workflow.steps.length > 0
        ? override.workflow.steps
        : base.workflow.steps,
      roleModels: Object.keys(mergedRoleModels).length > 0 ? mergedRoleModels : undefined,
      completion: override.workflow.completion ?? base.workflow.completion,
    },
    agents: mergedAgents,
    captain: {
      cli: override.captain?.cli ?? base.captain.cli,
      model: override.captain?.model ?? base.captain.model,
    },
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
  const parsedExecution = asObject(parsedWorkflow.execution);
  const parsedCompletion = asObject(parsedWorkflow.completion);
  const parsedRoleModels = asObject(parsedWorkflow.role_models);
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
      const strengths = Array.isArray(raw.strengths)
        ? raw.strengths.filter((s): s is string => typeof s === 'string')
        : undefined;
      const args = Array.isArray(raw.args)
        ? raw.args.filter((a): a is string => typeof a === 'string')
        : undefined;
      const capabilities = Array.isArray(raw.capabilities)
        ? raw.capabilities.filter((c): c is string => typeof c === 'string')
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
        capabilities,
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

  const toWorkflowStep = (rawStep: unknown): WorkflowConfig['steps'][number] => {
    const step = asObject(rawStep);

    return {
      role: typeof step.role === 'string' ? step.role : 'coder',
      agent: typeof step.agent === 'string' ? resolveAgentAlias(step.agent) : AgentId.CLAUDE_CODE,
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
        mode: parsedExecution.mode === 'judgment' ? 'judgment' : 'linear',
      },
      steps: Array.isArray(parsedWorkflow.steps)
        ? parsedWorkflow.steps.map(toWorkflowStep)
        : [],
      roleModels: Object.keys(roleModels).length > 0
        ? roleModels
        : undefined,
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
      model: typeof rawCaptain.model === 'string'
        ? resolveModelAliasOrThrow(rawCaptain.model, 'captain.model')
        : undefined,
    },
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
        agent: step.agent,
        action: step.action,
        max_passes: step.maxPasses,
        condition: step.condition,
        criteria: step.criteria,
      })),
      role_models: config.workflow.roleModels && Object.keys(config.workflow.roleModels).length > 0
        ? config.workflow.roleModels
        : undefined,
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
          capabilities: agent.capabilities,
          api_base: agent.apiBase,
          api_key: agent.apiKey,
        }),
      ]),
    ),
    captain: omitUndefined({
      cli: config.captain.cli,
      model: config.captain.model,
    }),
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
