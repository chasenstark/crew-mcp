import { describe, expect, it } from 'vitest';

import {
  isMergeable,
  legacyReadOnlyShim,
  ownsWorktree,
  runModeFromInput,
  runModeFromState,
  RUN_MODES,
} from '../../src/orchestrator/run-mode.js';

describe('run-mode resolvers', () => {
  it('ownsWorktree: write and ephemeral_review own a worktree; read_only does not', () => {
    expect(ownsWorktree('write')).toBe(true);
    expect(ownsWorktree('ephemeral_review')).toBe(true);
    expect(ownsWorktree('read_only')).toBe(false);
  });

  it('isMergeable: ONLY write merges', () => {
    expect(isMergeable('write')).toBe(true);
    expect(isMergeable('read_only')).toBe(false);
    expect(isMergeable('ephemeral_review')).toBe(false);
  });

  it('legacyReadOnlyShim is !isMergeable — ephemeral persists readOnly:true', () => {
    expect(legacyReadOnlyShim('write')).toBe(false);
    expect(legacyReadOnlyShim('read_only')).toBe(true);
    expect(legacyReadOnlyShim('ephemeral_review')).toBe(true);
    for (const mode of RUN_MODES) {
      expect(legacyReadOnlyShim(mode)).toBe(!isMergeable(mode));
    }
  });
});

describe('runModeFromInput', () => {
  it('defaults to write; read_only:true is sugar for read_only', () => {
    expect(runModeFromInput({})).toEqual({ ok: true, mode: 'write' });
    expect(runModeFromInput({ read_only: true })).toEqual({ ok: true, mode: 'read_only' });
    expect(runModeFromInput({ read_only: false })).toEqual({ ok: true, mode: 'write' });
    expect(runModeFromInput({ run_mode: 'ephemeral_review' }))
      .toEqual({ ok: true, mode: 'ephemeral_review' });
    expect(runModeFromInput({ run_mode: 'write' })).toEqual({ ok: true, mode: 'write' });
  });

  it('accepts an AGREEING pair', () => {
    expect(runModeFromInput({ run_mode: 'read_only', read_only: true }))
      .toEqual({ ok: true, mode: 'read_only' });
    expect(runModeFromInput({ run_mode: 'write', read_only: false }))
      .toEqual({ ok: true, mode: 'write' });
    // Dispatch/input readOnly is FALSE for ephemeral — not a conflict.
    expect(runModeFromInput({ run_mode: 'ephemeral_review', read_only: false }))
      .toEqual({ ok: true, mode: 'ephemeral_review' });
  });

  it('rejects a DISAGREEING pair loudly instead of letting one side win', () => {
    for (const runMode of ['write', 'ephemeral_review'] as const) {
      const res = runModeFromInput({ run_mode: runMode, read_only: true });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.message).toContain('conflicting mode inputs');
    }
    const res = runModeFromInput({ run_mode: 'read_only', read_only: false });
    expect(res.ok).toBe(false);
  });
});

describe('runModeFromState', () => {
  it('prefers the persisted runMode — the readOnly shim never overrides it', () => {
    // ephemeral persists readOnly:true (the !isMergeable shim); the mode wins.
    expect(runModeFromState({ runMode: 'ephemeral_review', readOnly: true }))
      .toBe('ephemeral_review');
    expect(runModeFromState({ runMode: 'write', readOnly: false })).toBe('write');
    expect(runModeFromState({ runMode: 'read_only', readOnly: true })).toBe('read_only');
  });

  it('derives legacy records (no runMode) from the readOnly shim', () => {
    expect(runModeFromState({})).toBe('write');
    expect(runModeFromState({ readOnly: true })).toBe('read_only');
    expect(runModeFromState({ readOnly: false })).toBe('write');
  });

  it('degrades an unrecognized future runMode to the shim-derived fail-safe', () => {
    expect(runModeFromState({ runMode: 'holographic_review', readOnly: true }))
      .toBe('read_only');
    expect(runModeFromState({ runMode: 'holographic_review' })).toBe('write');
  });
});
