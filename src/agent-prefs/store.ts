/**
 * Per-machine agent preferences file at `<crewHome>/agents.json`.
 *
 * Each adapter ships defaults for `strengths` (soft routing hints) and
 * `effort` (reasoning depth: low|medium|high). The user overrides those
 * defaults per-machine by editing this file. `crew install` seeds it on
 * first install with every registered adapter's defaults; `crew agents
 * edit` opens it in `$EDITOR`.
 *
 * File shape (per agent name):
 *   {
 *     "claude-code": { "strengths": [...], "effort": "medium" },
 *     "codex":       { "strengths": [...], "effort": "high" }
 *   }
 *
 * Underscore-prefixed keys (`_readme`, `_comment`) are reserved as a
 * JSON-comment escape hatch and ignored when computing per-agent prefs.
 *
 * Read path is forgiving — list_agents calls through this on every
 * dispatch and a crash here would silently break the captain's
 * adapter discovery:
 *   - missing file               → `{}` (use adapter defaults)
 *   - invalid JSON               → `{}` + warning log
 *   - per-agent value not object → drop that key + warning log
 *   - bad strengths/effort field → drop the field, keep the entry
 *
 * Write path is atomic (tmp + rename) so a crash mid-write can't leave
 * a half-written file.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { EffortLevel } from '../adapters/types.js';
import { logger } from '../utils/logger.js';

export type { EffortLevel };

export const AGENT_PREFS_FILENAME = 'agents.json';

/**
 * Runtime list mirror of the EffortLevel literal union. Used for
 * validation in `isEffortLevel` and as a docstring anchor for the help
 * text written into the seeded `agents.json` _readme. Mirrors codex's
 * `model_reasoning_effort` set verbatim.
 */
export const EFFORT_LEVELS: readonly EffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}

export interface AgentPreferences {
  /**
   * Soft routing hints (free-form strings). Empty = "no strengths
   * declared." Captain reads as nudges, not constraints.
   */
  readonly strengths?: readonly string[];
  /** Default effort level for dispatches to this agent. */
  readonly effort?: EffortLevel;
}

export type AgentPrefsMap = Record<string, AgentPreferences>;

/** Absolute path to the prefs file under the given crew home. */
export function resolveAgentPrefsPath(crewHome: string): string {
  return join(crewHome, AGENT_PREFS_FILENAME);
}

/**
 * Read the agent prefs file. Always returns a map (possibly empty);
 * never throws. Underscore-prefixed keys are stripped — they're
 * reserved for user-authored comments since strict JSON has no
 * comment syntax.
 */
export function readAgentPrefsFile(crewHome: string): AgentPrefsMap {
  const path = resolveAgentPrefsPath(crewHome);
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    logger.warn(
      `[agent-prefs] could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(
      `[agent-prefs] ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}); using adapter defaults`,
    );
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.warn(`[agent-prefs] ${path} must be a JSON object; using adapter defaults`);
    return {};
  }
  const out: Record<string, AgentPreferences> = {};
  for (const [agentName, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (agentName.startsWith('_')) continue;
    const prefs = coerceEntry(agentName, value);
    if (prefs) out[agentName] = prefs;
  }
  return out;
}

function coerceEntry(agentName: string, value: unknown): AgentPreferences | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    logger.warn(
      `[agent-prefs] entry for "${agentName}" must be an object; ignoring`,
    );
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const out: { -readonly [K in keyof AgentPreferences]: AgentPreferences[K] } = {};
  if ('strengths' in record) {
    if (Array.isArray(record.strengths)) {
      out.strengths = record.strengths.filter((v): v is string => typeof v === 'string');
    } else {
      logger.warn(
        `[agent-prefs] "${agentName}".strengths must be an array of strings; dropping field`,
      );
    }
  }
  if ('effort' in record) {
    if (isEffortLevel(record.effort)) {
      out.effort = record.effort;
    } else {
      logger.warn(
        `[agent-prefs] "${agentName}".effort must be one of ${EFFORT_LEVELS.join('|')}; dropping field`,
      );
    }
  }
  return out;
}

/**
 * Atomically write the prefs file. Used by `seedAgentPrefsFile` and by
 * tests/fixtures. Not used silently in a hot path — overwriting user
 * edits is a deliberate action.
 */
export function writeAgentPrefsFile(crewHome: string, data: AgentPrefsMap): void {
  const path = resolveAgentPrefsPath(crewHome);
  mkdirSync(dirname(path), { recursive: true });
  const serialized = JSON.stringify(data, null, 2) + '\n';
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, serialized, 'utf-8');
  renameSync(tmp, path);
}

/**
 * Write the file ONLY if it doesn't already exist. Called by
 * `crew install` after a successful target install so first-time users
 * end up with a discoverable, editable file. Never overwrites existing
 * user customization.
 *
 * Returns true if the file was written, false if it already existed.
 */
export function seedAgentPrefsFile(
  crewHome: string,
  defaults: AgentPrefsMap,
): boolean {
  const path = resolveAgentPrefsPath(crewHome);
  if (existsSync(path)) return false;
  // The _readme key is stripped on read but lands in the file as a
  // breadcrumb for users opening it for the first time.
  const seeded: Record<string, unknown> = {
    _readme: [
      'Per-machine agent preferences. Each adapter ships defaults; edit',
      'an entry to override for this machine. `strengths` are free-form',
      'soft routing hints surfaced to the captain via list_agents.',
      '`effort` is one of "low"|"medium"|"high"|"xhigh"|"max" — codex',
      'translates to its `model_reasoning_effort` flag; other adapters',
      'log a debug message and ignore (the captain restates the level',
      'in the prompt for portable signaling). Underscore-prefixed keys',
      'are always ignored. Delete this file to fall back to defaults.',
    ],
    ...defaults,
  };
  // writeAgentPrefsFile asserts AgentPrefsMap shape; the readme is a
  // string-array under an ignored key, so the cast is safe at runtime.
  writeAgentPrefsFile(crewHome, seeded as AgentPrefsMap);
  return true;
}

/**
 * Resolve the effective prefs for an agent: file override merged on
 * top of adapter defaults, field-by-field. A user who overrides only
 * `effort` keeps the adapter's default `strengths`.
 */
export function effectiveAgentPrefs(
  agentName: string,
  adapterDefault: AgentPreferences,
  overrides: AgentPrefsMap,
): AgentPreferences {
  const override = overrides[agentName];
  if (!override) return adapterDefault;
  return {
    strengths: override.strengths !== undefined ? override.strengths : adapterDefault.strengths,
    effort: override.effort !== undefined ? override.effort : adapterDefault.effort,
  };
}
