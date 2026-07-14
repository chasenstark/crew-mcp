// `crew-mcp serve` — the v2 stdio MCP server entry point.
//
// The host CLI (Claude Code / Codex / agy) spawns this command at session
// start via its MCP config block. We expose v2's MCP tool surface over
// stdio:
//
//   list_agents      — synchronous probe of the agent registry
//   get_crew_preferences — read configured agent defaults
//   list_runs        — recover persisted run records for the current repo
//   check_captain_inbox / acknowledge_messages
//                    — read and acknowledge worker messages to the captain
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

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, type Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { AdapterRegistry } from '../../adapters/registry.js';
import {
  drainProcessGroupTerminations,
  resolveProcessGroupForceKillAfterMs,
} from '../../adapters/process-group.js';
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
import { seedCodexRolloutQuota } from '../../orchestrator/codex-rollout-quota.js';
import { RunStateStore, type RunStateV1 } from '../../orchestrator/run-state.js';
import { gcTerminalRunsAndCriteriaSets, type RunGcArgs } from '../../orchestrator/run-gc.js';
import { sweepExpiredMessages } from '../../orchestrator/captain-inbox/store.js';
import {
  RunAuthError,
  validateRunAuthSidecar,
  writeWorkerReadyMarker,
  type RunAuthSidecar,
} from '../../orchestrator/auth/index.js';
import { isValidRunId } from '../../orchestrator/run-id.js';
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
  acknowledgeMessagesInputSchema,
  acknowledgeMessagesToolHandler,
  ACKNOWLEDGE_MESSAGES_DESCRIPTION,
} from '../../orchestrator/tools/acknowledge-messages.js';
import {
  checkCaptainInboxInputSchema,
  checkCaptainInboxToolHandler,
  CHECK_CAPTAIN_INBOX_DESCRIPTION,
} from '../../orchestrator/tools/check-captain-inbox.js';
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
  sendMessageInputSchema,
  sendMessageToolHandler,
  SEND_MESSAGE_DESCRIPTION,
} from '../../orchestrator/tools/send-message.js';
import {
  classifyClient,
  MIN_CODEX_APP_SERVER_WATCHER_VERSION,
  type ClientKind,
  type ProgressTokenSeen,
  type ToolHandlerDeps,
} from '../../orchestrator/tools/shared.js';
import {
  CODEX_BRIDGE_FILE_ENV,
  encodeCodexBridgeFile,
} from '../../codex/app-server-bridge.js';
import { readAgentPrefsFile } from '../../agent-prefs/store.js';
import { manifestPath } from '../../install/install-manifest.js';
import { projectManifestPath } from '../../install/project-install-manifest.js';
import { isTrustedProjectCrewWaitCommand } from '../../install/crew-binary.js';
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
   * registry (claude-code, codex, agy). M3 swaps this for a registry
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
   * Test seam for establishing whether this server was launched from the
   * repository's own node_modules/crew-mcp package. Production uses
   * process.argv[1].
   */
  serverScriptPath?: string;

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

  /** Test seam for the hosted Codex bridge environment. */
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

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
  readonly worktreeManager?: WorktreeManager;
  readonly runStateStore: RunStateStore;
  /**
   * Stops the periodic run-GC timer. The timer is unref'd so it never keeps
   * the process alive, but embedded/test builders that create multiple
   * servers in one process should call this to avoid accumulating timers.
   */
  readonly stopPeriodicRunGc: () => void;
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
const DEFAULT_RUN_GC_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

export function resolveRunGcIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CREW_RUN_GC_INTERVAL_MS;
  if (raw === undefined) return DEFAULT_RUN_GC_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn(
      `CREW_RUN_GC_INTERVAL_MS is present but is not a non-negative integer; using ${DEFAULT_RUN_GC_INTERVAL_MS}`,
    );
    return DEFAULT_RUN_GC_INTERVAL_MS;
  }
  return Math.floor(parsed);
}

