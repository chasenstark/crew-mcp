import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

import { atomicWrite } from '../../utils/atomic-write.js';
import {
  DEFAULT_ITERATE_MAX_ROUNDS_PER_EPOCH,
  DEFAULT_ITERATE_MAX_TOTAL_ROUNDS,
  type CrewIterateConfig,
} from '../../utils/config-store.js';
import { logger } from '../../utils/logger.js';
import { renderCriteriaBlock } from './render.js';
import {
  CRITERIA_SCHEMA_VERSION,
  criteriaSetStateSchemaV1,
  type CriteriaSetStateV1,
} from './schema.js';
import { withCriteriaLock } from './lock.js';

export function criteriaDir(crewHome: string, criteriaSetId: string): string {
  return join(crewHome, 'criteria', encodeURIComponent(criteriaSetId));
}

export function ensureCriteriaRoot(crewHome: string): void {
  mkdirSync(join(crewHome, 'criteria'), { recursive: true });
  mkdirSync(join(crewHome, 'criteria-locks'), { recursive: true });
}

export function readCriteriaState(targetCriteriaDir: string): CriteriaSetStateV1 | undefined {
  const path = join(targetCriteriaDir, 'criteria.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `criteria.unparsable: failed to parse ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const schemaVersion = typeof parsed === 'object' && parsed !== null
    ? (parsed as { schemaVersion?: unknown }).schemaVersion
    : undefined;
  if (schemaVersion !== CRITERIA_SCHEMA_VERSION) {
    throw new Error(
      `criteria.unknown_schema_version: expected ${CRITERIA_SCHEMA_VERSION}, got ${
        schemaVersion ?? 'undefined'
      }`,
    );
  }

  try {
    return criteriaSetStateSchemaV1.parse(parsed);
  } catch (err) {
    throw new Error(
      `criteria.unparsable: invalid criteria state at ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export function writeCriteriaStateAtomic(
  targetCriteriaDir: string,
  state: CriteriaSetStateV1,
): void {
  const finalPath = join(targetCriteriaDir, 'criteria.json');
  atomicWrite(finalPath, `${JSON.stringify(state, null, 2)}\n`, { makeDirs: false });
}

export function gcCriteriaSets(
  crewHome: string,
  ttlMs: number,
  now = Date.now(),
): number {
  if (ttlMs === Number.POSITIVE_INFINITY) return 0;
  const root = join(crewHome, 'criteria');
  if (!existsSync(root)) return 0;

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    logger.warn(
      `criteria GC: failed to read ${root}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }

  let deleted = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    let state: CriteriaSetStateV1 | undefined;
    try {
      state = readCriteriaState(dir);
    } catch (err) {
      logger.warn(
        `criteria GC: failed to read ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!state) continue;
    const updatedAtMs = Date.parse(state.updatedAt);
    if (!Number.isFinite(updatedAtMs)) continue;
    const ageMs = now - updatedAtMs;
    if (!Number.isFinite(ageMs) || ageMs < ttlMs) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      deleted += 1;
    } catch (err) {
      logger.warn(
        `criteria GC: failed to delete ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return deleted;
}

export interface CriteriaContractResolution {
  readonly criteriaSetId: string;
  readonly criteriaEpoch: number;
  readonly contractPrefix: string;
}

export interface IterationContinuationBackstop {
  readonly warnPerEpoch: number;
  readonly totalCap: number;
}

/**
 * Keep the runtime backstop beyond the captain's configured pause points.
 * The extra epoch's worth of total headroom preserves room for a user-approved
 * criteria revision without letting a stale captain loop forever.
 */
export function iterationContinuationBackstop(
  limits: Pick<CrewIterateConfig, 'maxRoundsPerEpoch' | 'maxTotalRounds'>,
): IterationContinuationBackstop {
  return {
    warnPerEpoch: limits.maxRoundsPerEpoch + 1,
    totalCap: limits.maxTotalRounds + limits.maxRoundsPerEpoch,
  };
}

export const ITERATION_CONTINUATION_WARN_PER_EPOCH =
  DEFAULT_ITERATE_MAX_ROUNDS_PER_EPOCH + 1;
export const ITERATION_CONTINUATION_TOTAL_CAP =
  DEFAULT_ITERATE_MAX_TOTAL_ROUNDS + DEFAULT_ITERATE_MAX_ROUNDS_PER_EPOCH;

export interface CriteriaIterationContinuationResult {
  readonly epoch: number;
  readonly epochContinuations: number;
  readonly totalContinuations: number;
  readonly warnings: readonly string[];
}

export async function recordCriteriaIterationContinuation(args: {
  readonly crewHome: string;
  readonly criteriaSetId: string;
  readonly expectedEpoch: number;
  readonly capOverride: boolean;
  readonly iterationLimits?: CrewIterateConfig;
  readonly now?: () => string;
}): Promise<CriteriaIterationContinuationResult> {
  const backstop = iterationContinuationBackstop(args.iterationLimits ?? {
    maxRoundsPerEpoch: DEFAULT_ITERATE_MAX_ROUNDS_PER_EPOCH,
    maxTotalRounds: DEFAULT_ITERATE_MAX_TOTAL_ROUNDS,
  });
  return withCriteriaLock(
    { crewHome: args.crewHome, criteriaSetId: args.criteriaSetId },
    async () => {
      const targetDir = criteriaDir(args.crewHome, args.criteriaSetId);
      const current = readCriteriaState(targetDir);
      if (!current) {
        throw new Error(`criteria.unknown: ${args.criteriaSetId}`);
      }
      if (current.status !== 'confirmed') {
        throw new Error(`criteria.not_confirmed: ${args.criteriaSetId} status=${current.status}`);
      }
      if (current.epoch !== args.expectedEpoch) {
        throw new Error(
          `criteria.epoch_changed: ${args.criteriaSetId} expected epoch ${args.expectedEpoch}, `
          + `found ${current.epoch}; resolve the current confirmed contract and retry.`,
        );
      }

      const epochContinuations = (current.iterationContinuations ?? 0) + 1;
      const historicalContinuations = current.history.reduce(
        (sum, snapshot) => sum + (snapshot.iterationContinuations ?? 0),
        0,
      );
      const totalContinuations = historicalContinuations + epochContinuations;
      writeCriteriaStateAtomic(targetDir, {
        ...current,
        iterationContinuations: epochContinuations,
        updatedAt: args.now?.() ?? new Date().toISOString(),
      });

      if (
        totalContinuations >= backstop.totalCap
        && !args.capOverride
      ) {
        throw new Error(
          `criteria.iteration_continuation_cap: ${args.criteriaSetId} recorded `
          + `${totalContinuations} total continue_run attempt(s), reaching the server cap of `
          + `${backstop.totalCap}. Ask the user whether to override the runaway-loop `
          + 'backstop, then retry with cap_override:true. The refused attempt remains counted.',
        );
      }

      const warnings: string[] = [];
      if (epochContinuations >= backstop.warnPerEpoch) {
        warnings.push(
          `criteria.iteration_continuation_warning: ${args.criteriaSetId} has `
          + `${epochContinuations} continuation(s) in epoch ${current.epoch} `
          + `(${totalContinuations} total); review loop progress before continuing.`,
        );
      }
      if (totalContinuations >= backstop.totalCap) {
        warnings.push(
          `criteria.iteration_continuation_cap_override: ${args.criteriaSetId} is at `
          + `${totalContinuations} total continuation(s); cap_override:true was supplied.`,
        );
      }
      return {
        epoch: current.epoch,
        epochContinuations,
        totalContinuations,
        warnings,
      };
    },
  );
}

export function resolveConfirmedCriteriaContract(args: {
  readonly crewHome: string;
  readonly repoRoot: string;
  readonly criteriaSetId: string;
}): CriteriaContractResolution {
  const state = readCriteriaState(criteriaDir(args.crewHome, args.criteriaSetId));
  if (!state) {
    throw new Error(`criteria.unknown: ${args.criteriaSetId}`);
  }
  if (state.repoRoot !== args.repoRoot) {
    throw new Error(`criteria.cross_repo: criteria set belongs to repo ${state.repoRoot}`);
  }
  if (state.status !== 'confirmed') {
    throw new Error(`criteria.not_confirmed: ${args.criteriaSetId} status=${state.status}`);
  }
  return {
    criteriaSetId: state.criteriaSetId,
    criteriaEpoch: state.epoch,
    contractPrefix: `${renderCriteriaBlock(state, { audience: 'contract' })}\n\n`,
  };
}

export async function linkCriteriaSetImplementerRun(args: {
  readonly crewHome: string;
  readonly criteriaSetId: string;
  readonly runId: string;
  readonly now?: () => string;
}): Promise<void> {
  await withCriteriaLock(
    { crewHome: args.crewHome, criteriaSetId: args.criteriaSetId },
    async () => {
      const targetDir = criteriaDir(args.crewHome, args.criteriaSetId);
      const current = readCriteriaState(targetDir);
      if (!current) {
        throw new Error(`criteria.unknown: ${args.criteriaSetId}`);
      }
      if (current.implementerRunId !== undefined) return;
      writeCriteriaStateAtomic(targetDir, {
        ...current,
        implementerRunId: args.runId,
        updatedAt: args.now?.() ?? new Date().toISOString(),
      });
    },
  );
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}
