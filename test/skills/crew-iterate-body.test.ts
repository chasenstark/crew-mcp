/**
 * Load-bearing-phrase tests for the crew-iterate skill body.
 *
 * Each assertion targets a rule the captain MUST hold while running the
 * iterate loop. If a future edit accidentally drops one of these phrases,
 * the test catches it. The phrase list is enumerated in the plan
 * (docs/plans/active/crew-iterate-skill.md §Phase 2 testing).
 *
 * Phrases are checked case-insensitively because the body uses sentence-
 * case in headings (e.g. "Iteration cap reached") while the plan lists
 * phrases in lowercase. The semantic content is what matters; casing is
 * just prose style.
 */

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { stripHtmlComments } from '../../src/install/skill-renderer.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(here, '..', '..');
const BODY_PATH = join(REPO_ROOT, 'skills', 'crew-iterate.body.md');

async function loadBody(): Promise<string> {
  const raw = await readFile(BODY_PATH, 'utf-8');
  return stripHtmlComments(raw);
}

function expectContainsCI(haystack: string, needle: string): void {
  const ok = haystack.toLowerCase().includes(needle.toLowerCase());
  if (!ok) {
    throw new Error(
      `Expected body to contain phrase (case-insensitive): "${needle}"`,
    );
  }
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('crew-iterate body — load-bearing phrases (plan §Phase 2 testing)', () => {
  it('mentions every load-bearing rule phrase', async () => {
    const body = await loadBody();
    const phrases = [
      'acceptance criteria',
      'Step 0',
      'PASS|FAIL|N-A',
      'Criteria scoring',
      'every criterion',
      'out-of-scope',
      'iteration cap',
      'always run inline review',
      'do not auto-merge',
      'Silence is not consent',
      'synthetic-turn',
      'CREW_WAIT_TERMINAL',
      'Mechanical-PASS without evidence',
      'score-vs-finding',
      'criteria drift detected',
      'Audit check',
      'foreground-wait',
      'clamped at',
      '[M]',
      '[B]',
      '[N]',
    ];
    for (const phrase of phrases) {
      expectContainsCI(body, phrase);
    }
  });

  it('mentions a new-epoch concept (either "new epoch" or "new loop epoch")', async () => {
    const body = (await loadBody()).toLowerCase();
    expect(
      body.includes('new epoch') || body.includes('new loop epoch'),
    ).toBe(true);
  });
});

describe('crew-iterate body — Step 0.5 agent picks', () => {
  it('contains the load-bearing agent-pick anchors', async () => {
    const body = await loadBody();
    expect(body).toContain('### Step 0.5 — Confirm agent picks');
    expect(body).toContain('Agents for this iteration:');
    expect(body).toContain('Override grammar');

    const start = body.indexOf('### Step 0.5 — Confirm agent picks');
    const end = body.indexOf('### Step 1 — Dispatch implementer', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const step = body.slice(start, end);
    expect(countOccurrences(step, 'get_crew_preferences')).toBe(1);
  });

  it('tells the captain to scale the reviewer count to change complexity', async () => {
    const body = await loadBody();
    const start = body.indexOf('### Step 0.5 — Confirm agent picks');
    const end = body.indexOf('### Step 1 — Dispatch implementer', start);
    const step = body.slice(start, end);
    // The count is a complexity-driven captain decision, not a fixed 1.
    expectContainsCI(step, 'How many reviewers');
    expect(step).toContain('1 dispatched reviewer');
    expect(step).toContain('2 distinct-model reviewers');
    expect(step).toContain('3 distinct-model reviewers');
  });
});

describe('crew-iterate body — standalone safety invariants', () => {
  it('contains all 8 numbered preamble invariants', async () => {
    const body = await loadBody();
    // Each invariant should appear under its own numbered bullet at
    // the top of the body. We test for keyword anchors, not the exact
    // wording, so a phrasing refresh doesn't break the test.
    const checks: Array<{ label: string; needle: string }> = [
      { label: 'merge boundary', needle: 'Merge boundary' },
      { label: 'dispatch lifecycle', needle: 'Dispatch lifecycle' },
      { label: 'escape hatch', needle: 'Escape hatch' },
      { label: 'tool availability', needle: 'Tool availability' },
      { label: 'own-host prohibition', needle: 'own host product' },
      { label: 'never shell out', needle: 'Never shell out' },
      { label: 'read-only cleanup', needle: 'do not auto-clean' },
      { label: 'ask on ambiguity', needle: 'before dispatching on ambiguity' },
    ];
    for (const { label, needle } of checks) {
      expectContainsCI(body, needle);
      void label;
    }
  });

  it('renders the verbatim review prompt template anchors', async () => {
    const body = await loadBody();
    // The template is embedded so reviewers receive the same instructions
    // every time. Anchor on a few non-trivial phrases inside the fenced
    // block; if the block gets accidentally deleted or rewritten, these
    // fail.
    expectContainsCI(body, 'Score every acceptance criterion');
    expectContainsCI(body, 'Produce an overall verdict');
    expectContainsCI(body, 'CHANGES_NEEDED');
    expectContainsCI(body, 'BLOCKING');
    expectContainsCI(body, 'Severity rubric');
  });
});
