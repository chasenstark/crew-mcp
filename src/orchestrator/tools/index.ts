// v2 tool barrel — surviving 2 of v0.1's 8 tools.
//
// run_agent and list_agents are the only v0.1 tools that survive into v2's
// hosted-MCP model. M2 will add lifecycle tools (continue_run, merge_run,
// discard_run, get_run_status) on top. The retired tools (ask_user,
// message_user, finish, plan_tasks, analyze_output, compress_context) move
// to the host CLI's responsibility — see HISTORICAL_CONTEXT.md.
export {
  planRunAgent,
  runAgentInputSchema,
  RUN_AGENT_DESCRIPTION,
  type RunAgentInput,
  type RunAgentPlan,
  type RunAgentDispatchPlan,
  type RunAgentErrorPlan,
  type RunAgentHandlerContext,
} from './run-agent.js';
export {
  listAgents,
  listAgentsInputSchema,
  LIST_AGENTS_DESCRIPTION,
  type ListAgentsAgentEntry,
  type ListAgentsContext,
  type ListAgentsInput,
  type ListAgentsOutput,
} from './list-agents.js';
