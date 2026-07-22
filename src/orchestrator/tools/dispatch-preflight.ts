import type { AgentAdapter } from '../../adapters/types.js';
import { isHealthCheckCacheMissError } from '../../utils/health-check-cache.js';
import type { QuotaSnapshot } from './list-agents.js';

export interface DispatchPreflightRegistry {
  get(name: string): AgentAdapter | undefined;
}

export interface DispatchPreflightRefusal {
  readonly code: 'agent_unavailable' | 'agent_quota_limited';
  readonly message: string;
}

export interface DispatchPreflightResult {
  readonly refuse?: DispatchPreflightRefusal;
  readonly warnings: readonly string[];
}

export async function preflightAgentDispatch(args: {
  readonly registry: DispatchPreflightRegistry;
  readonly agentId: string;
  readonly quotaProbe?: (agentName: string) => Promise<QuotaSnapshot | undefined>;
  readonly dispatchAnyway?: boolean;
  readonly now?: () => Date;
}): Promise<DispatchPreflightResult> {
  const adapter = args.registry.get(args.agentId);
  if (!adapter) return { warnings: [] };

  const warnings: string[] = [];
  let refusal: DispatchPreflightRefusal | undefined;

  try {
    const health = await adapter.healthCheck({ cachedOnly: true });
    if (!health.available) {
      refusal = {
        code: 'agent_unavailable',
        message: `agent_unavailable: agent "${adapter.name}" is unavailable; ${
          health.error !== undefined
            ? `healthcheck: ${health.error}`
            : 'no healthcheck detail available'
        }.`,
      };
    }
  } catch (err) {
    if (!isHealthCheckCacheMissError(err)) {
      warnings.push(
        `agent_healthcheck_failed_open: health preflight for agent "${adapter.name}" failed: ${
          err instanceof Error ? err.message : String(err)
        }; dispatch was not blocked.`,
      );
    }
  }

  let quota: QuotaSnapshot | undefined;
  if (args.quotaProbe !== undefined) {
    try {
      quota = await args.quotaProbe(adapter.name);
    } catch (err) {
      warnings.push(
        `agent_quota_probe_failed_open: quota preflight for agent "${adapter.name}" failed: ${
          err instanceof Error ? err.message : String(err)
        }; dispatch was not blocked.`,
      );
    }
  }

  if (quota !== undefined && quota.state !== 'ok' && quota.state !== 'local_unmetered') {
    const staleAfter = quota.staleAfter === undefined ? undefined : Date.parse(quota.staleAfter);
    const stale = staleAfter !== undefined
      && Number.isFinite(staleAfter)
      && staleAfter <= (args.now?.() ?? new Date()).getTime();
    const uncertain = quota.confidence === 'low' || stale;
    if (quota.state === 'limited' && !uncertain && refusal === undefined) {
      refusal = {
        code: 'agent_quota_limited',
        message: `agent_quota_limited: agent "${adapter.name}" is quota limited; ${
          quota.resetAt !== undefined
            ? `resetAt=${quota.resetAt}`
            : 'no reset time reported'
        }.`,
      };
    } else if (quota.state !== 'limited' || uncertain) {
      const qualifiers = [
        ...(quota.state === 'limited' ? ['limited'] : []),
        ...(quota.state === 'near_limit' ? ['near limit'] : []),
        ...(quota.state === 'unknown' ? ['unknown'] : []),
        ...(quota.confidence === 'low' ? ['low confidence'] : []),
        ...(stale ? ['stale'] : []),
      ];
      warnings.push(
        `agent_quota_warning: agent "${adapter.name}" quota is ${qualifiers.join(', ')}; `
        + 'dispatch was not blocked.',
      );
    }
  }

  if (refusal !== undefined && args.dispatchAnyway === true) {
    warnings.push(`${refusal.message} dispatch_anyway:true was supplied after user approval.`);
    return { warnings };
  }
  return {
    ...(refusal !== undefined ? { refuse: refusal } : {}),
    warnings,
  };
}
