import type { CriteriaSetStateV1, CriterionType, CriterionV1 } from './schema.js';

export function renderCriteriaBlock(
  state: CriteriaSetStateV1,
  options: { readonly audience: 'user' | 'contract' },
): string {
  const body = state.criteria.map((criterion, index) =>
    renderCriterion(criterion, index + 1)).join('\n');
  if (options.audience === 'user') {
    return body;
  }
  return [
    'Acceptance Criteria Contract',
    `criteria_set_id: ${state.criteriaSetId}`,
    `epoch: ${state.epoch}`,
    '',
    body,
  ].join('\n');
}

function renderCriterion(criterion: CriterionV1, number: number): string {
  const lines = [`${number}. **${criterion.title}** [${tagForType(criterion.type)}]`];
  if (criterion.detail !== undefined) {
    lines.push(`   ${criterion.detail}`);
  }
  if (criterion.subCriteria !== undefined) {
    for (const subCriterion of criterion.subCriteria) {
      lines.push(`   - ${subCriterion}`);
    }
  }
  if (criterion.signal !== undefined) {
    lines.push(`   Signal: ${criterion.signal}`);
  }
  return lines.join('\n');
}

function tagForType(type: CriterionType): 'M' | 'B' | 'N' {
  switch (type) {
    case 'mechanical':
      return 'M';
    case 'behavioral':
      return 'B';
    case 'negative':
      return 'N';
  }
}
