/**
 * run_agent — the v2 work primitive. Delegates a bounded task to a named
 * subagent in an isolated git worktree and returns the agent's TaskResult.
 *
 * v2 contract (changed from v0.1):
 * - **No auto-merge.** v0.1 merged the worktree back into HEAD on success
 *   inside this handler. v2 leaves the worktree alive after the dispatch
 *   completes; the host CLI explicitly calls `merge_run` (M2) when the
 *   user approves. This is the safety boundary that keeps crew from
 *   silently mutating the user's branch.
 * - **No worktree cleanup here either.** `discard_run` (M2) and
 *   `merge_run` (M2, conditional on `defaults.cleanup_on_merge`) are the
 *   two paths that delete worktrees. A run that's neither merged nor
 *   discarded persists across crew-serve restarts.
 *
 * Ownership model: this file owns the **schema** + a pure **plan builder**.
 * The MCP server (`crew serve`, src/cli/commands/serve.ts) calls
 * `planRunAgent` to validate input + allocate a worktree, then dispatches
 * the task through `ToolDispatcher` and waits for the terminal event before
 * shaping the response envelope.
 *
 * Worktree lifecycle: mint `runId = randomUUID()` per call, allocate
 * `.crew/runs/<runId>/worktree/` via worktreeManager.createRunWorktree,
 * return the dispatch task. The host CLI is responsible for the worktree's
 * end-of-life through merge_run / discard_run.
 */

import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { AdapterRegistry } from '../../adapters/registry.js';
import type { AgentAdapter, EffortLevel, TaskResult } from '../../adapters/types.js';
import type { AgentPrefsMap } from '../../agent-prefs/store.js';
import { effectiveAgentPrefs } from '../../agent-prefs/store.js';
import type { DispatchTaskContext } from '../tool-dispatcher.js';
import type { WorktreeManager } from '../../git/worktree.js';

/**
 * Minimal registry surface for run_agent. Accepts either AdapterRegistry or
 * the minimal AgentRegistry shape (src/captain/events.ts) that exposes only
 * `get` + `list`.
 */
export interface RegistryForRunAgent {
  get(name: string): AgentAdapter | undefined;
  listAvailable?(): AgentAdapter[];
  list?(): { name: string; strengths: readonly string[] | string[] }[];
}

export const runAgentInputSchema = z.object({
  agent_id: z.string().min(1),
  prompt: z.string().min(1),
  working_directory: z.string().optional(),
  model: z.string().optional(),
  /**
   * Per-call reasoning effort override. Wins over the user's
   * agents.json default + adapter default. Adapters with no native
   * reasoning-effort knob (gemini-cli, generic) ignore the value and
   * log a debug breadcrumb. Vocabulary mirrors codex's
   * `model_reasoning_effort` set.
   */
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});

export type RunAgentInput = z.infer<typeof runAgentInputSchema>;

export const RUN_AGENT_DESCRIPTION =
  '**Primary work primitive.** Delegate a bounded task to a named subagent. agent_id must come from list_agents; write the agent\'s prompt inline — do NOT route through plan_tasks for single-task work. working_directory defaults to the run worktree.';

export interface RunAgentHandlerContext {
  readonly registry: AdapterRegistry | RegistryForRunAgent;
  readonly worktreeManager: WorktreeManager;
  /**
   * Captain-level model resolver: if the call leaves `model` undefined,
   * this returns the configured default for the named agent (workflow
   * role model, per-agent model, etc.). Returning undefined is fine —
   * the agent adapter then falls back to its own default.
   */
  readonly resolveModel?: (agentName: string) => string | undefined;
  /**
   * Snapshot of the per-machine agent prefs (`~/.crew/agents.json`).
   * Read once per dispatch by the caller (serve.ts) and passed in here
   * so `planRunAgent` stays pure — no hidden FS reads in a hot path,
   * tests inject directly. Omitted = no overrides; adapter defaults win.
   */
  readonly agentPrefs?: AgentPrefsMap;
  /**
   * Optional hook for tests or future UI. Fires immediately after a
   * runId+worktree is allocated so callers can display "Agent X is running"
   * indicators before the first streaming token.
   */
  readonly onStart?: (info: { agentName: string; runId: string; worktreePath: string }) => void;
}

export interface RunAgentDispatchPlan {
  readonly kind: 'dispatched';
  readonly runId: string;
  readonly worktreePath: string;
  readonly adapter: AgentAdapter;
  readonly task: {
    toolCallId: string;
    toolName: 'run_agent';
    runId: string;
    input: Record<string, unknown>;
    run: (ctx: DispatchTaskContext) => Promise<unknown>;
  };
}

export interface RunAgentErrorPlan {
  readonly kind: 'error';
  readonly message: string;
}

export type RunAgentPlan = RunAgentDispatchPlan | RunAgentErrorPlan;

/**
 * Resolve a run_agent call into either a dispatch plan or a synchronous
 * error. The scheduler calls this; on a dispatch plan it returns a
 * `DispatchedToolCall` to the session-loop, on an error plan it returns a
 * synchronous error tool_result.
 *
 * The returned task's `run()` returns the raw `TaskResult` — including
 * output + filesModified + status — so the captain sees exactly what the
 * subagent produced.
 */
