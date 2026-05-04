/**
 * list_agents — agent-inventory discovery for the captain.
 *
 * Output shape: `{ agents: [{ name, strengths, effort?, adapter,
 * available, version?, authenticated?, quota? }] }`. `quota` is optional
 * and M3 omits it entirely — M4 can wire a `quotaProbe` callback when it
 * defines what a probe actually looks like (plan §5 Open Q #3).
 *
 * `strengths` and `effort` come from `effectiveAgentPrefs(adapter, prefs)`
 * — the user's `~/.crew/agents.json` override merged on top of adapter
 * defaults. Caller passes `agentPrefs` in (read once at serve startup or
 * per-call, depending on how stale the captain is willing to tolerate).
 *
 * Health-check discipline: failing adapters surface as `available: false`
 * with `error`, not as a thrown exception. The captain's decision to retry
 * via a different agent is preserved.
 */

import { z } from 'zod';
import type { AdapterRegistry } from '../../adapters/registry.js';
import type { AgentAdapter, EffortLevel } from '../../adapters/types.js';
import type { AgentPrefsMap } from '../../agent-prefs/store.js';
import { effectiveAgentPrefs } from '../../agent-prefs/store.js';

/**
 * Minimal registry surface list_agents needs. Both AdapterRegistry and
 * the minimal AgentRegistry (see src/captain/events.ts) can provide it —
 * keeping the dependency narrow here avoids pulling the full registry
 * shape into tool handlers that don't need it.
 */
export interface AgentListSource {
  listAvailable(): AgentAdapter[];
}

export const listAgentsInputSchema = z.object({}).passthrough();
export type ListAgentsInput = z.infer<typeof listAgentsInputSchema>;

export const LIST_AGENTS_DESCRIPTION =
  'Return the current agent inventory (name, strengths, effort, health, optional quota).';

export interface ListAgentsAgentEntry {
  readonly name: string;
  /**
   * Alternative ids the captain can pass as `agent_id` to run_agent /
   * continue_run; the registry resolves any alias to this adapter.
   * Empty (or omitted) when the adapter declares no aliases. Surfaced
   * so the captain knows the shorthand exists.
   */
  readonly aliases?: readonly string[];
  /**
   * Soft routing hints — adapter defaults merged with the user's
   * `~/.crew/agents.json` override. Captain reads as nudges (not
   * constraints) when picking between adapters.
   */
  readonly strengths: readonly string[];
  /**
   * Default effort level applied to dispatches that don't pass an
   * explicit `effort`. Omitted when the adapter has no native
   * reasoning-effort knob (currently gemini-cli, openai-compatible,
   * generic). Captain may override per-call via `run_agent`.
   */
  readonly effort?: EffortLevel;
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
  readonly registry: AdapterRegistry | AgentListSource;
  /**
   * Per-machine agent prefs snapshot. Caller (serve.ts) reads
   * `~/.crew/agents.json` and passes the result in. Omitting it means
   * "no overrides — adapter defaults win," which is the correct
   * behavior for tests + first-time users.
   */
  readonly agentPrefs?: AgentPrefsMap;
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

/**
 * Run the inventory probe. Resolves per-adapter healthChecks concurrently
 * so a slow adapter can't block the others. Captain gets a uniform
 * response shape; errors become `available: false` with `error`.
 */
export async function listAgents(ctx: ListAgentsContext): Promise<ListAgentsOutput> {
  const adapters = ctx.registry.listAvailable();
  // listAvailable() returns AgentAdapter[] on AdapterRegistry and is expected
  // to be present on any AgentListSource; the type narrowing above covers
  // the ambient case where a caller passes a plain object shape.
  const overrides = ctx.agentPrefs ?? {};
  const entries = await Promise.all(
    adapters.map(async (adapter): Promise<ListAgentsAgentEntry> => {
      const merged = effectiveAgentPrefs(
        adapter.name,
        { strengths: adapter.strengths, effort: adapter.defaultEffort },
        overrides,
      );
      const base = {
        name: adapter.name,
        // Only include `aliases` when the adapter declares any — keeps
        // payload tidy for the common case (most adapters have none).
        ...(adapter.aliases && adapter.aliases.length > 0
          ? { aliases: [...adapter.aliases] }
          : {}),
        strengths: [...(merged.strengths ?? [])],
        // `effort` only present when defined — adapters with no native
        // knob and no user override stay omitted, signalling honestly.
        ...(merged.effort ? { effort: merged.effort } : {}),
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
