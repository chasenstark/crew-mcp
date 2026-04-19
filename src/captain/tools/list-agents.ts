/**
 * list_agents — agent-inventory discovery for the captain.
 *
 * Output shape matches the plan: `{ agents: [{ name, capabilities, adapter,
 * available, version?, authenticated?, quota? }] }`. `quota` is optional and
 * M3 omits it entirely — M4 can wire a `quotaProbe` callback when it defines
 * what a probe actually looks like (plan §5 Open Q #3).
 *
 * Health-check discipline: failing adapters surface as `available: false`
 * with `error`, not as a thrown exception. The captain's decision to retry
 * via a different agent is preserved.
 */

import { z } from 'zod';
import type { ActionCatalogEntry } from '../action-server.js';
import type { AdapterRegistry } from '../../adapters/registry.js';

export const listAgentsInputSchema = z.object({}).passthrough();
export type ListAgentsInput = z.infer<typeof listAgentsInputSchema>;

export const LIST_AGENTS_DESCRIPTION =
  'Return the current agent inventory (name, capabilities, health, optional quota).';

export interface ListAgentsAgentEntry {
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly adapter: string;
  readonly available: boolean;
  readonly version?: string;
  readonly authenticated?: boolean;
  readonly error?: string;
  readonly quota?: {
    readonly remainingTokens?: number;
    readonly resetAt?: string;
  };
}

export interface ListAgentsOutput {
  readonly agents: readonly ListAgentsAgentEntry[];
}

export interface ListAgentsContext {
  readonly registry: AdapterRegistry;
  /**
   * Optional per-agent quota probe. M3 ships without a probe (returns
   * undefined for every agent); M4 can wire a real implementation. When
   * absent, the `quota` field is omitted entirely (not a zero-valued
   * object), matching the plan's "quota omitted when no probe is given".
   */
  readonly quotaProbe?: (agentName: string) => Promise<{
    remainingTokens?: number;
    resetAt?: string;
  } | undefined>;
}

export function buildListAgentsActionEntry(): ActionCatalogEntry {
  return {
    name: 'list_agents',
    description: LIST_AGENTS_DESCRIPTION,
    inputSchema: listAgentsInputSchema,
  };
}

/**
 * Run the inventory probe. Resolves per-adapter healthChecks concurrently
 * so a slow adapter can't block the others. Captain gets a uniform
 * response shape; errors become `available: false` with `error`.
 */
export async function listAgents(ctx: ListAgentsContext): Promise<ListAgentsOutput> {
  const adapters = ctx.registry.listAvailable();
  const entries = await Promise.all(
    adapters.map(async (adapter): Promise<ListAgentsAgentEntry> => {
      const base = {
        name: adapter.name,
        capabilities: [...adapter.capabilities],
        adapter: adapter.name,
      } as const;
      let health: Awaited<ReturnType<typeof adapter.healthCheck>>;
      try {
        health = await adapter.healthCheck();
      } catch (err: unknown) {
        return {
          ...base,
          available: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      let quota: { remainingTokens?: number; resetAt?: string } | undefined;
      if (ctx.quotaProbe) {
        try {
          quota = await ctx.quotaProbe(adapter.name);
        } catch {
          quota = undefined;
        }
      }
      return {
        ...base,
        available: health.available,
        version: health.version,
        authenticated: health.authenticated,
        error: health.error,
        quota,
      };
    }),
  );
  return { agents: entries };
}
