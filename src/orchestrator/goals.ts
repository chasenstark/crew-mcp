import { z } from 'zod';

import type {
  AgentAdapter,
  GoalContinuationPolicy,
  GoalExecutionResult,
  GoalOutcome,
  GoalRequest,
  GoalTaskConstraint,
} from '../adapters/types.js';
import type { RunMode } from './run-mode.js';

export const GOAL_OUTCOMES = [
  'not_requested',
  'unsupported',
  'achieved',
  'impossible',
  'turn_capped',
  'watchdog_timeout',
  'cancelled',
  'provider_error',
  'evaluator_error',
] as const satisfies readonly GoalOutcome[];

export const GOAL_CONTINUATION_POLICIES = [
  'inherit',
  'clear',
  'replace',
] as const satisfies readonly GoalContinuationPolicy[];

export const MAX_GOAL_TURNS = 20;
export const MAX_GOAL_WALL_CLOCK_MS = 10 * 60 * 1000;

export const goalRequestSchema = z.object({
  validation_command: z.string().trim().min(1).max(2_000).refine(
    (value) => !value.includes('\n') && !value.includes('\r'),
    'validation_command must be a single command line',
  ),
  repeat_safe: z.literal(true),
  max_turns: z.number().int().min(1).max(MAX_GOAL_TURNS),
  max_wall_clock_ms: z.number().int().min(1_000).max(MAX_GOAL_WALL_CLOCK_MS),
}).strict();

export type WireGoalRequest = z.infer<typeof goalRequestSchema>;

export interface GoalTurnRecord {
  readonly policy: 'not_requested' | 'start' | GoalContinuationPolicy;
  readonly request?: GoalRequest;
  /** Undefined only while a supported provider turn is in flight. */
  readonly outcome?: GoalOutcome;
  readonly authoritative: boolean;
  readonly reason?: string;
  readonly turnsUsed: number;
  readonly wallClockMsUsed: number;
}

export interface GoalBudgetRecord {
  readonly maxTurns: number;
  readonly maxWallClockMs: number;
  readonly turnsUsed: number;
  readonly wallClockMsUsed: number;
}

const persistedGoalRequestSchema = z.object({
  validationCommand: z.string().min(1),
  repeatSafe: z.literal(true),
  maxTurns: z.number().int().positive(),
  maxWallClockMs: z.number().int().positive(),
}).strict();

/** Strict codec for goal records copied into durable secondary stores. */
export const goalTurnRecordSchema = z.object({
  policy: z.enum(['not_requested', 'start', ...GOAL_CONTINUATION_POLICIES]),
  request: persistedGoalRequestSchema.optional(),
  outcome: z.enum(GOAL_OUTCOMES).optional(),
  authoritative: z.boolean(),
  reason: z.string().optional(),
  turnsUsed: z.number().nonnegative(),
  wallClockMsUsed: z.number().nonnegative(),
}).strict() satisfies z.ZodType<GoalTurnRecord>;

export interface WireGoalTurn {
  readonly policy: GoalTurnRecord['policy'];
  readonly requested?: {
    readonly validation_command: string;
    readonly repeat_safe: true;
    readonly max_turns: number;
    readonly max_wall_clock_ms: number;
  };
  readonly outcome?: GoalOutcome;
  readonly authoritative: boolean;
  readonly reason?: string;
  readonly turns_used: number;
  readonly wall_clock_ms_used: number;
}

export function goalRequestFromWire(request: WireGoalRequest): GoalRequest {
  return {
    validationCommand: request.validation_command,
    repeatSafe: true,
    maxTurns: request.max_turns,
    maxWallClockMs: request.max_wall_clock_ms,
  };
}

export function goalRequestToWire(request: GoalRequest): WireGoalTurn['requested'] {
  return {
    validation_command: request.validationCommand,
    repeat_safe: true,
    max_turns: request.maxTurns,
    max_wall_clock_ms: request.maxWallClockMs,
  };
}

