import {
  existsSync,
  readFileSync,
} from 'node:fs';

import { atomicWrite } from '../../../utils/atomic-write.js';
import {
  resolveAgentPrefsPath,
  type AgentPreferences,
} from '../../../agent-prefs/store.js';

export type RawAgentPrefs = Record<string, unknown>;

export function readRawAgentPrefsFile(crewHome: string): RawAgentPrefs {
  const path = resolveAgentPrefsPath(crewHome);
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must be a JSON object before crew-mcp can update it.`);
  }
  return parsed as RawAgentPrefs;
}

export function writeRawAgentPrefsFile(crewHome: string, data: RawAgentPrefs): void {
  const path = resolveAgentPrefsPath(crewHome);
  atomicWrite(path, JSON.stringify(data, null, 2) + '\n');
}

export function mergeAgentEntries(
  raw: RawAgentPrefs,
  entries: Record<string, AgentPreferences>,
): RawAgentPrefs {
  return {
    ...raw,
    ...entries,
  };
}
