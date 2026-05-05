// `crew-mcp serve` — the v2 stdio MCP server entry point.
//
// The host CLI (Claude Code / Codex / Gemini) spawns this command at session
// start via its MCP config block. We expose v2's full 6-tool surface over
// stdio:
//
//   list_agents      — synchronous probe of the agent registry
//   run_agent        — dispatch into a fresh worktree (block-and-stream
//                      with 60s async-fallback)
//   continue_run     — re-invoke the agent in an existing worktree
//   merge_run        — merge a worktree into the host's HEAD (the only
//                      mutating tool; host CLI must confirm with user)
//   discard_run      — abandon a worktree without merging
//   get_run_status   — poll a run's state.json + tail of events.log
//
// Logging discipline: stdout is reserved for the MCP wire protocol. The
// project's logger (src/utils/logger.ts) emits to stderr via console.error,
// which is safe; do NOT introduce any console.log() calls in the hot path.

import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { AdapterRegistry } from '../../adapters/registry.js';
import { createBuiltinRegistry } from '../../adapters/registry.js';
import type { TaskResult } from '../../adapters/types.js';
import { WorktreeManager } from '../../git/worktree.js';
import { ToolDispatcher } from '../../orchestrator/tool-dispatcher.js';
import { RunStateStore, type RunStateV1 } from '../../orchestrator/run-state.js';
import {
  listAgents,
  LIST_AGENTS_DESCRIPTION,
} from '../../orchestrator/tools/list-agents.js';
import {
  buildAdapterDispatchTask,
  planRunAgent,
  resolveEffectiveEffort,
  resolveEffectiveModel,
  runAgentInputSchema,
  RUN_AGENT_DESCRIPTION,
} from '../../orchestrator/tools/run-agent.js';
import {
  continueRunInputSchema,
  CONTINUE_RUN_DESCRIPTION,
} from '../../orchestrator/tools/continue-run.js';
import {
  mergeRunInputSchema,
  MERGE_RUN_DESCRIPTION,
} from '../../orchestrator/tools/merge-run.js';
import {
  cancelRunInputSchema,
  CANCEL_RUN_DESCRIPTION,
} from '../../orchestrator/tools/cancel-run.js';
import {
  discardRunInputSchema,
  DISCARD_RUN_DESCRIPTION,
} from '../../orchestrator/tools/discard-run.js';
import {
  getRunStatusInputSchema,
  GET_RUN_STATUS_DESCRIPTION,
} from '../../orchestrator/tools/get-run-status.js';
import { readAgentPrefsFile } from '../../agent-prefs/store.js';
import { resolveCrewHome } from '../../utils/crew-home.js';
import { logger } from '../../utils/logger.js';

export const SERVE_VERSION = '0.2.0-dev';

/**
 * If a dispatch exceeds this many milliseconds, run_agent / continue_run
 * return early with `{ status: 'running', run_id }` and the host CLI is
 * expected to poll via get_run_status. The dispatch keeps running in
 * the background and writes its terminal state to state.json regardless.
 *
 * 60s default — short enough that hosts which don't surface
 * `notifications/progress` to the user (observed: codex CLI as of
 * 2026-05) don't sit silent for minutes. Captain receives a fast
 * `status: "running"` envelope with a run_id and polls
 * `get_run_status` to surface the events.log tail; the user sees
 * activity even without progress streaming.
 *
 * The previous 5-minute default optimized for "single synchronous
 * return with full result" but turned a 2-minute Codex run into a UX
 * dead-zone — see commit message of the 60s change for the field
 * report. Hosts that DO support progress (Claude Code) keep working
 * the same; the live stream still flows, just inside a shorter block.
 */
export const ASYNC_FALLBACK_MS = 60_000;

export interface ServeOptions {
  /**
   * Test seam: override the working directory the worktree manager roots
   * itself at. Defaults to `process.cwd()`, which in production is the host
   * CLI's invocation directory (almost always the user's repo root).
   */
  cwd?: string;

  /**
   * Test seam: inject a pre-built adapter registry. Defaults to the built-in
   * registry (claude-code, codex, gemini). M3 swaps this for a registry
   * loaded from `~/.crew/agents.yaml`.
   */
  registry?: AdapterRegistry;

  /**
   * Test seam: inject a pre-constructed worktree manager. Useful when a test
   * wants to assert against a specific run-state path.
   */
  worktreeManager?: WorktreeManager;

