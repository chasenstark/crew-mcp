/**
 * list_agents — agent-inventory discovery for the captain.
 *
 * Output shape: `{ agents: [{ name, useWhen?, strengths, effort?, adapter,
 * available, version?, authenticated?, quota? }] }`. `quota` is optional
 * and omitted entirely when no `quotaProbe` is wired or the probe cannot
 * return a snapshot. When present, quota is a snapshot with state,
 * confidence, source, checkedAt, and optional provider-specific details.
 *
 * `useWhen`, `strengths`, and `effort` come from `effectiveAgentPrefs(adapter, prefs)`
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
import { logBestEffortFailure } from '../../utils/best-effort.js';
import type { ToolCallReturn, ToolHandlerDeps } from './shared.js';
import { jsonContent } from './shared.js';

/**
 * Minimal registry surface list_agents needs — keeping the dependency
 * narrow here avoids pulling the full AdapterRegistry shape into tool
 * handlers that don't need it.
 */
export interface AgentListSource {
  listAvailable(): AgentAdapter[];
  loadAll?(): Promise<AgentAdapter[]>;
}

export const listAgentsInputSchema = z.object({
  refresh: z.boolean().optional(),
}).passthrough();
export type ListAgentsInput = z.infer<typeof listAgentsInputSchema>;

export const LIST_AGENTS_DESCRIPTION =
  'List configured agents before dispatching so the caller can choose a valid agent_id. Takes no required input and returns agents with name, aliases, useWhen routing guidance, strengths, default effort/model, adapter, availability, health details, and optional quota snapshots with state, confidence, and source when a quotaProbe is wired. Quota is omitted entirely when no probe is wired or no snapshot is available. Unavailable agents are included with available:false and an error instead of throwing.';

export type QuotaState =
  | 'ok'
  | 'near_limit'
  | 'limited'
  | 'unknown'
  | 'local_unmetered';

export interface QuotaSnapshot {
  readonly state: QuotaState;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly source:
    | 'provider'
    | 'stream-cache'
    | 'statusline-cache'
    | 'local-ledger'
    | 'health-only';
  readonly checkedAt: string; // ISO timestamp
  readonly staleAfter?: string;
  readonly usedPercent?: number;
  readonly remainingTokens?: number;
  readonly remainingRequests?: number;
  readonly resetAt?: string;
  readonly retryAfterSeconds?: number;
  readonly message?: string;
}

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
   * Primary routing guidance — adapter default merged with the user's
   * `~/.crew/agents.json` override. Captain reads as the first nudge,
   * not as an enforced eligibility filter.
   */
  readonly useWhen?: string;
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
  /**
   * Default model applied to dispatches that don't pass an explicit
   * `model`. Omitted when the user hasn't expressed a per-machine
   * preference — in that case the adapter's CLI picks its own
   * default. Captain may override per-call via `run_agent`.
   */
  readonly model?: string;
  readonly adapter: string;
  readonly available: boolean;
  readonly version?: string;
  readonly authenticated?: boolean;
  readonly error?: string;
  readonly quota?: QuotaSnapshot;
}

export interface ListAgentsOutput {
  readonly agents: readonly ListAgentsAgentEntry[];
}

export interface ListAgentsContext {
  readonly registry: AdapterRegistry | AgentListSource;
  /**
   * When true, bypass adapter-side in-process health-check caches for this
   * inventory call. Useful immediately after installing/logging into a CLI.
   */
  readonly refresh?: boolean;
  /**
   * Per-machine agent prefs snapshot. Caller (serve.ts) reads
   * `~/.crew/agents.json` and passes the result in. Omitting it means
   * "no overrides — adapter defaults win," which is the correct
   * behavior for tests + first-time users.
   */
  readonly agentPrefs?: AgentPrefsMap;
  /**
   * Optional per-agent quota probe. When present, it may return a
   * QuotaSnapshot with state, confidence, source, checkedAt, and optional
   * limit details. When absent, undefined, or failing, the `quota` field is
   * omitted entirely (not a zero-valued object).
   */
  readonly quotaProbe?: (agentName: string) => Promise<QuotaSnapshot | undefined>;
}

export async function listAgentsToolHandler(
  args: ListAgentsInput,
  deps: Pick<ToolHandlerDeps, 'registry' | 'readAgentPrefs' | 'quotaProbe' | 'clearQuotaCache'>,
): Promise<ToolCallReturn> {
  if (args.refresh === true && deps.clearQuotaCache) {
    try {
      deps.clearQuotaCache();
    } catch (err) {
      logBestEffortFailure('quota-cache.clear', err);
    }
  }
  const agentPrefs = deps.readAgentPrefs();
  const out = await listAgents({
    registry: deps.registry,
    agentPrefs,
    refresh: args.refresh,
    quotaProbe: deps.quotaProbe,
  });
  return jsonContent(out);
}

/**
 * Run the inventory probe. Resolves per-adapter healthChecks concurrently
 * so a slow adapter can't block the others. Captain gets a uniform
 * response shape; errors become `available: false` with `error`.
 */
export async function listAgents(ctx: ListAgentsContext): Promise<ListAgentsOutput> {
  if (typeof ctx.registry.loadAll === 'function') {
    await ctx.registry.loadAll();
  }
  const adapters = ctx.registry.listAvailable();
  // listAvailable() returns AgentAdapter[] on AdapterRegistry and is expected
  // to be present on any AgentListSource; the type narrowing above covers
  // the ambient case where a caller passes a plain object shape.
  const overrides = ctx.agentPrefs ?? {};
  const entries = await Promise.all(
    adapters.map(async (adapter): Promise<ListAgentsAgentEntry> => {
      const merged = effectiveAgentPrefs(
        adapter.name,
        {
          useWhen: adapter.useWhen,
          strengths: adapter.strengths,
          effort: adapter.defaultEffort,
        },
        overrides,
      );
      const base = {
        name: adapter.name,
        // Only include `aliases` when the adapter declares any — keeps
        // payload tidy for the common case (most adapters have none).
        ...(adapter.aliases && adapter.aliases.length > 0
          ? { aliases: [...adapter.aliases] }
          : {}),
        ...(merged.useWhen ? { useWhen: merged.useWhen } : {}),
        strengths: [...(merged.strengths ?? [])],
        // `effort` only present when defined — adapters with no native
        // knob and no user override stay omitted, signalling honestly.
        ...(merged.effort ? { effort: merged.effort } : {}),
        // `model` only present when the user has set a per-machine
        // override. Absence = "the adapter's CLI picks."
        ...(merged.model ? { model: merged.model } : {}),
        adapter: adapter.name,
      } as const;
      let health: Awaited<ReturnType<typeof adapter.healthCheck>>;
      try {
        health = await adapter.healthCheck({ refresh: ctx.refresh === true });
      } catch (err: unknown) {
        return {
          ...base,
          available: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      let quota: QuotaSnapshot | undefined;
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
        ...(quota !== undefined ? { quota } : {}),
      };
    }),
  );
  return { agents: entries };
}
