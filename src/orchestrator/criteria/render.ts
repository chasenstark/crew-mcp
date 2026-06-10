import type { CriteriaSetStateV1, CriterionType, CriterionV1 } from './schema.js';

// Hosts (Claude Code included) render MCP tool results collapsed, so a
// rendered_block that only lives in the tool result is invisible to the user.
export const CRITERIA_DISPLAY_HINT =
  'The user cannot see this tool result — hosts collapse MCP output. Reprint rendered_block verbatim as normal chat text (it is a GFM markdown table) before asking the user anything about these criteria.';

export function renderCriteriaBlock(
  state: CriteriaSetStateV1,
  options: { readonly audience: 'user' | 'contract' },
): string {
  if (options.audience === 'user') {
    return renderUserTable(state.criteria);
  }
  const body = state.criteria.map((criterion, index) =>
    renderCriterion(criterion, index + 1)).join('\n');
  return [
    'Acceptance Criteria Contract',
    `criteria_set_id: ${state.criteriaSetId}`,
    `epoch: ${state.epoch}`,
    '',
    body,
  ].join('\n');
}

function renderUserTable(criteria: readonly CriterionV1[]): string {
  const rows = criteria.map((criterion, index) => {
    const detail = criterion.detail ?? criterion.subCriteria?.join('; ') ?? '';
    return [
      String(index + 1),
      `**${tableCell(criterion.title)}**`,
      `[${tagForType(criterion.type)}]`,
      tableCell(detail) || '—',
      tableCell(criterion.signal ?? '') || '—',
    ];
  });
  return [
    '| # | Criterion | Type | Detail | Signal |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((cells) => `| ${cells.join(' | ')} |`),
  ].join('\n');
}

// GFM table cells cannot hold raw pipes or newlines.
function tableCell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll(/\s*\n\s*/g, ' ').trim();
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
