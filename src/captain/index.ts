// v2 surviving captain-substrate exports.
//
// The v0.1 runtime (JudgmentRunner, CaptainSession, SessionStore, presets,
// prompts, schemas, steps, retired wrapper tools) was removed in M0. The
// pieces below are the load-bearing substrate that v2 reuses: the
// MCP-shaped action server, the per-CLI MCP registration converters, and
// the non-blocking dispatcher. ToolCatalog will be rebuilt in M1 against
// the trimmed 6-tool surface; until then, the M1 `crew serve` entrypoint
// will compose CaptainActionServer + ToolDispatcher + the surviving
// run-agent / list-agents tool definitions directly.
export { CaptainActionServer, DEFAULT_TOOL_NAMESPACE } from './action-server.js';
export type { ActionCatalogEntry } from './action-server.js';
export type { PipelineEvents, AgentRegistry } from './events.js';
export { ToolDispatcher } from './tool-dispatcher.js';
