/**
 * ToolCatalog — the single source of truth for the captain's M3 tool surface.
 *
 * Three projections feed off one catalog:
 *   1. `toActionCatalog()` → the `ActionCatalogEntry[]` that `CaptainActionServer`
 *      consumes to produce the `mcp__crew__<name>` tool definitions the captain sees.
 *   2. `toMcpServers()` → the catalog row `mcp-registration.ts` converters emit into
 *      per-captain argv (Codex) / inline JSON (Claude) / settings.json (Gemini).
 *   3. `toPromptAgentInventory()` → the agent-inventory block the captain-system
 *      prompt renders (M3-3).
 *
 * The 8 tools the M3 captain sees are built here as stubs-with-schemas. M3-5
 * and M3-6 will replace the stub handlers with real implementations; the
 * *shape* (names, input schemas, descriptions) is locked here so the schema
 * hash and the converter outputs stabilize.
 *
 * Handler wiring note: the catalog does NOT own the scheduler side of these
 * tools. The scheduler (`judgment-runner.buildM3Scheduler`) is what actually
 * translates a `mcp__crew__run_agent` call into a dispatched task. The catalog
 * declares the schemas; the scheduler declares the behavior.
 */

import type { ToolDefinition } from '../../adapters/types.js';
import type {
  AgentAdapter,
} from '../../adapters/types.js';
import type { AdapterRegistry } from '../../adapters/registry.js';
import type { z } from 'zod';
import { runAgentInputSchema, RUN_AGENT_DESCRIPTION } from './run-agent.js';
import { listAgentsInputSchema, LIST_AGENTS_DESCRIPTION } from './list-agents.js';
import { askUserInputSchema, ASK_USER_DESCRIPTION } from './ask-user.js';
import { messageUserInputSchema, MESSAGE_USER_DESCRIPTION } from './message-user.js';
import { planTasksInputSchema, PLAN_TASKS_DESCRIPTION } from './plan-tasks.js';
import { analyzeOutputInputSchema, ANALYZE_OUTPUT_DESCRIPTION } from './analyze-output.js';
import { compressContextInputSchema, COMPRESS_CONTEXT_DESCRIPTION } from './compress-context.js';
import { finishInputSchema, FINISH_DESCRIPTION } from './finish.js';

/**
 * Minimal registry surface the catalog needs. Accepts either the full
 * AdapterRegistry or the minimal AgentRegistry (src/captain/events.ts)
 * that exposes only `list` + `get`.
 */
export interface RegistryForCatalog {
  listAvailable?(): AgentAdapter[];
  list?(): { name: string; capabilities: readonly string[] | string[] }[];
  get(name: string): AgentAdapter | undefined;
}

function registryAgents(r: AdapterRegistry | RegistryForCatalog): Array<{ name: string; capabilities: string[] }> {
  if (typeof (r as RegistryForCatalog).listAvailable === 'function') {
    return (r as RegistryForCatalog).listAvailable!().map((a) => ({
      name: a.name,
      capabilities: [...a.capabilities],
    }));
  }
  if (typeof (r as RegistryForCatalog).list === 'function') {
    return (r as RegistryForCatalog).list!().map((a) => ({
      name: a.name,
      capabilities: [...(a.capabilities as string[])],
    }));
  }
  return [];
}
import type { WorkflowConfig } from '../../workflow/types.js';
import type { ActionCatalogEntry } from '../action-server.js';
import { CaptainActionServer } from '../action-server.js';
import type { McpServerSpec } from '../mcp-registration.js';
import type { CaptainPromptAgentEntry } from '../prompts/captain-system.js';
import type { CaptainSession } from '../session.js';
import type { ToolDispatcher } from '../tool-dispatcher.js';

/**
 * The 8 M3 tool names. Exported so tests and M3-10a's scheduler can key off
 * the same source.
 */
export const M3_TOOL_NAMES = [
  'run_agent',
  'list_agents',
  'ask_user',
  'message_user',
  'plan_tasks',
  'analyze_output',
  'compress_context',
  'finish',
] as const;

export type M3ToolName = typeof M3_TOOL_NAMES[number];

export interface ToolCatalogInit {
  readonly registry: AdapterRegistry | RegistryForCatalog;
  readonly workflow: WorkflowConfig;
  readonly session?: CaptainSession;
  readonly dispatcher?: ToolDispatcher;
  /**
   * When true, optional wrapper tools (plan_tasks / analyze_output /
   * compress_context) are excluded from the catalog. Kept as a lever for
   * tests and for future presets that want a slimmer surface; default is
   * false so the M3 bar of 8 tools is the default.
   */
  readonly omitOptionalWrappers?: boolean;
}

/**
 * Descriptions + input schemas re-export the per-tool canonical values
 * from each tool's own module. Keeping catalog a router (not a parallel
 * declaration) means there's a single schema per tool across:
 *   - the per-tool file's exported schema
 *   - the ActionCatalogEntry the CaptainActionServer publishes
 *   - the JSON Schema the captain sees
 * Schema drift was the Finding 1 risk from the M3 review.
 */
const DESCRIPTIONS: Record<M3ToolName, string> = {
  run_agent: RUN_AGENT_DESCRIPTION,
  list_agents: LIST_AGENTS_DESCRIPTION,
  ask_user: ASK_USER_DESCRIPTION,
  message_user: MESSAGE_USER_DESCRIPTION,
  plan_tasks: PLAN_TASKS_DESCRIPTION,
  analyze_output: ANALYZE_OUTPUT_DESCRIPTION,
  compress_context: COMPRESS_CONTEXT_DESCRIPTION,
  finish: FINISH_DESCRIPTION,
};

