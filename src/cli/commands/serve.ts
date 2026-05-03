// `crew serve` — the v2 stdio MCP server entry point.
//
// The host CLI (Claude Code / Codex / Gemini) spawns this command at session
// start via its MCP config block. We expose v2's tool surface over stdio:
//
//   M1 (this milestone):
//     - list_agents — synchronous probe of the agent registry
//     - run_agent   — block-and-wait dispatch into a fresh worktree
//
//   M2 will add: continue_run, merge_run, discard_run, get_run_status.
//
// Logging discipline: stdout is reserved for the MCP wire protocol. The
// project's logger (`src/utils/logger.ts`) emits to stderr via console.error,
// which is safe; do NOT introduce any console.log() calls in the hot path.

import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { AdapterRegistry } from '../../adapters/registry.js';
import { createBuiltinRegistry } from '../../adapters/registry.js';
import { WorktreeManager } from '../../git/worktree.js';
import { ToolDispatcher } from '../../orchestrator/tool-dispatcher.js';
import {
  listAgents,
  LIST_AGENTS_DESCRIPTION,
} from '../../orchestrator/tools/list-agents.js';
import {
  planRunAgent,
  runAgentInputSchema,
  RUN_AGENT_DESCRIPTION,
  type RunAgentDispatchPlan,
} from '../../orchestrator/tools/run-agent.js';
import { logger } from '../../utils/logger.js';

export const SERVE_VERSION = '0.2.0-dev';

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
   * wants to assert against a specific .crew/runs/ path.
   */
  worktreeManager?: WorktreeManager;
}

export interface RunEnvelope {
  readonly run_id: string;
  readonly worktree_path: string;
  readonly status: 'success' | 'partial' | 'error' | 'cancelled';
  readonly summary: string;
  readonly files_changed: readonly string[];
}

/**
 * The pieces a test or alternative entry point needs to drive the server
 * without spawning a subprocess: the configured `McpServer`, the dispatcher
 * (for asserting in-flight state or invoking cancellation), and the
 * worktree manager (for asserting on .crew/runs/ paths).
 */
export interface CrewMcpServerInstance {
  readonly server: McpServer;
  readonly dispatcher: ToolDispatcher;
  readonly worktreeManager: WorktreeManager;
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
  const registry = options.registry ?? createBuiltinRegistry();
  const worktreeManager = options.worktreeManager ?? new WorktreeManager(projectRoot);
  const dispatcher = new ToolDispatcher();

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
      const out = await listAgents({ registry });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }],
        // SDK's structuredContent type wants Record<string, unknown>; cast
        // through unknown rather than weaken our domain interfaces.
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
    async (args) => {
      const toolCallId = randomUUID();
      const plan = await planRunAgent(args, toolCallId, {
        registry,
        worktreeManager,
      });

      if (plan.kind === 'error') {
        return {
          content: [{ type: 'text' as const, text: plan.message }],
          isError: true,
        };
      }

      const terminal = await awaitDispatchTerminal(dispatcher, plan, toolCallId);
      const envelope = formatRunEnvelope(plan, terminal);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope as unknown as Record<string, unknown>,
        isError: terminal.kind !== 'complete' || envelope.status === 'error',
      };
    },
  );

  return { server, dispatcher, worktreeManager };
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

type DispatchTerminal =
  | { kind: 'complete'; result: unknown }
  | { kind: 'failed'; error: string }
  | { kind: 'cancelled'; reason: string };

function awaitDispatchTerminal(
  dispatcher: ToolDispatcher,
  plan: RunAgentDispatchPlan,
  toolCallId: string,
): Promise<DispatchTerminal> {
  return new Promise<DispatchTerminal>((resolve) => {
    const subs: Array<{ dispose(): void }> = [];
    const cleanupAndResolve = (value: DispatchTerminal): void => {
      for (const s of subs) s.dispose();
      resolve(value);
    };
    subs.push(
      dispatcher.onEvent('run:complete', (info) => {
        if (info.toolCallId !== toolCallId) return;
        cleanupAndResolve({ kind: 'complete', result: info.result });
      }),
      dispatcher.onEvent('run:failed', (info) => {
        if (info.toolCallId !== toolCallId) return;
        cleanupAndResolve({ kind: 'failed', error: info.error });
      }),
      dispatcher.onEvent('run:cancelled', (info) => {
        if (info.toolCallId !== toolCallId) return;
        cleanupAndResolve({ kind: 'cancelled', reason: info.reason });
      }),
    );
    // Start the dispatch only after the listeners are wired so we can never
    // miss a terminal event for a fast-resolving task.
    dispatcher.start(plan.task);
  });
}

function formatRunEnvelope(
  plan: RunAgentDispatchPlan,
  terminal: DispatchTerminal,
): RunEnvelope {
  if (terminal.kind === 'failed') {
    return {
      run_id: plan.runId,
      worktree_path: plan.worktreePath,
      status: 'error',
      summary: terminal.error,
      files_changed: [],
    };
  }
  if (terminal.kind === 'cancelled') {
    return {
      run_id: plan.runId,
      worktree_path: plan.worktreePath,
      status: 'cancelled',
      summary: terminal.reason,
      files_changed: [],
    };
  }
  // `complete` — the result shape is the adapter's TaskResult.
  const r = terminal.result as {
    output: string;
    filesModified: string[];
    status: 'success' | 'partial' | 'error';
  };
  return {
    run_id: plan.runId,
    worktree_path: plan.worktreePath,
    status: r.status,
    summary: r.output,
    files_changed: r.filesModified,
  };
}