  /**
   * Test seam: override the per-user crew home directory. Defaults to
   * `resolveCrewHome()` (`$CREW_HOME` if set, else `~/.crew`). Tests
   * point this at a tmpdir so run state stays isolated and doesn't
   * collide with the developer's real `~/.crew/runs/`.
   */
  crewHome?: string;

  /**
   * Test seam: override the async-fallback timeout. Tests that exercise the
   * fallback path use a tiny value (e.g., 50ms); production uses 60s.
   */
  asyncFallbackMs?: number;
}

export type RunStatus = 'running' | 'success' | 'partial' | 'error' | 'cancelled';

export interface RunEnvelope {
  readonly run_id: string;
  readonly worktree_path: string;
  readonly status: RunStatus;
  readonly summary: string;
  readonly files_changed: readonly string[];
  /**
   * Advisory messages from the dispatch layer (not the agent itself).
   * Today's only producer is the read-only run dirty-tree probe in
   * run-agent.ts. Surfaced through the envelope so the captain can
   * relay contract violations to the user without parsing the
   * summary text.
   */
  readonly warnings?: readonly string[];
}

export interface MergeEnvelope {
  readonly run_id: string;
  readonly status: 'merged' | 'conflict' | 'no-changes';
  readonly commit_sha?: string;
  readonly conflicts?: readonly string[];
}

export interface DiscardEnvelope {
  readonly run_id: string;
  readonly ok: true;
}

/**
 * The pieces a test or alternative entry point needs to drive the server
 * without spawning a subprocess: the configured `McpServer`, the dispatcher
 * (for asserting in-flight state or invoking cancellation), the worktree
 * manager (for asserting on run-state paths), and the run-state store
 * (for asserting persistence outcomes).
 */
export interface CrewMcpServerInstance {
  readonly server: McpServer;
  readonly dispatcher: ToolDispatcher;
  readonly worktreeManager: WorktreeManager;
  readonly runStateStore: RunStateStore;
}

/**
 * Build a fully-configured `McpServer` for crew without binding it to any
 * transport. The caller is responsible for `server.connect(transport)`.
 *
 * `serveCommand` is the production caller (binds stdio + signal handlers);
 * tests use `InMemoryTransport.createLinkedPair()` to drive the server with
 * an in-process Client.
 */
