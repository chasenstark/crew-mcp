import { JudgmentRunner } from '../../captain/judgment-runner.js';
import { CaptainSession } from '../../captain/session.js';
import { ToolDispatcher } from '../../captain/tool-dispatcher.js';
import type { AgentRegistry } from '../../captain/events.js';
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
  session: CaptainSession;
  dispatcher: ToolDispatcher;
}

export function createRunner(
  projectRoot: string,
  options: {
    stateStore?: StateStore;
  } = {},
): CreateRunnerResult {
  const config = loadWorkflowConfig(projectRoot);
  const registry = createRegistryFromConfig(config.agents);
  const stateStore = options.stateStore ?? new StateStore(projectRoot);
  const worktreeManager = new WorktreeManager(projectRoot);
  const captainAdapter = registry.getOrThrow(config.captain.cli);

  // Sync preflight: mutate `config` for model compatibility + log any
  // CREW_CODEX_CONFIG deprecation notice *before* the runner captures
  // captainModel. Async health checks still live in assertRequiredAgentsReady.
  checkCrewCodexConfigDeprecation();
  enforceCaptainModelCompatibility(config, captainAdapter);

  // Hydrate the persistent captain session (M1.5-10). JudgmentRunner is the
  // only runner; linear-mode Pipeline was removed in M4. v5 state files
  // with `executionMode: 'linear'` fall through the migration reader's
  // LegacyExecutionModeError at load time.
  const agentModels = Object.fromEntries(
    Object.entries(config.agents).map(([name, agentConfig]) => [name, agentConfig.model]),
  );
  const captainModel = resolveCaptainModel(config.captain);

  const session = CaptainSession.loadOrCreate({
    projectRoot,
    cliVersionTag: undefined,
    toolSchemaHash: undefined,
  });
  const dispatcher = new ToolDispatcher();

  const runner: CrewRunner = new JudgmentRunner(
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
