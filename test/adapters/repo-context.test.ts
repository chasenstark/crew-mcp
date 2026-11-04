import { describe, expect, it } from 'vitest';

import { repoContextWarnings } from '../../src/adapters/repo-context.js';
import { resolveRepoContextMode } from '../../src/adapters/types.js';

describe('repository context capability', () => {
  it('defaults undeclared capabilities to unknown rather than inferring from agent names', () => {
    expect(resolveRepoContextMode({})).toBe('unknown');
    expect(repoContextWarnings({ name: 'openai-compatible' })).toEqual([]);
  });

  it.each(['workspace', 'unknown'] as const)('does not claim %s adapters are supplied-text-only', (repoContextMode) => {
    expect(repoContextWarnings({ name: 'qwen', repoContextMode })).toEqual([]);
  });

  it('explains the checkout and continuation limitation for supplied-text adapters', () => {
    const warnings = repoContextWarnings({ name: 'arbitrary-worker', repoContextMode: 'supplied-text' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('repo_context.supplied_text_only:');
    expect(warnings[0]).toContain('cannot inspect or edit checkout files');
    expect(warnings[0]).toContain('prompt or peer messages, including on continuation');
  });

  it('describes bounded automatic review context without claiming workspace access or resume', () => {
    const [warning] = repoContextWarnings({ name: 'local-text', repoContextMode: 'supplied-text', acceptsRepoContext: true });
    expect(warning).toContain('Read-only runs receive bounded automatic review context when allowed');
    expect(warning).toContain('inspect omission warnings');
    expect(warning).toContain('attach context_files');
    expect(warning).toContain('not a complete-workspace or conversational-resume guarantee');
  });
});
