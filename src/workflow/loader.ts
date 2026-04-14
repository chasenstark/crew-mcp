import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import YAML from 'yaml';
import type { FullConfig, WorkflowConfig } from './types.js';

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
  return {
    workflow: {
      name: override.workflow.name ?? base.workflow.name,
      steps: override.workflow.steps.length > 0
        ? override.workflow.steps
        : base.workflow.steps,
      completion: override.workflow.completion ?? base.workflow.completion,
    },
    agents: {
      ...base.agents,
      ...override.agents,
    },
    orchestrator: override.orchestrator ?? base.orchestrator,
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

  // Map YAML structure to our types
  // The YAML has: workflow.name, workflow.steps[], agents{}, orchestrator{}, error_handling{}
  return {
    workflow: {
      name: parsed.workflow?.name ?? 'default',
      steps: (parsed.workflow?.steps ?? []).map((s: any) => ({
        role: s.role,
        agent: s.agent,
        action: s.action,
        maxPasses: s.max_passes,
        condition: s.condition,
        criteria: s.criteria,
      })),
      completion: parsed.workflow?.completion ?? { strategy: 'judge_approval', fallback: 'max_passes' },
    },
    agents: parsed.agents ?? {},
    orchestrator: parsed.orchestrator ?? { cli: 'claude-code' },
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
      'claude-code': { adapter: 'claude-code', auth: 'subscription', strengths: ['implementation', 'refactoring', 'TypeScript', 'React'] },
      'codex': { adapter: 'codex', auth: 'subscription', strengths: ['review', 'testing', 'Python', 'security'] },
    },
    orchestrator: { cli: 'claude-code' },
    errorHandling: {
      default: { retry: 1, fallback: null, onExhausted: 'ask_user' },
    },
  };
}
