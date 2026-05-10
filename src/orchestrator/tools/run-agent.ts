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
 * The MCP server (`crew-mcp serve`, src/cli/commands/serve.ts) calls
 * `planRunAgent` to validate input + allocate a worktree, then dispatches
 * the task asynchronously through `ToolDispatcher` and returns a
 * `{ status: "running", run_id }` envelope immediately. The captain
 * surfaces terminal results out-of-band via `crew-wait` watchers (Claude
 * Code), `get_run_status` reads on later turns, or `list_runs` recovery.
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
  load?(name: string): Promise<AgentAdapter | undefined>;
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
  /**
   * Skip worktree allocation. Use for review/triage/Q&A dispatches
   * where the agent is not expected to write. `working_directory`
   * defaults to the host repo root when this is set; pass an explicit
   * path (e.g., another run's worktree) to point a reviewer at the
   * implementer's changes.
   *
   * Trade-off: there is no FS-level isolation. If the agent ignores
   * the prompt contract and writes, the changes land in
   * `working_directory`. The dispatch surfaces a `warnings` field on
   * the result if it detects post-run uncommitted changes.
   *
   * Sticky: a `continue_run` against a read-only run stays read-only.
   * `merge_run` errors with a clear reason; `discard_run` is
   * metadata-only.
   */
  read_only: z.boolean().optional(),
});

export type RunAgentInput = z.infer<typeof runAgentInputSchema>;

export const RUN_AGENT_DESCRIPTION =
  'Start a new subagent run for a bounded task; agent_id must come from list_agents and prompt is sent verbatim. Optional model and effort override the agent defaults, working_directory changes the starting path, and read_only=true skips worktree allocation for review/triage. Returns an async dispatch envelope with status:"running", run_id, worktree_path, and tail links; read terminal results later with get_run_status.';

