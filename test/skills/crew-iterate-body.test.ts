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

function flattenWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ');
}

function sliceBetween(
  haystack: string,
  startNeedle: string,
  endNeedle: string,
): string {
  const start = haystack.indexOf(startNeedle);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = haystack.indexOf(endNeedle, start);
  expect(end).toBeGreaterThan(start);
  return haystack.slice(start, end);
}

function expectStructuredQuestionGuidance(section: string): void {
  const flat = flattenWhitespace(section);
  expectContainsCI(flat, 'AskUserQuestion on Claude Code');
  expectContainsCI(flat, 'if the host exposes no such tool');
  expectContainsCI(flat, 'surface the options as prose');
  expectContainsCI(flat, 'free-text reply');
  expectContainsCI(flat, 'Silence is not consent');
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
      'Host review (default-on',
      'native subagent',
      'do not auto-merge',
      'Silence is not consent',
      'synthetic-turn',
      'CREW_WAIT_TERMINAL',
      'Captain mechanical pass',
      'score-vs-finding',
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

  it('does not carry the stale inline-default doctrine', async () => {
    // The host vote is a native subagent by default; inline is fallback
    // only. The old "Inline review is mandatory" guardrail must be gone.
    const body = (await loadBody()).toLowerCase();
    expect(body).not.toContain('inline review is mandatory');
  });

  it('guards the host-review launch contract within Step 2', async () => {
    // Scope to the review step so the anchors can't be satisfied by the
    // unrelated watcher / foreground-wait prose elsewhere in the body.
    const body = await loadBody();
    const start = body.indexOf('### Step 2 —');
    const end = body.indexOf('### Step 3 —', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const step2 = body.slice(start, end);

    // crew dispatched first, host backgrounded if supported, else
    // foreground, inline only as last resort.
    expectContainsCI(step2, 'dispatch the crew reviewer');
    expectContainsCI(step2, 'run_in_background: true');
    expectContainsCI(step2, 'foreground');
    expectContainsCI(step2, 'last resort');

    // Order: crew dispatch precedes the foreground host path.
    expect(step2.toLowerCase().indexOf('dispatch the crew reviewer'))
      .toBeLessThan(step2.toLowerCase().indexOf('foreground'));

    // Inline is tied to "no native subagent", NOT to large diffs (the
    // round-2 regression that re-allowed inline for big diffs).
    const flat = step2.replace(/\s+/g, ' ').toLowerCase();
    expect(flat).toContain(
      'inline review is the last resort** — only when the host exposes no native subagent tool at all',
    );
    expect(flat).not.toContain('too large to review');
  });

  it('mentions a new-epoch concept (either "new epoch" or "new loop epoch")', async () => {
    const body = (await loadBody()).toLowerCase();
    expect(
      body.includes('new epoch') || body.includes('new loop epoch'),
    ).toBe(true);
  });
});

