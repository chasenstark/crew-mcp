// v2 surviving captain-substrate exports.
//
// The v0.1 runtime (JudgmentRunner, CaptainSession, SessionStore, presets,
// prompts, schemas, steps, retired wrapper tools) was removed in M0. The
// pieces below are the load-bearing substrate that v2 reuses: the
// MCP-shaped action server, the per-CLI MCP registration converters, and
// the non-blocking dispatcher. The live `crew-mcp serve` entrypoint composes
// CaptainActionServer + ToolDispatcher + the eight tools listed in
// `src/cli/commands/serve.ts` (list_agents, list_runs, run_agent,
// continue_run, merge_run, discard_run, cancel_run, get_run_status).
export { CaptainActionServer, DEFAULT_TOOL_NAMESPACE } from './action-server.js';
export type { ActionCatalogEntry } from './action-server.js';
export type { PipelineEvents, AgentRegistry } from './events.js';
export { ToolDispatcher } from './tool-dispatcher.js';