const INPUT_SCHEMAS: Record<M3ToolName, z.ZodType> = {
  run_agent: runAgentInputSchema,
  list_agents: listAgentsInputSchema,
  ask_user: askUserInputSchema,
  message_user: messageUserInputSchema,
  plan_tasks: planTasksInputSchema,
  analyze_output: analyzeOutputInputSchema,
  compress_context: compressContextInputSchema,
  finish: finishInputSchema,
};

/**
 * Richer catalog shape that backs every projection. See the class doc above.
 *
 * Implements the `ToolCatalog` interface from `../mcp-registration.ts` so
 * the Codex/Claude/Gemini converters can accept either the class instance or
 * a plain-object catalog (the latter is what test fixtures typically use).
 */
export class ToolCatalog {
  readonly registry: AdapterRegistry | RegistryForCatalog;
  readonly workflow: WorkflowConfig;
  readonly session: CaptainSession | undefined;
  readonly dispatcher: ToolDispatcher | undefined;
  private readonly omitOptionalWrappers: boolean;
  private cachedActionServer: CaptainActionServer | undefined;

  constructor(init: ToolCatalogInit) {
    this.registry = init.registry;
    this.workflow = init.workflow;
    this.session = init.session;
    this.dispatcher = init.dispatcher;
    this.omitOptionalWrappers = init.omitOptionalWrappers ?? false;
  }

  /**
   * The tool names this catalog surfaces, in a stable order. Used by
   * deterministic-rendering consumers (prompt, tests, catalog hash).
   */
  toolNames(): readonly M3ToolName[] {
    if (!this.omitOptionalWrappers) return M3_TOOL_NAMES;
    return M3_TOOL_NAMES.filter(
      (name) =>
        name !== 'plan_tasks' &&
        name !== 'analyze_output' &&
        name !== 'compress_context',
    );
  }

  /**
   * Action-server-ready list. Each entry's input schema is the canonical
   * zod shape from this module; descriptions are the canonical strings.
   * M3-5/M3-6 will wrap these with real handlers via the scheduler; the
   * catalog deliberately does not bind handlers (the scheduler is the
   * handler authority).
   */
  toActionCatalog(): ActionCatalogEntry[] {
    return this.toolNames().map((name) => ({
      name,
      description: DESCRIPTIONS[name],
      inputSchema: INPUT_SCHEMAS[name],
    }));
  }

  /**
   * MCP-server list for the three adapter converters. Currently empty:
   * the M3 `crew` placeholder (`command: 'crew-mcp'`) was decorative —
   * no such binary exists. claude-code silently tolerated the missing
   * binary; codex hung on the MCP handshake; gemini wrote broken settings
   * to `~/.gemini/settings.json`. Tool invocation in all three adapters
   * flows through the JSON-envelope loop + `onToolCall` callback anyway,
   * so the MCP registration was never load-bearing for routing.
   *
   * If M5 or later introduces a real captain-side MCP server (e.g., an
   * out-of-process crew-mcp that federates into other MCP endpoints),
   * put its spec here. Until then, this returns `[]` so:
   *   - claude-code's `--mcp-config` is literally `"{}"`
   *   - codex gets no `-c mcp_servers.*=...` flags
   *   - gemini's `~/.gemini/settings.json` has an empty `mcpServers`
   *
   * All three adapters handle empty configs cleanly.
   */
  toMcpServers(): readonly McpServerSpec[] {
    return [];
  }

  /**
   * Agent-inventory block for the captain-system prompt. The `healthy`
   * flag is best-effort: we don't block the prompt on a health probe, and
   * M3 doesn't yet wire quota probes — `available` from adapter.healthCheck
   * informs it only after an explicit call to list_agents.
   */
  toPromptAgentInventory(): CaptainPromptAgentEntry[] {
    return registryAgents(this.registry);
  }

  /**
   * The `ToolCatalog` view for M3-7's converters. `mcpServers` is what the
   * Codex/Claude/Gemini converters iterate; `crewTools` documents the
   * connection between the MCP servers and the concrete tools the captain
   * sees (converters don't read it).
   */
  toMcpRegistrationCatalog(): {
    readonly mcpServers: readonly McpServerSpec[];
    readonly crewTools: readonly ToolDefinition[];
  } {
    return {
      mcpServers: this.toMcpServers(),
      crewTools: this.buildActionServer().listTools(),
    };
  }

  /**
   * Convenience: a CaptainActionServer configured from this catalog. Cached
   * per instance so `getToolSchemaHash()` is free on the second call.
   */
  buildActionServer(): CaptainActionServer {
    if (!this.cachedActionServer) {
      this.cachedActionServer = new CaptainActionServer(this.toActionCatalog());
    }
    return this.cachedActionServer;
  }

  /**
   * Hash stable across identical catalogs (names, descriptions, input
   * schemas). MUST NOT read anything outside the tool spec — agent
   * inventory shifts and preset hint edits should not invalidate
   * providerSessionRef. (M3-4 plan: "the hash changes only when the tool
   * spec itself changes".)
   */
  getToolSchemaHash(): string {
    return this.buildActionServer().getToolSchemaHash();
  }
}

/**
 * Small helper — registry adapters surfaced as a prompt-ready entry list.
 * Used by M3-3's prompt module when it is not handed a ToolCatalog directly.
 */
export function promptAgentInventoryFromRegistry(
  registry: AdapterRegistry | RegistryForCatalog,
): CaptainPromptAgentEntry[] {
  return registryAgents(registry);
}
