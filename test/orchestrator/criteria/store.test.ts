import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import {
  CRITERIA_SCHEMA_VERSION,
  type CriteriaSetStateV1,
} from '../../../src/orchestrator/criteria/schema.js';
import {
  criteriaDir,
  gcCriteriaSets,
  readCriteriaState,
  writeCriteriaStateAtomic,
} from '../../../src/orchestrator/criteria/store.js';

function state(id = 'criteria-1', updatedAt = '2026-01-01T00:00:00.000Z'): CriteriaSetStateV1 {
  return {
    schemaVersion: CRITERIA_SCHEMA_VERSION,
    criteriaSetId: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    repoRoot: '/repo',
    status: 'proposed',
    epoch: 0,
    nextCriterionSeq: 2,
    criteria: [
      {
        id: 'c1',
        title: 'Tests pass',
        type: 'mechanical',
        detail: 'npm run test:run exits 0',
        signal: 'test output',
      },
    ],
    history: [],
  };
}

describe('criteria store', () => {
  let crewHome: string;

  beforeEach(() => {
    crewHome = mkdtempSync(join(tmpdir(), 'crew-criteria-store-'));
  });

  afterEach(() => {
    rmSync(crewHome, { recursive: true, force: true });
  });

  it('criteriaDir encodes ids under crewHome/criteria', () => {
    expect(criteriaDir('/crew', 'criteria/a b')).toBe(
      join('/crew', 'criteria', 'criteria%2Fa%20b'),
    );
  });

  it('round-trips state and overwrites atomically once the parent exists', () => {
    const dir = criteriaDir(crewHome, 'criteria-1');
    mkdirSync(dir, { recursive: true });
    writeCriteriaStateAtomic(dir, state('criteria-1'));
    writeCriteriaStateAtomic(dir, state('criteria-1', '2026-01-02T00:00:00.000Z'));

    expect(readCriteriaState(dir)?.updatedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(readFileSync(join(dir, 'criteria.json'), 'utf-8')).toContain(
      '"criteriaSetId": "criteria-1"',
    );
  });

  it('returns undefined when criteria.json is absent', () => {
    expect(readCriteriaState(criteriaDir(crewHome, 'missing'))).toBeUndefined();
  });

  it('rejects unknown schema versions', () => {
    const dir = criteriaDir(crewHome, 'criteria-1');
    mkdirSync(dir, { recursive: true });
    writeCriteriaStateAtomic(dir, {
      ...state('criteria-1'),
      schemaVersion: 2 as 1,
    });

    expect(() => readCriteriaState(dir)).toThrow(/^criteria\.unknown_schema_version:/);
  });

  it('deletes stale criteria sets and keeps fresh sets', () => {
    const staleDir = criteriaDir(crewHome, 'stale');
    const freshDir = criteriaDir(crewHome, 'fresh');
    mkdirSync(staleDir, { recursive: true });
    mkdirSync(freshDir, { recursive: true });
    writeCriteriaStateAtomic(staleDir, state('stale', '2026-01-01T00:00:00.000Z'));
    writeCriteriaStateAtomic(freshDir, state('fresh', '2026-01-03T00:00:00.000Z'));

    const deleted = gcCriteriaSets(
      crewHome,
      2 * 24 * 60 * 60 * 1000,
      Date.parse('2026-01-04T00:00:00.000Z'),
    );

    expect(deleted).toBe(1);
    expect(existsSync(staleDir)).toBe(false);
    expect(existsSync(freshDir)).toBe(true);
  });
});
