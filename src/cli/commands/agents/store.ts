import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

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
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
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