describe('crew-iterate body — structured-question gates', () => {
  it('defines the structured-choice surface and preserves open-ended asks', async () => {
    const body = await loadBody();
    const section = sliceBetween(
      body,
      '### Structured-choice surface',
      '### When to use this skill',
    );

    expectStructuredQuestionGuidance(section);
    expectContainsCI(section, 'Other/free-text escape');
    expectContainsCI(section, 'Genuinely open-ended asks are different');
  });

  it('routes the escape hatch discard/keep gate through structured questions', async () => {
    const body = await loadBody();
    const section = sliceBetween(
      body,
      '**3. Escape hatch.',
      '**4. Tool availability.',
    );

    expectStructuredQuestionGuidance(section);
    expectContainsCI(section, 'discard/keep options');
  });

  it('routes Step 0 criteria confirmation and revision gates through structured questions', async () => {
    const body = await loadBody();
    const step0 = sliceBetween(
      body,
      '### Step 0 — Derive and confirm acceptance criteria',
      '### Step 0.5 — Confirm agent picks',
    );

    const flat = flattenWhitespace(step0);
    expectStructuredQuestionGuidance(step0);
    expectContainsCI(flat, 'Confirm / Edit / Add options');
    expectContainsCI(flat, 'Edit and Add must allow free-text details');
    expectContainsCI(flat, 'Tools-absent fallback');
    expectContainsCI(flat, 'Confirm revision / Edit revision / Hand off options');
    expectContainsCI(flat, 'Edit revision must allow free-text details');
    expectContainsCI(flat, 'Require explicit re-confirmation');
  });

  it('routes Step 0.5 agent-pick confirmation through structured questions', async () => {
    const body = await loadBody();
    const step = sliceBetween(
      body,
      '### Step 0.5 — Confirm agent picks',
      '### Step 1 — Dispatch implementer',
    );

    expectStructuredQuestionGuidance(step);
    expectContainsCI(step, 'OK / Override options');
    expectContainsCI(step, 'Override must allow free-text details');
    expectContainsCI(step, 'restate the final picks and ask again');
  });

  it('routes Step 3 N-A, BLOCKING, and iteration-cap gates through structured questions', async () => {
    const body = await loadBody();
    const step3 = sliceBetween(
      body,
      '### Step 3 — Iterate or converge',
      '### Step 4 — Merge',
    );

    const naStart = step3.indexOf('**N-A guard');
    const consolidationStart = step3.indexOf('**Cross-model consolidation', naStart);
    expect(naStart).toBeGreaterThanOrEqual(0);
    expect(consolidationStart).toBeGreaterThan(naStart);
    const naGuard = step3.slice(naStart, consolidationStart);
    const flatNaGuard = flattenWhitespace(naGuard);
    expectStructuredQuestionGuidance(naGuard);
    expectContainsCI(flatNaGuard, 'Accept N-A (treat as PASS)');
    expectContainsCI(flatNaGuard, 'revise the criterion');
    expectContainsCI(flatNaGuard, 'override (treat as FAIL');
    expectContainsCI(flatNaGuard, 'hand off');

    const blockingStart = step3.indexOf('**BLOCKING verdict.');
    const capStart = step3.indexOf('**Iteration cap reached', blockingStart);
    const disagreementStart = step3.indexOf('**Reviewer disagreement', capStart);
    expect(blockingStart).toBeGreaterThanOrEqual(0);
    expect(capStart).toBeGreaterThan(blockingStart);
    expect(disagreementStart).toBeGreaterThan(capStart);

    const blockingGate = step3.slice(blockingStart, capStart);
    const flatBlockingGate = flattenWhitespace(blockingGate);
    expectStructuredQuestionGuidance(blockingGate);
    expectContainsCI(flatBlockingGate, 'rethink the approach');
    expectContainsCI(flatBlockingGate, 'revise the criteria');
    expectContainsCI(flatBlockingGate, 'discard');
    expectContainsCI(flatBlockingGate, 'continue anyway');

    const capGate = step3.slice(capStart, disagreementStart);
    const flatCapGate = flattenWhitespace(capGate);
    expectStructuredQuestionGuidance(capGate);
    expectContainsCI(flatCapGate, 'revise criteria');
    expectContainsCI(flatCapGate, 'switch implementer');
    expectContainsCI(flatCapGate, 'accept failing finding(s) and merge');
    expectContainsCI(flatCapGate, 'hand off');
  });

  it('routes Step 4 merge confirmation through structured questions without weakening explicit approval', async () => {
    const body = await loadBody();
    const step4 = sliceBetween(
      body,
      '### Step 4 — Merge',
      '## Operating guardrails',
    );

    expectStructuredQuestionGuidance(step4);
    expectContainsCI(step4, 'Merge / Do not merge options');
    expectContainsCI(step4, 'explicit "yes / go / merge"');
    expectContainsCI(step4, 'confirmed: true');
    expectContainsCI(step4, 'Do not auto-merge');
  });
});

