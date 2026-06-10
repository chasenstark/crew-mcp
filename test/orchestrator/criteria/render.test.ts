import { describe, expect, it } from 'vitest';

import {
  CRITERIA_SCHEMA_VERSION,
  criteriaValidationWarnings,
  type CriteriaSetStateV1,
} from '../../../src/orchestrator/criteria/schema.js';
import { renderCriteriaBlock } from '../../../src/orchestrator/criteria/render.js';

function state(): CriteriaSetStateV1 {
  return {
    schemaVersion: CRITERIA_SCHEMA_VERSION,
    criteriaSetId: 'criteria-abc',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    repoRoot: '/repo',
    status: 'confirmed',
    epoch: 2,
    nextCriterionSeq: 4,
    criteria: [
      {
        id: 'c1',
        title: 'Tests and lint green',
        type: 'mechanical',
        detail: 'npm run test:run and npm run lint exit 0',
      },
      {
        id: 'c2',
        title: 'Contract is non-droppable',
        type: 'behavioral',
        subCriteria: [
          'criteria contract is prepended before peer messages',
          'stored contract bypasses prompt truncation',
        ],
        signal: 'run-state prompt record',
      },
      {
        id: 'c3',
        title: 'No umbrella regression',
        type: 'negative',
        detail: 'dispatch without criteria_set_id is unchanged',
      },
    ],
    history: [],
  };
}

describe('renderCriteriaBlock', () => {
  it('renders user and contract audiences with stable tags and sub-bullets', () => {
    expect(renderCriteriaBlock(state(), { audience: 'user' })).toMatchInlineSnapshot(`
      "| # | Criterion | Type | Detail | Signal |
      | --- | --- | --- | --- | --- |
      | 1 | **Tests and lint green** | [M] | npm run test:run and npm run lint exit 0 | — |
      | 2 | **Contract is non-droppable** | [B] | criteria contract is prepended before peer messages; stored contract bypasses prompt truncation | run-state prompt record |
      | 3 | **No umbrella regression** | [N] | dispatch without criteria_set_id is unchanged | — |"
    `);
    expect(renderCriteriaBlock(state(), { audience: 'contract' })).toMatchInlineSnapshot(`
      "Acceptance Criteria Contract
      criteria_set_id: criteria-abc
      epoch: 2

      1. **Tests and lint green** [M]
         npm run test:run and npm run lint exit 0
      2. **Contract is non-droppable** [B]
         - criteria contract is prepended before peer messages
         - stored contract bypasses prompt truncation
         Signal: run-state prompt record
      3. **No umbrella regression** [N]
         dispatch without criteria_set_id is unchanged"
    `);
  });

  it('warns when a mechanical criterion has no signal', () => {
    expect(criteriaValidationWarnings(state().criteria)).toEqual([
      'criteria.mechanical_missing_signal: c1',
    ]);
  });
});
