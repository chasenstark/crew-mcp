import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

import { atomicWrite } from '../../utils/atomic-write.js';
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
