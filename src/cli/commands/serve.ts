// `crew-mcp serve` — the v2 stdio MCP server entry point.
//
// The host CLI (Claude Code / Codex / Gemini) spawns this command at session
// start via its MCP config block. We expose v2's MCP tool surface over
// stdio:
//
//   list_agents      — synchronous probe of the agent registry
//   get_crew_preferences — read configured agent defaults
//   list_runs        — recover persisted run records for the current repo
//   run_agent        — dispatch into a fresh worktree (block-and-stream
//                      with 60s async-fallback)
//   continue_run     — re-invoke the agent in an existing worktree
//   merge_run        — merge a worktree into the host's HEAD (the only
//                      mutating tool; host CLI must confirm with user)
//   discard_run      — abandon a worktree without merging
//   cancel_run       — abort an in-flight run
//   get_run_status   — poll a run's state.json + tail of events.log
//   run_panel        — dispatch a parallel reviewer panel
//   get_panel_status — read panel reviewer status
//   aggregate_panel  — build peer_messages from panel results
//   create_criteria / confirm_criteria / get_criteria / revise_criteria
//                    — persist and approve acceptance criteria for dispatch
//
// Logging discipline: stdout is reserved for the MCP wire protocol. The
// project's logger (src/utils/logger.ts) emits to stderr via console.error,
// which is safe; do NOT introduce any console.log() calls in the hot path.

