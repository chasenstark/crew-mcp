/**
 * Static tool catalog used by `crew-mcp install` (to render the skill's
 * tool list) and `crew-mcp verify` (to parity-check the rendered skill).
 *
 * Mirrors the tools registered in `src/cli/commands/serve.ts`. Drift
 * between this list and the live MCP surface is what `crew-mcp verify`
 * exists to catch — and a parity unit test in
 * `test/install/tool-catalog.test.ts` asserts the two stay aligned at
 * build time.
 *
 * When adding a new tool: register it in serve.ts AND add it here. The
 * unit test will fail loudly if you forget either.
 */

import {
  ACKNOWLEDGE_MESSAGES_DESCRIPTION,
  AGGREGATE_PANEL_DESCRIPTION,
  CANCEL_RUN_DESCRIPTION,
  CHECK_CAPTAIN_INBOX_DESCRIPTION,
  CONFIRM_CRITERIA_DESCRIPTION,
  CONTINUE_RUN_DESCRIPTION,
  CREATE_CRITERIA_DESCRIPTION,
  DISCARD_RUN_DESCRIPTION,
  GET_CREW_PREFERENCES_DESCRIPTION,
  GET_CRITERIA_DESCRIPTION,
  GET_PANEL_STATUS_DESCRIPTION,
  GET_RUN_STATUS_DESCRIPTION,
  LIST_AGENTS_DESCRIPTION,
  LIST_RUNS_DESCRIPTION,
  MERGE_RUN_DESCRIPTION,
  REVISE_CRITERIA_DESCRIPTION,
  RUN_PANEL_DESCRIPTION,
  RUN_AGENT_DESCRIPTION,
  SEND_MESSAGE_DESCRIPTION,
} from '../orchestrator/tools/index.js';
import type { SkillTool } from './skill-renderer.js';

export const CATALOG_TOOLS: readonly SkillTool[] = [
  { name: 'list_agents', description: LIST_AGENTS_DESCRIPTION },
  { name: 'get_crew_preferences', description: GET_CREW_PREFERENCES_DESCRIPTION },
  { name: 'list_runs', description: LIST_RUNS_DESCRIPTION },
  { name: 'check_captain_inbox', description: CHECK_CAPTAIN_INBOX_DESCRIPTION, mode: 'captain' },
  { name: 'acknowledge_messages', description: ACKNOWLEDGE_MESSAGES_DESCRIPTION, mode: 'captain' },
  { name: 'run_agent', description: RUN_AGENT_DESCRIPTION },
  { name: 'continue_run', description: CONTINUE_RUN_DESCRIPTION },
  { name: 'merge_run', description: MERGE_RUN_DESCRIPTION },
  { name: 'discard_run', description: DISCARD_RUN_DESCRIPTION },
  { name: 'get_run_status', description: GET_RUN_STATUS_DESCRIPTION },
  { name: 'cancel_run', description: CANCEL_RUN_DESCRIPTION },
  { name: 'run_panel', description: RUN_PANEL_DESCRIPTION },
  { name: 'get_panel_status', description: GET_PANEL_STATUS_DESCRIPTION },
  { name: 'aggregate_panel', description: AGGREGATE_PANEL_DESCRIPTION },
  { name: 'create_criteria', description: CREATE_CRITERIA_DESCRIPTION },
  { name: 'confirm_criteria', description: CONFIRM_CRITERIA_DESCRIPTION },
  { name: 'get_criteria', description: GET_CRITERIA_DESCRIPTION },
  { name: 'revise_criteria', description: REVISE_CRITERIA_DESCRIPTION },
  { name: 'send_message', description: SEND_MESSAGE_DESCRIPTION, mode: 'worker' },
];
