// `crew-mcp serve` — the v2 stdio MCP server entry point.
//
// The host CLI (Claude Code / Codex / Gemini) spawns this command at session
// start via its MCP config block. We expose v2's full 8-tool surface over
// stdio:
//
//   list_agents      — synchronous probe of the agent registry
//   list_runs        — recover persisted run records for the current repo
//   run_agent        — dispatch into a fresh worktree (block-and-stream
//                      with 60s async-fallback)
//   continue_run     — re-invoke the agent in an existing worktree
//   merge_run        — merge a worktree into the host's HEAD (the only
//                      mutating tool; host CLI must confirm with user)
//   discard_run      — abandon a worktree without merging
//   cancel_run       — abort an in-flight run
//   get_run_status   — poll a run's state.json + tail of events.log
//
// Logging discipline: stdout is reserved for the MCP wire protocol. The
// project's logger (src/utils/logger.ts) emits to stderr via console.error,
// which is safe; do NOT introduce any console.log() calls in the hot path.

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, type Dirent } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { AdapterRegistry } from '../../adapters/registry.js';
import { createBuiltinRegistry } from '../../adapters/registry.js';
import type { TaskResult } from '../../adapters/types.js';
import { WorktreeManager } from '../../git/worktree.js';
import { ToolDispatcher } from '../../orchestrator/tool-dispatcher.js';
import { filterEventsTailNoise } from '../../orchestrator/events-filter.js';
import { RunStateStore, type RunStateV1 } from '../../orchestrator/run-state.js';
import { validatePeerMessagesPreflight } from '../../orchestrator/peer-messages/preflight.js';
import type { PeerMessageInput } from '../../orchestrator/peer-messages/schema.js';
import {
  listAgents,
  listAgentsInputSchema,
  LIST_AGENTS_DESCRIPTION,
} from '../../orchestrator/tools/list-agents.js';
import {
  listRuns,
  listRunsInputSchema,
  LIST_RUNS_DESCRIPTION,
} from '../../orchestrator/tools/list-runs.js';
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
  DEFAULT_MAX_EVENTS_TAIL,
  getRunStatusInputSchema,
  GET_RUN_STATUS_DESCRIPTION,
  MAX_EVENTS_TAIL_CAP,
} from '../../orchestrator/tools/get-run-status.js';
import { readAgentPrefsFile } from '../../agent-prefs/store.js';
import { readConfigFile } from '../../utils/config-store.js';
import { resolveCrewHome } from '../../utils/crew-home.js';
import { logger, setLogFilePath } from '../../utils/logger.js';
import { CREW_MCP_VERSION } from '../version.js';
import { crewTailUrl } from './tail-url.js';

export const SERVE_VERSION = CREW_MCP_VERSION;

/**
 * Server-side cap on the long-poll wait that `get_run_status` honors
 * via `wait_for_change_ms`. Kept under the smallest known host MCP
 * tool-call timeout so a long-poll never trips the host's own deadline.
 * Captains usually pass 30000; we clamp anything larger to this value.
 */
export const MAX_LONG_POLL_MS = 60_000;

/**
 * Classification of the MCP host CLI that initialized this server, derived
 * from the `clientInfo.name` carried in the MCP `initialize` request. Used
 * to tailor the dispatch envelope's "next step" copy: Claude Code captains
 * need to spawn a watcher overlay before ending the turn, while Codex /
 * Gemini captains just end the turn after the dispatch tool returns.
 */
export type ClientKind = 'claude-code' | 'codex' | 'gemini' | 'unknown';

/**
 * Map an MCP `clientInfo.name` string to a `ClientKind`. Substring match
 * (not equality) so future renames of host clients still classify
 * correctly without re-shipping crew-mcp. Normalizes separators
 * (whitespace, underscores → hyphens) and case before matching so
 * `"Claude Code"`, `"claude_code"`, and `"claude-code-cli"` all fold
 * to the same kind. Exported for unit tests; the production lookup
 * runs once per server via `getClientKind` in `buildCrewMcpServer`.
 */
export function classifyClient(name: string | undefined): ClientKind {
  if (!name) return 'unknown';
  const n = name.toLowerCase().replace(/[\s_]+/g, '-');
  if (n.includes('claude-code') || n === 'claude') return 'claude-code';
  if (n.includes('codex')) return 'codex';
  if (n.includes('gemini')) return 'gemini';
  return 'unknown';
}

/**
 * Host-specific "next step" sentence appended to the dispatch envelope
 * summary and the markdown `- Next:` bullet. Single source of truth so
 * the structured `summary` field and the human-facing markdown can never
 * disagree. Unknown hosts get a neutral fallback that doesn't claim a
 * watcher will or won't exist — the captain's skill body covers the
 * host-specific watcher protocol.
 */
export function nextStepSentence(kind: ClientKind): string {
  switch (kind) {
    case 'claude-code':
      return 'End your turn after spawning the watcher; user is free to chat.';
    case 'codex':
    case 'gemini':
      return 'End your turn after this dispatch returns; user is free to chat.';
    case 'unknown':
      return 'End your turn after dispatch; user is free to chat.';
  }
}

const MERGE_CONFIRMATION_REQUIRED_MESSAGE =
  'merge_run: requires explicit user confirmation (config: confirmBeforeMerge=true). ' +
  'Ask the user to approve, then call merge_run again with {confirmed: true}. ' +
  'Run this from the captain skill — never auto-pass confirmed:true without an explicit user "yes".';

// Re-export for callers that imported these from this module.
// Canonical definitions live in `orchestrator/tools/get-run-status` so
// the schema bound and the default share one source of truth.
export { DEFAULT_MAX_EVENTS_TAIL, MAX_EVENTS_TAIL_CAP };

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
   * Test seam: override the stale-run sweeper while preserving the same
   * deferred scheduling path used in production.
   */
  staleRunSweeper?: (args: StaleRunSweepArgs) => void | Promise<void>;

  /**
   * When set, every logger call also appends to this absolute path. Useful
   * for diagnosing host MCP-lifecycle problems (e.g. Conductor) that don't
   * surface the server's stderr. If unset, callers also honor the
   * `CREW_LOG_FILE` env var; the env path is resolved relative to the
   * server's working directory if not absolute. Tests pass an explicit
   * path so the env stays clean.
   */
  logFile?: string;
}

export type RunStatus = 'running' | 'success' | 'partial' | 'error' | 'cancelled';

