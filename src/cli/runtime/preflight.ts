import type { AgentAdapter } from '../../adapters/types.js';
import { AgentId } from '../../workflow/agents.js';
import type { FullConfig } from '../../workflow/types.js';

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

export async function assertRequiredAgentsReady(
  registry: AdapterLookup,
  config: FullConfig,
): Promise<void> {
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
