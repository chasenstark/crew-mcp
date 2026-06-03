/**
 * Per-machine agent preferences file at `<crewHome>/agents.json`.
 *
 * Each adapter ships defaults for `strengths` (soft routing hints) and
 * `effort` (reasoning depth: low|medium|high). The user overrides those
 * defaults per-machine by editing this file. `crew-mcp install` seeds it on
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
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { EffortLevel } from '../adapters/types.js';
import { atomicWrite } from '../utils/atomic-write.js';
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
   * Optional adapter implementation for custom agents. Built-in entries
   * usually omit this and use the file only for routing/model hints.
   */
  readonly adapter?: string;
  /**
   * Soft routing hints (free-form strings). Empty = "no strengths
   * declared." Captain reads as nudges, not constraints.
   */
  readonly strengths?: readonly string[];
  /** Default effort level for dispatches to this agent. */
  readonly effort?: EffortLevel;
  /**
   * Default model for dispatches to this agent. Free-form string
   * (passed through to the adapter's `--model` flag). Per-call
   * `run_agent({model})` wins. Empty/missing = adapter's CLI picks
   * its own default — we deliberately don't second-guess
   * `~/.claude.json` / `~/.codex/config.toml` etc. when the user
   * hasn't expressed a per-machine preference.
   */
  readonly model?: string;
  /** Base URL for OpenAI-compatible custom agents. */
  readonly apiBase?: string;
  /** API key or provider-specific sentinel for OpenAI-compatible agents. */
  readonly apiKey?: string;
  /** Shell command for generic custom agents. */
  readonly command?: string;
  /** Argument template for generic custom agents. */
  readonly args?: readonly string[];
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
  if ('adapter' in record) {
    if (typeof record.adapter === 'string' && record.adapter.trim().length > 0) {
      out.adapter = record.adapter.trim();
    } else {
      logger.warn(
        `[agent-prefs] "${agentName}".adapter must be a non-empty string; dropping field`,
      );
    }
  }
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
  if ('model' in record) {
    if (typeof record.model === 'string' && record.model.trim().length > 0) {
      out.model = record.model.trim();
    } else {
      logger.warn(
        `[agent-prefs] "${agentName}".model must be a non-empty string; dropping field`,
      );
    }
  }
  if ('apiBase' in record) {
    if (typeof record.apiBase === 'string' && record.apiBase.trim().length > 0) {
      out.apiBase = record.apiBase.trim();
    } else {
      logger.warn(
        `[agent-prefs] "${agentName}".apiBase must be a non-empty string; dropping field`,
      );
    }
  }
  if ('apiKey' in record) {
    if (typeof record.apiKey === 'string' && record.apiKey.trim().length > 0) {
      out.apiKey = record.apiKey.trim();
    } else {
      logger.warn(
        `[agent-prefs] "${agentName}".apiKey must be a non-empty string; dropping field`,
      );
    }
  }
  if ('command' in record) {
    if (typeof record.command === 'string' && record.command.trim().length > 0) {
      out.command = record.command.trim();
    } else {
      logger.warn(
        `[agent-prefs] "${agentName}".command must be a non-empty string; dropping field`,
      );
    }
  }
  if ('args' in record) {
    if (Array.isArray(record.args)) {
      out.args = record.args.filter((v): v is string => typeof v === 'string');
    } else {
      logger.warn(
        `[agent-prefs] "${agentName}".args must be an array of strings; dropping field`,
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
  const serialized = JSON.stringify(data, null, 2) + '\n';
  atomicWrite(path, serialized);
}

/**
 * Write the file ONLY if it doesn't already exist. Called by
 * `crew-mcp install` after a successful target install so first-time users
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
      'an entry to override for this machine. Three tunable fields:',
      '  - strengths: free-form soft routing hints surfaced via list_agents.',
      '  - effort: "low"|"medium"|"high"|"xhigh"|"max" — codex translates',
      '    to its model_reasoning_effort flag; other adapters log+ignore',
      '    and the captain restates the level in the prompt instead.',
      '  - model: free-form string passed to the adapter\'s --model flag.',
      '    Empty/missing = the adapter\'s CLI picks (we don\'t override',
      '    your ~/.claude.json or ~/.codex/config.toml).',
      'Per-call overrides via run_agent({model, effort}) always win.',
      'Underscore-prefixed keys are ignored. Delete this file to reset.',
      'Run `crew-mcp agents add` to register a custom OpenAI-compatible',
      'or generic agent — it walks you through provider, model, and',
      'verification without hand-editing this file.',
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
 * `effort` keeps the adapter's default `strengths`. `model` is the
 * exception — adapters intentionally don't ship a default for it
 * (they delegate to the CLI's own config), so the result's `model`
 * is just whatever the override specifies (or undefined).
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
    model: override.model !== undefined ? override.model : adapterDefault.model,
  };
}