export interface RunEnvelope {
  readonly run_id: string;
  /**
   * Custom `crew-tail://` URL pointing directly at the run's events.log.
   * This is the one path-like field captains need in structuredContent by
   * default; markdown still carries the human-facing worktree and manual
   * tail details.
   */
  readonly tail_url: string;
  readonly summary: string;
  readonly files_changed: readonly string[];
  /**
   * Advisory messages from the dispatch layer (not the agent itself).
   * Producers: read-only dirty-tree probe (markTerminal) and peer_messages
   * truncation/cap warnings (run_agent / continue_run dispatch).
   */
  readonly warnings?: readonly string[];
  /**
   * Full-envelope opt-in fields. Set CREW_FULL_ENVELOPE=1 to restore
   * the pre-trim structuredContent for legacy structured consumers.
   */
  readonly status?: RunStatus;
  /**
   * The adapter id that's running this dispatch (e.g., "codex",
   * "claude-code", "gemini"). Surfaced so the captain (and any host
   * UI reading `structuredContent`) can label the run without
   * round-tripping back through state.json. Optional for backward
   * compat — older callers that constructed envelopes without it
   * still type-check.
   */
  readonly agent_id?: string;
  readonly worktree_path?: string;
  readonly events_log_path?: string;
  /**
   * Absolute path to a generated `tail.command` shell script that
   * tails `events_log_path` indefinitely. On macOS this is the
   * extension Terminal.app registers as a launcher: a user can
   * `open` the file or click a `file://` link to it and a Terminal
   * window opens running the tail. The dispatch markdown surfaces a
   * clickable link only on macOS; on other platforms the file is
   * still a runnable shell script the user can invoke directly.
   */
  readonly tail_command_path?: string;
  /**
   * Pre-encoded `file://` URL pointing at `tail_command_path`. Provided
   * as a separate field so captains can paste it verbatim into a
   * markdown link without having to re-implement path encoding (we
   * use `pathToFileURL().href` here so paths with `#`, `?`, spaces, or
   * unicode round-trip correctly).
   */
  readonly tail_command_url?: string;
}

