import { Pipeline, type AgentRegistry } from '../../captain/pipeline.js';
import { JudgmentRunner } from '../../captain/judgment-runner.js';
import { AdapterRegistry, createRegistryFromConfig } from '../../adapters/registry.js';
import { StateStore } from '../../state/store.js';
import { WorktreeManager } from '../../git/worktree.js';
import { loadWorkflowConfig } from '../../workflow/loader.js';
import { resolveCaptainModel } from '../../workflow/config-codec.js';
import {
  checkCrewCodexConfigDeprecation,
  enforceCaptainModelCompatibility,
} from './preflight.js';
import type { CrewRunner } from '../../captain/runner.js';

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
  runner: CrewRunner;
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
  const captainAdapter = registry.getOrThrow(config.captain.cli);
  const mode = options.mode ?? config.workflow.execution?.mode ?? 'judgment';

  // Sync preflight: mutate `config` for model compatibility + log any
  // CREW_CODEX_CONFIG deprecation notice *before* the runner captures
  // captainModel. Async health checks still live in assertRequiredAgentsReady.
  checkCrewCodexConfigDeprecation();
  enforceCaptainModelCompatibility(config, captainAdapter);

  const runner: CrewRunner = mode === 'judgment'
    ? new JudgmentRunner(
      captainAdapter,
      toAgentRegistry(registry),
      config.workflow,
      stateStore,
      worktreeManager,
      {
        captainModel: resolveCaptainModel(config.captain),
        agentModels: Object.fromEntries(
          Object.entries(config.agents).map(([name, agentConfig]) => [name, agentConfig.model]),
        ),
      },
    )
    : new Pipeline(
      captainAdapter,
      toAgentRegistry(registry),
      config.workflow,
      stateStore,
      worktreeManager,
      {
        captainModel: resolveCaptainModel(config.captain),
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
