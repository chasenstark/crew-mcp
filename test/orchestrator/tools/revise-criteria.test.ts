import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  criteriaDir,
  readCriteriaState,
  writeCriteriaStateAtomic,
} from '../../../src/orchestrator/criteria/store.js';
import { confirmCriteriaHandler } from '../../../src/orchestrator/tools/confirm-criteria.js';
import { createCriteriaHandler } from '../../../src/orchestrator/tools/create-criteria.js';
import { reviseCriteriaHandler } from '../../../src/orchestrator/tools/revise-criteria.js';

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
    subCriteria: ['confirmed sets are accepted'],
  },
  {
    title: 'No regressions',
    type: 'negative' as const,
    detail: 'dispatch without criteria is unchanged',
  },
];

describe('reviseCriteriaHandler', () => {
  let crewHome: string;

  beforeEach(async () => {
    crewHome = mkdtempSync(join(tmpdir(), 'crew-revise-criteria-'));
    createCriteriaHandler({ criteria: initialCriteria }, {
      crewHome,
      repoRoot: '/repo',
      now: () => '2026-01-01T00:00:00.000Z',
      makeCriteriaSetId: () => 'criteria-1',
    });
    await confirmCriteriaHandler({
      criteria_set_id: 'criteria-1',
    }, {
      crewHome,
      now: () => '2026-01-02T00:00:00.000Z',
    });
    const dir = criteriaDir(crewHome, 'criteria-1');
    const current = readCriteriaState(dir)!;
    writeCriteriaStateAtomic(dir, {
      ...current,
      rounds: [
        {
          roundId: 'round-1',
          createdAt: '2026-01-02T00:00:00.000Z',
          reviewerRunIds: ['r1'],
          status: 'complete',
        },
      ],
      naDecisions: [
        {
          criterionId: 'c1',
          decidedAt: '2026-01-02T00:00:00.000Z',
          reason: 'covered by lint',
        },
      ],
    });
  });

  afterEach(() => {
    rmSync(crewHome, { recursive: true, force: true });
  });

  it('bumps epoch, returns to proposed, snapshots history, and clears Phase-2 state', async () => {
    const out = await reviseCriteriaHandler({
      criteria_set_id: 'criteria-1',
      note: 'tighten wording',
      ops: {
        update: [{ id: 'c2', title: 'Confirmed contract enforced' }],
      },
    }, {
      crewHome,
      now: () => '2026-01-03T00:00:00.000Z',
    });

    const state = readCriteriaState(criteriaDir(crewHome, 'criteria-1'));
    expect(out).toMatchObject({
      criteria_set_id: 'criteria-1',
      status: 'proposed',
      epoch: 1,
    });
    expect(state?.status).toBe('proposed');
    expect(state?.epoch).toBe(1);
    expect(state?.criteria[1].title).toBe('Confirmed contract enforced');
    expect(state?.history).toMatchObject([
      {
        epoch: 0,
        supersededAt: '2026-01-03T00:00:00.000Z',
        note: 'tighten wording',
      },
    ]);
    expect(state?.rounds).toBeUndefined();
    expect(state?.naDecisions).toBeUndefined();
  });

  it('rejects duplicate ids as criteria.invalid', async () => {
    await expect(reviseCriteriaHandler({
      criteria_set_id: 'criteria-1',
      ops: { order: ['c1', 'c1'] },
    }, {
      crewHome,
    })).rejects.toThrow(/^criteria\.invalid:/);
  });
});
