import type { WorkflowState } from '../types.js';
import { logger } from '../../utils/logger.js';

// CURRENT_STATE_SCHEMA_VERSION now lives in v4-to-v5.ts — v5 is the target
// for fresh writes post-M3-11. The v4 tag is still a valid intermediate
// shape produced by this migrator when called from store.loadState().
export const V4_SCHEMA_VERSION = 4;

/**
 * Migrates a raw state blob read from disk up to the current schema version.
 *
 * Pre-M3 state files (schemaVersion 2 or 3, or missing) keep their shape;
 * the only on-disk change at v4 is the version tag itself. This lets M3
 * delete the runtime-only fields (actionHistory, toolCallTranscript, etc.)
 * in a single step while v3 readers keep working until then.
 *
 * Returns the upgraded state, or null if the input is not a recognizable
 * WorkflowState shape.
 */
export function migrateStateToV4(raw: unknown): WorkflowState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const state = raw as Partial<WorkflowState> & Record<string, unknown>;
  const version = typeof state.schemaVersion === 'number' ? state.schemaVersion : undefined;

  if (version === V4_SCHEMA_VERSION) {
    return state as WorkflowState;
  }

  // Let v5+ pass through untouched — the caller (store.loadState) chains
  // this migrator with migrateStateToV5, so a fresh v5 state should not be
  // downgraded to v4. Unknown higher versions are surfaced via the v5
  // migrator's own "refuse to load" branch.
  if (typeof version === 'number' && version > V4_SCHEMA_VERSION) {
    return state as WorkflowState;
  }

  if (version === undefined || version <= 3) {
    logger.debug(
      `[state] upgrading workflow state from schemaVersion ${version ?? 'unversioned'} to ${V4_SCHEMA_VERSION}`,
    );
    return {
      ...(state as WorkflowState),
      schemaVersion: V4_SCHEMA_VERSION,
    };
  }

  logger.warn(
    `[state] encountered unknown schemaVersion ${version}; refusing to load. ` +
      'Consider running `crew state reset` to start fresh.',
  );
  return null;
}
