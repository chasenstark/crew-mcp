import YAML from 'yaml';
import type { AgentConfig, FullConfig, WorkflowConfig } from './types.js';

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
    orchestrator: {
      cli: override.orchestrator?.cli ?? base.orchestrator.cli,
      model: override.orchestrator?.model ?? base.orchestrator.model,
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
    (acc, [name, value]) => {
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
        adapter: typeof raw.adapter === 'string' ? raw.adapter : undefined,
        auth: typeof raw.auth === 'string' ? raw.auth : undefined,
        strengths,
        model: typeof raw.model === 'string' ? raw.model : undefined,
        command: typeof raw.command === 'string' ? raw.command : undefined,
        args,
        capabilities,
      };
      return acc;
    },
    {},
  );
  const roleModels = Object.entries(parsedRoleModels).reduce<Record<string, string>>((acc, [key, value]) => {
    if (typeof value === 'string') {
      acc[key] = value;
    }
    return acc;
  }, {});

  const rawOrchestrator = asObject(parsed.orchestrator);

  const toWorkflowStep = (rawStep: unknown): WorkflowConfig['steps'][number] => {
    const step = asObject(rawStep);

    return {
      role: typeof step.role === 'string' ? step.role : 'coder',
      agent: typeof step.agent === 'string' ? step.agent : 'claude-code',
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
    orchestrator: {
      cli: typeof rawOrchestrator.cli === 'string' ? rawOrchestrator.cli : 'claude-code',
      model: typeof rawOrchestrator.model === 'string' ? rawOrchestrator.model : undefined,
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
        }),
      ]),
    ),
    orchestrator: omitUndefined({
      cli: config.orchestrator.cli,
      model: config.orchestrator.model,
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

export function getDefaultConfig(): FullConfig {
  return {
    workflow: {
      name: 'default',
      execution: { mode: 'judgment' },
      steps: [
        { role: 'coder', agent: 'claude-code', action: 'implement' },
        { role: 'reviewer', agent: 'codex', action: 'review', maxPasses: 3 },
        { role: 'judge', agent: 'orchestrator', action: 'evaluate_review', criteria: ['Are the review findings actionable?', 'Is the fix complete and correct?'] },
        { role: 'coder', agent: 'claude-code', action: 'fix_review_issues', condition: 'judge says fixes needed' },
      ],
      completion: { strategy: 'judge_approval', fallback: 'max_passes' },
    },
    agents: {
      'claude-code': {
        adapter: 'claude-code',
        auth: 'subscription',
        model: 'claude-opus-4-6',
        strengths: ['implementation', 'refactoring', 'TypeScript', 'React'],
      },
      'codex': {
        adapter: 'codex',
        auth: 'subscription',
        model: 'gpt-5.3-codex',
        strengths: ['review', 'testing', 'Python', 'security'],
      },
    },
    orchestrator: { cli: 'claude-code', model: 'claude-sonnet-4-5' },
    errorHandling: {
      default: { retry: 1, fallback: null, onExhausted: 'ask_user' },
    },
  };
}
