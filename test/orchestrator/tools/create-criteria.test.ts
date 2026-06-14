import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCriteriaState, criteriaDir } from '../../../src/orchestrator/criteria/store.js';
import {
  createCriteriaHandler,
  createCriteriaToolHandler,
} from '../../../src/orchestrator/tools/create-criteria.js';
import type { ToolHandlerDeps } from '../../../src/orchestrator/tools/shared.js';

function expectCriteriaToolMarkdown(out: Awaited<ReturnType<typeof createCriteriaToolHandler>>): void {
  expect(out.content[0].text).toMatch(/^The user cannot see this tool result/);
  expect(out.content[0].text).toContain('\n\n| # | Criterion | Type | Detail | Signal |');
  expect(out.content[0].text).not.toMatch(/^\{/);
  expect(() => JSON.parse(out.content[0].text)).toThrow();
  expect(out.structuredContent.rendered_block).toContain('| # | Criterion | Type | Detail | Signal |');
  expect(out.structuredContent.display_hint).toContain('Reprint rendered_block verbatim');
}

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
    expect(out.rendered_block).toContain('| 1 | **Tests green** | [M] |');
    expect(out.display_hint).toContain('Reprint rendered_block verbatim');
    expect(readCriteriaState(criteriaDir(crewHome, 'criteria-1'))?.criteria).toMatchObject([
      { id: 'c1', title: 'Tests green' },
    ]);
  });

  it('returns markdown text while preserving structured fields for tool calls', () => {
    const out = createCriteriaToolHandler({
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
      runStateStore: { repoRoot: '/repo' } as ToolHandlerDeps['runStateStore'],
    });

    expectCriteriaToolMarkdown(out);
    expect(out.structuredContent.criteria_set_id).toMatch(/^criteria-/);
    expect(out.structuredContent.status).toBe('proposed');
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