export interface FullRunEnvelope extends RunEnvelope {
  readonly status: RunStatus;
  readonly agent_id?: string;
  readonly worktree_path: string;
  readonly events_log_path: string;
  readonly tail_command_path: string;
  readonly tail_command_url: string;
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

export type StaleRunSweepArgs = {
  crewHome: string;
  projectRoot: string;
  runStateStore: RunStateStore;
};

let staleRunSweepPromise: Promise<void> | null = null;

export function getStaleRunSweep(): Promise<void> | null {
  return staleRunSweepPromise;
}

export function scheduleStaleRunSweep(
  args: StaleRunSweepArgs,
  sweep: (args: StaleRunSweepArgs) => void | Promise<void> = markAbandonedRunningRuns,
): Promise<void> {
  if (staleRunSweepPromise !== null) return staleRunSweepPromise;

  staleRunSweepPromise = new Promise<void>((resolve) => {
    setImmediate(resolve);
  })
    .then(() => sweep(args))
    .catch((err) => {
      logger.warn(
        `stale-run sweeper: failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    })
    .finally(() => {
      staleRunSweepPromise = null;
    });

  return staleRunSweepPromise;
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
  void scheduleStaleRunSweep(
    { crewHome, projectRoot, runStateStore },
    options.staleRunSweeper,
  );
  // Per-server one-shot loud-log state for progressToken presence/absence.
  // Crew's stdio MCP server is normally 1:1 with a single host client, so
  // per-server is effectively per-client today. If crew grows SSE or another
  // multi-client transport, revisit this storage so one client's first
  // dispatch does not consume another client's startup diagnostic.
  // Created here (not module-level) so tests that build a fresh server
  // start with a clean slate — otherwise a serve test's first dispatch
  // logs cleanly but later tests' first dispatches go silent on the
  // load-bearing warn line.
  const progressTokenSeen: ProgressTokenSeen = {
    presentLogged: false,
    absentLogged: false,
  };

  const server = new McpServer({
    name: 'crew',
    version: SERVE_VERSION,
  });

  // Memoized host-CLI classification. `getClientVersion()` returns
  // `undefined` until the MCP `initialize` handshake completes, but tool
  // calls only fire post-initialize so the first dispatch will always
  // see a defined value. Cache so we don't re-classify on every
  // dispatch — the answer can't change within a single server lifetime.
  let cachedClientKind: ClientKind | undefined;
  const getClientKind = (): ClientKind => {
    if (cachedClientKind !== undefined) return cachedClientKind;
    const info = server.server.getClientVersion();
    cachedClientKind = classifyClient(info?.name);
    return cachedClientKind;
  };

  // ---- list_agents -----------------------------------------------------
  server.registerTool(
    'list_agents',
    {
      description: LIST_AGENTS_DESCRIPTION,
      inputSchema: listAgentsInputSchema.shape,
    },
    async (args) => {
      // Re-read on every call: the file is small and the user may
      // have edited it between dispatches without restarting serve.
      const agentPrefs = readAgentPrefsFile(crewHome);
      const out = await listAgents({ registry, agentPrefs, refresh: args.refresh });
      return jsonContent(out);
    },
  );

  // ---- list_runs -------------------------------------------------------
  server.registerTool(
    'list_runs',
    {
      description: LIST_RUNS_DESCRIPTION,
      inputSchema: listRunsInputSchema.shape,
    },
    async (args) => {
      const out = listRuns(args, { crewHome, repoRoot: projectRoot });
      return jsonContent(out);
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
      let validatedInput: readonly PeerMessageInput[];
      try {
        validatedInput = validatePeerMessagesPreflight(args.peer_messages, runStateStore.caps);
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }

      const agentPrefs = readAgentPrefsFile(crewHome);
      const plan = await planRunAgent(args, {
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

      let createResult: Awaited<ReturnType<RunStateStore['create']>>;
      try {
        createResult = await runStateStore.create({
          runId: plan.runId,
          agentId: args.agent_id,
          worktreePath: plan.worktreePath,
          initialPrompt: args.prompt,
          initialPeerMessagesInput: validatedInput.length > 0 ? validatedInput : undefined,
          readOnly: plan.readOnly,
        });
      } catch (err) {
        if (!plan.readOnly) {
          try {
            await worktreeManager.cleanupByRunId(plan.runId);
          } catch (cleanupErr) {
            logger.warn(
              `run_agent cleanup after rejection failed: ${
                cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
              }`,
            );
          }
        }
        return errorContent(err instanceof Error ? err.message : String(err));
      }

      const { composedPrompt, warnings } = createResult;
      const task = plan.buildTask(composedPrompt);

      return runDispatchAndRespond({
        runId: plan.runId,
        agentName: args.agent_id,
        worktreePath: plan.worktreePath,
        toolCallId: plan.toolCallId,
        task,
        warnings,
        dispatcher,
        runStateStore,
        progress: progressNotifierFrom(extra, args.agent_id, progressTokenSeen),
        clientKind: getClientKind(),
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
      const userPrompt = args.prompt ?? '';
      const preState = runStateStore.read(args.run_id);
      if (!preState) {
        return errorContent(`Unknown run_id "${args.run_id}".`);
      }

      let validatedInput: readonly PeerMessageInput[];
      try {
        validatedInput = validatePeerMessagesPreflight(args.peer_messages, runStateStore.caps);
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }

      if (userPrompt === '' && validatedInput.length === 0) {
        return errorContent('peer_messages.no_op: continue_run requires either prompt or peer_messages');
      }

      if (preState.status === 'running') {
        return errorContent('continue_run: run is currently running; call cancel_run first.');
      }
      if (
        preState.status === 'discarded'
        || preState.status === 'merged'
        || preState.status === 'merge_conflict'
      ) {
        return errorContent(
          `Cannot continue run "${args.run_id}" with status "${preState.status}".`,
        );
      }
      const adapter = typeof registry.load === 'function'
        ? await registry.load(preState.agentId)
        : registry.get(preState.agentId);
      if (!adapter) {
        return errorContent(
          `Agent "${preState.agentId}" is no longer registered; cannot continue run "${args.run_id}".`,
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
      let appendResult: Awaited<ReturnType<RunStateStore['appendPrompt']>>;
      try {
        appendResult = await runStateStore.appendPrompt(args.run_id, {
          userPrompt,
          peerMessagesInput: validatedInput.length > 0 ? validatedInput : undefined,
        });
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
      const { state, composedPrompt, warnings } = appendResult;

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

      const task = buildAdapterDispatchTask({
        toolCallId,
        runId: args.run_id,
        adapter,
        prompt: composedPrompt,
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

      return runDispatchAndRespond({
        runId: args.run_id,
        agentName: state.agentId,
        worktreePath: state.worktreePath,
        toolCallId,
        task,
        warnings,
        dispatcher,
        runStateStore,
        progress: progressNotifierFrom(continueExtra, state.agentId, progressTokenSeen),
        clientKind: getClientKind(),
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
      if (state.status === 'running') {
        return errorContent('merge_run: run is currently running; call cancel_run first.');
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
      const confirmationGate = resolveMergeConfirmationGate(crewHome);
      if (confirmationGate.error) {
        return errorContent(confirmationGate.error);
      }
      if (confirmationGate.enabled && args.confirmed !== true) {
        return errorContent(MERGE_CONFIRMATION_REQUIRED_MESSAGE);
      }
      try {
        const result = await worktreeManager.mergeRunWorktree(args.run_id, {
          targetBranch: args.target_branch,
          force: args.force,
          commitTitle: args.commit_title,
          commitBody: args.commit_body,
        });
        const target = args.target_branch ?? '<host current branch>';
        if (result.status === 'merged') {
          runStateStore.markMerged(args.run_id, {
            target,
            commitSha: result.commitSha,
          });
          // Best-effort worktree cleanup: once the run is merged into
          // the host's HEAD, the worktree itself has no remaining
          // value (the changes are durably in main). state.json +
          // events.log persist for archeology per cleanupByRunId
          // semantics. If cleanup fails, the merge still succeeded
          // and the captain can retry via discard_run.
          try {
            await worktreeManager.cleanupByRunId(args.run_id);
          } catch (err) {
            logger.warn(
              `merge_run ${args.run_id}: worktree cleanup failed after `
              + `successful merge — call discard_run to retry. Error: `
              + `${err instanceof Error ? err.message : String(err)}`,
            );
          }
          const env: MergeEnvelope = {
            run_id: args.run_id,
            status: 'merged',
            commit_sha: result.commitSha,
          };
          return markdownContent(renderMergeMarkdown(env), env);
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
          return markdownContent(renderMergeMarkdown(env), env, /* isError */ true);
        }
        // no-changes
        const env: MergeEnvelope = {
          run_id: args.run_id,
          status: 'no-changes',
        };
        return markdownContent(renderMergeMarkdown(env), env);
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
      if (state?.status === 'running') {
        return errorContent('discard_run: run is currently running; call cancel_run first.');
      }
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
      return markdownContent(renderDiscardMarkdown(env), env);
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
        return buildGetRunStatusResponse(
          state,
          runStateStore,
          args.run_id,
          cursor,
          args.log_lines,
          args.max_events_tail,
        );
      }

      const terminalOnly = args.wait_for_terminal_only === true;

      if (!terminalOnly) {
        // Already-have-data path: if the events log already has *signal*
        // lines past the captain's cursor, return immediately without
        // waiting. Lines the noise filter would drop (codex receipts:
        // command-started / exit-0 / item.* lifecycle frames) don't
        // count — they'd round-trip the captain a payload of
        // events_tail: [] and a bumped cursor, which is strictly worse
        // than a long-poll wait. The cursor still advances on the next
        // poll because buildGetRunStatusResponse reads the raw file via
        // readEventsSince. Terminal-only waits skip this fast-return
        // entirely because the caller asked to wake only on terminal.
        // See docs/plans/active/noise-symmetric-filter.md.
        const head = runStateStore.readSignalEventsSince(args.run_id, cursor);
        if (head.lines.length > 0) {
          return buildGetRunStatusResponse(
            state,
            runStateStore,
            args.run_id,
            cursor,
            args.log_lines,
            args.max_events_tail,
          );
        }
      }

      // Long-poll: subscribe to dispatcher events for this run; resolve
      // on the first stream/terminal event or after wait_for_change_ms.
      // In terminal-only mode, omit the stream subscription so chunks do
      // not wake the captain.
      // The clamp prevents a misbehaving captain from holding the
      // request open longer than the host's MCP tool-call timeout.
      const waitMs = Math.min(args.wait_for_change_ms ?? 0, MAX_LONG_POLL_MS);
      const timedOut = await waitForRunChange({
        dispatcher,
        agentName: state.agentId,
        runId: args.run_id,
        waitMs,
        terminalOnly,
      });

      if (terminalOnly && timedOut && !isTerminalRunStatus(state.status)) {
        return getRunStatusContent(args.run_id, { status: 'running', timed_out: true });
      }
      const fresh = runStateStore.read(args.run_id) ?? state;
      return buildGetRunStatusResponse(
        fresh,
        runStateStore,
        args.run_id,
        cursor,
        args.log_lines,
        args.max_events_tail,
      );
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
        const env = { run_id: args.run_id, ok: false, reason };
        return markdownContent(renderCancelMarkdown(env), env);
      }
      // Trigger abort — the existing run:cancelled lifecycle listener
      // will mark the run terminal with status='cancelled'.
      dispatcher.cancel(inFlight.toolCallId, 'cancel_run requested');
      const env = { run_id: args.run_id, ok: true };
      return markdownContent(renderCancelMarkdown(env), env);
    },
  );

  return { server, dispatcher, worktreeManager, runStateStore };
}

function resolveMergeConfirmationGate(crewHome: string):
  | { enabled: boolean; error?: undefined }
  | { enabled?: undefined; error: string } {
  if (process.env.CREW_CONFIRM_BEFORE_MERGE === 'off') {
    return { enabled: false };
  }
  // readConfigFile is forgiving — fs/JSON failures return DEFAULT_CONFIG
  // (confirmBeforeMerge=true), which is fail-closed by default. We don't
  // need a wrapping try/catch here.
  return { enabled: readConfigFile(crewHome).confirmBeforeMerge };
}

/**
 * Production entry point. Builds the server, wires SIGINT/SIGTERM, connects
 * stdio. Blocks until the transport closes (stdin EOF) or a signal arrives.
 */
export async function serveCommand(options: ServeOptions = {}): Promise<void> {
  // Diagnostic file logging: honor either the explicit option or the env
  // var. Resolved before buildCrewMcpServer so startup messages (worktree
  // manager init, stale-run sweep result, registry probes) are captured.
  // Failure to open the file logs to stderr and proceeds — the server must
  // still come up even if the path is unwritable.
  const rawLogFile = options.logFile ?? process.env.CREW_LOG_FILE;
  if (rawLogFile && rawLogFile.trim().length > 0) {
    const cwd = options.cwd ?? process.cwd();
    const resolved = isAbsolute(rawLogFile) ? rawLogFile : join(cwd, rawLogFile);
    try {
      setLogFilePath(resolved);
      logger.info(`crew-mcp serve: file logging enabled at ${resolved}`);
    } catch (err) {
      logger.warn(
        `crew-mcp serve: failed to open log file ${resolved}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

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
  /**
   * Adapter id for this dispatch. Used as the `[prefix]` on
   * `notifications/progress` chunks (so the host UI labels each line
   * with which subagent emitted it) and surfaced in the markdown
   * tool-call result for human readability. Must match the adapter
   * the dispatcher is invoking — the captain's `run_agent` /
   * `continue_run` call sites both have it on hand.
   */
  agentName: string;
  worktreePath: string;
  toolCallId: string;
  task: import('../../orchestrator/tool-dispatcher.js').DispatchTask;
  dispatcher: ToolDispatcher;
  runStateStore: RunStateStore;
  /**
   * Advisory warnings generated before dispatch, such as peer_messages
   * truncation or cap repair notices. These are shown in the immediate
   * dispatch envelope while terminal adapter warnings continue to persist
   * through markTerminal().
   */
  warnings?: readonly string[];
  /**
   * Optional MCP progress notifier — when supplied, each adapter
   * onOutput chunk fires `notifications/progress` so the host CLI
   * can render live streaming output during the tool call. Absent
   * when the client did not include a `progressToken` in the request
   * `_meta`. Callers build this via `progressNotifierFrom(extra)`.
   */
  progress?: ProgressNotifier;
  /**
   * Host-CLI classification (claude-code / codex / gemini / unknown),
   * resolved once per server lifetime from the MCP initialize handshake.
   * Drives the "next step" copy in the dispatch envelope: Claude Code
   * captains need to spawn a watcher overlay; Codex / Gemini captains
   * just end the turn. See `nextStepSentence`.
   */
  clientKind: ClientKind;
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
 * returns `status: "running"` immediately and the captain yields the
 * turn after dispatch. Lifecycle listeners keep state.json current
 * while the user can keep chatting.
 *
 * Why: the prior model produced a 60s opening blackout for every
 * dispatch on hosts that don't surface MCP progress notifications
 * (codex), and snapshot polling at 10–20s cadence felt like a hung
 * UI even when the agent was actively working. Async-first lets the
 * captain hand chat back to the user while progress remains available
 * via the tail side channel and later status reads.
 *
 * The lifecycle listeners installed here keep firing in the
 * background after we return — they own state.json writes on
 * terminal events. Later status reads observe state.json + events.log.
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
    agentName: args.agentName,
    toolCallId: args.toolCallId,
    progress: args.progress,
  });
  args.dispatcher.start(args.task);

  const summary = `Dispatched as "${args.runId}". ${nextStepSentence(args.clientKind)}`;
  const eventsLogPath = args.runStateStore.eventsLogPath(args.runId);
  const tailCommandPath = args.runStateStore.tailCommandPath(args.runId);
  const env: FullRunEnvelope = {
    run_id: args.runId,
    agent_id: args.agentName,
    worktree_path: args.worktreePath,
    events_log_path: eventsLogPath,
    tail_command_path: tailCommandPath,
    tail_command_url: fileUrlHref(tailCommandPath),
    tail_url: crewTailUrl(eventsLogPath),
    status: 'running',
    summary,
    files_changed: [],
    ...mergeEnvelopeWarnings(
      args.runStateStore.read(args.runId)?.warnings,
      args.warnings,
    ),
  };
  return {
    content: [{ type: 'text' as const, text: renderDispatchMarkdown(env, args.clientKind) }],
    structuredContent: structuredRunEnvelope(env) as unknown as Record<string, unknown>,
  };
}

function structuredRunEnvelope(env: FullRunEnvelope): RunEnvelope {
  if (process.env.CREW_FULL_ENVELOPE === '1') {
    return env;
  }
  return {
    run_id: env.run_id,
    tail_url: env.tail_url,
    summary: env.summary,
    files_changed: env.files_changed,
    ...(env.warnings !== undefined ? { warnings: env.warnings } : {}),
  };
}

/**
 * Human-facing markdown rendered into the MCP tool-call result for
 * `run_agent` / `continue_run`. Hosts that show the result inline
 * (Claude Code's expand-on-click panel, codex's `> tool` block)
 * render this directly; the structured payload still travels via
 * `structuredContent` for programmatic consumers.
 *
 * Why markdown over the prior JSON.stringify: hosts collapse MCP
 * tool calls to a one-line title and only show the result when the
 * user expands. Raw JSON in that expand reads as noise; a short
 * markdown block reads as a status report. Captain still extracts
 * `run_id` reliably — it appears in a backticked code span the
 * model can pluck verbatim.
 */
function renderDispatchMarkdown(env: FullRunEnvelope, clientKind: ClientKind): string {
  const lines = [
    `**Dispatched** ${mdInlineCode(env.agent_id ?? 'agent')} as run \`${env.run_id}\`.`,
    '',
    `- Status: \`${env.status}\``,
    `- Worktree: ${mdInlineCode(env.worktree_path)}`,
  ];
  // The clickable custom-scheme link only does something useful on macOS,
  // where LaunchServices can route `crew-tail://` to the optional handler
  // app. On Linux/Windows (and on macOS before installation), the manual
  // tail line below stays the portable recovery path. Rationale comments
  // live here, not in the user-visible markdown — captains read this on
  // every dispatch.
  if (process.platform === 'darwin') {
    lines.push(
      `- **Tail in Terminal**: [open in a side window](${env.tail_url})`,
    );
  }
  lines.push(
    `- Tail manually: \`tail -F ${env.events_log_path}\``,
    `- Next: ${nextStepSentence(clientKind)}`,
    `- Later status read: \`get_run_status({ run_id: "${env.run_id}" })\``,
  );
  if (env.warnings && env.warnings.length > 0) {
    lines.push(
      '',
      '## Warnings',
      '',
      ...env.warnings.map((warning) => `- ${warning}`),
    );
  }
  return lines.join('\n');
}

function mergeEnvelopeWarnings(
  ...warnings: Array<readonly string[] | undefined>
): { warnings?: readonly string[] } {
  const merged = warnings.flatMap((entry) => entry ?? []);
  return merged.length > 0 ? { warnings: merged } : {};
}

/**
 * Convert an absolute filesystem path to a `file://` URI. `pathToFileURL`
 * handles URI delimiters such as `#` and `?` as literal path characters.
 */
export function fileUrlHref(absPath: string): string {
  return pathToFileURL(absPath).href;
}

function mdInlineCode(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, ' ');
  if (!normalized.includes('`')) return `\`${normalized}\``;
  const longestBacktickRun = Math.max(
    ...Array.from(normalized.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = '`'.repeat(Math.max(2, longestBacktickRun + 1));
  return `${fence} ${normalized} ${fence}`;
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
  /**
   * Adapter id, threaded through purely so progress-notification
   * messages can be prefixed `[<agent>]`. Hosts that render
   * `notifications/progress` inline (Claude Code) get a labeled
   * stream so multi-agent dispatches don't blur together.
   */
  agentName: string;
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
        const progressLines = formatProgressLines(args.agentName, info.chunk);
        try {
          for (const line of progressLines) {
            args.runStateStore.appendEvent(args.runId, line);
          }
        } catch {
          // Log writes are best-effort; never let a write failure break dispatch.
        }
        // Bridge to MCP progress notifications when the client supplied
        // a progressToken. Adapters typically emit line-buffered chunks
        // (codex/claude-code/gemini-cli all do); we split multi-line
        // chunks so each rendered line is a discrete progress message
        // rather than a wall of text the host has to layout itself.
        // events.log and host UI share the same canonical server-side
        // agent prefix so event tails and progress notifications match.
        if (args.progress) {
          for (const line of progressLines) {
            args.progress.send(line);
          }
        }
      }),
    );
  });
}