export function startPeriodicRunGc(
  args: RunGcArgs,
  gc: (args: RunGcArgs) => void | Promise<unknown> = gcTerminalRunsAndCriteriaSets,
  intervalMs = resolveRunGcIntervalMs(),
): ReturnType<typeof setInterval> | undefined {
  if (intervalMs <= 0) return undefined;
  const timer = setInterval(() => {
    void scheduleRunGc(args, gc);
  }, intervalMs);
  timer.unref?.();
  return timer;
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
  readonly command?: string;
  readonly source:
    | 'project-manifest'
    | 'global-manifest'
    | 'legacy-fallback'
    | 'invalid-project-manifest';
  readonly reason?: string;
}

const LEGACY_CREW_WAIT_COMMAND = 'crew-wait';

/**
 * Resolve the watcher command that dispatch envelopes tell Claude Code or
 * hosted Codex to spawn. Selection is deliberately host-scoped and deterministic:
 * client kind -> HostId, then the project install manifest when this server
 * is itself project-local, then the user-scope manifest. A project command is
 * accepted only when it exactly matches one of the fixed forms emitted by
 * Crew's project installer: the project manifest belongs to the checkout and
 * is not a trusted source of arbitrary shell. Legacy Claude installs retain
 * the old PATH fallback; Codex degrades to next-turn recovery unless both
 * the installed watcher command and Crew's App Server bridge are present.
 */
export function resolveCrewWaitCommandForClientKind(args: {
  readonly clientKind: ClientKind;
  readonly projectRoot: string;
  readonly home: string;
  readonly projectInstallActive: boolean;
}): CrewWaitCommandResolution {
  const hostId = hostIdForClientKind(args.clientKind);
  if (hostId === undefined) {
    return { source: 'legacy-fallback' };
  }

  if (args.projectInstallActive) {
    const project = readStoredCrewWaitCommand(projectManifestPath(args.projectRoot), hostId);
    if (project.targetPresent) {
      if (project.command && !isTrustedProjectCrewWaitCommand(project.command)) {
        return {
          source: 'invalid-project-manifest',
          reason: `untrusted project crewWaitCommand ${JSON.stringify(project.command)}`,
        };
      }
      return {
        command: project.command ?? legacyCrewWaitCommand(args.clientKind),
        source: project.command ? 'project-manifest' : 'legacy-fallback',
      };
    }
  }

  const global = readStoredCrewWaitCommand(manifestPath(args.home), hostId);
  if (global.targetPresent) {
    return {
      command: global.command ?? legacyCrewWaitCommand(args.clientKind),
      source: global.command ? 'global-manifest' : 'legacy-fallback',
    };
  }

  return {
    command: legacyCrewWaitCommand(args.clientKind),
    source: 'legacy-fallback',
  };
}

function legacyCrewWaitCommand(kind: ClientKind): string | undefined {
  return kind === 'claude-code' ? LEGACY_CREW_WAIT_COMMAND : undefined;
}

/**
 * Project manifests are repository-controlled, so their executable choice is
 * trusted only when the MCP server itself is running from that repository's
 * physical node_modules/crew-mcp package. The server entrypoint may be the
 * normal node_modules/.bin/crew-mcp symlink, so trust is based on real paths:
 * both the package and the running script must resolve inside the project.
 * A project-local shim or package symlink targeting a global install fails
 * that physical containment check.
 */
