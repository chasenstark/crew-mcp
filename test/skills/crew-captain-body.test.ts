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
  });
});
