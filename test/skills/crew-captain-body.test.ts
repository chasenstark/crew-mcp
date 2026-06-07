import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { stripHtmlComments } from '../../src/install/skill-renderer.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(here, '..', '..');
const BODY_PATH = join(REPO_ROOT, 'skills', 'crew-captain.body.md');

async function loadBody(): Promise<string> {
  const raw = await readFile(BODY_PATH, 'utf-8');
  return stripHtmlComments(raw);
}

describe('crew-captain body — review panel agent picks', () => {
  it('contains the load-bearing panel-pick anchors in Review panels', async () => {
    const body = await loadBody();
    const reviewPanelsStart = body.indexOf('## Review panels');
    expect(reviewPanelsStart).toBeGreaterThanOrEqual(0);
    const toolsStart = body.indexOf('## Tools', reviewPanelsStart);
    const sectionEnd = toolsStart === -1 ? body.length : toolsStart;
    expect(sectionEnd).toBeGreaterThan(reviewPanelsStart);
    const section = body.slice(reviewPanelsStart, sectionEnd);

    expect(section).toContain('### Confirm reviewer picks');
    expect(section).toContain('Agents for this panel:');
    expect(section).toContain('Override grammar');
    expect(section).toContain('get_crew_preferences({scope: "panel"})');
    expect(section).toContain('panel.reviewers');
    expect(section).toContain('panel.banList');
    // The host model reviews via a native subagent, not run_panel.
    expect(section).toContain('The host reviewer');
    expect(section).toContain('native subagent');
  });
});

describe('crew-captain body — general dispatch-order rule', () => {
  it('states crew-first ordering with the dependency carve-out in Dispatch lifecycle', async () => {
    const body = await loadBody();
    // Slice the Dispatch lifecycle section so anchors can't be satisfied
    // by the unrelated watcher prose (which also says run_in_background)
    // elsewhere in the body. Section end is "## The tools" (NOT "## Tools"
    // — that heading belongs to the iterate body).
    const start = body.indexOf('## Dispatch lifecycle');
    const end = body.indexOf('## The tools', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const section = body.slice(start, end);

    // Deletion anchors: the subsection and its core mechanics.
    expect(section).toContain('### Dispatch order — crew first');
    expect(section).toContain('native subagent');
    expect(section).toContain('run_in_background');

    // Contradiction anchor: the dependency exception. A crew-first rule
    // without this carve-out contradicts §"The default flow" step 3 and
    // §implement-then-review, where the dispatch is produced by prior
    // captain-side work. Dropping the carve-out must fail the test.
    expect(section).toContain('Exception');
    expect(section).toContain('produces');
    expect(section).toContain('prerequisite');
  });
});
