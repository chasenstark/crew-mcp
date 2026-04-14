import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import YAML from 'yaml';
import type { AgentConfig, FullConfig, WorkflowConfig } from './types.js';

export function getGlobalConfigPath(): string {
  return join(homedir(), '.orchestra', 'workflow.yaml');
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

export function mergeConfigs(base: FullConfig, override: FullConfig): FullConfig {
  const mergedAgents: Record<string, AgentConfig> = { ...base.agents };
  for (const [name, agentOverride] of Object.entries(override.agents)) {
    mergedAgents[name] = {
      ...(base.agents[name] ?? {}),
      ...agentOverride,
    };
  }

  return {
    workflow: {
      name: override.workflow.name ?? base.workflow.name,
      steps: override.workflow.steps.length > 0
        ? override.workflow.steps
        : base.workflow.steps,
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

export function loadWorkflowConfig(projectRoot: string): FullConfig {
  const projectConfigPath = join(projectRoot, '.orchestra', 'workflow.yaml');
  const globalConfigPath = getGlobalConfigPath();

  const projectConfig = loadRawConfig(projectConfigPath);
  const globalConfig = loadRawConfig(globalConfigPath);

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

export function parseWorkflowYaml(yamlContent: string): FullConfig {
  const parsed = YAML.parse(yamlContent);

  const steps = parsed.workflow?.steps;
  if (steps !== undefined && !Array.isArray(steps)) {
    throw new Error('workflow.steps must be an array');
  }

  const parsedAgents = parsed.agents && typeof parsed.agents === 'object'
    ? Object.entries(parsed.agents as Record<string, unknown>).reduce<Record<string, AgentConfig>>(
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
    )
    : {};

  const rawOrchestrator = parsed.orchestrator && typeof parsed.orchestrator === 'object'
    ? parsed.orchestrator as Record<string, unknown>
    : {};

  const toWorkflowStep = (rawStep: unknown): WorkflowConfig['steps'][number] => {
    const step = rawStep && typeof rawStep === 'object'
      ? rawStep as Record<string, unknown>
      : {};

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

  // Map YAML structure to our types
  // The YAML has: workflow.name, workflow.steps[], agents{}, orchestrator{}, error_handling{}
  return {
    workflow: {
      name: parsed.workflow?.name ?? 'default',
      steps: (parsed.workflow?.steps ?? []).map(toWorkflowStep),
      completion: parsed.workflow?.completion ?? { strategy: 'judge_approval', fallback: 'max_passes' },
    },
    agents: parsedAgents,
    orchestrator: {
      cli: typeof rawOrchestrator.cli === 'string' ? rawOrchestrator.cli : 'claude-code',
      model: typeof rawOrchestrator.model === 'string' ? rawOrchestrator.model : undefined,
    },
    errorHandling: {
      default: {
        retry: parsed.error_handling?.default?.retry ?? 1,
        fallback: parsed.error_handling?.default?.fallback ?? null,
        onExhausted: parsed.error_handling?.default?.on_exhausted ?? 'ask_user',
      },
    },
  };
}

export function getDefaultConfig(): FullConfig {
  return {
    workflow: {
      name: 'default',
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
