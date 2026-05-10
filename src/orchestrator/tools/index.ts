// v2 tool barrel — the 8-tool surface.
//
// run_agent + list_agents survive from v0.1 (with run_agent's auto-merge
// removed in M1). list_runs adds repo-scoped run recovery. The lifecycle
// tools (continue_run, merge_run, discard_run, get_run_status, cancel_run)
// hand worktree lifecycle control to the host CLI explicitly. The retired v0.1 tools
// (ask_user, message_user, finish, plan_tasks, analyze_output,
// compress_context) move to the host CLI's responsibility — see
// HISTORICAL_CONTEXT.md.
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
export {
  DEFAULT_LIST_RUNS_LIMIT,
  listRuns,
  listRunsInputSchema,
  LIST_RUNS_DESCRIPTION,
  MAX_LIST_RUNS_LIMIT,
  runStatusSchema,
  type ListRunsContext,
  type ListRunsEntry,
  type ListRunsInput,
  type ListRunsOutput,
} from './list-runs.js';
export {
  continueRunInputSchema,
  CONTINUE_RUN_DESCRIPTION,
  type ContinueRunInput,
} from './continue-run.js';
export {
  mergeRunInputSchema,
  MERGE_RUN_DESCRIPTION,
  type MergeRunInput,
} from './merge-run.js';
export {
  discardRunInputSchema,
  DISCARD_RUN_DESCRIPTION,
  type DiscardRunInput,
} from './discard-run.js';
export {
  getRunStatusInputSchema,
  GET_RUN_STATUS_DESCRIPTION,
  type GetRunStatusInput,
} from './get-run-status.js';
export {
  cancelRunInputSchema,
  CANCEL_RUN_DESCRIPTION,
  type CancelRunInput,
} from './cancel-run.js';
