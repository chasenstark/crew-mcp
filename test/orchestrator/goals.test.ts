import { describe, expect, it } from 'vitest';

import {
  continuationGoalPlan,
  GOAL_OUTCOMES,
  initialGoalPlan,
} from '../../src/orchestrator/goals.js';

const request = {
  validation_command: 'npm run test:run -- --run goal',
  repeat_safe: true as const,
  max_turns: 6,
  max_wall_clock_ms: 60_000,
};

describe('provider goal policy', () => {
  it('defines the complete terminal outcome vocabulary', () => {
    expect(GOAL_OUTCOMES).toEqual([
      'not_requested',
      'unsupported',
      'achieved',
      'impossible',
      'turn_capped',
      'watchdog_timeout',
      'cancelled',
      'provider_error',
      'evaluator_error',
    ]);
  });

  it('keeps Codex goals explicit and single-shot unsupported', () => {
    const plan = initialGoalPlan({
      adapter: { goalSupport: 'unsupported' },
      runMode: 'write',
      request,
    });
    expect(plan.record).toMatchObject({ outcome: 'unsupported', authoritative: true });
    expect(plan.constraint).toBeUndefined();
  });

  it('defaults can clear a prior Claude goal through an authoritative control action', () => {
    const initial = initialGoalPlan({
      adapter: { goalSupport: 'claude-native' },
      runMode: 'write',
      request,
    });
    const plan = continuationGoalPlan({
      adapter: { goalSupport: 'claude-native' },
      runMode: 'write',
      policy: 'clear',
      previous: initial.record,
      budget: initial.budget,
    });
    expect(plan).toMatchObject({
      ok: true,
      record: { policy: 'clear', authoritative: false },
      constraint: { action: 'clear' },
    });
  });

  it('retries a prior clear until provider-authoritative confirmation is recorded', () => {
    const plan = continuationGoalPlan({
      adapter: { goalSupport: 'claude-native' },
      runMode: 'write',
      policy: 'clear',
      previous: {
        policy: 'clear',
        outcome: 'provider_error',
        authoritative: false,
        reason: 'dispatch failed before provider confirmation',
        turnsUsed: 0,
        wallClockMsUsed: 0,
      },
      budget: {
        maxTurns: 6,
        maxWallClockMs: 60_000,
        turnsUsed: 2,
        wallClockMsUsed: 10_000,
      },
    });

    expect(plan).toMatchObject({
      ok: true,
      record: { policy: 'clear', authoritative: false },
      constraint: { action: 'clear', maxTurns: 0, maxWallClockMs: 0 },
    });
    expect(Object.hasOwn(plan, 'budget')).toBe(false);
  });

  it('subtracts cumulative use and refuses replacement budget extension', () => {
    const previous = initialGoalPlan({
      adapter: { goalSupport: 'claude-native' },
      runMode: 'write',
      request,
    }).record;
    const inherited = continuationGoalPlan({
      adapter: { goalSupport: 'claude-native' },
      runMode: 'write',
      policy: 'inherit',
      previous: { ...previous, outcome: 'turn_capped' },
      budget: {
        maxTurns: 6,
        maxWallClockMs: 60_000,
        turnsUsed: 4,
        wallClockMsUsed: 25_000,
      },
    });
    expect(inherited).toMatchObject({
      ok: true,
      constraint: { maxTurns: 2, maxWallClockMs: 35_000 },
    });

    const extended = continuationGoalPlan({
      adapter: { goalSupport: 'claude-native' },
      runMode: 'write',
      policy: 'replace',
      request: { ...request, max_turns: 7 },
      previous,
      budget: {
        maxTurns: 6,
        maxWallClockMs: 60_000,
        turnsUsed: 1,
        wallClockMsUsed: 1_000,
      },
    });
    expect(extended).toEqual({
      ok: false,
      message: 'goal.budget_extension_refused: replacement cannot increase the run aggregate goal budget',
    });

    const tightened = continuationGoalPlan({
      adapter: { goalSupport: 'claude-native' },
      runMode: 'write',
      policy: 'replace',
      request: { ...request, max_turns: 5, max_wall_clock_ms: 50_000 },
      previous,
      budget: {
        maxTurns: 6,
        maxWallClockMs: 60_000,
        turnsUsed: 4,
        wallClockMsUsed: 25_000,
      },
    });
    expect(tightened).toMatchObject({
      ok: true,
      budget: { maxTurns: 5, maxWallClockMs: 50_000 },
      constraint: { maxTurns: 1, maxWallClockMs: 25_000 },
    });
  });
});
