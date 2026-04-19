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

import { z } from 'zod';
import type { ToolDefinition } from '../../adapters/types.js';
import type {
  AgentAdapter,
} from '../../adapters/types.js';
import type { AdapterRegistry } from '../../adapters/registry.js';

/**
 * Minimal registry surface the catalog needs. Accepts either the full
 * AdapterRegistry or the legacy AgentRegistry that exposes only `list` +
 * `get`.
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
import type { WorkflowConfig, PresetConfig } from '../../workflow/types.js';
import type { ActionCatalogEntry } from '../action-server.js';
import { CaptainActionServer, DEFAULT_TOOL_NAMESPACE } from '../action-server.js';
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
  readonly preset?: PresetConfig;
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
 * Input schemas — the canonical contract for each tool. These are the ONLY
 * thing that feeds the schema hash; descriptions, agent inventory shifts,
 * and preset hints do not.
 */
const runAgentInput = z.object({
  agent_id: z.string().min(1),
  prompt: z.string().min(1),
  working_directory: z.string().optional(),
  model: z.string().optional(),
  capabilities_hint: z.array(z.string()).optional(),
});

const listAgentsInput = z.object({}).passthrough();

const askUserInput = z.object({
  question: z.string().min(1),
});

const messageUserInput = z.object({
  text: z.string().min(1),
});

const planTasksInput = z.object({
  user_request: z.string().min(1),
  hints: z.array(z.string()).optional(),
});

const analyzeOutputInput = z.object({
  task_description: z.string().min(1),
  agent_output: z.string(),
  files_modified: z.array(z.string()).optional(),
});

const compressContextInput = z.object({
  analyzed_output: z.unknown(),
  pass_number: z.number().optional(),
});

const finishInput = z.object({
  summary: z.string().min(1),
  outcome: z.enum(['success', 'partial', 'failed']).optional(),
});

/**
 * Descriptions — prompt material that DOES feed the schema hash (via
 * CaptainActionServer.listTools → JSON schema). Keep stable across releases
 * so providerSessionRef doesn't invalidate gratuitously.
 */
const DESCRIPTIONS: Record<M3ToolName, string> = {
  run_agent:
    'Delegate a bounded task to a named subagent. agent_id must come from list_agents; the prompt is what the agent sees verbatim. working_directory defaults to the run worktree.',
  list_agents:
    'Return the current agent inventory (name, capabilities, health, optional quota).',
  ask_user:
    'Block and wait for a user response. Use only when genuinely blocked.',
  message_user:
    'Write a message visible to the user without ending the turn.',
  plan_tasks:
    'Decompose the user request into structured tasks (id, role, dependencies, scope).',
  analyze_output:
    'Summarize an agent result into a structured assessment (decisions, concerns, review findings).',
  compress_context:
    'Condense an analyzed output into a terse summary for the next pass.',
  finish:
    'Emit the final report and terminate the session. Call when the user request is addressed.',
};

const INPUT_SCHEMAS: Record<M3ToolName, z.ZodType> = {
  run_agent: runAgentInput,
  list_agents: listAgentsInput,
  ask_user: askUserInput,
  message_user: messageUserInput,
  plan_tasks: planTasksInput,
  analyze_output: analyzeOutputInput,
  compress_context: compressContextInput,
  finish: finishInput,
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
  readonly preset: PresetConfig | undefined;
  readonly session: CaptainSession | undefined;
  readonly dispatcher: ToolDispatcher | undefined;
  private readonly omitOptionalWrappers: boolean;
  private cachedActionServer: CaptainActionServer | undefined;

  constructor(init: ToolCatalogInit) {
    this.registry = init.registry;
    this.workflow = init.workflow;
    this.preset = init.preset;
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
   * MCP-server list for the three adapter converters. M3 emits a single
   * `crew` server entry describing the captain action namespace; M5 will
   * add real external MCP servers. The converters don't distinguish — they
   * serialize whatever the catalog emits.
   */
  toMcpServers(): readonly McpServerSpec[] {
    // The `crew` server entry is a self-reference: it describes the MCP
    // namespace the captain sees but does not point at a real process.
    // Converters serialize `command` verbatim; M3 ships no external servers
    // so this is a placeholder record the real catalog can later be
    // superseded by (see M3-4 plan: "today this is a derivation of
    // CaptainActionServer.listTools() wrapped in the crew MCP transport
    // metadata; most real MCP-server entries land in M5").
    return [
      {
        name: 'crew',
        command: 'crew-mcp',
        args: ['--namespace', DEFAULT_TOOL_NAMESPACE],
      },
    ];
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
