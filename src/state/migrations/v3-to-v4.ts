import type { WorkflowState } from '../types.js';
import { logger } from '../../utils/logger.js';

export const CURRENT_STATE_SCHEMA_VERSION = 4;

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

  if (version === CURRENT_STATE_SCHEMA_VERSION) {
    return state as WorkflowState;
  }

  if (version === undefined || version <= 3) {
    logger.info(
      `[state] upgrading workflow state from schemaVersion ${version ?? 'unversioned'} to ${CURRENT_STATE_SCHEMA_VERSION}`,
    );
    return {
      ...(state as WorkflowState),
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    };
  }

  logger.warn(
    `[state] encountered unknown schemaVersion ${version}; refusing to load. ` +
      'Consider running `crew state reset` to start fresh.',
  );
  return null;
}
