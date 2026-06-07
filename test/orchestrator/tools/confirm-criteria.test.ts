import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { criteriaDir, readCriteriaState } from '../../../src/orchestrator/criteria/store.js';
import { confirmCriteriaHandler } from '../../../src/orchestrator/tools/confirm-criteria.js';
import { createCriteriaHandler } from '../../../src/orchestrator/tools/create-criteria.js';

const initialCriteria = [
  {
    title: 'Tests green',
    type: 'mechanical' as const,
    detail: 'npm run test:run exits 0',
    signal: 'test output',
  },
  {
    title: 'Contract enforced',
    type: 'behavioral' as const,
    subCriteria: ['confirmed sets are accepted', 'proposed sets are rejected'],
  },
  {
    title: 'No regressions',
    type: 'negative' as const,
    detail: 'dispatch without criteria is unchanged',
  },
];

describe('confirmCriteriaHandler', () => {
  let crewHome: string;

  beforeEach(() => {
    crewHome = mkdtempSync(join(tmpdir(), 'crew-confirm-criteria-'));
    createCriteriaHandler({ criteria: initialCriteria }, {
      crewHome,
      repoRoot: '/repo',
      now: () => '2026-01-01T00:00:00.000Z',
      makeCriteriaSetId: () => 'criteria-1',
    });
  });

  afterEach(() => {
    rmSync(crewHome, { recursive: true, force: true });
  });

  it('confirms a set and is idempotent with no ops', async () => {
    const first = await confirmCriteriaHandler({
      criteria_set_id: 'criteria-1',
    }, {
      crewHome,
      now: () => '2026-01-02T00:00:00.000Z',
    });
    const before = readCriteriaState(criteriaDir(crewHome, 'criteria-1'));
    const second = await confirmCriteriaHandler({
      criteria_set_id: 'criteria-1',
    }, {
      crewHome,
      now: () => '2026-01-03T00:00:00.000Z',
    });

    expect(first.status).toBe('confirmed');
    expect(second).toEqual(first);
    expect(readCriteriaState(criteriaDir(crewHome, 'criteria-1'))).toEqual(before);
  });

  it('applies add, update, removeIds, and order in id-aware sequence', async () => {
    await confirmCriteriaHandler({
      criteria_set_id: 'criteria-1',
      ops: {
        add: [
          {
            title: 'Docs updated',
            type: 'mechanical',
            detail: 'README mentions the new tool',
            signal: 'README diff',
          },
        ],
        update: [
          {
            id: 'c2',
            title: 'Confirmed contract enforced',
          },
        ],
        removeIds: ['c3'],
        order: ['c4', 'c2', 'c1'],
      },
    }, {
      crewHome,
      now: () => '2026-01-02T00:00:00.000Z',
    });

    const state = readCriteriaState(criteriaDir(crewHome, 'criteria-1'));
    expect(state?.criteria.map((criterion) => criterion.id)).toEqual(['c4', 'c2', 'c1']);
    expect(state?.criteria.map((criterion) => criterion.title)).toEqual([
      'Docs updated',
      'Confirmed contract enforced',
      'Tests green',
    ]);
    expect(state?.nextCriterionSeq).toBe(5);
  });

  it('rejects unknown and duplicate ids as criteria.invalid', async () => {
    await expect(confirmCriteriaHandler({
      criteria_set_id: 'criteria-1',
      ops: { update: [{ id: 'c99', title: 'nope' }] },
    }, {
      crewHome,
    })).rejects.toThrow(/^criteria\.invalid:/);

    await expect(confirmCriteriaHandler({
      criteria_set_id: 'criteria-1',
      ops: { removeIds: ['c1', 'c1'] },
    }, {
      crewHome,
    })).rejects.toThrow(/^criteria\.invalid:/);
  });

  it('returns criteria.unknown when the set is absent', async () => {
    await expect(confirmCriteriaHandler({
      criteria_set_id: 'missing',
    }, {
      crewHome,
    })).rejects.toThrow(/^criteria\.unknown:/);
  });
});