import { existsSync, readFileSync, readdirSync, realpathSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { AdapterRegistry } from '../../adapters/registry.js';
import {
  BUILTIN_ADAPTER_NAMES,
  createBuiltinRegistry,
  mergeCustomAgents,
} from '../../adapters/registry.js';
import { WorktreeManager } from '../../git/worktree.js';
import { ToolDispatcher } from '../../orchestrator/tool-dispatcher.js';
import {
  drainPendingTerminalPersists,
} from '../../orchestrator/run-lifecycle-listeners.js';
import {
  QuotaCache,
  probeQuota,
  recordQuotaObservation,
} from '../../orchestrator/quota-cache.js';
import { RunStateStore, type RunStateV1 } from '../../orchestrator/run-state.js';
import { gcTerminalRunsAndCriteriaSets, type RunGcArgs } from '../../orchestrator/run-gc.js';
import {
  listAgentsInputSchema,
  listAgentsToolHandler,
  LIST_AGENTS_DESCRIPTION,
} from '../../orchestrator/tools/list-agents.js';
import {
  getCrewPreferencesInputSchema,
  getCrewPreferencesToolHandler,
  GET_CREW_PREFERENCES_DESCRIPTION,
} from '../../orchestrator/tools/get-crew-preferences.js';
import {
  listRunsInputSchema,
  listRunsToolHandler,
  LIST_RUNS_DESCRIPTION,
} from '../../orchestrator/tools/list-runs.js';
import {
  runAgentToolHandler,
  runAgentInputSchema,
  RUN_AGENT_DESCRIPTION,
} from '../../orchestrator/tools/run-agent.js';
import {
  continueRunInputSchema,
  continueRunToolHandler,
  CONTINUE_RUN_DESCRIPTION,
} from '../../orchestrator/tools/continue-run.js';
import {
  mergeRunInputSchema,
  mergeRunToolHandler,
  MERGE_RUN_DESCRIPTION,
} from '../../orchestrator/tools/merge-run.js';
import {
  cancelRunInputSchema,
  cancelRunToolHandler,
  CANCEL_RUN_DESCRIPTION,
} from '../../orchestrator/tools/cancel-run.js';
import {
  discardRunInputSchema,
  discardRunToolHandler,
  DISCARD_RUN_DESCRIPTION,
} from '../../orchestrator/tools/discard-run.js';
import {
  getRunStatusInputSchema,
  getRunStatusToolHandler,
  GET_RUN_STATUS_DESCRIPTION,
} from '../../orchestrator/tools/get-run-status.js';
import {
  runPanelInputSchema,
  runPanelToolHandler,
  RUN_PANEL_DESCRIPTION,
} from '../../orchestrator/tools/run-panel.js';
import {
  getPanelStatusInputSchema,
  getPanelStatusToolHandler,
  GET_PANEL_STATUS_DESCRIPTION,
} from '../../orchestrator/tools/get-panel-status.js';
import {
  aggregatePanelInputSchema,
  aggregatePanelToolHandler,
  AGGREGATE_PANEL_DESCRIPTION,
} from '../../orchestrator/tools/aggregate-panel.js';
import {
  createCriteriaInputSchema,
  createCriteriaToolHandler,
  CREATE_CRITERIA_DESCRIPTION,
} from '../../orchestrator/tools/create-criteria.js';
import {
  confirmCriteriaInputSchema,
  confirmCriteriaToolHandler,
  CONFIRM_CRITERIA_DESCRIPTION,
} from '../../orchestrator/tools/confirm-criteria.js';
import {
  getCriteriaInputSchema,
  getCriteriaToolHandler,
  GET_CRITERIA_DESCRIPTION,
} from '../../orchestrator/tools/get-criteria.js';
import {
  reviseCriteriaInputSchema,
  reviseCriteriaToolHandler,
  REVISE_CRITERIA_DESCRIPTION,
} from '../../orchestrator/tools/revise-criteria.js';
import {
  classifyClient,
  type ClientKind,
  type ProgressTokenSeen,
  type ToolHandlerDeps,
} from '../../orchestrator/tools/shared.js';
import { readAgentPrefsFile } from '../../agent-prefs/store.js';
import { manifestPath } from '../../install/install-manifest.js';
import { projectManifestPath } from '../../install/project-install-manifest.js';
import type { HostId } from '../../install/hosts/index.js';
import { resolveCrewHome } from '../../utils/crew-home.js';
import { logger, setLogFilePath } from '../../utils/logger.js';
import { CREW_MCP_VERSION } from '../version.js';

export const SERVE_VERSION = CREW_MCP_VERSION;

// Re-export for callers that imported these from this module.
// Canonical definitions live in `orchestrator/tools/get-run-status` so
// the schema bound and the default share one source of truth.
export { DEFAULT_MAX_EVENTS_TAIL, MAX_EVENTS_TAIL_CAP } from '../../orchestrator/tools/get-run-status.js';
export { formatProgressLines } from '../../orchestrator/progress.js';
export {
  classifyClient,
  fileUrlHref,
  MAX_LONG_POLL_MS,
  nextStepSentence,
} from '../../orchestrator/tools/shared.js';
export type {
  ClientKind,
  DiscardEnvelope,
  FullRunEnvelope,
  MergeEnvelope,
  RunEnvelope,
  RunStatus,
} from '../../orchestrator/tools/shared.js';

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
   * Test seam for reading the user-scope install manifest. Production
   * defaults to the OS home; if `crewHome` is explicitly a `.crew`
   * directory, that parent is used so custom CREW_HOME installs can
   * still resolve their adjacent manifest.
   */
  home?: string;

  /**
   * Test seam: override the stale-run sweeper while preserving the same
   * deferred scheduling path used in production.
   */
  staleRunSweeper?: (args: StaleRunSweepArgs) => void | Promise<void>;

  /**
   * Test seam: override the terminal-run garbage collector while preserving
   * the same deferred scheduling path used in production.
   */
  runGc?: (args: RunGcArgs) => void | Promise<unknown>;

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

export const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

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
  dispatcher: ToolDispatcher;
};

const staleRunSweepPromises = new Map<string, Promise<void>>();

export function getStaleRunSweep(): Promise<void> | null {
  return joinInFlightPromises(staleRunSweepPromises);
}

