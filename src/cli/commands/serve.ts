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
 * Server-side cap on the long-poll wait that `get_run_status` honors
 * via `wait_for_change_ms`. Kept under the smallest known host MCP
 * tool-call timeout so a long-poll never trips the host's own deadline.
 * Captains usually pass 30000; we clamp anything larger to this value.
 */
export const MAX_LONG_POLL_MS = 60_000;

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

      const cursor = args.since_event_line ?? 0;
      const useLongPoll = (args.wait_for_change_ms ?? 0) > 0
        && !isTerminalRunStatus(state.status);

      // Snapshot path — fast return.
      if (!useLongPoll) {
        return buildGetRunStatusResponse(state, runStateStore, args.run_id, cursor, args.log_lines);
      }

      // Already-have-data path: if the events log already advanced past
      // the captain's cursor, return immediately without waiting.
      const head = runStateStore.readEventsSince(args.run_id, cursor);
      if (head.lines.length > 0) {
        return buildGetRunStatusResponse(state, runStateStore, args.run_id, cursor, args.log_lines);
      }

      // Long-poll: subscribe to dispatcher events for this run; resolve
      // on the first stream/terminal event or after wait_for_change_ms.
      // The clamp prevents a misbehaving captain from holding the
      // request open longer than the host's MCP tool-call timeout.
      const waitMs = Math.min(args.wait_for_change_ms ?? 0, MAX_LONG_POLL_MS);
      await waitForRunChange({
        dispatcher,
        runId: args.run_id,
        waitMs,
      });

      const fresh = runStateStore.read(args.run_id) ?? state;
      return buildGetRunStatusResponse(fresh, runStateStore, args.run_id, cursor, args.log_lines);
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
 * Async-first dispatch — pre-2026-05 this raced a sync window against
 * the terminal event so fast runs could return inline; now it always
 * returns `status: "running"` immediately and the captain drives the
 * lifecycle via `get_run_status` (long-polled, cursor-based).
 *
 * Why: the prior model produced a 60s opening blackout for every
 * dispatch on hosts that don't surface MCP progress notifications
 * (codex), and snapshot polling at 10–20s cadence felt like a hung
 * UI even when the agent was actively working. Async-first lets the
 * captain start a tight long-poll loop inside `get_run_status` that
 * surfaces new events.log lines with sub-second latency.
 *
 * The lifecycle listeners installed here keep firing in the
 * background after we return — they own state.json writes on
 * terminal events. The captain's polls read state.json + events.log
 * (cursor-based) to follow along.
 */
async function runDispatchAndRespond(args: DispatchAndRespondArgs): Promise<ToolCallReturn> {
  // Install terminal-event listeners + start the dispatch; we don't
  // await the terminal promise — it resolves in the background and
  // its side effects (markTerminal on state.json) are what later
  // get_run_status calls observe.
  void installRunLifecycleListeners({
    dispatcher: args.dispatcher,
    runStateStore: args.runStateStore,
    runId: args.runId,
    toolCallId: args.toolCallId,
    progress: args.progress,
  });
  args.dispatcher.start(args.task);

  const env: RunEnvelope = {
    run_id: args.runId,
    worktree_path: args.worktreePath,
    status: 'running',
    summary: `Dispatched. Poll get_run_status with run_id="${args.runId}" (use wait_for_change_ms: 30000 + since_event_line cursor for live progress).`,
    files_changed: [],
  };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(env, null, 2) }],
    structuredContent: env as unknown as Record<string, unknown>,
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
            // Persist advisory warnings (read-only dirty-tree probe is
            // the only producer today). With async-first dispatch the
            // captain reads them via get_run_status — there's no
            // synchronous envelope path to surface them through.
            warnings: terminal.result.warnings,
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

/**
 * `get_run_status` payload shape — the run's persisted state plus
 * cursor-driven events delta. `events_tail` contains only lines with
 * index >= the input `since_event_line`; `next_event_line` is the
 * cursor the captain passes back next call. `log_tail` is retained
 * for snapshot callers that haven't migrated to cursor semantics
 * (mirrors `tailEvents` output and only populated when the caller
 * passes `log_lines` and not `since_event_line`).
 */
interface GetRunStatusResponse {
  // Spread of RunStateV1 — typed wide because the state shape is
  // additive over time and we don't want to re-declare it here.
  readonly [key: string]: unknown;
  readonly events_tail: readonly string[];
  readonly next_event_line: number;
  readonly log_tail?: readonly string[];
}

function buildGetRunStatusResponse(
  state: object,
  store: RunStateStore,
  runId: string,
  sinceLine: number,
  logLines: number | undefined,
): ToolCallReturn {
  const { lines, nextLine } = store.readEventsSince(runId, sinceLine);
  const payload: GetRunStatusResponse = {
    ...state,
    events_tail: lines,
    next_event_line: nextLine,
    // Backward-compat: the legacy `log_tail` field is still surfaced
    // for callers that pass `log_lines` but no cursor. Once captains
    // are all on cursor semantics this can be deleted.
    ...(sinceLine === 0 && logLines !== undefined
      ? { log_tail: store.tailEvents(runId, logLines) }
      : {}),
  };
  return jsonContent(payload);
}

function isTerminalRunStatus(status: string): boolean {
  return (
    status === 'success'
    || status === 'partial'
    || status === 'error'
    || status === 'cancelled'
    || status === 'merged'
    || status === 'merge_conflict'
    || status === 'discarded'
  );
}

/**
 * Block until the dispatcher fires any of stream/complete/failed/
 * cancelled for `runId`, OR `waitMs` elapses — whichever happens
 * first. Listeners self-dispose on either path. The captain's
 * long-poll resolves and the next `get_run_status` snapshot read
 * picks up the latest state + new events.
 */
async function waitForRunChange(args: {
  dispatcher: ToolDispatcher;
  runId: string;
  waitMs: number;
}): Promise<void> {
  const subs: Array<{ dispose(): void }> = [];
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      for (const s of subs) s.dispose();
      resolve();
    };
    const matches = (info: { runId?: string }): boolean => info.runId === args.runId;
    subs.push(
      args.dispatcher.onEvent('run:stream', (info) => {
        if (matches(info)) finish();
      }),
      args.dispatcher.onEvent('run:complete', (info) => {
        if (matches(info)) finish();
      }),
      args.dispatcher.onEvent('run:failed', (info) => {
        if (matches(info)) finish();
      }),
      args.dispatcher.onEvent('run:cancelled', (info) => {
        if (matches(info)) finish();
      }),
    );
    setTimeout(finish, args.waitMs);
  });
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
