// v2 tool barrel — the tool surface.
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
  getCrewPreferencesHandler,
  getCrewPreferencesInputSchema,
  GET_CREW_PREFERENCES_DESCRIPTION,
  type GetCrewPreferencesContext,
  type GetCrewPreferencesInput,
  type GetCrewPreferencesOutput,
} from './get-crew-preferences.js';
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
export {
  runPanelHandler,
  runPanelInputSchema,
  RUN_PANEL_DESCRIPTION,
  type FailedReviewerEnvelope,
  type ReviewerDispatchEnvelope,
  type RunPanelHandlerContext,
  type RunPanelInput,
  type RunPanelOutput,
} from './run-panel.js';
export {
  getPanelStatusHandler,
  getPanelStatusInputSchema,
  GET_PANEL_STATUS_DESCRIPTION,
  isTerminalRunStatus,
  type GetPanelStatusHandlerContext,
  type GetPanelStatusInput,
  type GetPanelStatusOutput,
  type PanelReviewerStatus,
} from './get-panel-status.js';
export {
  aggregatePanelHandler,
  aggregatePanelInputSchema,
  AGGREGATE_PANEL_DESCRIPTION,
  type AggregatePanelHandlerContext,
  type AggregatePanelInput,
  type AggregatePanelOutput,
} from './aggregate-panel.js';
export {
  createCriteriaHandler,
  createCriteriaInputSchema,
  CREATE_CRITERIA_DESCRIPTION,
  type CreateCriteriaContext,
  type CreateCriteriaInput,
  type CreateCriteriaOutput,
} from './create-criteria.js';
export {
  confirmCriteriaHandler,
  confirmCriteriaInputSchema,
  CONFIRM_CRITERIA_DESCRIPTION,
  type ConfirmCriteriaContext,
  type ConfirmCriteriaInput,
  type ConfirmCriteriaOutput,
} from './confirm-criteria.js';
export {
  getCriteriaHandler,
  getCriteriaInputSchema,
  GET_CRITERIA_DESCRIPTION,
  type GetCriteriaContext,
  type GetCriteriaInput,
  type GetCriteriaOutput,
} from './get-criteria.js';
export {
  reviseCriteriaHandler,
  reviseCriteriaInputSchema,
  REVISE_CRITERIA_DESCRIPTION,
  type ReviseCriteriaContext,
  type ReviseCriteriaInput,
  type ReviseCriteriaOutput,
} from './revise-criteria.js';