export function scheduleStaleRunSweep(
  args: StaleRunSweepArgs,
  sweep: (args: StaleRunSweepArgs) => void | Promise<void> = markAbandonedRunningRuns,
): Promise<void> {
  const key = singleFlightKey(args.crewHome, args.projectRoot);
  const existing = staleRunSweepPromises.get(key);
  if (existing) return existing;

  const promise = new Promise<void>((resolve) => {
    setImmediate(resolve);
  })
    .then(() => sweep(args))
    .catch((err) => {
      logger.warn(
        `stale-run sweeper: failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    })
    .finally(() => {
      staleRunSweepPromises.delete(key);
    });

  staleRunSweepPromises.set(key, promise);
  return promise;
}

const runGcPromises = new Map<string, Promise<void>>();

export function getRunGc(): Promise<void> | null {
  return joinInFlightPromises(runGcPromises);
}

/**
 * Schedule the terminal-run garbage collector to run once, deferred to the
 * next tick so server boot isn't blocked on filesystem + git work. Mirrors
 * `scheduleStaleRunSweep`: at most one in flight per process, failures are
 * logged not thrown, and `getRunGc()` lets tests await completion.
 */
export function scheduleRunGc(
  args: RunGcArgs,
  gc: (args: RunGcArgs) => void | Promise<unknown> = gcTerminalRunsAndCriteriaSets,
): Promise<void> {
  const key = singleFlightKey(args.crewHome, args.projectRoot);
  const existing = runGcPromises.get(key);
  if (existing) return existing;

  const promise = new Promise<void>((resolve) => {
    setImmediate(resolve);
  })
    .then(async () => {
      await gc(args);
    })
    .catch((err) => {
      logger.warn(
        `run GC: failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    })
    .finally(() => {
      runGcPromises.delete(key);
    });

  runGcPromises.set(key, promise);
  return promise;
}

function singleFlightKey(crewHome: string, projectRoot: string): string {
  return `${crewHome}\0${projectRoot}`;
}

function joinInFlightPromises(promises: Map<string, Promise<void>>): Promise<void> | null {
  const current = Array.from(promises.values());
  if (current.length === 0) return null;
  return Promise.allSettled(current).then(() => undefined);
}

interface CrewWaitCommandResolution {
  readonly command: string;
  readonly source: 'project-manifest' | 'global-manifest' | 'legacy-fallback';
}

const LEGACY_CREW_WAIT_COMMAND = 'crew-wait';

/**
 * Resolve the watcher command that dispatch envelopes tell Claude Code
 * to spawn. Selection is deliberately host-scoped and deterministic:
 * client kind -> HostId, then project install manifest first, then the
 * user-scope manifest. That means a committed project install wins
 * over an older global install for the same host. If the selected
 * manifest predates `crewWaitCommand`, serve falls back to the legacy
 * bare command and logs a warning instead of silently inferring from
 * serverCommand.
 */
export function resolveCrewWaitCommandForClientKind(args: {
  readonly clientKind: ClientKind;
  readonly projectRoot: string;
  readonly home: string;
}): CrewWaitCommandResolution {
  const hostId = hostIdForClientKind(args.clientKind);
  if (hostId === undefined) {
    return { command: LEGACY_CREW_WAIT_COMMAND, source: 'legacy-fallback' };
  }

  const project = readStoredCrewWaitCommand(projectManifestPath(args.projectRoot), hostId);
  if (project.targetPresent) {
    return {
      command: project.command ?? LEGACY_CREW_WAIT_COMMAND,
      source: project.command ? 'project-manifest' : 'legacy-fallback',
    };
  }

  const global = readStoredCrewWaitCommand(manifestPath(args.home), hostId);
  if (global.targetPresent) {
    return {
      command: global.command ?? LEGACY_CREW_WAIT_COMMAND,
      source: global.command ? 'global-manifest' : 'legacy-fallback',
    };
  }

  return { command: LEGACY_CREW_WAIT_COMMAND, source: 'legacy-fallback' };
}

function hostIdForClientKind(kind: ClientKind): HostId | undefined {
  switch (kind) {
    case 'claude-code':
      return 'claude-code';
    case 'codex':
      return 'codex';
    case 'gemini':
      return 'gemini';
    case 'unknown':
      return undefined;
  }
}

function readStoredCrewWaitCommand(
  path: string,
  hostId: HostId,
): { targetPresent: boolean; command?: string } {
  if (!existsSync(path)) return { targetPresent: false };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
      targets?: Record<string, unknown>;
    };
    const target = parsed.targets?.[hostId];
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      return { targetPresent: false };
    }
    const command = (target as Record<string, unknown>).crewWaitCommand;
    return {
      targetPresent: true,
      ...(typeof command === 'string' && command.trim().length > 0
        ? { command }
        : {}),
    };
  } catch (err) {
    logger.warn(
      `crew-mcp serve: failed to read install manifest ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { targetPresent: false };
  }
}

function inferInstallManifestHome(crewHome: string): string {
  if (crewHome.endsWith('/.crew') || crewHome.endsWith('\\.crew')) {
    return dirname(crewHome);
  }
  return homedir();
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
  const installManifestHome = options.home ?? inferInstallManifestHome(crewHome);
  const registry = options.registry ?? createBuiltinRegistry();
  if (!options.registry) {
    const before = new Set(registry.listAvailable().map((adapter) => adapter.name));
    const agentPrefs = readAgentPrefsFile(crewHome);
    const { warnings } = mergeCustomAgents(registry, agentPrefs, {
      reservedNames: BUILTIN_ADAPTER_NAMES,
    });
    for (const warning of warnings) {
      logger.warn(warning);
    }
    for (const adapter of registry.listAvailable()) {
      if (!before.has(adapter.name)) {
        logger.info(`Registered custom agent "${adapter.name}" from agents.json`);
      }
    }
  }
  const worktreeManager = options.worktreeManager
    ?? new WorktreeManager({ projectRoot, crewHome });
  const dispatcher = new ToolDispatcher({ stallTimeoutMs: resolveDispatchStallTimeoutMs() });
  const runStateStore = new RunStateStore({ crewHome, repoRoot: projectRoot });
  const quotaCache = new QuotaCache();
  void scheduleStaleRunSweep(
    { crewHome, projectRoot, runStateStore, dispatcher },
    options.staleRunSweeper,
  );
  void scheduleRunGc(
    { crewHome, projectRoot, runStateStore, worktreeManager },
    options.runGc,
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
  let cachedCrewWaitCommand: string | undefined;
  let loggedLegacyCrewWaitFallback = false;
  const getCrewWaitCommand = (): string => {
    if (cachedCrewWaitCommand !== undefined) return cachedCrewWaitCommand;
    const resolution = resolveCrewWaitCommandForClientKind({
      clientKind: getClientKind(),
      projectRoot,
      home: installManifestHome,
    });
    if (
      resolution.source === 'legacy-fallback'
      && getClientKind() === 'claude-code'
      && !loggedLegacyCrewWaitFallback
    ) {
      loggedLegacyCrewWaitFallback = true;
      logger.warn(
        'crew-mcp serve: no stored crewWaitCommand found for Claude Code; '
        + 'falling back to legacy `crew-wait`. Re-run `crew-mcp install -t claude-code` '
        + 'to persist the exact allowlisted watcher command.',
      );
    }
    cachedCrewWaitCommand = resolution.command;
    return cachedCrewWaitCommand;
  };

  const toolDeps: ToolHandlerDeps = {
    registry,
    worktreeManager,
    runStateStore,
    dispatcher,
    crewHome,
    projectRoot,
    getClientKind,
    getCrewWaitCommand,
    progressTokenSeen,
    readAgentPrefs: () => readAgentPrefsFile(crewHome),
    quotaProbe: async (agentName) =>
      probeQuota(quotaCache, agentName, { unmetered: registry.get(agentName)?.unmetered === true }),
    clearQuotaCache: () => quotaCache.clear(),
    onTerminalPersisted: (state) => recordQuotaObservation(quotaCache, state, {
      resolveCanonicalAgentId: (agentId) => registry.get(agentId)?.name ?? agentId,
    }),
  };

  // ---- list_agents -----------------------------------------------------
  server.registerTool(
    'list_agents',
    {
      description: LIST_AGENTS_DESCRIPTION,
      inputSchema: listAgentsInputSchema.shape,
    },
    async (args) => listAgentsToolHandler(args, toolDeps),
  );

  // ---- get_crew_preferences -------------------------------------------
  server.registerTool(
    'get_crew_preferences',
    {
      description: GET_CREW_PREFERENCES_DESCRIPTION,
      inputSchema: getCrewPreferencesInputSchema.shape,
    },
    async (args) => getCrewPreferencesToolHandler(args, toolDeps),
  );

  // ---- list_runs -------------------------------------------------------
  server.registerTool(
    'list_runs',
    {
      description: LIST_RUNS_DESCRIPTION,
      inputSchema: listRunsInputSchema.shape,
    },
    async (args) => listRunsToolHandler(args, toolDeps),
  );

  // ---- run_agent -------------------------------------------------------
  server.registerTool(
    'run_agent',
    {
      description: RUN_AGENT_DESCRIPTION,
      inputSchema: runAgentInputSchema.shape,
    },
    async (args, extra) => runAgentToolHandler(args, extra, toolDeps),
  );

  // ---- run_panel -------------------------------------------------------
  server.registerTool(
    'run_panel',
    {
      description: RUN_PANEL_DESCRIPTION,
      inputSchema: runPanelInputSchema.shape,
    },
    async (args, extra) => runPanelToolHandler(args, extra, toolDeps),
  );

  // ---- get_panel_status ------------------------------------------------
  server.registerTool(
    'get_panel_status',
    {
      description: GET_PANEL_STATUS_DESCRIPTION,
      inputSchema: getPanelStatusInputSchema.shape,
    },
    async (args) => getPanelStatusToolHandler(args, toolDeps),
  );

  // ---- aggregate_panel -------------------------------------------------
  server.registerTool(
    'aggregate_panel',
    {
      description: AGGREGATE_PANEL_DESCRIPTION,
      inputSchema: aggregatePanelInputSchema.shape,
    },
    async (args) => aggregatePanelToolHandler(args, toolDeps),
  );

  // ---- create_criteria -------------------------------------------------
  server.registerTool(
    'create_criteria',
    {
      description: CREATE_CRITERIA_DESCRIPTION,
      inputSchema: createCriteriaInputSchema.shape,
    },
    async (args) => createCriteriaToolHandler(args, toolDeps),
  );

  // ---- confirm_criteria ------------------------------------------------
  server.registerTool(
    'confirm_criteria',
    {
      description: CONFIRM_CRITERIA_DESCRIPTION,
      inputSchema: confirmCriteriaInputSchema.shape,
    },
    async (args) => confirmCriteriaToolHandler(args, toolDeps),
  );

  // ---- get_criteria ----------------------------------------------------
  server.registerTool(
    'get_criteria',
    {
      description: GET_CRITERIA_DESCRIPTION,
      inputSchema: getCriteriaInputSchema.shape,
    },
    async (args) => getCriteriaToolHandler(args, toolDeps),
  );

  // ---- revise_criteria -------------------------------------------------
  server.registerTool(
    'revise_criteria',
    {
      description: REVISE_CRITERIA_DESCRIPTION,
      inputSchema: reviseCriteriaInputSchema.shape,
    },
    async (args) => reviseCriteriaToolHandler(args, toolDeps),
  );

  // ---- continue_run ----------------------------------------------------
  server.registerTool(
    'continue_run',
    {
      description: CONTINUE_RUN_DESCRIPTION,
      inputSchema: continueRunInputSchema.shape,
    },
    async (args, extra) => continueRunToolHandler(args, extra, toolDeps),
  );

  // ---- merge_run -------------------------------------------------------
  server.registerTool(
    'merge_run',
    {
      description: MERGE_RUN_DESCRIPTION,
      inputSchema: mergeRunInputSchema.shape,
    },
    async (args) => mergeRunToolHandler(args, toolDeps),
  );

  // ---- discard_run -----------------------------------------------------
  server.registerTool(
    'discard_run',
    {
      description: DISCARD_RUN_DESCRIPTION,
      inputSchema: discardRunInputSchema.shape,
    },
    async (args) => discardRunToolHandler(args, toolDeps),
  );

  // ---- get_run_status --------------------------------------------------
  server.registerTool(
    'get_run_status',
    {
      description: GET_RUN_STATUS_DESCRIPTION,
      inputSchema: getRunStatusInputSchema.shape,
    },
    async (args) => getRunStatusToolHandler(args, toolDeps),
  );

  // ---- cancel_run ------------------------------------------------------
  server.registerTool(
    'cancel_run',
    {
      description: CANCEL_RUN_DESCRIPTION,
      inputSchema: cancelRunInputSchema.shape,
    },
    async (args) => cancelRunToolHandler(args, toolDeps),
  );

  return { server, dispatcher, worktreeManager, runStateStore };
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
    const graceMs = resolveShutdownGraceMs();
    if (inFlight > 0) {
      logger.info(
        `crew serve received ${signal}; cancelling ${inFlight} in-flight task(s)`,
      );
      dispatcher.cancelAll(`Server received ${signal}`);
    }
    const drained = await waitForShutdownDrain(dispatcher, { maxWaitMs: graceMs });
    if (!drained.inFlightDrained) {
      logger.warn(
        `crew serve shutdown grace expired with ${dispatcher.inFlightCount()} task(s) still in-flight`,
      );
    }
    if (!drained.terminalPersistsDrained) {
      logger.warn(
        'crew serve shutdown grace expired before all terminal run state writes finished',
      );
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

function resolveShutdownGraceMs(): number {
  const raw = process.env.CREW_SHUTDOWN_GRACE_MS;
  if (raw === undefined) return DEFAULT_SHUTDOWN_GRACE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SHUTDOWN_GRACE_MS;
  return Math.floor(parsed);
}

export async function waitForInFlightDrain(
  dispatcher: Pick<ToolDispatcher, 'listInFlight'>,
  options: {
    readonly maxWaitMs?: number;
    readonly pollIntervalMs?: number;
  } = {},
): Promise<boolean> {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const deadline = Date.now() + maxWaitMs;
  while (dispatcher.listInFlight().length > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
  }
  return true;
}

export async function waitForShutdownDrain(
  dispatcher: Pick<ToolDispatcher, 'listInFlight'>,
  options: {
    readonly maxWaitMs?: number;
    readonly pollIntervalMs?: number;
  } = {},
): Promise<{
  readonly inFlightDrained: boolean;
  readonly terminalPersistsDrained: boolean;
}> {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const startedAt = Date.now();
  const inFlightDrained = await waitForInFlightDrain(dispatcher, options);
  const elapsed = Date.now() - startedAt;
  const remaining = Math.max(0, maxWaitMs - elapsed);
  const terminalPersistsDrained = await drainPendingTerminalPersists({
    maxWaitMs: remaining,
  });
  return { inFlightDrained, terminalPersistsDrained };
}

/**
 * Cross-adapter idle-stall watchdog threshold for dispatched runs, in ms. A
 * run whose stream emits nothing for this long is aborted (surfacing as
 * cancelled with a stall reason), so a wedged subprocess can't linger forever.
 *
 * Distinct from the adapter-level `CREW_STREAM_IDLE_TIMEOUT_MS` (claude-code
 * only today, default-on at 120s), which keys off the CLI's own stream-json
 * events and throws → run:failed. This one is the dispatcher-level net that
 * covers every adapter and stalls outside an adapter's stream loop. It is OFF
 * by default — only adapters that stream incrementally are safe to auto-kill
 * on idle. Opt in via `CREW_DISPATCH_STALL_TIMEOUT_MS`. Values below ~1s
 * round up to the watchdog's 1s minimum sampling cadence.
 */
function resolveDispatchStallTimeoutMs(): number {
  const raw = process.env.CREW_DISPATCH_STALL_TIMEOUT_MS;
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

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

function isWithinStaleRunGrace(state: RunStateV1): boolean {
  const lastStampedAt = latestStampedAt(state);
  if (lastStampedAt === undefined) return false;
  const ageMs = Date.now() - lastStampedAt;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < STALE_RUN_GRACE_MS;
}

function dispatcherInFlightRunIds(dispatcher: ToolDispatcher): Set<string> {
  return new Set(
    dispatcher
      .listInFlight()
      .map((entry) => entry.runId)
      .filter((runId): runId is string => typeof runId === 'string'),
  );
}

async function markAbandonedRunningRuns(args: StaleRunSweepArgs): Promise<void> {
  const runsDir = join(args.crewHome, 'runs');
  const currentRepoRoot = resolveComparableRepoRoot(args.projectRoot);
  const initiallyInFlightRunIds = dispatcherInFlightRunIds(args.dispatcher);
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
    let state: RunStateV1 | undefined;
    try {
      state = args.runStateStore.read(runId);
    } catch (err) {
      logger.warn(
        `stale-run sweeper: failed to read state for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!state) continue;

    if (state.status !== 'running') continue;
    if (state.repoRoot === undefined) continue;
    if (resolveComparableRepoRoot(state.repoRoot) !== currentRepoRoot) continue;
    // Skip if serverPid is missing (legacy records pre-dating the field —
    // we don't know if they're still owned, so don't kill them; user can
    // `discard_run` manually if truly stale).
    if (state.serverPid === undefined) {
      continue;
    }

    // Same-server orphan recovery: if this live process stamped the record
    // but the dispatcher no longer has a matching in-flight task, the agent
    // lifecycle listener was lost and no other server can finish it for us.
    // Match by runId, the stable id exposed by listInFlight(). A pre-scan
    // snapshot is only an early skip: before marking, apply the same grace
    // used for dead-PID recovery and re-query in-flight state to avoid
    // racing a just-created or just-completing task.
    if (state.serverPid === process.pid) {
      if (initiallyInFlightRunIds.has(runId)) continue;
      if (isWithinStaleRunGrace(state)) continue;
      if (dispatcherInFlightRunIds(args.dispatcher).has(runId)) continue;
      await markRunAbandoned(args.runStateStore, runId, 'abandoned (not in-flight)');
      continue;
    }

    // Multi-server safety: every dispatched agent's MCP connection spawns
    // its own crew-mcp server. A different live PID may legitimately own
    // this run, so leave it alone.
    if (isProcessAlive(state.serverPid)) {
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
    if (isWithinStaleRunGrace(state)) continue;

    await markRunAbandoned(args.runStateStore, runId, 'abandoned (server restart)');
  }
}

async function markRunAbandoned(
  runStateStore: RunStateStore,
  runId: string,
  reason: string,
): Promise<void> {
  try {
    await runStateStore.markTerminal(runId, {
      status: 'error',
      summary: reason,
      filesChanged: [],
      lastError: reason,
    });
  } catch (err) {
    logger.warn(
      `stale-run sweeper: failed to mark ${runId} abandoned: ${err instanceof Error ? err.message : String(err)}`,
    );
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

// Re-export RunStateV1 for tests that want to inspect persisted state.
export type { RunStateV1 };