export function goalTurnToWire(goal: GoalTurnRecord): WireGoalTurn {
  return {
    policy: goal.policy,
    ...(goal.request !== undefined ? { requested: goalRequestToWire(goal.request) } : {}),
    ...(goal.outcome !== undefined ? { outcome: goal.outcome } : {}),
    authoritative: goal.authoritative,
    ...(goal.reason !== undefined ? { reason: goal.reason } : {}),
    turns_used: goal.turnsUsed,
    wall_clock_ms_used: goal.wallClockMsUsed,
  };
}

export function initialGoalPlan(args: {
  readonly adapter: Pick<AgentAdapter, 'goalSupport'>;
  readonly runMode: RunMode;
  readonly request?: WireGoalRequest;
}): {
  readonly record: GoalTurnRecord;
  readonly budget?: GoalBudgetRecord;
  readonly constraint?: GoalTaskConstraint;
  readonly warning?: string;
} {
  if (args.request === undefined) {
    return {
      record: settledGoalRecord('not_requested', 'not_requested', true),
    };
  }
  const request = goalRequestFromWire(args.request);
  if (args.adapter.goalSupport !== 'claude-native' || args.runMode !== 'write') {
    return {
      record: {
        ...settledGoalRecord('start', 'unsupported', true),
        request,
        reason: args.runMode !== 'write'
          ? 'Native goals are restricted to write implementers.'
          : 'This provider has no proven Crew worker-goal lifecycle.',
      },
      warning: 'goal.unsupported: dispatched once without a provider-native inner loop',
    };
  }
  return {
    record: pendingGoalRecord('start', request),
    budget: {
      maxTurns: request.maxTurns,
      maxWallClockMs: request.maxWallClockMs,
      turnsUsed: 0,
      wallClockMsUsed: 0,
    },
    constraint: {
      action: 'start',
      request,
      maxTurns: request.maxTurns,
      maxWallClockMs: request.maxWallClockMs,
    },
  };
}

export type ContinuationGoalPlan =
  | {
      readonly ok: true;
      readonly record: GoalTurnRecord;
      readonly budget?: GoalBudgetRecord;
      readonly constraint?: GoalTaskConstraint;
      readonly warning?: string;
    }
  | { readonly ok: false; readonly message: string };

export function continuationGoalPlan(args: {
  readonly adapter: Pick<AgentAdapter, 'goalSupport'>;
  readonly runMode: RunMode;
  readonly policy: GoalContinuationPolicy;
  readonly request?: WireGoalRequest;
  readonly previous?: GoalTurnRecord;
  readonly budget?: GoalBudgetRecord;
}): ContinuationGoalPlan {
  if (args.policy === 'clear') {
    if (args.request !== undefined) {
      return { ok: false, message: 'goal.policy_invalid: a goal object requires goal_policy:"replace"' };
    }
    const priorClearUnconfirmed = args.previous?.policy === 'clear'
      && (
        args.previous.outcome !== 'not_requested'
        || args.previous.authoritative !== true
      );
    if (
      args.adapter.goalSupport !== 'claude-native'
      || args.runMode !== 'write'
      || (args.previous?.request === undefined && !priorClearUnconfirmed)
    ) {
      return { ok: true, record: settledGoalRecord('clear', 'not_requested', true) };
    }
    return {
      ok: true,
      record: pendingGoalRecord('clear'),
      constraint: { action: 'clear', maxTurns: 0, maxWallClockMs: 0 },
    };
  }

  if (args.policy === 'inherit') {
    if (args.request !== undefined) {
      return { ok: false, message: 'goal.policy_invalid: inherit does not accept a replacement goal' };
    }
    if (args.previous?.request === undefined) {
      return { ok: false, message: 'goal.inherit_missing: no prior requested goal exists' };
    }
    if (args.previous.outcome === 'achieved' || args.previous.outcome === 'impossible') {
      return {
        ok: false,
        message: `goal.inherit_terminal: prior goal outcome is ${args.previous.outcome}; use replace or clear`,
      };
    }
    return boundedContinuation({ ...args, request: args.previous.request, action: 'inherit' });
  }

  if (args.request === undefined) {
    return { ok: false, message: 'goal.replace_missing: replace requires a goal object' };
  }
  return boundedContinuation({
    ...args,
    request: goalRequestFromWire(args.request),
    action: 'replace',
  });
}

