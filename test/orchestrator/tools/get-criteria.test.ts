import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getCriteriaHandler } from '../../../src/orchestrator/tools/get-criteria.js';
import { createCriteriaHandler } from '../../../src/orchestrator/tools/create-criteria.js';

describe('getCriteriaHandler', () => {
  let crewHome: string;

  beforeEach(() => {
    crewHome = mkdtempSync(join(tmpdir(), 'crew-get-criteria-'));
    createCriteriaHandler({
      criteria: [
        {
          title: 'Tests green',
          type: 'mechanical',
          detail: 'npm run test:run exits 0',
          signal: 'test output',
        },
      ],
    }, {
      crewHome,
      repoRoot: '/repo',
      makeCriteriaSetId: () => 'criteria-1',
    });
  });

  afterEach(() => {
    rmSync(crewHome, { recursive: true, force: true });
  });

  it('returns full state and a rendered user block', () => {
    const out = getCriteriaHandler({ criteria_set_id: 'criteria-1' }, { crewHome });
    expect(out.criteria_set_id).toBe('criteria-1');
    expect(out.state.criteriaSetId).toBe('criteria-1');
    expect(out.state.criteria[0].id).toBe('c1');
    expect(out.rendered_block).toContain('**Tests green** [M]');
  });

  it('returns criteria.unknown when absent', () => {
    expect(() => getCriteriaHandler({ criteria_set_id: 'missing' }, { crewHome }))
      .toThrow(/^criteria\.unknown:/);
  });
});
