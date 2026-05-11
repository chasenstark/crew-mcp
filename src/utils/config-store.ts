/**
 * Per-machine crew-mcp configuration file at `<crewHome>/config.json`.
 *
 * Stores user preferences that span the whole crew install (not
 * per-agent — those live in `agents.json`). Currently:
 *   - `notifications` (boolean): toggle OS toast on terminal run
 *     status. Env var `CREW_OS_NOTIFICATIONS=off` always overrides.
 *
 * Read path is forgiving — every read happens on a hot path (each
 * dispatched run terminal status) and a parser crash would silently
 * break notifications:
 *   - missing file        → defaults (notifications: true)
 *   - invalid JSON        → defaults + warning log
 *   - non-object root     → defaults + warning log
 *   - bad field type      → drop that field, keep the rest
 *
 * Write path is atomic (tmp + rename) so a crash mid-write can't leave
 * a half-written file. Underscore-prefixed keys are reserved for
 * user-authored comments (strict JSON has no comment syntax).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { logger } from './logger.js';

export const CONFIG_FILENAME = 'config.json';

export interface CrewConfig {
  /**
   * Whether OS terminal-status notifications fire when a dispatched
   * run reaches a terminal state. Defaults to true.
   */
  readonly notifications: boolean;
}

export const DEFAULT_CONFIG: CrewConfig = {
  notifications: true,
};

export function resolveConfigPath(crewHome: string): string {
  return join(crewHome, CONFIG_FILENAME);
}

/**
 * Read the config file. Always returns a complete config (defaults
 * fill any missing fields); never throws.
 */
export function readConfigFile(crewHome: string): CrewConfig {
  const path = resolveConfigPath(crewHome);
  if (!existsSync(path)) return DEFAULT_CONFIG;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    logger.warn(
      `[config] could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return DEFAULT_CONFIG;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(
      `[config] ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}); using defaults`,
    );
    return DEFAULT_CONFIG;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.warn(`[config] ${path} must be a JSON object; using defaults`);
    return DEFAULT_CONFIG;
  }
  const record = parsed as Record<string, unknown>;
  const out: { -readonly [K in keyof CrewConfig]: CrewConfig[K] } = { ...DEFAULT_CONFIG };
  if ('notifications' in record) {
    if (typeof record.notifications === 'boolean') {
      out.notifications = record.notifications;
    } else {
      logger.warn(
        `[config] ${path}: "notifications" must be a boolean; using default (${DEFAULT_CONFIG.notifications})`,
      );
    }
  }
  return out;
}

/**
 * Atomically write the config file. Preserves any underscore-prefixed
 * comment keys already present in the file so user breadcrumbs survive
 * round-trips through the TUI.
 */
export function writeConfigFile(crewHome: string, config: CrewConfig): void {
  const path = resolveConfigPath(crewHome);
  mkdirSync(dirname(path), { recursive: true });
  const existing = readRawObject(path);
  const merged: Record<string, unknown> = {};
  // Preserve _readme / _comment keys (and any other underscore-prefixed
  // user notes) by reading them from the existing file. Otherwise seed
  // a fresh _readme for first-time writes so the file is self-documenting.
  if (existing) {
    for (const [k, v] of Object.entries(existing)) {
      if (k.startsWith('_')) merged[k] = v;
    }
  }
  if (!('_readme' in merged)) {
    merged._readme = DEFAULT_README;
  }
  merged.notifications = config.notifications;
  const serialized = JSON.stringify(merged, null, 2) + '\n';
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, serialized, 'utf-8');
  renameSync(tmp, path);
}

function readRawObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Swallow — caller is rewriting the file anyway.
  }
  return undefined;
}

const DEFAULT_README: readonly string[] = [
  'crew-mcp per-machine configuration. Edit via `crew-mcp config`',
  '(interactive) or by hand. Underscore-prefixed keys are ignored.',
  'Fields:',
  '  - notifications (boolean): OS toast on terminal run status.',
  '    Env var CREW_OS_NOTIFICATIONS=off always overrides to off.',
  'Delete this file to reset to defaults.',
];
