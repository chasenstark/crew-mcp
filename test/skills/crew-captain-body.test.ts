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

function expectContainsCI(haystack: string, needle: string): void {
  const ok = haystack.toLowerCase().includes(needle.toLowerCase());
  if (!ok) {
    throw new Error(
      `Expected body to contain phrase (case-insensitive): "${needle}"`,
    );
  }
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

  it('routes reviewer-pick confirmation through structured questions', async () => {
    const body = await loadBody();
    const section = sliceBetween(
      body,
      '### Confirm reviewer picks',
      '#### Override grammar',
    );

    expectStructuredQuestionGuidance(section);
    expectContainsCI(section, 'OK / Override options');
    expectContainsCI(section, 'Override must allow free-text details');
    expectContainsCI(section, 'restate the final reviewer list');
  });
});

describe('crew-captain body — structured-question gates', () => {
  it('describes criteria tool markdown results and the pre-question table reprint gate', async () => {
    const body = await loadBody();
    const section = sliceBetween(
      body,
      '## Criteria tool display',
      '## Dispatch-vs-inline',
    );
    const flat = flattenWhitespace(section);

    expectContainsCI(flat, 'create_criteria');
    expectContainsCI(flat, 'confirm_criteria');
    expectContainsCI(flat, 'revise_criteria');
    expectContainsCI(flat, 'return chat-readable markdown as the tool result text');
    expectContainsCI(flat, 'display hint');
    expectContainsCI(flat, 'GFM criteria table');
    expectContainsCI(flat, 'Reprint that table verbatim as normal chat before invoking AskUserQuestion');
    expectContainsCI(flat, 'Do not treat these results as raw JSON');
  });

  it('routes dispatch-vs-inline and same-host decisions through structured questions', async () => {
    const body = await loadBody();
    const section = sliceBetween(
      body,
      '## Dispatch-vs-inline',
      '## The default flow',
    );

    const flat = flattenWhitespace(section);
    expectStructuredQuestionGuidance(section);
    expectContainsCI(flat, 'dispatch-vs-inline decision');
    expectContainsCI(flat, 'native subagent and explicit worktree isolation');
    expectContainsCI(flat, 'Other/free-text escape');
  });

  it('routes terminal follow-up choices through structured questions', async () => {
    const body = await loadBody();
    const section = sliceBetween(
      body,
      '## The default flow',
      '## Merge boundary',
    );

    const flat = flattenWhitespace(section);
    expectStructuredQuestionGuidance(section);
    expectContainsCI(flat, 'merge, continue iterating, or discard');
    expectContainsCI(flat, 'discard the worktree (cleanup) or keep it');
  });

  it('routes merge/discard confirmation and merge-strategy choice through structured questions', async () => {
    const body = await loadBody();
    const mergeBoundary = sliceBetween(
      body,
      '## Merge boundary',
      '### Pick the merge strategy',
    );
    expectStructuredQuestionGuidance(mergeBoundary);
    expectContainsCI(flattenWhitespace(mergeBoundary), 'merge and discard confirmations');
    expectContainsCI(mergeBoundary, 'confirmed: true');
    expectContainsCI(mergeBoundary, 'yes / go / merge');

    const strategy = sliceBetween(
      body,
      '### Pick the merge strategy',
      '## When to ask the user',
    );
    expectStructuredQuestionGuidance(strategy);
    expectContainsCI(strategy, 'Squash / Preserve options');
  });

  it('keeps open-ended clarifications free-text capable while structuring discrete rubric choices', async () => {
    const body = await loadBody();
    const section = sliceBetween(
      body,
      '## When to ask the user',
      '## Dispatch lifecycle',
    );

    const flat = flattenWhitespace(section);
    expectStructuredQuestionGuidance(section);
    expectContainsCI(flat, 'Do not force genuinely open-ended asks');
    expectContainsCI(flat, 'what does done look like');
    expectContainsCI(flat, 'Other/free-text option');
    expectContainsCI(flat, 'Scope is open-ended');
    expectContainsCI(flat, 'More than one plausible approach exists');
    expectContainsCI(flat, "You don't know which agent fits");
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

describe('crew-captain body — quota-aware routing', () => {
  it('pins preemptive quota routing and reactive remediation guidance', async () => {
    const body = await loadBody();
    const section = sliceBetween(
      body,
      '## Quota-aware routing',
      '## Forwarding peer context',
    );
    const flat = flattenWhitespace(section);

    expectStructuredQuestionGuidance(section);
    expectContainsCI(flat, '`limited` agents are excluded');
    expectContainsCI(flat, '`near_limit` agents are down-ranked');
    expectContainsCI(flat, '`unknown` agents are allowed but penalized');
    expectContainsCI(flat, '`local_unmetered` agents are preferred');
    expectContainsCI(flat, 'refresh: true');
    expectContainsCI(flat, 'un-stick');
    expectContainsCI(flat, 'quota_exhausted');
    expectContainsCI(flat, 'rate_limited');
    expectContainsCI(flat, 'auth');
    expectContainsCI(flat, 'Never retry the same agent');
    expectContainsCI(flat, 'write run with any captured edits');
    expectContainsCI(flat, 'never auto-discard a half-done worktree');
  });
});

describe('crew-captain body — watcher checklist', () => {
  it('requires one watcher per crew run and distinguishes native subagents', async () => {
    const body = await loadBody();
    const section = sliceBetween(
      body,
      '### Step 2 — background watcher overlay',
      '### Foreground',
    );
    const flat = flattenWhitespace(section);

    expectContainsCI(flat, 'complete this checklist before ending the turn');
    expectContainsCI(flat, 'Bash({{CREW_WAIT_COMMAND}} <run_id>, run_in_background: true)');
    expectContainsCI(flat, 'N crew runs means N watchers');
    expectContainsCI(flat, 'Agent');
    expectContainsCI(flat, 'Task');
    expectContainsCI(flat, 'not harness-tracked');
  });
});

describe('crew-captain body — ephemeral review dispatches (agy)', () => {
  it('teaches the ephemeral_review contract: disposable worktree, findings only, never mergeable', async () => {
    const body = await loadBody();
    const flat = flattenWhitespace(body);

    expectContainsCI(flat, 'Ephemeral review dispatches (agy)');
    expectContainsCI(flat, 'run_mode: "ephemeral_review"');
    expectContainsCI(flat, 'disposable snapshot worktree');
    expectContainsCI(flat, 'Never mergeable');
    expectContainsCI(flat, 'frozen snapshot');
    expectContainsCI(flat, 'trusted diffs');
    // read_only on agy stays a reject, and the panel path is explicitly not wired.
    expectContainsCI(flat, 'Do NOT put agy on a `run_panel`');
  });
});
