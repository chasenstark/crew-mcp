import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCriteriaState, criteriaDir } from '../../../src/orchestrator/criteria/store.js';
import { createCriteriaHandler } from '../../../src/orchestrator/tools/create-criteria.js';

describe('createCriteriaHandler', () => {
  let crewHome: string;

  beforeEach(() => {
    crewHome = mkdtempSync(join(tmpdir(), 'crew-create-criteria-'));
  });

  afterEach(() => {
    rmSync(crewHome, { recursive: true, force: true });
  });

  it('creates a proposed set with stable criterion ids and warnings', () => {
    const out = createCriteriaHandler({
      criteria: [
        {
          title: 'Tests green',
          type: 'mechanical',
          detail: 'npm run test:run exits 0',
        },
      ],
    }, {
      crewHome,
      repoRoot: '/repo',
      now: () => '2026-01-01T00:00:00.000Z',
      makeCriteriaSetId: () => 'criteria-1',
    });

    expect(out).toMatchObject({
      criteria_set_id: 'criteria-1',
      status: 'proposed',
      epoch: 0,
      warnings: [
        'criteria.count_outside_recommended_range: expected 3-7 criteria, got 1',
        'criteria.mechanical_missing_signal: c1',
      ],
    });
    expect(out.rendered_block).toContain('1. **Tests green** [M]');
    expect(readCriteriaState(criteriaDir(crewHome, 'criteria-1'))?.criteria).toMatchObject([
      { id: 'c1', title: 'Tests green' },
    ]);
  });

  it('rejects criteria without detail or subCriteria', () => {
    expect(() => createCriteriaHandler({
      criteria: [
        {
          title: 'Invalid',
          type: 'behavioral',
        },
      ],
    }, {
      crewHome,
      repoRoot: '/repo',
    })).toThrow(/^criteria\.invalid:/);
  });
});