/**
 * Maximum per-line length sent in a `notifications/progress` message.
 * Picked so a chunk fits comfortably in Claude Code's inline progress
 * area (~one terminal line at default width) without truncating
 * anything that's actually load-bearing in adapter output. Bigger
 * payloads get truncated with an ellipsis suffix. The same bounded,
 * prefixed lines are written to `events.log`, keeping `events_tail`
 * and inline progress consistent.
 */
const PROGRESS_LINE_MAX_LEN = 240;

/**
 * Format an adapter `onOutput` chunk into one or more progress
 * notification messages. Splits on newlines (multi-line chunks
 * become multiple notifications), drops empty lines, trims trailing
 * whitespace, truncates over-long lines, and prefixes each line
 * with `[<agentName>] ` so the host inline display labels who's
 * speaking.
 *
 * Exported for tests. The contract is intentionally narrow: input
 * is a raw chunk + agent id, output is the lines to feed into
 * `progress.send` in order. No parsing of JSON event lines (that's
 * the domain of the parked structured-events plan); we only do
 * presentation cleanup.
 */
export function formatProgressLines(agentName: string, chunk: string): string[] {
  const out: string[] = [];
  for (const raw of chunk.split(/\r\n|\r|\n/)) {
    const trimmed = raw.replace(/\s+$/, '');
    if (trimmed.length === 0) continue;
    const prefix = `[${agentName}] `;
    if (prefix.length >= PROGRESS_LINE_MAX_LEN) {
      out.push(takeCodePointBudget(prefix, PROGRESS_LINE_MAX_LEN));
      continue;
    }
    const bodyBudget = PROGRESS_LINE_MAX_LEN - prefix.length;
    const unprefixed = trimmed.startsWith(prefix)
      ? trimmed.slice(prefix.length)
      : trimmed;
    const body =
      unprefixed.length > bodyBudget
        ? `${takeCodePointBudget(unprefixed, bodyBudget - 1)}…`
        : unprefixed;
    out.push(`${prefix}${body}`);
  }
  return out;
}