export async function planRunAgent(
  input: RunAgentInput,
  toolCallId: string,
  ctx: RunAgentHandlerContext,
): Promise<RunAgentPlan> {
  const adapter = ctx.registry.get(input.agent_id);
  if (!adapter) {
    const reg = ctx.registry as { listAvailable?: () => AgentAdapter[]; list?: () => Array<{ name: string }> };
    const fromListAvailable =
      typeof reg.listAvailable === 'function'
        ? reg.listAvailable().map((a) => a.name)
        : undefined;
    const fromList =
      typeof reg.list === 'function'
        ? reg.list().map((a) => a.name)
        : undefined;
    const available = (fromListAvailable ?? fromList ?? []).slice().sort();
    return {
      kind: 'error',
      message:
        `Unknown agent_id "${input.agent_id}". Available agents: ${available.join(', ') || '(none registered)'}`,
    };
  }

  const runId = randomUUID();
  let worktreePath: string;
  try {
    worktreePath = await ctx.worktreeManager.createRunWorktree(runId);
  } catch (err: unknown) {
    return {
      kind: 'error',
      message: `Failed to allocate worktree for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const effectiveWorkingDirectory = input.working_directory ?? worktreePath;
  const effectiveModel = resolveEffectiveModel(adapter, input.model, ctx.agentPrefs, ctx.resolveModel);
  const effectiveEffort = resolveEffectiveEffort(adapter, input.effort, ctx.agentPrefs);
  ctx.onStart?.({ agentName: input.agent_id, runId, worktreePath });

  return {
    kind: 'dispatched',
    runId,
    worktreePath,
    adapter,
    task: buildAdapterDispatchTask({
      toolCallId,
      runId,
      adapter,
      prompt: input.prompt,
      effectiveWorkingDirectory,
      worktreePath,
      effectiveModel,
      effectiveEffort,
      worktreeManager: ctx.worktreeManager,
      input: { ...input },
    }),
  };
}

/**
 * Resolve the effort that actually goes to the adapter:
 *   1. per-call override (input.effort)
 *   2. user's agents.json override for this agent
 *   3. adapter's defaultEffort
 *   4. undefined (adapter has no native effort concept)
 *
 * Exported for tests that want to verify the precedence without
 * driving the full dispatch.
 */
export function resolveEffectiveEffort(
  adapter: AgentAdapter,
  perCall: EffortLevel | undefined,
  prefs: AgentPrefsMap | undefined,
): EffortLevel | undefined {
  if (perCall) return perCall;
  const merged = effectiveAgentPrefs(
    adapter.name,
    { effort: adapter.defaultEffort },
    prefs ?? {},
  );
  return merged.effort;
}

/**
 * Resolve the model that actually goes to the adapter:
 *   1. per-call override (input.model)
 *   2. user's agents.json override for this agent
 *   3. legacy ctx.resolveModel hook (vestigial v1; serve.ts doesn't
 *      inject it, but kept so workflow-config-driven setups can wire
 *      a resolver if they want)
 *   4. undefined → adapter doesn't pass --model and the CLI's own
 *      default (claude-code's ~/.claude.json, codex's config.toml,
 *      etc.) wins
 *
 * Exported for tests + symmetry with resolveEffectiveEffort.
 */
export function resolveEffectiveModel(
  adapter: AgentAdapter,
  perCall: string | undefined,
  prefs: AgentPrefsMap | undefined,
  resolveModel?: (agentName: string) => string | undefined,
): string | undefined {
  if (perCall) return perCall;
  const fromPrefs = prefs?.[adapter.name]?.model;
  if (fromPrefs) return fromPrefs;
  return resolveModel?.(adapter.name);
}

/**
 * Build a dispatch task that drives the adapter against an existing worktree
 * and returns the adapter's TaskResult enriched with filesModified discovered
 * from the worktree status. Used by `planRunAgent` (fresh runs) and by
 * `continue_run` in serve.ts (reusing an existing worktree).
 *
 * No merge, no cleanup — v2's host CLI owns worktree lifecycle.
 */
export function buildAdapterDispatchTask(args: {
  readonly toolCallId: string;
  readonly runId: string;
  readonly adapter: AgentAdapter;
  readonly prompt: string;
  readonly effectiveWorkingDirectory: string;
  readonly worktreePath: string;
  readonly effectiveModel: string | undefined;
  /**
   * Effort already resolved upstream via `resolveEffectiveEffort`.
   * Threading it as a separate field (vs. picking it back out of
   * `input.effort`) keeps the per-machine prefs override visible to
   * the adapter.
   */
  readonly effectiveEffort?: EffortLevel;
  readonly worktreeManager: WorktreeManager;
  readonly input: Record<string, unknown>;
}): RunAgentDispatchPlan['task'] {
  return {
    toolCallId: args.toolCallId,
    toolName: 'run_agent' as const,
    runId: args.runId,
    input: args.input,
    run: async (taskCtx: DispatchTaskContext): Promise<TaskResult> => {
      const result = await args.adapter.execute({
        prompt: args.prompt,
        context: {
          workingDirectory: args.effectiveWorkingDirectory,
        },
        constraints: {
          signal: taskCtx.signal,
          model: args.effectiveModel,
          effort: args.effectiveEffort,
        },
        onOutput: taskCtx.onStream,
      });

      // v2: enrich filesModified from worktree status when the adapter ran
      // inside its dedicated worktree AND the run didn't error. We do NOT
      // merge — host CLI does that explicitly via merge_run.
      if (result.status === 'error' || args.effectiveWorkingDirectory !== args.worktreePath) {
        return result;
      }
      try {
        const fromWorktree = await args.worktreeManager.getModifiedFilesByRun(args.runId);
        if (fromWorktree.length === 0) return result;
        const merged = Array.from(
          new Set([...result.filesModified, ...fromWorktree].filter((f) => f.trim().length > 0)),
        );
        return { ...result, filesModified: merged };
      } catch {
        // Probing the worktree shouldn't fail the dispatch.
        return result;
      }
    },
  };
}
