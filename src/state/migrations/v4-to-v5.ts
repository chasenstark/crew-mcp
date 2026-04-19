/**
 * v4 → v5 migration (M3-11).
 *
 * The v5 bump drops nine runtime-scratch fields that the M3 runner no
 * longer writes:
 *
 *   - `executionMode`      (linear path retired)
 *   - `toolCallTranscript` (session-log is the durable record)
 *   - `actionHistory`      (11-verb controller scratch)
 *   - `controllerCursor`   (11-verb controller scratch)
 *   - `nativeToolCalls`    (budget counter on the deleted native-loop path)
 *   - `artifactsByTask`    (legacy task-keyed layout; M1.5-14 moved to runs)
 *   - `taskStates`         (same)
 *   - `pendingQueue`       (same)
 *   - `providerSession`    (ref lives on CaptainSession post-M1.5-7)
 *
 * v4 readers discard the fields on write; v5 writers never produce them.
 *
 * Legacy-mode gate: any state file with `executionMode === 'linear'` is
 * rejected here with `LegacyExecutionModeError`. The error suggests
 * `crew state reset` — the single user-facing recovery path once
 * `crew resume` is deleted (M3-12).
 */

import type { WorkflowState } from '../types.js';
import { logger } from '../../utils/logger.js';

export const CURRENT_STATE_SCHEMA_VERSION = 5;

export class LegacyExecutionModeError extends Error {
  readonly name = 'LegacyExecutionModeError';
  constructor() {
    super(
      'This session was created with the legacy linear execution mode; it cannot be resumed on the current version. ' +
      'Run `crew state reset` to start fresh.',
    );
  }
}

/**
 * Accepts v3/v4/v5 input; returns v5. Null when the input is not a
 * recognizable WorkflowState shape. Throws LegacyExecutionModeError when
 * the input is v3/v4 with `executionMode: 'linear'`.
 */
export function migrateStateToV5(raw: unknown): WorkflowState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const state = raw as Partial<WorkflowState> & Record<string, unknown>;
  const version = typeof state.schemaVersion === 'number' ? state.schemaVersion : undefined;

  // Reject legacy linear mode regardless of schemaVersion — v3, v4, and v5
  // all gate here so the error text is reached through every entry point.
  if (state.executionMode === 'linear') {
    throw new LegacyExecutionModeError();
  }

  if (version === CURRENT_STATE_SCHEMA_VERSION) {
    return state as WorkflowState;
  }

  if (version === undefined || version <= 4) {
    logger.debug(
      `[state] upgrading workflow state from schemaVersion ${version ?? 'unversioned'} to ${CURRENT_STATE_SCHEMA_VERSION}`,
    );
    // Drop the v5-obsolete fields on upgrade. The output is still the
    // shape-rich `WorkflowState` interface; dropped fields are simply
    // unset.
    const {
      executionMode: _exec,
      toolCallTranscript: _tc,
      actionHistory: _ah,
      controllerCursor: _cc,
      nativeToolCalls: _ntc,
      artifactsByTask: _abt,
      taskStates: _ts,
      pendingQueue: _pq,
      providerSession: _ps,
      ...rest
    } = state as WorkflowState;
    return {
      ...(rest as WorkflowState),
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    };
  }

  logger.warn(
    `[state] encountered unknown schemaVersion ${version}; refusing to load. ` +
      'Consider running `crew state reset` to start fresh.',
  );
  return null;
}