function boundedContinuation(args: {
  readonly adapter: Pick<AgentAdapter, 'goalSupport'>;
  readonly runMode: RunMode;
  readonly request: GoalRequest;
  readonly action: 'inherit' | 'replace';
  readonly budget?: GoalBudgetRecord;
}): ContinuationGoalPlan {
  if (args.adapter.goalSupport !== 'claude-native' || args.runMode !== 'write') {
    return {
      ok: true,
      record: {
        ...settledGoalRecord(args.action, 'unsupported', true),
        request: args.request,
        reason: args.runMode !== 'write'
          ? 'Native goals are restricted to write implementers.'
          : 'This provider has no proven Crew worker-goal lifecycle.',
      },
      warning: 'goal.unsupported: continuation dispatched once without a provider-native inner loop',
    };
  }

  const budget = args.budget ?? {
    maxTurns: args.request.maxTurns,
    maxWallClockMs: args.request.maxWallClockMs,
    turnsUsed: 0,
    wallClockMsUsed: 0,
  };
  if (
    args.action === 'replace'
    && (args.request.maxTurns > budget.maxTurns
      || args.request.maxWallClockMs > budget.maxWallClockMs)
  ) {
    return {
      ok: false,
      message: 'goal.budget_extension_refused: replacement cannot increase the run aggregate goal budget',
    };
  }
  // A replacement may tighten but never reset the aggregate run ceiling.
  // Persist that tighter ceiling so a later inherit cannot recover allowance.
  const effectiveBudget = args.action === 'replace'
    ? {
        ...budget,
        maxTurns: Math.min(budget.maxTurns, args.request.maxTurns),
        maxWallClockMs: Math.min(budget.maxWallClockMs, args.request.maxWallClockMs),
      }
    : budget;
  const remainingTurns = Math.max(0, effectiveBudget.maxTurns - effectiveBudget.turnsUsed);
  const remainingWallClockMs = Math.max(
    0,
    effectiveBudget.maxWallClockMs - effectiveBudget.wallClockMsUsed,
  );
  if (remainingTurns <= 0) {
    return { ok: false, message: 'goal.turn_budget_exhausted: aggregate native-turn budget is exhausted' };
  }
  if (remainingWallClockMs < 1_000) {
    return { ok: false, message: 'goal.wall_clock_budget_exhausted: aggregate goal wall-clock budget is exhausted' };
  }
  return {
    ok: true,
    record: pendingGoalRecord(args.action, args.request),
    budget: effectiveBudget,
    constraint: {
      action: args.action,
      request: args.request,
      maxTurns: remainingTurns,
      maxWallClockMs: remainingWallClockMs,
    },
  };
}

export function pendingGoalRecord(
  policy: GoalTurnRecord['policy'],
  request?: GoalRequest,
): GoalTurnRecord {
  return {
    policy,
    ...(request !== undefined ? { request } : {}),
    authoritative: false,
    turnsUsed: 0,
    wallClockMsUsed: 0,
  };
}

export function settledGoalRecord(
  policy: GoalTurnRecord['policy'],
  outcome: GoalOutcome,
  authoritative: boolean,
  reason?: string,
): GoalTurnRecord {
  return {
    policy,
    outcome,
    authoritative,
    ...(reason !== undefined ? { reason } : {}),
    turnsUsed: 0,
    wallClockMsUsed: 0,
  };
}

export function applyGoalResult(
  record: GoalTurnRecord,
  result: GoalExecutionResult,
): GoalTurnRecord {
  return {
    ...record,
    outcome: result.outcome,
    authoritative: result.authoritative,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    turnsUsed: result.turnsUsed,
    wallClockMsUsed: result.wallClockMsUsed,
  };
}