function takeCodePointBudget(value: string, maxCodeUnits: number): string {
  if (maxCodeUnits <= 0) return '';
  let used = 0;
  let out = '';
  for (const codePoint of value) {
    const next = used + codePoint.length;
    if (next > maxCodeUnits) break;
    out += codePoint;
    used = next;
  }
  return out;
}

/**
 * Per-server one-shot loud-log state for progressToken presence/absence.
 * The per-call info-level log still fires every dispatch; this state
 * is only consulted to elevate the FIRST occurrence to warn so the
 * "is my host streaming progress?" question has a hard-to-miss
 * answer at server startup. Reset per `buildCrewMcpServer` so tests
 * (which spin a fresh server per case) start clean.
 */
interface ProgressTokenSeen {
  presentLogged: boolean;
  absentLogged: boolean;
  lastObserved?: 'present' | 'absent';
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
function progressNotifierFrom(
  extra: {
    _meta?: { progressToken?: string | number };
    sendNotification: (n: {
      method: 'notifications/progress';
      params: { progressToken: string | number; progress: number; message?: string };
    }) => Promise<void>;
  },
  agentId: string,
  seen: ProgressTokenSeen,
): ProgressNotifier | undefined {
  const token = extra._meta?.progressToken;
  const observed = token === undefined ? 'absent' : 'present';
  // Per-call info log: a one-liner the operator can grep when sanity-
  // checking a single dispatch ("did this run get a token?"). Cheap.
  logger.info(
    `progress token (agent=${agentId}): ${
      token === undefined ? 'absent (no streaming chunks to captain)' : String(token)
    }`,
  );
  if (seen.lastObserved !== undefined && seen.lastObserved !== observed) {
    logger.info(
      `progressToken state changed from ${seen.lastObserved} to ${observed} this server session (agent=${agentId}).`,
    );
  }
  seen.lastObserved = observed;
  // First-occurrence warn-level log: the question "is my host actually
  // providing a progressToken?" deserves a loud answer the first time
  // it's answered, so users catch a missing token without grepping
  // info-level lines. Subsequent calls fall back to the info log
  // above so we don't spam.
  if (token === undefined && !seen.absentLogged) {
    seen.absentLogged = true;
    logger.warn(
      'progressToken absent on first dispatch without a token this server session ' +
      `(agent=${agentId}). Inline notifications/progress will not fire for this call. ` +
      'The dispatch markdown\'s tail.command / events.log side-channel and any ' +
      'later get_run_status / list_runs reads are the live progress paths. ' +
      'Known: codex CLI 0.128.0 omits the token; Claude Code supplies it.',
    );
  } else if (token !== undefined && !seen.presentLogged) {
    seen.presentLogged = true;
    logger.info(
      `progressToken present on first dispatch with a token this server session (agent=${agentId}); inline progress streaming active for this call.`,
    );
  }
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
 * `get_run_status` payload shape — intentionally lean to keep the
 * captain's context window clean across long-poll loops.
 *
 * **Always present:** `status`, `events_tail`, `next_event_line`,
 * except terminal-only wait timeouts, which intentionally return only
 * `{status:"running", timed_out:true}`. While the run is `running`,
 * that's *all* — every other field is either static (already returned
 * in the run_agent / continue_run dispatch result: run_id and tail_url
 * in structuredContent by default, plus human-facing worktree/tail
 * details in markdown) or terminal-only.
 *
 * **Terminal-only fields** appear when `status` ∈ {success, partial,
 * error, cancelled, merged, merge_conflict, discarded}: `filesChanged`,
 * `prompts` (turn metadata only — `{turn, startedAt, completedAt}`;
 * per-turn summaries and verbatim prompts are durable in state.json
 * but elided here so multi-turn polls don't re-ship prior output the
 * captain already received in earlier tool returns), `summary`
 * (top-level convenience for the last turn's adapter output), and
 * the conditional `lastError` / `mergeStatus` / `warnings` /
 * `readOnly`. `events_tail` carries the recent tail of the full run
 * log on terminal (capped per `max_events_tail`).
 *
 * `log_tail` is retained for legacy snapshot callers that pass
 * `log_lines` without a cursor — modern captains use the cursor
 * exclusively via `next_event_line`.
 */
interface GetRunStatusResponse {
  readonly status: string;
  readonly events_tail: readonly string[];
  readonly next_event_line: number;
  readonly timed_out?: true;
  // Terminal-only fields. Indexed-signature shape kept additive so the
  // server can grow new terminal fields without revising every caller's
  // type narrowing.
  readonly [key: string]: unknown;
  readonly events_tail_skipped?: number;
  readonly log_tail?: readonly string[];
}

/**
 * Public projection of a per-turn record on terminal poll-returns.
 * Mirrors `PromptRecord` from run-state.ts minus `prompt` and
 * `summary` — verbatim prompt text and per-turn output are durable
 * on disk in state.json but not worth re-shipping on every poll.
 * Top-level `summary` carries the latest turn's output for
 * convenience; prior-turn summaries are recoverable from state.json
 * if a captain ever needs them post-compaction. Multi-turn runs
 * see the biggest savings — a 5-turn p90 run was previously
 * shipping ~30K chars of redundant per-turn summaries on every
 * terminal poll.
 */
type TerminalPromptRecord = {
  readonly turn: number;
  readonly startedAt: string;
  readonly completedAt?: string;
};

function buildGetRunStatusResponse(
  state: RunStateV1,
  store: RunStateStore,
  runId: string,
  sinceLine: number,
  logLines: number | undefined,
  maxEventsTail: number | undefined,
): ToolCallReturn {
  // Captain-context conservation: while the run is running, `events_tail`
  // is intentionally empty. Captains coordinate; they don't narrate. Users
  // follow along via the dispatch result's `tail_url` on macOS (or the
  // generated `tail.command` helper / manual tail line elsewhere). The
  // cursor (`next_event_line`) still advances so anything that *does* read
  // events_tail later — most
  // importantly, the terminal poll-return — has a coherent view.
  const status = state.status;
  const terminal = isTerminalRunStatus(status);

  // Always advance the cursor relative to the requested sinceLine; the
  // file is the source of truth and the cursor must match it regardless
  // of whether we're emitting events_tail content this turn.
  let cursorAfterDelta: number;

  let cappedLines: readonly string[] = [];
  let skipped = 0;
  // Skip the tail build for discarded runs: the worktree is gone and the
  // captain rarely wants forensics on a run the user explicitly threw
  // away. `events_log_path` still resolves on disk if anyone needs it.
  if (terminal && status !== 'discarded') {
    // On terminal: ignore the cursor and return the recent tail of the
    // entire log. The captain wants "what the run did" for its final
    // summary, not "what happened since my last 30s long-poll" — those
    // are usually the same anyway because terminal events fire close to
    // last activity, but this gives a stable rendering surface even
    // across long-quiet runs.
    //
    // Filter pure adapter receipts (codex command-started / exit-0
    // / item.* lines) before applying the cap so the budget gets
    // spent on synthesis lines, not on `command: started ...` noise
    // the captain reads and learns nothing from. events.log on disk
    // is unchanged — users tailing `events_log_path` see everything.
    const maxTail = maxEventsTail ?? DEFAULT_MAX_EVENTS_TAIL;
    const tail = store.readFilteredTailFromEnd(runId, maxTail);
    cursorAfterDelta = tail.totalLineCount;
    const overCap = tail.totalFilteredCount > maxTail;
    // Reserve one slot for the "(N skipped)" marker so total length
    // stays at maxTail — keeps verbatim renderers honest about elision.
    const eventLineBudget = overCap ? Math.max(0, maxTail - 1) : maxTail;
    skipped = overCap ? tail.totalFilteredCount - eventLineBudget : 0;
    const tailLines = eventLineBudget > 0 ? tail.lines.slice(-eventLineBudget) : [];
    cappedLines = overCap
      ? [`(${skipped} more events skipped)`, ...tailLines]
      : tail.lines;
  } else {
    const { nextLine } = store.readEventsSince(runId, sinceLine);
    cursorAfterDelta = nextLine;
  }

  // Legacy snapshot tail — only populated for callers that passed
  // `log_lines` without a cursor. Same in both running and terminal
  // branches; computed once.
  const legacyLogTail = sinceLine === 0 && logLines !== undefined
    ? { log_tail: store.tailEvents(runId, logLines) }
    : {};

  // Running poll-return: minimum viable payload. The captain already
  // has run_id/tail_url from dispatch structuredContent and the
  // worktree/manual-tail details from dispatch markdown; we do not
  // re-ship them on every long-poll wake-up.
  if (!terminal) {
    const payload: GetRunStatusResponse = {
      status,
      events_tail: cappedLines,
      next_event_line: cursorAfterDelta,
      ...legacyLogTail,
    };
    return getRunStatusContent(runId, payload);
  }

  // Terminal poll-return: include the synthesis surface the captain
  // needs for its end-of-run summary. Each conditional spread keeps
  // unset fields off the wire entirely (avoids null/undefined noise).
  const projectedPrompts: readonly TerminalPromptRecord[] = state.prompts.map((p) => ({
    turn: p.turn,
    startedAt: p.startedAt,
    ...(p.completedAt !== undefined ? { completedAt: p.completedAt } : {}),
  }));
  const lastSummary = state.prompts.length > 0
    ? state.prompts[state.prompts.length - 1]?.summary
    : undefined;

  const payload: GetRunStatusResponse = {
    status,
    events_tail: cappedLines,
    next_event_line: cursorAfterDelta,
    filesChanged: state.filesChanged,
    prompts: projectedPrompts,
    ...(lastSummary !== undefined ? { summary: lastSummary } : {}),
    ...(state.lastError !== undefined ? { lastError: state.lastError } : {}),
    ...(state.mergeStatus !== undefined ? { mergeStatus: state.mergeStatus } : {}),
    ...(state.warnings !== undefined ? { warnings: state.warnings } : {}),
    ...(state.readOnly ? { readOnly: state.readOnly } : {}),
    ...(skipped > 0 ? { events_tail_skipped: skipped } : {}),
    ...legacyLogTail,
  };
  return getRunStatusContent(runId, payload);
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
 * Grace window for the stale-run sweeper. Records whose most recent
 * `prompts[].startedAt` is within this window are skipped even when
 * `serverPid` resolves to ESRCH — see the same-second restart race
 * detailed at the call site. Default chosen to cover host MCP-lifecycle
 * recycle cycles (Conductor was observed at ~3s SIGTERM after dispatch)
 * with comfortable headroom; override via `CREW_STALE_RUN_GRACE_MS`.
 */
export const DEFAULT_STALE_RUN_GRACE_MS = 30_000;

function resolveStaleRunGraceMs(): number {
  const raw = process.env.CREW_STALE_RUN_GRACE_MS;
  if (raw === undefined) return DEFAULT_STALE_RUN_GRACE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_STALE_RUN_GRACE_MS;
  return Math.floor(parsed);
}

const STALE_RUN_GRACE_MS = resolveStaleRunGraceMs();

/**
 * Most recent timestamp at which `serverPid` was stamped onto a run —
 * either the original `create()` (top-level `startedAt`) or the last
 * `appendPrompt()` (last `prompts[].startedAt`, since both reset the
 * PID). Returns epoch ms, or `undefined` if neither parses.
 */
function latestStampedAt(state: RunStateV1): number | undefined {
  const prompts = state.prompts;
  const lastPrompt = prompts && prompts.length > 0 ? prompts[prompts.length - 1] : undefined;
  const candidate = lastPrompt?.startedAt ?? state.startedAt;
  if (typeof candidate !== 'string') return undefined;
  const ms = Date.parse(candidate);
  return Number.isFinite(ms) ? ms : undefined;
}

function markAbandonedRunningRuns(args: StaleRunSweepArgs): void {
  const runsDir = join(args.crewHome, 'runs');
  const currentRepoRoot = resolveComparableRepoRoot(args.projectRoot);
  let entries: Dirent[];
  try {
    entries = readdirSync(runsDir, { withFileTypes: true });
  } catch (err) {
    logger.warn(
      `stale-run sweeper: failed to read ${runsDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    if (runId === '.meta' || runId === '.locks') continue;
    const statePath = join(runsDir, runId, 'state.json');
    if (!existsSync(statePath)) continue;
    let state: RunStateV1;
    try {
      state = JSON.parse(readFileSync(statePath, 'utf-8')) as RunStateV1;
    } catch (err) {
      logger.warn(
        `stale-run sweeper: failed to read state for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    if (state.status !== 'running') continue;
    if (state.repoRoot === undefined) continue;
    if (resolveComparableRepoRoot(state.repoRoot) !== currentRepoRoot) continue;
    // Multi-server safety: every dispatched agent's MCP connection
    // spawns its own crew-mcp server. Without this gate, each
    // sub-server's startup sweep would mark its sibling agents'
    // in-flight runs as abandoned within seconds of dispatch.
    //
    // Skip if serverPid is missing (legacy records pre-dating the
    // field — we don't know if they're still owned, so don't kill
    // them; user can `discard_run` manually if truly stale) OR if
    // serverPid resolves to a live process. Only sweep records we
    // can prove are abandoned (PID set, ESRCH on lookup).
    if (state.serverPid === undefined || isProcessAlive(state.serverPid)) {
      continue;
    }
    // Same-second restart race: if the host is recycling crew-mcp
    // within ~seconds of dispatch (observed under Conductor — see
    // ABANDONED_SERVER_RESTART_DIAGNOSIS) the new server can boot
    // fast enough that the dying predecessor's serverPid is already
    // ESRCH by the time this sweep runs, even though the codex child
    // it spawned is technically still alive (or has just been
    // SIGTERMed and is exiting). Skip records whose most recent
    // prompt was started within the last `STALE_RUN_GRACE_MS`:
    // they're either in-flight under a new server or seconds-fresh
    // garbage that the next dispatch (or a user-initiated
    // discard_run) will clear up properly. We use the latest
    // `prompts[].startedAt` because `serverPid` is re-stamped on
    // `appendPrompt` (continue_run), so a long-lived run that just
    // received a new prompt should be protected too.
    const lastStampedAt = latestStampedAt(state);
    if (lastStampedAt !== undefined) {
      const ageMs = Date.now() - lastStampedAt;
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < STALE_RUN_GRACE_MS) {
        continue;
      }
    }

    try {
      args.runStateStore.markTerminal(runId, {
        status: 'error',
        summary: 'abandoned (server restart)',
        filesChanged: [],
        lastError: 'abandoned (server restart)',
      });
    } catch (err) {
      logger.warn(
        `stale-run sweeper: failed to mark ${runId} abandoned: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Returns true iff the OS reports the given PID as a live process
 * we either own or can observe. `process.kill(pid, 0)`:
 *   - returns void if the process exists and we have permission to signal it,
 *   - throws ESRCH if the process doesn't exist,
 *   - throws EPERM if the process exists but we lack signal permission.
 * Both "alive" cases mean "don't sweep" — only ESRCH (or other unexpected
 * errors, treated conservatively as alive) lets the run be marked abandoned.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM (or anything else unexpected) → conservatively treat as alive.
    return true;
  }
}

function resolveComparableRepoRoot(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Block until the dispatcher fires a watched event for `runId`, OR
 * `waitMs` elapses — whichever happens first. Returns true when the
 * wait elapsed rather than an event waking it. Normal long-polls watch
 * signal stream chunks plus terminal events; terminal-only long-polls
 * omit the stream subscription entirely so stream chunks never wake
 * the captain. Listeners self-dispose on either path. The next
 * `get_run_status` snapshot read picks up the latest state + events.
 */
async function waitForRunChange(args: {
  dispatcher: ToolDispatcher;
  agentName: string;
  runId: string;
  waitMs: number;
  terminalOnly: boolean;
}): Promise<boolean> {
  const subs: Array<{ dispose(): void }> = [];
  return new Promise<boolean>((resolve) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (timedOut: boolean): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const s of subs) s.dispose();
      resolve(timedOut);
    };
    const matches = (info: { runId?: string }): boolean => info.runId === args.runId;
    if (!args.terminalOnly) {
      // Stream wake-ups gate on signal: a chunk that the noise filter
      // would drop (codex receipt lines like "command: started ...",
      // "(exit 0)", or item.* lifecycle frames) does NOT resolve the
      // long-poll. The dispatcher still fires `run:stream` for every
      // chunk and `events.log` still records it; we just don't wake
      // the captain on noise. Terminal-only waits skip this
      // subscription entirely. See
      // docs/plans/active/noise-symmetric-filter.md.
      subs.push(args.dispatcher.onEvent('run:stream', (info) => {
        if (!matches(info)) return;
        const lines = formatProgressLines(args.agentName, info.chunk);
        if (filterEventsTailNoise(lines).length === 0) return;
        finish(false);
      }));
    }
    subs.push(
      args.dispatcher.onEvent('run:complete', (info) => {
        if (matches(info)) finish(false);
      }),
      args.dispatcher.onEvent('run:failed', (info) => {
        if (matches(info)) finish(false);
      }),
      args.dispatcher.onEvent('run:cancelled', (info) => {
        if (matches(info)) finish(false);
      }),
    );
    timer = setTimeout(() => finish(true), args.waitMs);
  });
}

function markdownContent<T extends object>(
  text: string,
  value: T,
  isError = false,
): ToolCallReturn {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: value as unknown as Record<string, unknown>,
    isError,
  };
}

function jsonContent<T extends object>(value: T, isError = false): ToolCallReturn {
  return markdownContent(JSON.stringify(value), value, isError);
}

function renderMergeMarkdown(env: MergeEnvelope): string {
  if (env.status === 'merged') {
    return `**Merged** ${mdInlineCode(env.run_id)} → ${mdInlineCode(env.commit_sha ?? '')}`;
  }
  if (env.status === 'conflict') {
    const conflicts = env.conflicts ?? [];
    return `**Conflict** on ${mdInlineCode(env.run_id)} (${conflicts.length} files): ${conflicts.join(', ')}`;
  }
  return `**No changes** to merge from ${mdInlineCode(env.run_id)}`;
}

function renderDiscardMarkdown(env: DiscardEnvelope): string {
  return `**Discarded** ${mdInlineCode(env.run_id)}`;
}

function renderCancelMarkdown(env: {
  readonly run_id: string;
  readonly ok: boolean;
  readonly reason?: string;
}): string {
  if (env.ok) {
    return `**Cancelled** ${mdInlineCode(env.run_id)}`;
  }
  return `${mdInlineCode(env.run_id)} not cancelled: ${env.reason ?? 'unknown reason'}`;
}

function getRunStatusContent<T extends object>(
  runId: string,
  payload: T,
): ToolCallReturn {
  return markdownContent(renderGetRunStatusMarkdown(runId, payload), payload);
}

function renderGetRunStatusMarkdown(
  runId: string,
  payload: {
    readonly status?: unknown;
    readonly timed_out?: unknown;
    readonly next_event_line?: unknown;
    readonly filesChanged?: unknown;
    readonly summary?: unknown;
    readonly events_tail_skipped?: unknown;
  },
): string {
  const status = typeof payload.status === 'string' ? payload.status : 'unknown';
  if (payload.timed_out === true) {
    const cursor = typeof payload.next_event_line === 'number'
      ? ` at cursor ${payload.next_event_line}`
      : '';
    return `${mdInlineCode(runId)} status: \`${status}\` (timed out${cursor})`;
  }

  if (!isTerminalRunStatus(status)) {
    const cursor = typeof payload.next_event_line === 'number'
      ? String(payload.next_event_line)
      : 'unknown';
    return `${mdInlineCode(runId)} status: \`${status}\` (cursor: ${cursor})`;
  }

  const lines = [`**${mdInlineCode(runId)} ${status}**`];
  const filesChanged = Array.isArray(payload.filesChanged)
    ? payload.filesChanged.filter((path): path is string => typeof path === 'string')
    : [];
  if (filesChanged.length > 0) {
    const firstPaths = filesChanged.slice(0, 3).join(', ');
    const more = filesChanged.length > 3
      ? ` [+ ${filesChanged.length - 3} more]`
      : '';
    lines.push(`${filesChanged.length} files changed: ${firstPaths}${more}`);
  }
  if (typeof payload.summary === 'string') {
    lines.push(`> ${truncateMarkdownSummary(payload.summary, 200)}`);
  }
  if (
    typeof payload.events_tail_skipped === 'number'
    && payload.events_tail_skipped > 0
  ) {
    lines.push(`${payload.events_tail_skipped} events skipped`);
  }
  return lines.join('\n');
}

function truncateMarkdownSummary(summary: string, maxChars: number): string {
  const normalized = summary.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
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
