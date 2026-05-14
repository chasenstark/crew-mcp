import { describe, expect, it } from 'vitest';

import { validateRunPanelPreflight } from '../../../src/orchestrator/panels/preflight.js';

describe('validateRunPanelPreflight', () => {
  it('throws run_panel.too_many_reviewers when count exceeds the runtime cap', () => {
    expect(() => validateRunPanelPreflight(Array.from({ length: 21 })))
      .toThrow(/^run_panel\.too_many_reviewers:/);
  });

  it('accepts the default runtime cap', () => {
    expect(() => validateRunPanelPreflight(Array.from({ length: 20 }))).not.toThrow();
  });
});
