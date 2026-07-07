import type { FullConfig } from './types.js';

export interface ConfigDiagnostic {
  path: string;
  expected: string;
  received: unknown;
  example: string;
  message: string;
}

function createDiagnostic(
  path: string,
  expected: string,
  received: unknown,
  example: string,
): ConfigDiagnostic {
  const rendered = typeof received === 'string'
    ? `"${received}"`
    : JSON.stringify(received);

  return {
    path,
    expected,
    received,
    example,
    message: `Invalid value for ${path}: expected ${expected}, received ${rendered}. Example: ${example}`,
  };
}

function validateOptionalAgentDefaultId(
  diagnostics: ConfigDiagnostic[],
  path: string,
  value: unknown,
): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.trim().length === 0) {
    diagnostics.push(
      createDiagnostic(
        path,
        'non-empty string agent id',
        value,
        `/config set ${path} codex`,
      ),
    );
  }
}

function validateAgentDefaultIdList(
  diagnostics: ConfigDiagnostic[],
  path: string,
  value: unknown,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    diagnostics.push(
      createDiagnostic(
        path,
        'array of non-empty string agent ids',
        value,
        `/config set ${path} '["codex"]'`,
      ),
    );
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      diagnostics.push(
        createDiagnostic(
          `${path}[${index}]`,
          'non-empty string agent id',
          entry,
          `/config set ${path} '["codex"]'`,
        ),
      );
    }
  }
}

function validateReviewerBanCollision(
  diagnostics: ConfigDiagnostic[],
  scopePath: string,
  reviewers: unknown,
  banList: unknown,
): void {
  if (!Array.isArray(reviewers) || !Array.isArray(banList)) return;
  const banned = new Set(
    banList
      .filter((id): id is string => typeof id === 'string')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
  const collision = reviewers
    .filter((id): id is string => typeof id === 'string')
    .map((id) => id.trim())
    .find((id) => id.length > 0 && banned.has(id));
  if (!collision) return;
  diagnostics.push(
    createDiagnostic(
      `${scopePath}.banList`,
      'agent ids not also present in reviewers',
      collision,
      `/config set ${scopePath}.banList '[]'`,
    ),
  );
}

export function validateConfig(config: FullConfig): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  const defaults = config.workflow.agentDefaults;
  if (!defaults) return diagnostics;

  validateOptionalAgentDefaultId(
    diagnostics,
    'workflow.agentDefaults.iterate.implementer',
    defaults.iterate?.implementer,
  );
  validateAgentDefaultIdList(
    diagnostics,
    'workflow.agentDefaults.iterate.reviewers',
    defaults.iterate?.reviewers,
  );
  validateAgentDefaultIdList(
    diagnostics,
    'workflow.agentDefaults.iterate.banList',
    defaults.iterate?.banList,
  );
  validateReviewerBanCollision(
    diagnostics,
    'workflow.agentDefaults.iterate',
    defaults.iterate?.reviewers,
    defaults.iterate?.banList,
  );

  validateAgentDefaultIdList(
    diagnostics,
    'workflow.agentDefaults.panel.reviewers',
    defaults.panel?.reviewers,
  );
  validateAgentDefaultIdList(
    diagnostics,
    'workflow.agentDefaults.panel.banList',
    defaults.panel?.banList,
  );
  validateReviewerBanCollision(
    diagnostics,
    'workflow.agentDefaults.panel',
    defaults.panel?.reviewers,
    defaults.panel?.banList,
  );

  return diagnostics;
}
