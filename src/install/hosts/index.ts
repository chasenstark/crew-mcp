/**
 * Host adapter registry. The install / verify / uninstall commands
 * resolve targets through this map. `--target all` enumerates the hosts
 * valid for the requested scope.
 *
 * Three id sets, because scope-capability is not uniform:
 *   - ALL_HOST_IDS     — every registered host (id validation).
 *   - GLOBAL_HOST_IDS  — hosts installable at global scope (they have a
 *                        global MCP config). `--target all` (global)
 *                        enumerates these.
 *   - PROJECT_HOST_IDS — hosts installable at project scope. `--target
 *                        all --scope project` enumerates these.
 *
 * Most hosts are global-capable; codex + claude-code are ALSO project-
 * capable. agy is the inverse: project-only (its MCP config loads ONLY
 * from <repo>/.agents/mcp_config.json), so it is in PROJECT_HOST_IDS and
 * ALL_HOST_IDS but NOT GLOBAL_HOST_IDS.
 */

import type { HostAdapter } from './types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { agyAdapter } from './agy.js';

export type HostId = HostAdapter['id'];

export const HOST_ADAPTERS: Record<HostId, HostAdapter> = {
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
  agy: agyAdapter,
};

export const ALL_HOST_IDS: readonly HostId[] = ['claude-code', 'codex', 'agy'];
export const GLOBAL_HOST_IDS: readonly HostId[] = ['claude-code', 'codex'];
export const PROJECT_HOST_IDS: readonly HostId[] = ['claude-code', 'codex', 'agy'];

export function isProjectHostId(id: HostId): boolean {
  return PROJECT_HOST_IDS.includes(id);
}

export function isGlobalHostId(id: HostId): boolean {
  return GLOBAL_HOST_IDS.includes(id);
}

export type { HostAdapter };
export { claudeCodeAdapter, codexAdapter, agyAdapter };
