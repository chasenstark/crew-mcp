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
 * Worktree lifecycle: mint a human-readable `runId` (`<agent>-<task>-<hex>`,
 * see makeRunId) per call, allocate
 * `.crew/runs/<runId>/worktree/` via worktreeManager.createRunWorktree,
 * return the dispatch task. The host CLI is responsible for the worktree's
 * end-of-life through merge_run / discard_run.
 */

import { createHash, randomUUID } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { resolve, sep } from 'path';
import { z } from 'zod';
import type { AdapterRegistry } from '../../adapters/registry.js';
import type { AgentAdapter, EffortLevel, TaskResult } from '../../adapters/types.js';
import { clampEffortToSupported, resolveReviewDispatchMode } from '../../adapters/types.js';
import {
  isMergeable,
  ownsWorktree,
  runModeFromInput,
  RUN_MODES,
  type RunMode,
} from '../run-mode.js';
import { AgentId } from '../../workflow/agents.js';
import type { AgentPrefsMap } from '../../agent-prefs/store.js';
import { effectiveAgentPrefs } from '../../agent-prefs/store.js';
import type { DispatchTaskContext } from '../tool-dispatcher.js';
import type { DispatchTask } from '../tool-dispatcher.js';
import type { WorktreeManager } from '../../git/worktree.js';
import { peerMessageInputSchema } from '../peer-messages/schema.js';
import { logger } from '../../utils/logger.js';
import { dispatchRunAgentInternal } from '../dispatch-run-agent-internal.js';
import { makeRunId } from '../run-id.js';
import type { ToolCallReturn, ToolHandlerDeps, ToolRequestExtra, FullRunEnvelope } from './shared.js';
import {
  errorContent,
  fileUrlHref,
  mergeEnvelopeWarnings,
  nextStepSentence,
  progressNotifierFrom,
  requiredNextActionForRun,
  renderDispatchMarkdown,
  structuredRunEnvelope,
} from './shared.js';

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
  peer_messages: z.array(peerMessageInputSchema).max(10000).optional(),
  criteria_set_id: z.string().min(1).optional(),
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
   *
   * Legacy sugar for `run_mode: 'read_only'`. When both fields are
   * supplied they must agree; a disagreeing pair is rejected.
   */
  read_only: z.boolean().optional(),
  /**
   * Explicit lifecycle mode. `write` (default) allocates a mergeable
   * worktree; `read_only` runs in place (same as `read_only: true`);
   * `ephemeral_review` allocates a DISPOSABLE worktree for a
   * write-capable reviewer (agy): only its text findings are kept, the
   * run is never mergeable, `continue_run` follow-ups see a frozen
   * snapshot, and the worktree is reclaimed via discard_run / GC.
   * `ephemeral_review` requires an adapter with
   * `reviewDispatchMode: 'ephemeral-worktree'` and refuses a
   * caller-supplied `working_directory` (the worktree is crew-allocated).
   */
  run_mode: z.enum(RUN_MODES).optional(),
});

export type RunAgentInput = z.infer<typeof runAgentInputSchema>;

export const RUN_AGENT_DESCRIPTION =
  'Start a bounded subagent run. Optional peer_messages are prepended as untrusted context; optional confirmed criteria_set_id injects a non-droppable contract. model/effort override defaults and working_directory changes the start path. run_mode picks the lifecycle: write (default, mergeable worktree), read_only (in place, no worktree; read_only:true is legacy sugar), or ephemeral_review (disposable worktree for a write-capable reviewer like agy — findings only, never mergeable, frozen snapshot on continue). Returns an async dispatch envelope; spawn crew-wait on Claude Code. Do not block the turn long-polling get_run_status.';