describe('crew-iterate body — criteria-store adoption', () => {
  it('anchors the Step 0 criteria tool flow and explicit consent rules', async () => {
    const body = await loadBody();
    const start = body.indexOf('### Step 0 — Derive and confirm acceptance criteria');
    const end = body.indexOf('### Step 0.5 — Confirm agent picks', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const step0 = body.slice(start, end);
    const flatStep0 = flattenWhitespace(step0);

    expect(step0).toContain('create_criteria({criteria})');
    expect(step0).toContain('returned tool-result text');
    expectContainsCI(flatStep0, 'GFM markdown table');
    expectContainsCI(flatStep0, 'Print the table before invoking AskUserQuestion');
    expect(step0).toContain('confirm_criteria({criteria_set_id})');
    expect(step0).toContain('confirm_criteria({criteria_set_id, ops})');
    expect(step0).toContain('CriteriaEditOps');
    expectContainsCI(step0, 'confirmation is the point of no return');
    expectContainsCI(step0, 'always sets `status: "confirmed"`');
    expectContainsCI(step0, 'Silence is not consent');
  });

  it('passes criteria_set_id through dispatch without acceptance-criteria peer messages', async () => {
    const body = await loadBody();
    const start = body.indexOf('### Step 1 — Dispatch implementer');
    const end = body.indexOf('### Step 3 — Iterate or converge', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const dispatchSteps = body.slice(start, end);

    expectContainsCI(dispatchSteps, 'criteria_set_id: <confirmed criteria_set_id>');
    expectContainsCI(dispatchSteps, 'run_agent({');
    expectContainsCI(dispatchSteps, 'run_panel({');
    expectContainsCI(dispatchSteps, 'Do not restate criteria inline');
    expect(dispatchSteps).not.toContain('from_label: "acceptance criteria"');
    expect(dispatchSteps).not.toContain('restating the criteria inline');
  });

  it('anchors host-native get_criteria and mid-loop revise_criteria handling', async () => {
    const body = await loadBody();
    expect(body).toContain('get_criteria({criteria_set_id})');
    expect(body).toContain('get_criteria({criteria_set_id}).rendered_block');
    expect(body).toContain('revise_criteria({criteria_set_id, ops, note})');
    expectContainsCI(body, 'returns `status: "proposed"`');
    expectContainsCI(body, 'Require explicit re-confirmation with `confirm_criteria`');
  });

  it('keeps the tools-absent fallback and removes stale reviewer criteria branches', async () => {
    const body = await loadBody();
    const flat = flattenWhitespace(body);
    expectContainsCI(body, 'Tools-absent fallback');
    expectContainsCI(flat, 'legacy prose criteria block');
    expect(body).not.toContain('no criteria provided; cannot score');
    expect(body).not.toContain('criteria drift detected');
    expect(body).not.toContain('Audit check');
  });

  it('documents the exact criteria error scopes', async () => {
    const body = await loadBody();
    const flat = flattenWhitespace(body);
    for (const error of [
      'criteria.unknown',
      'criteria.not_confirmed',
      'criteria.cross_repo',
      'criteria.unparsable',
      'criteria.unknown_schema_version',
      'criteria.linkage_mismatch',
      'criteria.contract_too_large',
    ]) {
      expect(body).toContain(error);
    }
    expectContainsCI(
      flat,
      '`criteria.invalid` is a validation error for `create_criteria`, `confirm_criteria`, and `revise_criteria`',
    );
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
      { label: 'own-host routing to native subagent', needle: 'own host product' },
      { label: 'never shell out', needle: 'Never shell out' },
      { label: 'read-only cleanup', needle: 'do not auto-clean' },
      { label: 'ask on ambiguity', needle: 'before dispatching on ambiguity' },
    ];
    for (const { label, needle } of checks) {
      expectContainsCI(body, needle);
      void label;
    }
  });

  it('folds the crew-first ordering into invariant #2 (no 9th invariant)', async () => {
    const body = await loadBody();
    // The rule lives inside invariant #2, not as a new invariant — the
    // intro count and the count test below must stay at eight.
    const start = body.indexOf('**2. Dispatch lifecycle');
    const end = body.indexOf('**3. Escape hatch', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const inv2 = body.slice(start, end);
    expectContainsCI(inv2, 'Crew before captain-side work');
    expectContainsCI(inv2, 'run_in_background');
    // Dependency carve-out must be present (contradiction anchor).
    expectContainsCI(inv2, 'prerequisite');

    // Count is unchanged: intro still says eight, and no 9th invariant
    // bullet was introduced. Collapse whitespace — the intro wraps
    // "eight\ninvariants below" across a line break.
    const flat = body.replace(/\s+/g, ' ');
    expectContainsCI(flat, 'eight invariants below');
    expect(body).not.toContain('**9.');

    // Step 2 cross-references the invariant so it reads as an instance.
    const s2start = body.indexOf('### Step 2 —');
    const s2end = body.indexOf('### Step 3 —', s2start);
    const step2 = body.slice(s2start, s2end);
    expect(step2).toContain('(invariant #2)');
  });

  it('requires per-run watchers for independent runs and one panel-level watcher in invariant #2', async () => {
    const body = await loadBody();
    const start = body.indexOf('**2. Dispatch lifecycle');
    const end = body.indexOf('**3. Escape hatch', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const inv2 = flattenWhitespace(body.slice(start, end));

    expectContainsCI(inv2, 'complete this checklist');
    expectContainsCI(inv2, 'Bash({{CREW_WAIT_COMMAND}} <run_id>, run_in_background: true)');
    expectContainsCI(inv2, 'Repeat once per independent run');
    expectContainsCI(inv2, 'ONE watcher for the whole panel');
    expectContainsCI(inv2, 'Bash({{CREW_WAIT_COMMAND}} <id1> <id2> ..., run_in_background: true)');
    expectContainsCI(inv2, 'required_next_action');
    expectContainsCI(inv2, 'get_panel_status');
    expectContainsCI(inv2, 'running_count');
    expectContainsCI(inv2, 'aggregate_panel');
    expectContainsCI(inv2, 'Agent');
    expectContainsCI(inv2, 'Task');
    expectContainsCI(inv2, 'not harness-tracked');
    expect(inv2).not.toContain('N crew runs means N watchers');
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
