/**
 * Static tool catalog used by `crew install` (to render the skill's
 * tool list) and `crew verify` (to parity-check the rendered skill).
 *
 * Mirrors the tools registered in `src/cli/commands/serve.ts`. Drift
 * between this list and the live MCP surface is what `crew verify`
 * exists to catch — and a parity unit test in
 * `test/install/tool-catalog.test.ts` asserts the two stay aligned at
 * build time.
 *
 * When adding a new tool: register it in serve.ts AND add it here. The
 * unit test will fail loudly if you forget either.
 */

import {
  CONTINUE_RUN_DESCRIPTION,
  DISCARD_RUN_DESCRIPTION,
  GET_RUN_STATUS_DESCRIPTION,
  LIST_AGENTS_DESCRIPTION,
  MERGE_RUN_DESCRIPTION,
  RUN_AGENT_DESCRIPTION,
} from '../orchestrator/tools/index.js';
import type { SkillTool } from './skill-renderer.js';

export const CATALOG_TOOLS: readonly SkillTool[] = [
  { name: 'list_agents', description: LIST_AGENTS_DESCRIPTION },
  { name: 'run_agent', description: RUN_AGENT_DESCRIPTION },
  { name: 'continue_run', description: CONTINUE_RUN_DESCRIPTION },
  { name: 'merge_run', description: MERGE_RUN_DESCRIPTION },
  { name: 'discard_run', description: DISCARD_RUN_DESCRIPTION },
  { name: 'get_run_status', description: GET_RUN_STATUS_DESCRIPTION },
];

export function getCatalogToolNames(): readonly string[] {
  return CATALOG_TOOLS.map((t) => t.name);
}
