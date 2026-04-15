import { Pipeline, type AgentRegistry } from '../../orchestrator/pipeline.js';
import { JudgmentRunner } from '../../orchestrator/judgment-runner.js';
import { AdapterRegistry, createRegistryFromConfig } from '../../adapters/registry.js';
import { StateStore } from '../../state/store.js';
import { WorktreeManager } from '../../git/worktree.js';
import { loadWorkflowConfig } from '../../workflow/loader.js';
import type { OrchestrationRunner } from '../../orchestrator/runner.js';

export function toAgentRegistry(registry: AdapterRegistry): AgentRegistry {
  return {
    get: (name: string) => registry.get(name),
    list: () =>
      registry.listAvailable().map((a) => ({
        name: a.name,
        capabilities: a.capabilities as string[],
      })),
  };
}

export interface CreateRunnerResult {
  runner: OrchestrationRunner;
  config: ReturnType<typeof loadWorkflowConfig>;
  registry: AdapterRegistry;
  stateStore: StateStore;
}

export function createRunner(
  projectRoot: string,
  options: {
    stateStore?: StateStore;
    mode?: 'linear' | 'judgment';
  } = {},
): CreateRunnerResult {
  const config = loadWorkflowConfig(projectRoot);
  const registry = createRegistryFromConfig(config.agents);
  const stateStore = options.stateStore ?? new StateStore(projectRoot);
  const worktreeManager = new WorktreeManager(projectRoot);
  const orchestratorAdapter = registry.getOrThrow(config.orchestrator.cli);
  const mode = options.mode ?? config.workflow.execution?.mode ?? 'linear';

  const runner: OrchestrationRunner = mode === 'judgment'
    ? new JudgmentRunner(
      orchestratorAdapter,
      toAgentRegistry(registry),
      config.workflow,
      stateStore,
      worktreeManager,
      {
        orchestratorModel: config.orchestrator.model,
        agentModels: Object.fromEntries(
          Object.entries(config.agents).map(([name, agentConfig]) => [name, agentConfig.model]),
        ),
      },
    )
    : new Pipeline(
      orchestratorAdapter,
      toAgentRegistry(registry),
      config.workflow,
      stateStore,
      worktreeManager,
      {
        orchestratorModel: config.orchestrator.model,
        agentModels: Object.fromEntries(
          Object.entries(config.agents).map(([name, agentConfig]) => [name, agentConfig.model]),
        ),
      },
    );

  return {
    runner,
    config,
    registry,
    stateStore,
  };
}
