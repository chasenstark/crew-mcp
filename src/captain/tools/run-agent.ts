/**
 * run_agent — the new work primitive. Delegates a bounded task to a named
 * subagent and returns the agent's TaskResult.
 *
 * Ownership model: this file owns the **schema** + **prompt builder** + a
 * handler-builder closure. The scheduler (judgment-runner.buildM3Scheduler,
 * M3-10a) is what actually translates a `mcp__crew__run_agent` call into a
 * DispatchedToolCall — because the scheduler holds the worktreeManager,
 * dispatcher, and registry refs that the handler needs. Having the schema
 * live in one place (this file + `catalog.ts`) and the scheduler in another
 * keeps the action-catalog stable while the dispatcher lifecycle stays
 * single-owner.
 *
 * Worktree lifecycle (Finding 8): mint `runId = randomUUID()` per call,
 * allocate `.crew/runs/<runId>/worktree/` via worktreeManager.createRunWorktree,
 * dispatch the task with that runId, and rely on the existing dispatcher
 * terminal-event listener (judgment-runner.ts:345-355) to call
 * `worktreeManager.cleanupByRunId`. The handler itself must NOT add a finally
 * cleanup — that would double-delete.
 */

import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { ActionCatalogEntry } from '../action-server.js';
import type { AdapterRegistry } from '../../adapters/registry.js';
import type { AgentAdapter, TaskResult } from '../../adapters/types.js';
import type { DispatchTaskContext } from '../tool-dispatcher.js';
import type { WorktreeManager } from '../../git/worktree.js';

export const runAgentInputSchema = z.object({
  agent_id: z.string().min(1),
  prompt: z.string().min(1),
  working_directory: z.string().optional(),
  model: z.string().optional(),
  capabilities_hint: z.array(z.string()).optional(),
});

export type RunAgentInput = z.infer<typeof runAgentInputSchema>;

export const RUN_AGENT_DESCRIPTION =
  'Delegate a bounded task to a named subagent. agent_id must come from list_agents; the prompt is what the agent sees verbatim. working_directory defaults to the run worktree.';

/**
 * The catalog entry. Used by code that wants the action-server shape
 * (M3-4's ToolCatalog consumes this via its canonical input schemas
 * directly; this builder is a convenience for tests + external wirings).
 */
export function buildRunAgentActionEntry(): ActionCatalogEntry {
  return {
    name: 'run_agent',
    description: RUN_AGENT_DESCRIPTION,
    inputSchema: runAgentInputSchema,
  };
}

export interface RunAgentHandlerContext {
  readonly registry: AdapterRegistry;
  readonly worktreeManager: WorktreeManager;
  /**
   * Captain-level model resolver: if the call leaves `model` undefined,
   * this returns the configured default for the named agent (workflow
   * role model, per-agent model, etc.). Returning undefined is fine —
   * the agent adapter then falls back to its own default.
   */
  readonly resolveModel?: (agentName: string) => string | undefined;
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
    const available = ctx.registry.listAvailable().map((a) => a.name).sort();
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
  const effectiveModel = input.model ?? ctx.resolveModel?.(input.agent_id);
  ctx.onStart?.({ agentName: input.agent_id, runId, worktreePath });

  return {
    kind: 'dispatched',
    runId,
    worktreePath,
    adapter,
    task: {
      toolCallId,
      toolName: 'run_agent' as const,
      runId,
      input: { ...input },
      run: async (taskCtx: DispatchTaskContext): Promise<TaskResult> => {
        return adapter.execute({
          prompt: input.prompt,
          context: {
            workingDirectory: effectiveWorkingDirectory,
          },
          constraints: {
            signal: taskCtx.signal,
            model: effectiveModel,
          },
          onOutput: taskCtx.onStream,
        });
      },
    },
  };
}