export interface RunAgentHandlerContext {
  readonly registry: AdapterRegistry | RegistryForRunAgent;
  readonly worktreeManager: WorktreeManager;
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
  /**
   * The agent's CWD for this dispatch. For an editing run this is the
   * allocated worktree; for a read-only run it's `working_directory`
   * if the caller supplied one, else the host repo root. Read by
   * serve.ts to populate state.json's `worktreePath` field — yes, the
   * field name is a misnomer for read-only runs (no worktree exists),
   * but renaming it would mean a state-schema migration.
   */
  readonly worktreePath: string;
  /**
   * True iff this dispatch skipped worktree allocation. serve.ts uses
   * this to (a) propagate the bit into RunStateV1 so continue_run
   * stays sticky, (b) suppress merge-related branches in lifecycle
   * cleanup. Distinct from `worktreePath === host repo root` because
   * a read-only run can also point at someone else's worktree.
   */
  readonly readOnly: boolean;
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
  const adapter = await getRegistryAdapter(ctx.registry, input.agent_id);
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
  const readOnly = input.read_only === true;
  let worktreePath: string;
  if (readOnly) {
    // No FS isolation: working_directory is either what the caller
    // specified (e.g., another run's worktree for the reviewer
    // pattern) or the host repo root. The "worktreePath" stored in
    // RunStateV1 mirrors that — it is informational, not a worktree
    // we own.
    worktreePath = input.working_directory ?? ctx.worktreeManager.getProjectRoot();
  } else {
    try {
      worktreePath = await ctx.worktreeManager.createRunWorktree(runId);
    } catch (err: unknown) {
      return {
        kind: 'error',
        message: `Failed to allocate worktree for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const effectiveWorkingDirectory = input.working_directory ?? worktreePath;
  const effectiveModel = resolveEffectiveModel(adapter, input.model, ctx.agentPrefs);
  const effectiveEffort = resolveEffectiveEffort(adapter, input.effort, ctx.agentPrefs);
  ctx.onStart?.({ agentName: input.agent_id, runId, worktreePath });

  return {
    kind: 'dispatched',
    runId,
    worktreePath,
    readOnly,
    adapter,
    task: buildAdapterDispatchTask({
      toolCallId,
      runId,
      adapter,
      prompt: input.prompt,
      effectiveWorkingDirectory,
      worktreePath,
      readOnly,
      effectiveModel,
      effectiveEffort,
      worktreeManager: ctx.worktreeManager,
      input: { ...input },
    }),
  };
}

async function getRegistryAdapter(
  registry: AdapterRegistry | RegistryForRunAgent,
  name: string,
): Promise<AgentAdapter | undefined> {
  if (typeof registry.load === 'function') {
    return registry.load(name);
  }
  return registry.get(name);
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
 *   3. undefined → adapter doesn't pass --model and the CLI's own
 *      default (claude-code's ~/.claude.json, codex's config.toml,
 *      etc.) wins
 *
 * Exported for tests + symmetry with resolveEffectiveEffort.
 */
export function resolveEffectiveModel(
  adapter: AgentAdapter,
  perCall: string | undefined,
  prefs: AgentPrefsMap | undefined,
): string | undefined {
  if (perCall) return perCall;
  return prefs?.[adapter.name]?.model;
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
  /**
   * Whether the dispatch is read-only (no worktree allocated).
   * Changes the post-run probe: instead of enriching filesModified
   * from the worktree, run a best-effort `git status --porcelain` in
   * the working_directory and surface a `warnings` entry if the
   * agent dirtied the tree against the prompt's contract.
   */
  readonly readOnly?: boolean;
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
      let writablePaths: readonly string[] | undefined;
      if (!args.readOnly) {
        try {
          writablePaths = args.worktreeManager.getRunGitCommitWritablePaths(args.runId).paths;
        } catch (err) {
          return {
            output: '',
            filesModified: [],
            status: 'error',
            metadata: {},
            warnings: [
              `Failed to derive git writable paths for run ${args.runId}: ${err instanceof Error ? err.message : String(err)}`,
            ],
          };
        }
      }

      const result = await args.adapter.execute({
        prompt: args.prompt,
        context: {
          workingDirectory: args.effectiveWorkingDirectory,
        },
        constraints: {
          signal: taskCtx.signal,
          model: args.effectiveModel,
          effort: args.effectiveEffort,
          sandbox: args.readOnly ? 'read-only' : 'workspace-write',
          writablePaths,
          // Allow localhost egress so tests that hit a local DB or
          // devserver actually exercise the change. Without this,
          // Codex's workspace-write sandbox blocks connect() and the
          // run reports "tests passed" without having tested anything
          // that touches the network — verified failure mode 2026-05.
          // FS isolation still comes from the worktree (write-mode) +
          // the dirty-tree probe (read-only mode); enabling network
          // does not weaken either contract.
          networkAccess: true,
        },
        onOutput: taskCtx.onStream,
      });

      if (result.status === 'error') return result;

      if (args.readOnly) {
        // Best-effort: detect contract violations (the agent edited
        // despite being told not to) and surface as a warning. Never
        // fail the dispatch on probe errors — the run completed; the
        // probe is purely advisory.
        try {
          const dirtied = await detectDirtyTree(args.effectiveWorkingDirectory);
          if (dirtied.length === 0) return result;
          const warning =
            `Read-only run produced uncommitted changes in ${args.effectiveWorkingDirectory}: ` +
            `${dirtied.join(', ')}. Review with \`git status\` in that directory.`;
          const existing = Array.isArray(result.warnings) ? result.warnings : [];
          return { ...result, warnings: [...existing, warning] };
        } catch {
          return result;
        }
      }

      // v2: enrich filesModified from worktree status when the adapter ran
      // inside its dedicated worktree AND the run didn't error, unless the
      // adapter declares its terminal `filesModified` list authoritative. We
      // do NOT merge — host CLI does that explicitly via merge_run.
      if (args.effectiveWorkingDirectory !== args.worktreePath) {
        return result;
      }
      if (args.adapter.filesModifiedReliable === true) {
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

/**
 * Best-effort dirty-tree probe for read-only dispatches. Uses
 * `simple-git` so the call is cheap and matches the rest of the
 * codebase's git plumbing. Returns an empty array if the directory
 * isn't a git checkout (the agent had nothing to dirty in any
 * trackable way) or if status fails — the warning is purely
 * advisory.
 */
async function detectDirtyTree(workingDirectory: string): Promise<string[]> {
  // Lazy import to keep the planning path tree-shake-friendly.
  const { default: simpleGit } = await import('simple-git');
  try {
    const git = simpleGit(workingDirectory);
    const status = await git.status();
    const all = [
      ...status.modified,
      ...status.created,
      ...status.not_added,
      ...(status.deleted ?? []),
      ...(status.renamed ?? []).map((r) => r.to),
    ];
    return Array.from(new Set(all.filter((f) => f.length > 0)));
  } catch {
    return [];
  }
}