export function buildCrewMcpServer(options: ServeOptions = {}): CrewMcpServerInstance {
  const projectRoot = options.cwd ?? process.cwd();
  const crewHome = options.crewHome ?? resolveCrewHome();
  const registry = options.registry ?? createBuiltinRegistry();
  const worktreeManager = options.worktreeManager
    ?? new WorktreeManager({ projectRoot, crewHome });
  const dispatcher = new ToolDispatcher();
  const runStateStore = new RunStateStore({ crewHome, repoRoot: projectRoot });
  const fallbackMs = options.asyncFallbackMs ?? ASYNC_FALLBACK_MS;

  const server = new McpServer({
    name: 'crew',
    version: SERVE_VERSION,
  });

  // ---- list_agents -----------------------------------------------------
  server.registerTool(
    'list_agents',
    {
      description: LIST_AGENTS_DESCRIPTION,
    },
    async () => {
      // Re-read on every call: the file is small and the user may
      // have edited it between dispatches without restarting serve.
      const agentPrefs = readAgentPrefsFile(crewHome);
      const out = await listAgents({ registry, agentPrefs });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }],
        structuredContent: out as unknown as Record<string, unknown>,
      };
    },
  );

  // ---- run_agent -------------------------------------------------------
  server.registerTool(
    'run_agent',
    {
      description: RUN_AGENT_DESCRIPTION,
      inputSchema: runAgentInputSchema.shape,
    },
    async (args, extra) => {
      const toolCallId = randomUUID();
      const agentPrefs = readAgentPrefsFile(crewHome);
      const plan = await planRunAgent(args, toolCallId, {
        registry,
        worktreeManager,
        agentPrefs,
      });

      if (plan.kind === 'error') {
        return {
          content: [{ type: 'text' as const, text: plan.message }],
          isError: true,
        };
      }

      runStateStore.create({
        runId: plan.runId,
        agentId: args.agent_id,
        worktreePath: plan.worktreePath,
        initialPrompt: args.prompt,
        readOnly: plan.readOnly,
      });

      return runDispatchAndRespond({
        runId: plan.runId,
        worktreePath: plan.worktreePath,
        toolCallId,
        task: plan.task,
        dispatcher,
        runStateStore,
        fallbackMs,
        progress: progressNotifierFrom(extra),
      });
    },
  );

  // ---- continue_run ----------------------------------------------------
  server.registerTool(
    'continue_run',
    {
      description: CONTINUE_RUN_DESCRIPTION,
      inputSchema: continueRunInputSchema.shape,
    },
    async (args, extra) => {
      const state = runStateStore.read(args.run_id);
      if (!state) {
        return errorContent(`Unknown run_id "${args.run_id}".`);
      }
      if (state.status === 'discarded' || state.status === 'merged') {
        return errorContent(
          `Cannot continue run "${args.run_id}" with status "${state.status}".`,
        );
      }
      const adapter = registry.get(state.agentId);
      if (!adapter) {
        return errorContent(
          `Agent "${state.agentId}" is no longer registered; cannot continue run "${args.run_id}".`,
        );
      }
      const continueExtra = extra;

      const toolCallId = randomUUID();
      // Resolve effort + model with the same precedence run_agent
      // uses: per-call > agents.json > adapter default. Re-read prefs
      // each continue so a user edit between dispatches is honored
      // without a serve restart.
      const continueAgentPrefs = readAgentPrefsFile(crewHome);
      const effectiveEffort = resolveEffectiveEffort(
        adapter,
        args.effort,
        continueAgentPrefs,
      );
      const effectiveModel = resolveEffectiveModel(
        adapter,
        args.model,
        continueAgentPrefs,
      );
      const task = buildAdapterDispatchTask({
        toolCallId,
        runId: args.run_id,
        adapter,
        prompt: args.prompt,
        effectiveWorkingDirectory: state.worktreePath,
        worktreePath: state.worktreePath,
        // Stickiness: a continue_run inherits the original dispatch's
        // read_only bit. Read it back from state.json so the
        // post-dispatch probe (warning vs. worktree enrichment)
        // matches the original run's contract.
        readOnly: state.readOnly === true,
        effectiveModel,
        effectiveEffort,
        worktreeManager,
        input: { ...args },
      });

      runStateStore.appendPrompt(args.run_id, args.prompt);

      // Re-mirror uncommitted host state into the worktree so changes
      // the user made between turns are visible to this turn's agent.
      // Skip for read-only runs — they don't have a worktree we own.
      // Best-effort: failures are logged inside the manager.
      if (state.readOnly !== true) {
        try {
          await worktreeManager.syncUncommittedToRunWorktree(args.run_id);
        } catch (err) {
          logger.warn(
            `continue_run: uncommitted-state sync failed for ${args.run_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return runDispatchAndRespond({
        runId: args.run_id,
        worktreePath: state.worktreePath,
        toolCallId,
        task,
        dispatcher,
        runStateStore,
        fallbackMs,
        progress: progressNotifierFrom(continueExtra),
      });
    },
  );

  // ---- merge_run -------------------------------------------------------
  server.registerTool(
    'merge_run',
    {
      description: MERGE_RUN_DESCRIPTION,
      inputSchema: mergeRunInputSchema.shape,
    },
    async (args) => {
      const state = runStateStore.read(args.run_id);
      if (!state) {
        return errorContent(`Unknown run_id "${args.run_id}".`);
      }
      if (state.readOnly) {
        // No worktree exists for read-only runs; merge is meaningless.
        // Surface a precise reason so the captain can explain the
        // category mismatch instead of pretending the merge could
        // have worked under different circumstances.
        return errorContent(
          `Run "${args.run_id}" was dispatched read-only; nothing to merge. ` +
          'Read-only runs run against the host repo (or a target worktree) without ' +
          'allocating their own branch. Use `discard_run` to drop the run record.',
        );
      }
      if (state.status === 'discarded') {
        return errorContent(
          `Cannot merge run "${args.run_id}" — it was discarded.`,
        );
      }
      if (state.status === 'merged') {
        return errorContent(
          `Run "${args.run_id}" was already merged${
            state.mergeStatus?.commitSha
              ? ` at commit ${state.mergeStatus.commitSha}`
              : ''
          }.`,
        );
      }
      try {
        const result = await worktreeManager.mergeRunWorktree(args.run_id, {
          targetBranch: args.target_branch,
          force: args.force,
        });
        const target = args.target_branch ?? '<host current branch>';
        if (result.status === 'merged') {
          runStateStore.markMerged(args.run_id, {
            target,
            commitSha: result.commitSha,
          });
          const env: MergeEnvelope = {
            run_id: args.run_id,
            status: 'merged',
            commit_sha: result.commitSha,
          };
          return jsonContent(env);
        }
        if (result.status === 'conflict') {
          runStateStore.markMergeConflict(args.run_id, {
            target,
            conflicts: result.conflicts,
          });
          const env: MergeEnvelope = {
            run_id: args.run_id,
            status: 'conflict',
            conflicts: result.conflicts,
          };
          return jsonContent(env, /* isError */ true);
        }
        // no-changes
        const env: MergeEnvelope = {
          run_id: args.run_id,
          status: 'no-changes',
        };
        return jsonContent(env);
      } catch (err) {
        return errorContent(
          err instanceof Error ? err.message : `merge_run failed: ${String(err)}`,
        );
      }
    },
  );

  // ---- discard_run -----------------------------------------------------
  server.registerTool(
    'discard_run',
    {
      description: DISCARD_RUN_DESCRIPTION,
      inputSchema: discardRunInputSchema.shape,
    },
    async (args) => {
      // Idempotent: if state.json doesn't exist or run is already discarded,
      // succeed quietly.
      const state = runStateStore.read(args.run_id);
      try {
        if (state && state.status !== 'discarded') {
          // Read-only runs never allocated a worktree, so the
          // worktree-cleanup branch would no-op anyway — but skipping
          // it explicitly makes the contract clearer and avoids the
          // run-lock acquisition the cleanup helper takes.
          if (!state.readOnly) {
            await worktreeManager.cleanupByRunId(args.run_id);
          }
          runStateStore.markDiscarded(args.run_id);
        }
      } catch (err) {
        return errorContent(
          err instanceof Error ? err.message : `discard_run failed: ${String(err)}`,
        );
      }
      const env: DiscardEnvelope = { run_id: args.run_id, ok: true };
      return jsonContent(env);
    },
  );

  // ---- get_run_status --------------------------------------------------
  server.registerTool(
    'get_run_status',
    {
      description: GET_RUN_STATUS_DESCRIPTION,
      inputSchema: getRunStatusInputSchema.shape,
    },
    async (args) => {
      const state = runStateStore.read(args.run_id);
      if (!state) {
        return errorContent(`Unknown run_id "${args.run_id}".`);
      }
      const logTail = runStateStore.tailEvents(args.run_id, args.log_lines ?? 50);
      const payload = { ...state, log_tail: logTail };
      return jsonContent(payload);
    },
  );

  // ---- cancel_run ------------------------------------------------------
  server.registerTool(
    'cancel_run',
    {
      description: CANCEL_RUN_DESCRIPTION,
      inputSchema: cancelRunInputSchema.shape,
    },
    async (args) => {
      // Match by runId rather than toolCallId — the captain knows the
      // run_id (returned from run_agent), not the internal toolCallId.
      const inFlight = dispatcher
        .listInFlight()
        .find((t) => t.runId === args.run_id);
      if (!inFlight) {
        // Not in-flight: either already terminal, never started, or
        // unknown. Surface state to help the captain explain to the user.
        const state = runStateStore.read(args.run_id);
        const reason = state
          ? `Run "${args.run_id}" is not in-flight (status="${state.status}").`
          : `Unknown run_id "${args.run_id}".`;
        return jsonContent({ run_id: args.run_id, ok: false, reason });
      }
      // Trigger abort — the existing run:cancelled lifecycle listener
      // will mark the run terminal with status='cancelled'.
      dispatcher.cancel(inFlight.toolCallId, 'cancel_run requested');
      return jsonContent({ run_id: args.run_id, ok: true });
    },
  );

  return { server, dispatcher, worktreeManager, runStateStore };
}

/**
 * Production entry point. Builds the server, wires SIGINT/SIGTERM, connects
 * stdio. Blocks until the transport closes (stdin EOF) or a signal arrives.
 */
export async function serveCommand(options: ServeOptions = {}): Promise<void> {
  const { server, dispatcher } = buildCrewMcpServer(options);

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    const inFlight = dispatcher.inFlightCount();
    if (inFlight > 0) {
      logger.info(
        `crew serve received ${signal}; cancelling ${inFlight} in-flight task(s)`,
      );
      dispatcher.cancelAll(`Server received ${signal}`);
      // Brief grace window so the cancel propagates and dispatcher emits
      // its terminal events before the process tears down.
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    process.exit(0);
  };
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ---------------------------------------------------------------------------
// Internal: dispatch lifecycle + envelope shaping
// ---------------------------------------------------------------------------

type DispatchTerminal =
  | { kind: 'complete'; result: TaskResult }
  | { kind: 'failed'; error: string }
  | { kind: 'cancelled'; reason: string };

type ToolCallReturn = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

interface DispatchAndRespondArgs {
  runId: string;
  worktreePath: string;
  toolCallId: string;
  task: import('../../orchestrator/tool-dispatcher.js').DispatchTask;
  dispatcher: ToolDispatcher;
  runStateStore: RunStateStore;
  fallbackMs: number;
  /**
   * Optional MCP progress notifier — when supplied, each adapter
   * onOutput chunk fires `notifications/progress` so the host CLI
   * can render live streaming output. Absent when the client did
   * not include a `progressToken` in the request `_meta`. Callers
   * build this via `progressNotifierFrom(extra)`.
   */
  progress?: ProgressNotifier;
}

/**
 * Shape of a per-call progress notifier. `send(message)` increments
 * an internal monotonic counter and fires `notifications/progress`.
 * Returns void; failures are swallowed so a transport hiccup can't
 * fail the dispatch.
 */
interface ProgressNotifier {
  send(message: string): void;
}

/**
 * The shared dispatch lifecycle for run_agent + continue_run. Wires the
 * dispatcher event subscriptions (state-write side effects + terminal
 * promise resolution + stream-log appends), starts the dispatch, and
 * races a 60s timer against the terminal event.
 *
 * If the terminal wins: returns a full RunEnvelope. If the timer wins:
 * returns an early `status:'running'` envelope. Either way, the run-state
 * subscriptions stay alive until the dispatch eventually terminates and
 * write the final state to state.json.
 */
async function runDispatchAndRespond(args: DispatchAndRespondArgs): Promise<ToolCallReturn> {
  const terminalPromise = installRunLifecycleListeners({
    dispatcher: args.dispatcher,
    runStateStore: args.runStateStore,
    runId: args.runId,
    toolCallId: args.toolCallId,
    progress: args.progress,
  });
  args.dispatcher.start(args.task);

  const winner = await Promise.race([
    terminalPromise.then((terminal) => ({ kind: 'terminal' as const, terminal })),
    sleep(args.fallbackMs).then(() => ({ kind: 'timeout' as const })),
  ]);

  if (winner.kind === 'timeout') {
    const env: RunEnvelope = {
      run_id: args.runId,
      worktree_path: args.worktreePath,
      status: 'running',
      summary: `Dispatch exceeded ${args.fallbackMs}ms; poll get_run_status with run_id="${args.runId}".`,
      files_changed: [],
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(env, null, 2) }],
      structuredContent: env as unknown as Record<string, unknown>,
    };
  }

  const env = formatRunEnvelope(args.runId, args.worktreePath, winner.terminal);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(env, null, 2) }],
    structuredContent: env as unknown as Record<string, unknown>,
    isError: winner.terminal.kind !== 'complete' || env.status === 'error',
  };
}

/**
 * Subscribe to dispatcher events for a single tool-call lifecycle. Has two
 * jobs:
 *
 *   1. Persist run-state changes: every terminal event writes state.json
 *      (status + completedAt + summary + filesChanged). Stream chunks
 *      append to events.log for get_run_status to surface. These
 *      side-effect listeners self-dispose after the terminal event so the
 *      EventEmitter doesn't accumulate dead handlers.
 *
 *   2. Resolve the returned promise with the terminal kind so the caller
 *      can race it against the async-fallback timer.
 *
 * State-write errors are swallowed (warn-logged) — a bad write must NEVER
 * crash the server or fail the tool call.
 */
function installRunLifecycleListeners(args: {
  dispatcher: ToolDispatcher;
  runStateStore: RunStateStore;
  runId: string;
  toolCallId: string;
  progress?: ProgressNotifier;
}): Promise<DispatchTerminal> {
  return new Promise<DispatchTerminal>((resolve) => {
    const subs: Array<{ dispose(): void }> = [];
    const onTerminal = (terminal: DispatchTerminal): void => {
      try {
        if (terminal.kind === 'complete') {
          args.runStateStore.markTerminal(args.runId, {
            status: terminal.result.status,
            summary: terminal.result.output,
            filesChanged: terminal.result.filesModified,
          });
        } else if (terminal.kind === 'failed') {
          args.runStateStore.markTerminal(args.runId, {
            status: 'error',
            summary: terminal.error,
            filesChanged: [],
            lastError: terminal.error,
          });
        } else {
          args.runStateStore.markTerminal(args.runId, {
            status: 'cancelled',
            summary: terminal.reason,
            filesChanged: [],
          });
        }
      } catch (err) {
        logger.warn(
          `Failed to write run state for ${args.runId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      for (const s of subs) s.dispose();
      resolve(terminal);
    };

    subs.push(
      args.dispatcher.onEvent('run:complete', (info) => {
        if (info.toolCallId !== args.toolCallId) return;
        onTerminal({ kind: 'complete', result: info.result as TaskResult });
      }),
      args.dispatcher.onEvent('run:failed', (info) => {
        if (info.toolCallId !== args.toolCallId) return;
        onTerminal({ kind: 'failed', error: info.error });
      }),
      args.dispatcher.onEvent('run:cancelled', (info) => {
        if (info.toolCallId !== args.toolCallId) return;
        onTerminal({ kind: 'cancelled', reason: info.reason });
      }),
      args.dispatcher.onEvent('run:stream', (info) => {
        if (info.toolCallId !== args.toolCallId) return;
        try {
          args.runStateStore.appendEvent(args.runId, info.chunk);
        } catch {
          // Log writes are best-effort; never let a write failure break dispatch.
        }
        // Bridge to MCP progress notifications when the client supplied
        // a progressToken. Adapters typically emit line-buffered chunks
        // (codex/claude-code/gemini-cli all do), so per-chunk firing is
        // reasonable. A noisy adapter could be batched here later if it
        // shows up as a problem.
        if (args.progress) args.progress.send(info.chunk);
      }),
    );
  });
}

/**
 * Build a per-call progress notifier from the MCP request `extra`. If
 * the client did not provide a `progressToken` in the request `_meta`,
 * returns undefined — caller treats that as "no progress notifications
 * for this call." The captain shouldn't depend on progress events; they
 * are pure UX, the tool result is the contract.
 *
 * Counter is monotonically increasing per the MCP progress spec. We
 * don't know the total chunk count up-front so `total` is omitted
 * (renderers handle that as an indeterminate progress bar).
 *
 * Notification failures are caught + dropped: a transport hiccup
 * (e.g., client disconnected) must never fail the dispatch.
 */
function progressNotifierFrom(extra: {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: {
    method: 'notifications/progress';
    params: { progressToken: string | number; progress: number; message?: string };
  }) => Promise<void>;
}): ProgressNotifier | undefined {
  const token = extra._meta?.progressToken;
  // Diagnostic — one line per dispatched call. Lets the user/operator see
  // whether their host CLI is opting into progress streaming. Some clients
  // (codex CLI as of 2026-05) don't supply a token; that silently disables
  // streaming chunks back to the captain, so the only signal is this log.
  // info-level so it shows by default; the runtime is one line per call.
  logger.info(
    `progress token: ${token === undefined ? 'absent (no streaming chunks to captain)' : String(token)}`,
  );
  if (token === undefined) return undefined;
  let counter = 0;
  return {
    send(message: string): void {
      counter += 1;
      void extra
        .sendNotification({
          method: 'notifications/progress',
          params: { progressToken: token, progress: counter, message },
        })
        .catch(() => {
          // Swallow — see jsdoc above.
        });
    },
  };
}

function formatRunEnvelope(
  runId: string,
  worktreePath: string,
  terminal: DispatchTerminal,
): RunEnvelope {
  if (terminal.kind === 'failed') {
    return {
      run_id: runId,
      worktree_path: worktreePath,
      status: 'error',
      summary: terminal.error,
      files_changed: [],
    };
  }
  if (terminal.kind === 'cancelled') {
    return {
      run_id: runId,
      worktree_path: worktreePath,
      status: 'cancelled',
      summary: terminal.reason,
      files_changed: [],
    };
  }
  // Carry warnings (e.g., read-only dirty-tree contract violations)
  // through to the captain-visible envelope. Omit the field entirely
  // when empty/undefined so happy-path envelopes stay narrow.
  const warnings =
    terminal.result.warnings && terminal.result.warnings.length > 0
      ? terminal.result.warnings
      : undefined;
  return {
    run_id: runId,
    worktree_path: worktreePath,
    status: terminal.result.status,
    summary: terminal.result.output,
    files_changed: terminal.result.filesModified,
    ...(warnings ? { warnings } : {}),
  };
}

function jsonContent<T extends object>(value: T, isError = false): ToolCallReturn {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as unknown as Record<string, unknown>,
    isError,
  };
}

function errorContent(message: string): ToolCallReturn {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-export RunStateV1 for tests that want to inspect persisted state.
export type { RunStateV1 };
