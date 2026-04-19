import type { AgentAdapter } from '../../adapters/types.js';
import { AgentId } from '../../workflow/agents.js';
import type { FullConfig } from '../../workflow/types.js';
import { resolveCaptainModel } from '../../workflow/config-codec.js';
import { logger } from '../../utils/logger.js';

interface AdapterLookup {
  get(name: string): AgentAdapter | undefined;
}

interface PreflightFailure {
  agentName: string;
  isCaptain: boolean;
  reason: string;
}

export function collectRequiredAgentNames(config: FullConfig): string[] {
  const required = new Set<string>();

  required.add(config.captain.cli);

  for (const configuredAgent of Object.keys(config.agents)) {
    required.add(configuredAgent);
  }

  for (const step of config.workflow.steps) {
    if (step.agent && step.agent !== AgentId.CAPTAIN) {
      required.add(step.agent);
    }
  }

  return [...required];
}

let crewCodexConfigWarned = false;

/**
 * Exported for tests only; lets a test reset the "warned once" latch so each
 * test observes the deprecation path cleanly.
 */
export function __resetPreflightWarningLatchForTest(): void {
  crewCodexConfigWarned = false;
}

/**
 * Emits the CREW_CODEX_CONFIG deprecation notice once per process if set.
 * The env var is honored nowhere after M0.5-2; we still read it so the
 * user learns the flag they set is ignored, rather than silently.
 */
export function checkCrewCodexConfigDeprecation(): void {
  const value = process.env.CREW_CODEX_CONFIG?.trim();
  if (!value) return;
  if (crewCodexConfigWarned) return;
  logger.warn(
    `[preflight] CREW_CODEX_CONFIG is set to "${value}" but is no longer honored. ` +
      'Per-session Codex overrides are now driven by the captain tool registry; ' +
      'remove the env var or migrate to `codex -p <profile>`.',
  );
  crewCodexConfigWarned = true;
}

/**
 * If the resolved captain model is set but the captain adapter doesn't
 * recognize it, log a warning and clear the value so the captain falls back
 * to its built-in default. Returns the pre-warn value for test assertions.
 */
export function enforceCaptainModelCompatibility(
  config: FullConfig,
  captainAdapter: AgentAdapter,
): { warnedModel?: string } {
  const resolved = resolveCaptainModel(config.captain);
  if (!resolved) return {};

  // Adapters without recognizesModel pass through unchanged.
  if (typeof captainAdapter.recognizesModel !== 'function') return {};

  if (captainAdapter.recognizesModel(resolved)) return {};

  logger.warn(
    `[preflight] captain.model "${resolved}" is not recognized by captain.cli "${config.captain.cli}". ` +
      'Falling back to the captain CLI default for this run.',
  );
  // Clear the effective model so downstream code sees undefined and lets
  // the adapter's default kick in.
  if (typeof config.captain.model === 'string') {
    config.captain.model = undefined;
  } else if (config.captain.model && typeof config.captain.model === 'object') {
    const key = config.captain.cli as keyof typeof config.captain.model;
    delete config.captain.model[key];
  }
  return { warnedModel: resolved };
}

export async function assertRequiredAgentsReady(
  registry: AdapterLookup,
  config: FullConfig,
): Promise<void> {
  checkCrewCodexConfigDeprecation();

  const captainAdapter = registry.get(config.captain.cli);
  if (captainAdapter) {
    enforceCaptainModelCompatibility(config, captainAdapter);
  }

  const requiredAgents = collectRequiredAgentNames(config);

  const failures = (
    await Promise.all(
      requiredAgents.map(async (agentName): Promise<PreflightFailure | null> => {
        const adapter = registry.get(agentName);
        const isCaptain = agentName === config.captain.cli;

        if (!adapter) {
          return {
            agentName,
            isCaptain,
            reason: 'adapter is not registered',
          };
        }

        try {
          const health = await adapter.healthCheck();
          if (!health.available) {
            return {
              agentName,
              isCaptain,
              reason: health.error
                ? `unavailable: ${health.error}`
                : 'unavailable',
            };
          }

          if (!health.authenticated) {
            return {
              agentName,
              isCaptain,
              reason: health.error
                ? `not authenticated: ${health.error}`
                : 'not authenticated',
            };
          }
        } catch (error: unknown) {
          return {
            agentName,
            isCaptain,
            reason: error instanceof Error
              ? `health check failed: ${error.message}`
              : `health check failed: ${String(error)}`,
          };
        }

        return null;
      }),
    )
  ).filter((failure): failure is PreflightFailure => failure !== null);

  if (failures.length === 0) return;

  const detailLines = failures.map((failure) => {
    const label = failure.isCaptain
      ? `${failure.agentName} (captain)`
      : failure.agentName;
    return `- ${label}: ${failure.reason}`;
  });

  throw new Error([
    'Preflight checks failed. Required adapters are not ready:',
    ...detailLines,
    'Run `crew status` and authenticate missing providers before running the workflow.',
  ].join('\n'));
}
