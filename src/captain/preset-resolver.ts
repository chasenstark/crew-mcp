// preset-resolver owns the "which preset is active right now" decision.
// Two inputs can point at a preset name: the config's `captain.preset`
// (global default) and the session's `activePreset` (user-scoped mid-run
// override via /preset). The session override wins when it's a non-empty
// string that resolves to a real entry in `presets`; otherwise the config
// default wins; otherwise no preset applies.
//
// The narrow PresetResolverArgs shape (rather than `FullConfig`) keeps the
// resolver decoupled from the full config shape so unit tests parameterize
// trivially. Callers (create-runner, judgment-runner per-turn, /preset
// handler) assemble the three fields from whatever they have on hand.

import { logger } from '../utils/logger.js';
import type { PresetConfig } from '../workflow/types.js';

export interface PresetResolverArgs {
  readonly presets?: Record<string, PresetConfig>;
  /** From `config.captain.preset`. Missing → the default is "no hint". */
  readonly defaultPresetName?: string;
  /**
   * From `session.activePreset`. When set + resolving to a real entry,
   * supersedes `defaultPresetName`. When set but pointing at an unknown
   * name, the resolver returns `undefined` (the caller decides fallback
   * policy at the next level up).
   */
  readonly sessionOverride?: string;
}

export interface ResolvedPreset {
  /** The resolved key — useful for logs, /preset list, event payloads. */
  readonly name: string;
  readonly preset: PresetConfig;
}

/**
 * Throttle the "unknown preset" warn per-name so a session that repeatedly
 * references a deleted preset across many turns only logs once. Process-
 * scoped: short-lived CLI invocations rarely need invalidation, and a
 * keys-hash invalidation (per the execution plan's §risks table) is cheap
 * to add later if a long-lived shell starts accumulating false silences.
 */
const warnedUnknownPresets = new Set<string>();

/**
 * Exported for tests only — clears the throttle latch between scenarios.
 */
export function __resetPresetWarnLatchForTest(): void {
  warnedUnknownPresets.clear();
}

function warnUnknownPresetOnce(name: string, source: 'session' | 'config'): void {
  const key = `${source}:${name}`;
  if (warnedUnknownPresets.has(key)) return;
  warnedUnknownPresets.add(key);
  const hint = source === 'session'
    ? `session.activePreset points at unknown preset "${name}"`
    : `captain.preset "${name}" is not declared in presets`;
  logger.warn(`[preset-resolver] ${hint}. Falling back to the next resolution tier (config default / no hint).`);
}

export function resolveActivePreset(args: PresetResolverArgs): ResolvedPreset | undefined {
  const { presets, defaultPresetName, sessionOverride } = args;

  if (typeof sessionOverride === 'string' && sessionOverride.length > 0) {
    const entry = presets?.[sessionOverride];
    if (entry) return { name: sessionOverride, preset: entry };
    // Non-empty session override pointing at an unknown name: warn (throttled)
    // and fall through. We do NOT silently fall back to the config default,
    // because M5-7's contract is "unknown session override resolves to
    // undefined; the runner decides fallback at the next tier."
    warnUnknownPresetOnce(sessionOverride, 'session');
    return undefined;
  }

  if (typeof defaultPresetName === 'string' && defaultPresetName.length > 0) {
    const entry = presets?.[defaultPresetName];
    if (entry) return { name: defaultPresetName, preset: entry };
    warnUnknownPresetOnce(defaultPresetName, 'config');
    return undefined;
  }

  return undefined;
}
