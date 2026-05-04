/**
 * Host adapter registry. The install / verify / uninstall commands
 * resolve targets through this map. `--target all` enumerates all
 * registered hosts.
 */

import type { HostAdapter } from './types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { geminiAdapter } from './gemini.js';

export type HostId = HostAdapter['id'];

export const HOST_ADAPTERS: Record<HostId, HostAdapter> = {
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
};

export const ALL_HOST_IDS: readonly HostId[] = ['claude-code', 'codex', 'gemini'];

export function getHostAdapter(id: HostId): HostAdapter {
  return HOST_ADAPTERS[id];
}

export type { HostAdapter };
export { claudeCodeAdapter, codexAdapter, geminiAdapter };
