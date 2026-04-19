import { Pipeline, type AgentRegistry } from '../../captain/pipeline.js';
import { JudgmentRunner } from '../../captain/judgment-runner.js';
import { CaptainSession } from '../../captain/session.js';
import { ToolDispatcher } from '../../captain/tool-dispatcher.js';
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
  session: CaptainSession | undefined;
  dispatcher: ToolDispatcher | undefined;
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

  // Hydrate the persistent captain session (M1.5-10). Judgment-mode runners
  // always get one; linear-mode Pipeline doesn't use it (shim path remains
  // the slot-based API until pipeline.ts is deleted in M3).
  const agentModels = Object.fromEntries(
    Object.entries(config.agents).map(([name, agentConfig]) => [name, agentConfig.model]),
  );
  const captainModel = resolveCaptainModel(config.captain);

  let session: CaptainSession | undefined;
  let dispatcher: ToolDispatcher | undefined;

  if (mode === 'judgment') {
    session = CaptainSession.loadOrCreate({
      projectRoot,
      cliVersionTag: undefined,
      toolSchemaHash: undefined,
    });
    dispatcher = new ToolDispatcher();
  }

  const runner: CrewRunner = mode === 'judgment'
    ? new JudgmentRunner(
      captainAdapter,
      toAgentRegistry(registry),
      config.workflow,
      stateStore,
      worktreeManager,
      {
        captainModel,
        agentModels,
        session,
        dispatcher,
      },
    )
    : new Pipeline(
      captainAdapter,
      toAgentRegistry(registry),
      config.workflow,
      stateStore,
      worktreeManager,
      {
        captainModel,
        agentModels,
      },
    );

  return {
    runner,
    config,
    registry,
    stateStore,
    session,
    dispatcher,
  };
}