export async function runAgentToolHandler(
  args: RunAgentInput,
  extra: ToolRequestExtra,
  deps: ToolHandlerDeps,
): Promise<ToolCallReturn> {
  const agentPrefs = deps.readAgentPrefs();
  const progress = progressNotifierFrom(extra, args.agent_id, deps.progressTokenSeen);
  let dispatchResult: Awaited<ReturnType<typeof dispatchRunAgentInternal>>;
  try {
    dispatchResult = await dispatchRunAgentInternal({
      input: args,
      ctx: {
        registry: deps.registry,
        worktreeManager: deps.worktreeManager,
        runStateStore: deps.runStateStore,
        agentPrefs,
        dispatcher: deps.dispatcher,
        crewHome: deps.crewHome,
        repoRoot: deps.runStateStore.repoRoot,
        projectRoot: deps.projectRoot,
        onTerminalPersisted: deps.onTerminalPersisted,
      },
      progress,
    });
  } catch (err) {
    return errorContent(err instanceof Error ? err.message : String(err));
  }

  const clientKind = deps.getClientKind();
  const summary = `Dispatched as "${dispatchResult.runId}". ${nextStepSentence(clientKind)}`;
  const eventsLogPath = deps.runStateStore.eventsLogPath(dispatchResult.runId);
  const requiredNextAction = requiredNextActionForRun(
    clientKind,
    deps.getCrewWaitCommand(),
    dispatchResult.runId,
  );
  const env: FullRunEnvelope = {
    run_id: dispatchResult.runId,
    agent_id: args.agent_id,
    worktree_path: dispatchResult.worktreePath,
    events_log_path: eventsLogPath,
    tail_command_path: dispatchResult.tailCommandPath,
    tail_command_url: fileUrlHref(dispatchResult.tailCommandPath),
    tail_url: dispatchResult.tailUrl,
    status: 'running',
    summary,
    files_changed: [],
    ...(requiredNextAction !== undefined ? { required_next_action: requiredNextAction } : {}),
    ...mergeEnvelopeWarnings(
      deps.runStateStore.read(dispatchResult.runId)?.warnings,
      dispatchResult.warnings,
    ),
  };
  return {
    content: [{ type: 'text' as const, text: renderDispatchMarkdown(env, clientKind) }],
    structuredContent: structuredRunEnvelope(env) as unknown as Record<string, unknown>,
  };
}

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
  readonly onStart?: (
    info: { agentName: string; runId: string; worktreePath: string },
  ) => void | Promise<void>;
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
   * Resolved lifecycle mode for this dispatch (see run-mode.ts). The
   * dispatch layer persists it into RunStateV1 so continue_run stays
   * sticky, and branches cleanup/merge behavior through the
   * `ownsWorktree`/`isMergeable` resolvers.
   */
  readonly runMode: RunMode;
  /**
   * True iff this dispatch skipped worktree allocation
   * (`runMode === 'read_only'`). Legacy convenience; new code should
   * route through `runMode` + the resolvers. Distinct from
   * `worktreePath === host repo root` because a read-only run can also
   * point at someone else's worktree.
   */
  readonly readOnly: boolean;
  readonly dispatchWarnings: readonly string[];
  readonly branchPointBefore?: ReadonlyMap<string, string>;
  readonly adapter: AgentAdapter;
  readonly toolCallId: string;
  readonly buildTask: (composedPrompt: string) => DispatchTask;
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

  const runId = makeRunId(input.agent_id, input.prompt);
  const modeResolution = runModeFromInput(input);
  if (!modeResolution.ok) {
    return { kind: 'error', message: modeResolution.message };
  }
  const runMode = modeResolution.mode;
  const readOnly = runMode === 'read_only';

  // Fail-closed read-only reject. Adapters that cannot enforce read-only by any
  // means (rejectsReadOnly) are refused the IN-PLACE read-only path at the plan
  // layer BEFORE allocation or dispatch, so the run never starts and the generic
  // read-only advisory below is never emitted (it would contradict the reject).
  // The reject message redirects to run_mode:'ephemeral_review' when the adapter
  // supports the disposable-worktree review route (agy); otherwise review/triage
  // routes to an adapter that can sandbox (codex) or to the host.
  if (readOnly && adapter.rejectsReadOnly === true) {
    return { kind: 'error', message: readOnlyRejectMessage(adapter.name, adapter) };
  }
  if (runMode === 'ephemeral_review') {
    // Only adapters that opted into the disposable-worktree review route may
    // be dispatched ephemeral — for everyone else the cheap in-place
    // read-only path is the honest review surface.
    if (resolveReviewDispatchMode(adapter) !== 'ephemeral-worktree') {
      return { kind: 'error', message: ephemeralReviewUnsupportedMessage(adapter.name) };
    }
    // The disposable worktree is always crew-allocated: a caller-supplied
    // working_directory is exactly the redirect vector the mode exists to
    // remove (consistent with the requiresCrewWorktree write-mode guard).
    if (input.working_directory !== undefined) {
      return {
        kind: 'error',
        message: ephemeralWorkingDirectoryRejectMessage(adapter.name, input.working_directory),
      };
    }
  }
  // Crew-owned-worktree enforcement (write mode). An adapter that an untrusted
  // prompt can steer to write outside its working directory (requiresCrewWorktree)
  // must run in its OWN crew-allocated worktree; refuse a caller-supplied
  // working_directory override, which is the redirect vector.
  if (runMode === 'write' && adapter.requiresCrewWorktree === true && input.working_directory !== undefined) {
    return { kind: 'error', message: crewWorktreeRejectMessage(adapter.name, input.working_directory) };
  }

  const dispatchWarnings = readOnly && adapter.enforcesReadOnly !== true
    ? [readOnlyAdvisoryWarning(adapter.name)]
    : [];
  let worktreePath: string;
  if (!ownsWorktree(runMode)) {
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
  const branchPointBefore =
    ownsWorktree(runMode)
    && effectiveWorkingDirectory === worktreePath
      ? await captureRunBranchPointSnapshot(ctx.worktreeManager, runId, worktreePath)
      : undefined;

  const effectiveModel = resolveEffectiveModel(adapter, input.model, ctx.agentPrefs);
  const effectiveEffort = resolveEffectiveEffort(adapter, input.effort, ctx.agentPrefs);
  const toolCallId = randomUUID();
  await ctx.onStart?.({ agentName: input.agent_id, runId, worktreePath });

  const buildTask = (composedPrompt: string): DispatchTask =>
    buildAdapterDispatchTask({
      toolCallId,
      runId,
      adapter,
      prompt: composedPrompt,
      effectiveWorkingDirectory,
      worktreePath,
      runMode,
      dispatchWarnings,
      branchPointBefore,
      effectiveModel,
      effectiveEffort,
      worktreeManager: ctx.worktreeManager,
      input: { ...input },
    });

  return {
    kind: 'dispatched',
    runId,
    worktreePath,
    runMode,
    readOnly,
    dispatchWarnings,
    branchPointBefore,
    adapter,
    toolCallId,
    buildTask,
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
 * Then clamp into `adapter.supportedEfforts` if declared, so a captain
 * passing `max` against codex doesn't have to know codex 0.130 rejects
 * `max` — we silently translate to the nearest supported level
 * (`xhigh` today) and log a debug breadcrumb. This keeps the canonical
 * five-level vocabulary in captain-facing surfaces (skill body, MCP
 * schema, agents.json) decoupled from per-CLI quirks.
 *
 * Exported for tests that want to verify the precedence + clamp
 * without driving the full dispatch.
 */
export function resolveEffectiveEffort(
  adapter: AgentAdapter,
  perCall: EffortLevel | undefined,
  prefs: AgentPrefsMap | undefined,
): EffortLevel | undefined {
  let resolved: EffortLevel | undefined;
  if (perCall) {
    resolved = perCall;
  } else {
    const merged = effectiveAgentPrefs(
      adapter.name,
      { effort: adapter.defaultEffort },
      prefs ?? {},
    );
    resolved = merged.effort;
  }
  if (resolved === undefined) return undefined;
  const clamped = clampEffortToSupported(resolved, adapter.supportedEfforts);
  if (clamped !== resolved) {
    logger.debug('[run-agent] clamped effort to adapter supported set', {
      agent: adapter.name,
      requested: resolved,
      clamped,
      supported: adapter.supportedEfforts,
    });
  }
  return clamped;
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
   * The run's lifecycle mode. Changes the post-run probe:
   *   - `read_only` (no worktree allocated): instead of enriching
   *     filesModified from the worktree, run a best-effort
   *     `git status --porcelain` in the working_directory and surface a
   *     `warnings` entry if the agent dirtied the tree against the
   *     prompt's contract.
   *   - `ephemeral_review`: suppress filesModified entirely (the
   *     worktree is disposable; its changes are never output) — at most
   *     a single pathless warning that the reviewer wrote.
   *   - `write`: enrich filesModified from worktree git status.
   */
  readonly runMode: RunMode;
  readonly dispatchWarnings?: readonly string[];
  readonly branchPointBefore?: ReadonlyMap<string, string>;
  readonly effectiveModel: string | undefined;
  /**
   * Effort already resolved upstream via `resolveEffectiveEffort`.
   * Threading it as a separate field (vs. picking it back out of
   * `input.effort`) keeps the per-machine prefs override visible to
   * the adapter.
   */
  readonly effectiveEffort?: EffortLevel;
  /**
   * Provider conversation/session id to RESUME on this dispatch. Threaded by
   * continue_run from the prior run's persisted sessionId so a stateful adapter
   * (agy) continues server-side context. Undefined for a fresh run_agent
   * dispatch (no prior session) and for adapters that don't resume.
   */
  readonly resumeSessionId?: string;
  readonly worktreeManager: WorktreeManager;
  readonly input: Record<string, unknown>;
}): DispatchTask {
  return {
    toolCallId: args.toolCallId,
    toolName: 'run_agent' as const,
    runId: args.runId,
    input: args.input,
    run: async (taskCtx: DispatchTaskContext): Promise<TaskResult> => {
      const readOnly = args.runMode === 'read_only';
      let writablePaths: readonly string[] | undefined;
      if (ownsWorktree(args.runMode)) {
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

      // Read-only contract probe — pre-snapshot. Captures the host
      // repo's existing dirty state BEFORE the agent runs so the
      // post-dispatch warning only fires on agent-introduced changes,
      // not on whatever the user was already editing. Without this,
      // every read-only dispatch against a dirty host repo (the common
      // case during development) returns a false-positive warning
      // listing files the agent never touched.
      const dirtyBefore = readOnly
        ? await capturePathSignatureSnapshot(
            args.effectiveWorkingDirectory,
            await detectDirtyTree(args.effectiveWorkingDirectory).catch(() => []),
          )
        : undefined;
      const result = await args.adapter.execute({
        prompt: args.prompt,
        context: {
          workingDirectory: args.effectiveWorkingDirectory,
        },
        constraints: {
          signal: taskCtx.signal,
          model: args.effectiveModel,
          effort: args.effectiveEffort,
          resumeSessionId: args.resumeSessionId,
          // ephemeral_review deliberately dispatches workspace-write: the
          // reviewer runs write-capable in its disposable worktree (agy would
          // hard-error on sandbox:'read-only'); containment is disposal.
          sandbox: readOnly ? 'read-only' : 'workspace-write',
          // Findings-only contract for disposable-worktree reviews — the
          // adapter (agy) swaps its operational preamble on this.
          reviewIntent: args.runMode === 'ephemeral_review' ? true : undefined,
          // Only auto-trust the workspace (gemini headless trust gate) when the
          // dir is crew-controlled — the host repo or a crew worktree, i.e. the
          // user's own code. Never force-trust an arbitrary caller-supplied
          // working_directory: trusting loads its project config/MCP/hooks/.env,
          // which run outside the read-only tool policy. See isCrewControlledPath.
          trustWorkspace:
            readOnly
            && args.worktreeManager.isCrewControlledPath(args.effectiveWorkingDirectory),
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

      return finalizeAdapterResult({
        result,
        dirtyBefore,
        runMode: args.runMode,
        dispatchWarnings: args.dispatchWarnings,
        effectiveWorkingDirectory: args.effectiveWorkingDirectory,
        worktreePath: args.worktreePath,
        branchPointBefore: args.branchPointBefore,
        worktreeManager: args.worktreeManager,
        runId: args.runId,
        adapterName: args.adapter.name,
      });
    },
  };
}

async function finalizeAdapterResult(args: {
  readonly result: TaskResult;
  readonly dirtyBefore: ReadonlyMap<string, string> | undefined;
  readonly runMode: RunMode;
  readonly dispatchWarnings: readonly string[] | undefined;
  readonly effectiveWorkingDirectory: string;
  readonly worktreePath: string;
  readonly branchPointBefore: ReadonlyMap<string, string> | undefined;
  readonly worktreeManager: WorktreeManager;
  readonly runId: string;
  readonly adapterName: string;
}): Promise<TaskResult> {
  const resultWithDispatchWarnings =
    args.dispatchWarnings && args.dispatchWarnings.length > 0
      ? { ...args.result, warnings: [...(args.result.warnings ?? []), ...args.dispatchWarnings] }
      : args.result;

  // ephemeral_review: filesModified is suppressed AT THE DATA LAYER, before
  // terminal persistence copies it into state.filesChanged and before any
  // reader sees it — for success, partial, AND error results. The worktree is
  // disposable; listing the reviewer's stray writes would invite treating them
  // as output. At most one pathless advisory when the reviewer did write
  // (best-effort probe against the dispatch-time branch-point signature so the
  // host's pre-existing dirty state, mirrored into the worktree at allocation,
  // doesn't false-positive).
  if (args.runMode === 'ephemeral_review') {
    const suppressed = { ...resultWithDispatchWarnings, filesModified: [] };
    try {
      const fromWorktree = await args.worktreeManager.getModifiedFilesByRun(args.runId);
      const before = args.branchPointBefore ?? new Map<string, string>();
      const after = await capturePathSignatureSnapshot(args.worktreePath, fromWorktree);
      const changed = fromWorktree.filter((path) => before.get(path) !== after.get(path));
      if (changed.length === 0 && resultWithDispatchWarnings.filesModified.length === 0) {
        return suppressed;
      }
      return {
        ...suppressed,
        warnings: [ephemeralReviewWriteNotice(), ...(suppressed.warnings ?? [])],
      };
    } catch {
      return suppressed;
    }
  }

  if (args.runMode === 'read_only') {
    // Best-effort: detect contract violations (the agent edited
    // despite being told not to) and surface as a warning. Never
    // fail the dispatch on probe errors — the run completed; the
    // probe is purely advisory.
    //
    // Compares bounded content signatures against the pre-dispatch
    // snapshot, so pre-existing host-repo dirt is ignored unless
    // the agent changes that already-dirty file during the run.
    try {
      const dirtyAfter = await detectDirtyTree(args.effectiveWorkingDirectory);
      const before = args.dirtyBefore ?? new Map<string, string>();
      const after = await capturePathSignatureSnapshot(args.effectiveWorkingDirectory, dirtyAfter);
      const changed = dirtyAfter.filter((path) => before.get(path) !== after.get(path));
      if (changed.length === 0) return resultWithDispatchWarnings;
      const warning =
        `Read-only run produced uncommitted changes in ${args.effectiveWorkingDirectory}: ` +
        `${changed.join(', ')}. Review with \`git status\` in that directory.`;
      const existing = Array.isArray(resultWithDispatchWarnings.warnings)
        ? resultWithDispatchWarnings.warnings
        : [];
      return { ...resultWithDispatchWarnings, warnings: [warning, ...existing] };
    } catch {
      return resultWithDispatchWarnings;
    }
  }

  // v2: enrich filesModified from worktree status when the adapter ran
  // inside its dedicated worktree. We do NOT merge — host CLI does that
  // explicitly via merge_run.
  if (args.effectiveWorkingDirectory !== args.worktreePath) {
    return resultWithDispatchWarnings;
  }
  try {
    const fromWorktree = await args.worktreeManager.getModifiedFilesByRun(args.runId);
    const before = args.branchPointBefore ?? new Map<string, string>();
    const after = await capturePathSignatureSnapshot(args.worktreePath, fromWorktree);
    const changedSinceDispatch = fromWorktree.filter((path) => before.get(path) !== after.get(path));
    if (changedSinceDispatch.length === 0) {
      return maybeWarnAgyScratchEscape(resultWithDispatchWarnings, args.adapterName);
    }
    const merged = Array.from(
      new Set([...resultWithDispatchWarnings.filesModified, ...changedSinceDispatch].filter((f) => f.trim().length > 0)),
    );
    return { ...resultWithDispatchWarnings, filesModified: merged };
  } catch {
    // Probing the worktree shouldn't fail the dispatch.
    return resultWithDispatchWarnings;
  }
}

/**
 * Past-tense write verbs an agy response uses when it believes it edited files.
 * Deliberately past/participle forms ("created", not "create") to avoid firing
 * on prose that merely describes an intended-but-skipped action.
 */
const AGY_WRITE_CLAIM_REGEX =
  /\b(created|wrote|modified|edited|updated|saved|added|deleted|removed|appended|generated)\b/i;

/**
 * agy-only backstop for the scratch-escape failure mode: agy can silently write
 * to its internal scratch dir instead of the crew worktree (see
 * withAgyWorkspacePreamble). The workspace-contract preamble makes that rare,
 * but it is prompt-level mitigation, not a sandbox — so when a WRITE-mode agy
 * run reports success, its output claims it wrote files, yet the worktree shows
 * ZERO changes, warn that the writes may have escaped to scratch rather than
 * letting the empty diff read as a clean no-op. Warning-only (not a failure):
 * a legitimately no-op run — inspection, "nothing to change" — must still
 * succeed, and false positives here cost only a cautionary note. Scoped to agy
 * so no other adapter's honest no-op run is second-guessed; the scratch dir is
 * deliberately NOT scanned (global, concurrent, weak attribution).
 */
function maybeWarnAgyScratchEscape(result: TaskResult, adapterName: string): TaskResult {
  if (adapterName !== AgentId.AGY) return result;
  if (result.status !== 'success') return result;
  if (!AGY_WRITE_CLAIM_REGEX.test(result.output ?? '')) return result;
  const warning =
    'agy reported a successful write task, but crew detected no changes in the run worktree. '
    + 'agy may have written to its internal scratch project instead of the worktree (this happens '
    + 'when it uses relative paths). Inspect ~/.gemini/antigravity-cli/scratch and re-run before '
    + 'trusting this result.';
  return { ...result, warnings: [warning, ...(result.warnings ?? [])] };
}

/**
 * Message for a fail-closed read-only reject (adapter.rejectsReadOnly). Used by
 * planRunAgent / continue_run when an adapter that cannot enforce read-only is
 * dispatched read-only. This is a terminal config refusal — the run never
 * starts — NOT the advisory below (which means "we'll run it anyway"). When the
 * adapter supports the disposable-worktree review route (agy), the message
 * redirects the captain to `run_mode: 'ephemeral_review'` instead of leaving
 * them stuck.
 */
export function readOnlyRejectMessage(
  adapterName: string,
  adapter?: Pick<AgentAdapter, 'reviewDispatchMode'>,
): string {
  const redirect =
    adapter !== undefined && resolveReviewDispatchMode(adapter) === 'ephemeral-worktree'
      ? ` For a review, dispatch it with run_mode: 'ephemeral_review' instead: it runs write-capable `
        + 'in a disposable crew worktree, only its text findings are kept, and the run is never mergeable.'
      : ' Route read-only review/triage to an agent with a real sandbox (codex) or to the host.';
  return `Agent "${adapterName}" cannot run read-only and crew refuses to dispatch it read-only: `
    + 'it has no enforceable read-only sandbox (no OS sandbox, no tool-deny policy), so a review/triage '
    + `prompt carrying untrusted content could make it write outside any boundary.${redirect} `
    + 'This is a configuration refusal, not a transient error — it will not be retried.';
}

/**
 * Message for an `ephemeral_review` dispatch to an adapter that has not opted
 * into the disposable-worktree review route. In-place read-only dispatch is
 * the honest (and cheaper) review surface for everyone else.
 */
export function ephemeralReviewUnsupportedMessage(adapterName: string): string {
  return `Agent "${adapterName}" does not support run_mode: 'ephemeral_review' `
    + "(its reviewDispatchMode is not 'ephemeral-worktree'). Dispatch it as a reviewer with "
    + "read_only: true instead — the disposable-worktree route exists only for agents that "
    + 'cannot honestly enforce read-only (agy).';
}

/**
 * Message for an `ephemeral_review` dispatch that supplies a
 * working_directory: the disposable worktree is always crew-allocated.
 */
export function ephemeralWorkingDirectoryRejectMessage(
  adapterName: string,
  workingDirectory: string,
): string {
  return `Agent "${adapterName}" runs ephemeral reviews only inside a crew-allocated disposable `
    + `worktree; refusing the working_directory override "${workingDirectory}". Omit `
    + 'working_directory — crew snapshots the host repo (including uncommitted changes) into the '
    + "review worktree automatically.";
}

/**
 * The single, deliberately pathless advisory attached when an ephemeral
 * reviewer modified its disposable worktree. Paths are never listed —
 * that would invite treating discarded writes as run output.
 */
export function ephemeralReviewWriteNotice(): string {
  return 'ephemeral_review note: the reviewer modified files in its disposable review worktree. '
    + 'Those changes are NOT part of the run output, will never be merged, and are discarded with '
    + 'the worktree (discard_run / GC). Only the text findings above survive.';
}

/**
 * Message for a write-mode crew-worktree reject (adapter.requiresCrewWorktree).
 * Used when a write dispatch supplies a working_directory override for an
 * adapter that must stay inside its own allocated worktree.
 */
export function crewWorktreeRejectMessage(adapterName: string, workingDirectory: string): string {
  return `Agent "${adapterName}" runs write-mode dispatches only inside its own crew-allocated worktree; `
    + `refusing the working_directory override "${workingDirectory}". Write dispatches always get a fresh `
    + 'isolated worktree — omit working_directory. (Use read_only with working_directory to point a '
    + 'reviewer at another run, but this agent does not support read-only.)';
}

export function readOnlyAdvisoryWarning(adapterName: string): string {
  if (adapterName === AgentId.GEMINI_CLI) {
    // Gemini self-enforces read-only at the TOOL level (a per-run `--policy`
    // deny on its write_file/replace/run_shell_command/save_memory tools). It
    // is not an OS filesystem sandbox, so the note states the real posture and
    // the dirty-tree probe still runs as a backstop. Two honest caveats: the
    // `--policy` deny is user-tier, so a central admin policy could override it;
    // and project `.gemini` config/MCP/hooks (loaded when the dir is trusted)
    // run outside the policy — crew only auto-trusts crew-controlled paths, so
    // do not point a read-only Gemini review at untrusted third-party code and
    // expect it to be sandboxed.
    return `read_only note: adapter "${adapterName}" enforces read-only at the tool level — `
      + 'crew dispatches it with a per-run Gemini policy that denies the write_file, replace, '
      + 'run_shell_command, and save_memory tools (blocks file writes and git commits). This is '
      + 'tool-level denial, not an OS filesystem sandbox: the dirty-tree probe still runs as a '
      + 'backstop, a central admin Gemini policy could override the deny, and project config/MCP/hooks '
      + 'loaded from a trusted dir run outside it — so use it on your own code, not untrusted trees.';
  }
  return `read_only advisory: adapter "${adapterName}" does not enforce a read-only filesystem sandbox. `
    + 'Crew will run it anyway for review/triage workflows, but the no-write contract relies on the prompt '
    + 'and the best-effort dirty-tree probe after the run.';
}

export async function captureRunBranchPointSnapshot(
  worktreeManager: WorktreeManager,
  runId: string,
  worktreePath: string,
): Promise<ReadonlyMap<string, string>> {
  return capturePathSignatureSnapshot(
    worktreePath,
    await worktreeManager.getModifiedFilesByRun(runId).catch(() => []),
  );
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

const SNAPSHOT_PATH_LIMIT = 1000;
const HASH_FILE_MAX_BYTES = 1024 * 1024;

async function capturePathSignatureSnapshot(
  workingDirectory: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const unique = Array.from(new Set(paths.filter((p) => p.trim().length > 0)))
    .sort()
    .slice(0, SNAPSHOT_PATH_LIMIT);
  for (const path of unique) {
    snapshot.set(path, pathSignature(workingDirectory, path));
  }
  return snapshot;
}

function pathSignature(workingDirectory: string, relativePath: string): string {
  const root = resolve(workingDirectory);
  const abs = resolve(root, relativePath);
  if (abs !== root && !abs.startsWith(`${root}${sep}`)) {
    return 'outside-worktree';
  }
  try {
    if (!existsSync(abs)) return 'missing';
    const st = statSync(abs);
    if (!st.isFile()) return `non-file:${st.size}:${Math.trunc(st.mtimeMs)}`;
    if (st.size > HASH_FILE_MAX_BYTES) {
      return `large-file:${st.size}:${Math.trunc(st.mtimeMs)}`;
    }
    const digest = createHash('sha256').update(readFileSync(abs)).digest('hex');
    return `sha256:${digest}`;
  } catch (err) {
    return `error:${err instanceof Error ? err.message : String(err)}`;
  }
}