export function isActiveProjectCrewInstall(
  projectRoot: string,
  serverScriptPath: string | undefined = process.argv[1],
): boolean {
  if (!serverScriptPath) return false;
  const lexicalProjectRoot = resolve(projectRoot);
  const lexicalPackageRoot = join(lexicalProjectRoot, 'node_modules', 'crew-mcp');
  const lexicalScriptPath = resolve(serverScriptPath);
  try {
    const physicalProjectRoot = realpathSync(lexicalProjectRoot);
    const physicalPackageRoot = realpathSync(lexicalPackageRoot);
    const physicalScriptPath = realpathSync(lexicalScriptPath);
    return pathIsWithin(physicalProjectRoot, physicalPackageRoot)
      && pathIsWithin(physicalPackageRoot, physicalScriptPath);
  } catch {
    return false;
  }
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel.length === 0
    || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function hostIdForClientKind(kind: ClientKind): HostId | undefined {
  switch (kind) {
    case 'claude-code':
      return 'claude-code';
    case 'codex':
    case 'codex-legacy':
      return 'codex';
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
  const captainServeInstance = randomUUID();
  const workerAuth = resolveWorkerServeAuth(crewHome);
  const installManifestHome = options.home ?? inferInstallManifestHome(crewHome);
  const runtimeEnv = options.env ?? process.env;
  const projectInstallActive = isActiveProjectCrewInstall(
    projectRoot,
    options.serverScriptPath,
  );

  const server = new McpServer({
    name: 'crew',
    version: SERVE_VERSION,
  });

  if (workerAuth !== undefined) {
    const dispatcher = new ToolDispatcher({
      streamingIdleTimeoutMs: resolveDispatchStallTimeoutMs(),
      bufferedAbsoluteTimeoutMs: resolveDispatchAbsoluteTimeoutMs(),
    });
    const runStateStore = new RunStateStore({ crewHome, repoRoot: projectRoot });
    server.registerTool(
      'send_message',
      {
        description: SEND_MESSAGE_DESCRIPTION,
        inputSchema: sendMessageInputSchema.shape,
      },
      async (args) => sendMessageToolHandler(args, { crewHome, workerAuth }),
    );
    writeWorkerReadyMarker({
      crewHome,
      runId: workerAuth.run_id,
      serverInstance: captainServeInstance,
      registeredTools: ['send_message'],
    });
    return {
      server,
      dispatcher,
      runStateStore,
      stopPeriodicRunGc: () => undefined,
    };
  }

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
  const dispatcher = new ToolDispatcher({
    streamingIdleTimeoutMs: resolveDispatchStallTimeoutMs(),
    bufferedAbsoluteTimeoutMs: resolveDispatchAbsoluteTimeoutMs(),
  });
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
  const periodicRunGcTimer = startPeriodicRunGc(
    { crewHome, projectRoot, runStateStore, worktreeManager },
    options.runGc,
  );
  const stopPeriodicRunGc = (): void => {
    if (periodicRunGcTimer) clearInterval(periodicRunGcTimer);
  };
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

  // Memoized host-CLI classification. `getClientVersion()` returns
  // `undefined` until the MCP `initialize` handshake completes, but tool
  // calls only fire post-initialize so the first dispatch will always
  // see a defined value. Cache so we don't re-classify on every
  // dispatch — the answer can't change within a single server lifetime.
  let cachedClientKind: ClientKind | undefined;
  let loggedLegacyCodexClient = false;
  const getClientKind = (): ClientKind => {
    if (cachedClientKind !== undefined) return cachedClientKind;
    const info = server.server.getClientVersion();
    cachedClientKind = classifyClient(info?.name, info?.version);
    if (cachedClientKind === 'codex-legacy' && !loggedLegacyCodexClient) {
      loggedLegacyCodexClient = true;
      logger.warn(
        `crew-mcp serve: Codex client version ${JSON.stringify(info?.version ?? '(missing)')} `
        + `does not support the hosted watcher bridge (requires ${MIN_CODEX_APP_SERVER_WATCHER_VERSION}+); `
        + 'dispatch remains available with next-turn status recovery.',
      );
    }
    return cachedClientKind;
  };
  let cachedCrewWaitCommand: string | undefined;
  let crewWaitCommandResolved = false;
  let loggedCrewWaitResolution = false;
  const getCrewWaitCommand = (): string | undefined => {
    if (crewWaitCommandResolved) return cachedCrewWaitCommand;
    crewWaitCommandResolved = true;
    const clientKind = getClientKind();
    const resolution = resolveCrewWaitCommandForClientKind({
      clientKind,
      projectRoot,
      home: installManifestHome,
      projectInstallActive,
    });
    if (!loggedCrewWaitResolution) {
      loggedCrewWaitResolution = true;
      if (resolution.source === 'invalid-project-manifest') {
        logger.warn(
          `crew-mcp serve: ${resolution.reason}; watcher auto-execution is disabled. `
          + `Re-run \`crew-mcp install --scope project -t ${hostIdForClientKind(clientKind) ?? 'codex'}\` `
          + 'to replace the project install manifest.',
        );
      } else if (resolution.source === 'legacy-fallback' && clientKind === 'claude-code') {
        logger.warn(
          'crew-mcp serve: no stored crewWaitCommand found for Claude Code; '
          + 'falling back to legacy `crew-wait`. Re-run `crew-mcp install -t claude-code` '
          + 'to persist the exact allowlisted watcher command.',
        );
      } else if (resolution.source === 'legacy-fallback' && clientKind === 'codex') {
        logger.warn(
          'crew-mcp serve: no stored crewWaitCommand found for Codex; hosted watcher '
          + 'auto-execution is disabled. Re-run `crew-mcp install -t codex` and restart Codex.',
        );
      }
    }
    cachedCrewWaitCommand = resolution.command;
    if (clientKind === 'codex' && cachedCrewWaitCommand !== undefined) {
      const bridgeFile = runtimeEnv[CODEX_BRIDGE_FILE_ENV];
      if (!bridgeFile || !isAbsolute(bridgeFile) || !existsSync(bridgeFile)) {
        logger.warn(
          'crew-mcp serve: this Codex session is not attached to Crew\'s App Server bridge; '
          + 'watcher auto-wake is disabled. Launch future sessions with `crew-mcp codex`.',
        );
        cachedCrewWaitCommand = undefined;
      } else {
        cachedCrewWaitCommand += ` --codex-bridge-base64 ${encodeCodexBridgeFile(bridgeFile)}`;
      }
    }
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
    captainServeInstance,
    readAgentPrefs: () => readAgentPrefsFile(crewHome),
    quotaProbe: async (agentName) =>
      probeQuota(quotaCache, agentName, { unmetered: registry.get(agentName)?.unmetered === true }),
    clearQuotaCache: () => quotaCache.clear(),
    onTerminalPersisted: async (state) => {
      const resolveCanonicalAgentId = (agentId: string): string =>
        registry.get(agentId)?.name ?? agentId;
      recordQuotaObservation(quotaCache, state, { resolveCanonicalAgentId });
      // Preemptive numeric headroom: codex persists real used_percent to
      // its session rollout file; seed the cache from it post-terminal.
      if (state.sessionId !== undefined) {
        await seedCodexRolloutQuota(quotaCache, {
          agentId: resolveCanonicalAgentId(state.agentId),
          threadId: state.sessionId,
        });
      }
    },
  };

  void sweepExpiredMessages({
    crewHome,
    repoRoot: projectRoot,
    force: true,
  }).catch((err) => {
    logger.warn(
      `captain inbox sweep: failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

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

  // ---- check_captain_inbox --------------------------------------------
  server.registerTool(
    'check_captain_inbox',
    {
      description: CHECK_CAPTAIN_INBOX_DESCRIPTION,
      inputSchema: checkCaptainInboxInputSchema.shape,
    },
    async (args) => checkCaptainInboxToolHandler(args, toolDeps),
  );

  // ---- acknowledge_messages -------------------------------------------
  server.registerTool(
    'acknowledge_messages',
    {
      description: ACKNOWLEDGE_MESSAGES_DESCRIPTION,
      inputSchema: acknowledgeMessagesInputSchema.shape,
    },
    async (args) => acknowledgeMessagesToolHandler(args, toolDeps),
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

  return { server, dispatcher, worktreeManager, runStateStore, stopPeriodicRunGc };
}

function resolveWorkerServeAuth(crewHome: string): RunAuthSidecar | undefined {
  const runId = process.env.CREW_RUN_ID;
  const token = process.env.CREW_RUN_TOKEN;
  // Both unset is the intended captain path; worker env-less serve is blocked
  // by agy's MCP-config quarantine.
  if (runId === undefined && token === undefined) return undefined;
  if (!runId || !token) {
    throw new Error(
      'crew-mcp: partial worker env (CREW_RUN_ID xor CREW_RUN_TOKEN); refusing to start',
    );
  }
  if (!isValidRunId(runId)) {
    throw new RunAuthError('run_id_invalid', `run_id_invalid: ${runId}`);
  }
  return validateRunAuthSidecar({ crewHome, runId, token });
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

  const { server, dispatcher, runStateStore, stopPeriodicRunGc } = buildCrewMcpServer(options);
  warnIfShutdownGraceCannotReachForceKill();

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals | 'uncaughtException', exitCode = 0): Promise<void> => {
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
    if (!drained.processGroupsDrained) {
      logger.warn(
        'crew serve shutdown grace expired before all adapter process groups exited',
      );
    }
    stopPeriodicRunGc();
    runStateStore.closeEventAppendHandles();
    process.exit(exitCode);
  };
  process.on('unhandledRejection', (reason) => {
    logger.error(
      `crew serve unhandledRejection (surviving): ${
        reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
      }`,
    );
  });
  process.on('uncaughtExceptionMonitor', (err) => {
    logger.error(`crew serve uncaughtExceptionMonitor: ${err.stack ?? err.message}`);
  });
  process.once('uncaughtException', (err) => {
    logger.error(`crew serve uncaughtException: ${err.stack ?? err.message}`);
    void shutdown('uncaughtException', 1);
  });
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
const STALE_RUN_SWEEP_YIELD_EVERY = 50;

function resolveShutdownGraceMs(): number {
  const raw = process.env.CREW_SHUTDOWN_GRACE_MS;
  if (raw === undefined) return DEFAULT_SHUTDOWN_GRACE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SHUTDOWN_GRACE_MS;
  return Math.floor(parsed);
}

function warnIfShutdownGraceCannotReachForceKill(): void {
  const shutdownGraceMs = resolveShutdownGraceMs();
  const forceKillAfterMs = resolveProcessGroupForceKillAfterMs();
  if (shutdownGraceMs <= forceKillAfterMs) {
    logger.warn(
      `CREW_SHUTDOWN_GRACE_MS (${shutdownGraceMs}) is <= CREW_PROCESS_GROUP_FORCE_KILL_AFTER_MS `
      + `(${forceKillAfterMs}); shutdown may exit before stubborn adapter process groups are force-killed.`,
    );
  }
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
  readonly processGroupsDrained: boolean;
}> {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const startedAt = Date.now();
  const [inFlightDrained, processGroupsDrained] = await Promise.all([
    waitForInFlightDrain(dispatcher, options),
    drainProcessGroupTerminations({ maxWaitMs }),
  ]);
  const elapsed = Date.now() - startedAt;
  const terminalPersistRemaining = Math.max(0, maxWaitMs - elapsed);
  const terminalPersistsDrained = await drainPendingTerminalPersists({
    maxWaitMs: terminalPersistRemaining,
  });
  return { inFlightDrained, terminalPersistsDrained, processGroupsDrained };
}

/**
 * Dispatcher idle-stall watchdog threshold for incrementally streaming runs,
 * in ms. Default is generous (12m) so quiet-but-healthy phases have room; set
 * `CREW_DISPATCH_STALL_TIMEOUT_MS=0` to disable.
 */
function resolveDispatchStallTimeoutMs(): number {
  const raw = process.env.CREW_DISPATCH_STALL_TIMEOUT_MS;
  if (raw === undefined) return 12 * 60 * 1000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

/**
 * Dispatcher absolute wall-clock cap for buffering adapters, in ms. Default is
 * 60m; set `CREW_DISPATCH_ABSOLUTE_TIMEOUT_MS=0` to disable.
 */
function resolveDispatchAbsoluteTimeoutMs(): number {
  const raw = process.env.CREW_DISPATCH_ABSOLUTE_TIMEOUT_MS;
  if (raw === undefined) return 60 * 60 * 1000;
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
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (err) {
    logger.warn(
      `stale-run sweeper: failed to read ${runsDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  let visited = 0;
  for (const entry of entries) {
    visited += 1;
    if (visited % STALE_RUN_SWEEP_YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }
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

    if (state.repoRoot === undefined) continue;
    if (resolveComparableRepoRoot(state.repoRoot) !== currentRepoRoot) {
      args.runStateStore.dropParsedStateCache(runId);
      continue;
    }
    if (state.status !== 'running') continue;
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

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
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
