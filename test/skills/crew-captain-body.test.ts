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

function flattenWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ');
}

function expectContainsCI(haystack: string, needle: string): void {
  expect(haystack.toLowerCase()).toContain(needle.toLowerCase());
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

function expectAskGate(section: string): void {
  expect(section).toContain('**Ask gate:**');
  expect(section).toContain('Ask protocol');
  expect(section).toContain('Silence is not consent');
}

describe('crew-captain body — named protocols', () => {
  it('defines Ask protocol and Own-host rule once, then references short gates', async () => {
    const body = await loadBody();
    expect(body.match(/^### Ask protocol$/gm)).toHaveLength(1);
    expect(body.match(/^### Own-host rule$/gm)).toHaveLength(1);

    const protocols = sliceBetween(body, '## Named protocols', '## Dispatch or inline');
    const flat = flattenWhitespace(protocols);
    expectContainsCI(flat, 'AskUserQuestion on Claude Code');
    expectContainsCI(flat, 'If the host has no structured question tool');
    expectContainsCI(flat, 'free-text reply');
    expectContainsCI(flat, 'Other/free-text path');
    expectContainsCI(flat, 'Silence is not consent');
    expectContainsCI(flat, 'dispatch it as a native subagent');
    expectContainsCI(flat, 'explicitly asks for same-product worktree isolation');

    expect(body.match(/\*\*Ask gate:\*\*/g)?.length).toBeGreaterThanOrEqual(7);
    expect(body.match(/\*\*Own-host gate:\*\*/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('crew-captain body — structured gates', () => {
  it('keeps concise Ask gates adjacent to dispatch, terminal, merge, strategy, rubric, quota, and panel choices', async () => {
    const body = await loadBody();
    expectAskGate(sliceBetween(body, '## Dispatch or inline', '## Default flow'));
    expectAskGate(sliceBetween(body, '## Default flow', '## Merge boundary'));
    expectAskGate(sliceBetween(body, '## Merge boundary', '### Pick the merge strategy'));
    expectAskGate(sliceBetween(body, '### Pick the merge strategy', '## When to ask before dispatch'));
    expectAskGate(sliceBetween(body, '## When to ask before dispatch', '## Dispatch lifecycle'));
    expectAskGate(sliceBetween(body, '## Quota-aware routing', '## Peer context'));
    expectAskGate(sliceBetween(body, '### Confirm reviewer picks', '### Host reviewer'));
  });

  it('keeps criteria-table display guidance before any user confirmation', async () => {
    const body = await loadBody();
    const section = sliceBetween(body, '## Criteria display', '## Named protocols');
    const flat = flattenWhitespace(section);

    expectContainsCI(flat, 'create_criteria');
    expectContainsCI(flat, 'confirm_criteria');
    expectContainsCI(flat, 'revise_criteria');
    expectContainsCI(flat, 'chat-readable markdown');
    expectContainsCI(flat, 'display hint');
    expectContainsCI(flat, 'GFM criteria table');
    expectContainsCI(flat, 'Reprint that table verbatim');
    expectContainsCI(flat, 'rendered_block');
  });
});

describe('crew-captain body — dispatch lifecycle', () => {
  it('states async dispatch, scoped turn-start checks, watcher degradation, and timestamp-free recovery', async () => {
    const body = await loadBody();
    const section = sliceBetween(body, '## Dispatch lifecycle', '## The tools');
    const flat = flattenWhitespace(section);

    expectContainsCI(flat, 'async-first');
    expectContainsCI(flat, "Don't block the turn with `get_run_status`");
    expectContainsCI(flat, 'wait_for_terminal_only');
    expectContainsCI(flat, '### Dispatch order - crew first');
    expectContainsCI(flat, 'Exception');
    expectContainsCI(flat, 'prerequisite');
    expectContainsCI(flat, 'crew-mcp install-tail-handler');
    expectContainsCI(flat, 'live runs:');
    expectContainsCI(flat, 'Complete this checklist before ending the turn');
    expectContainsCI(flat, 'Bash(<required_next_action.command>, run_in_background: true)');
    expectContainsCI(flat, 'required_next_action.working_directory_json');
    expectContainsCI(flat, 'N crew runs means N watchers');
    expectContainsCI(flat, 'Agent');
    expectContainsCI(flat, 'Task');
    expectContainsCI(flat, 'not Crew-tracked');
    expectContainsCI(flat, 'diagnostic code 3');
    expectContainsCI(flat, 'unknown');
    expectContainsCI(flat, '$CREW_HOME');
    expectContainsCI(flat, 'Do not respawn in a loop');
    expectContainsCI(flat, 'without `completedAfter`');
    expectContainsCI(flat, 'dedupe by `run_id`');
    expectContainsCI(flat, 'context was compacted or cleared');
    expectContainsCI(flat, 'more than one pending run');
    expectContainsCI(flat, 'one repo-scoped `list_runs` call');
  });
});

describe('crew-captain body — merge and cleanup', () => {
  it('uses commit metadata for merge strategy and keeps git log as old-run fallback', async () => {
    const body = await loadBody();
    const section = sliceBetween(body, '### Pick the merge strategy', '## When to ask before dispatch');
    const flat = flattenWhitespace(section);

    expectContainsCI(flat, '`commits` and `commit_count`');
    expectContainsCI(flat, 'newest-first');
    expectContainsCI(flat, 'capped at 20');
    expectContainsCI(flat, 'fall back to `git log`');
    expectContainsCI(flat, 'commit_title');
    expectContainsCI(flat, 'squash');
    expectContainsCI(flat, 'preserve');
  });

  it('describes prompt-discard habit plus run-GC backstop for read-only and ephemeral runs', async () => {
    const body = await loadBody();
    const guardrails = sliceBetween(body, '## Operating guardrails', '## Quota-aware routing');
    const flat = flattenWhitespace(guardrails);

    expect(flat).not.toContain("Read-only runs don't auto-clean");
    expectContainsCI(flat, 'Prompt discard remains the habit');
    expectContainsCI(flat, 'terminal worktrees are eligible after 7 days');
    expectContainsCI(flat, 'run directories after 30 days');
    expectContainsCI(flat, 'repo-scoped');
    expectContainsCI(flat, 'run_mode: "ephemeral_review"');
    expectContainsCI(flat, 'disposable snapshot worktree');
    expectContainsCI(flat, 'never mergeable');
    expectContainsCI(flat, 'frozen snapshot');
    expectContainsCI(flat, 'trusted diffs');
  });
});

describe('crew-captain body — quota-aware routing', () => {
  it('pins preemptive quota routing and reactive remediation guidance', async () => {
    const body = await loadBody();
    const section = sliceBetween(body, '## Quota-aware routing', '## Peer context');
    const flat = flattenWhitespace(section);

    expectContainsCI(flat, '`limited` agents');
    expectContainsCI(flat, '`near_limit`');
    expectContainsCI(flat, '`unknown`');
    expectContainsCI(flat, '`local_unmetered`');
    expectContainsCI(flat, 'refresh:');
    expectContainsCI(flat, 'un-stick');
    expectContainsCI(flat, 'rate_limited');
    expectContainsCI(flat, 'quota_exhausted');
    expectContainsCI(flat, 'auth');
    expectContainsCI(flat, 'Never retry the same agent');
    expectContainsCI(flat, 'captured edits');
    expectContainsCI(flat, 'Never auto-discard a half-done worktree');
  });
});

describe('crew-captain body — peer context', () => {
  it('inlines peer_messages error families and removes plan references', async () => {
    const body = await loadBody();
    const section = sliceBetween(body, '## Peer context', '## Review panels');
    const flat = flattenWhitespace(section);

    expectContainsCI(flat, 'peer_messages.composed_prompt_too_large');
    expectContainsCI(flat, 'peer_messages.item_too_large');
    expectContainsCI(flat, 'peer_messages.too_many_items');
    expectContainsCI(flat, 'peer_messages.run_unknown');
    expectContainsCI(flat, 'peer_messages.run_in_flight');
    expectContainsCI(flat, 'peer_messages.run_terminal');
    expect(flat).not.toContain('See plan');
    expect(flat).not.toContain('in this plan');
    expect(flat).not.toContain('peer_messages.<code>');
  });
});

describe('crew-captain body — review panels', () => {
  it('contains panel-pick anchors and own-host/native-review routing', async () => {
    const body = await loadBody();
    const section = sliceBetween(body, '## Review panels', '### Panel lifecycle');
    const flat = flattenWhitespace(section);

    expectContainsCI(flat, '### Confirm reviewer picks');
    expectContainsCI(flat, 'Agents for this panel:');
    expectContainsCI(flat, 'Override grammar');
    expectContainsCI(flat, 'get_crew_preferences({scope: "panel"})');
    expectContainsCI(flat, 'panel.reviewers');
    expectContainsCI(flat, 'panel.banList');
    expectContainsCI(flat, 'Own-host gate');
    expectContainsCI(flat, 'native subagent');
    expectContainsCI(flat, 'inline fallback');
  });

  it('tells the captain to silently no-op a host reviewer completion for an already-consolidated round', async () => {
    const body = await loadBody();
    const section = sliceBetween(body, '### Host reviewer', '### `run_panel` shape');
    const flat = flattenWhitespace(section);

    expectContainsCI(flat, 'completion banner');
    expectContainsCI(flat, 'separate channel from the panel watcher');
    expectContainsCI(flat, 'expected, redundant wake');
    expectContainsCI(flat, 'silently end the turn');
    expectContainsCI(flat, "verdict differs");
  });

  it('uses one panel watcher and get_panel_status fallback instead of aggregate_not_ready discovery', async () => {
    const body = await loadBody();
    const section = sliceBetween(body, '### Panel lifecycle', '### Aggregation and consolidation');
    const flat = flattenWhitespace(section);

    expectContainsCI(flat, 'panel-level');
    expectContainsCI(flat, 'required_next_action');
    expectContainsCI(flat, 'Bash(<panel required_next_action.command>, run_in_background: true)');
    expectContainsCI(flat, 'Spawn one watcher for the panel');
    expectContainsCI(flat, 'per-run commands for selective/degraded waits');
    expectContainsCI(flat, 'get_panel_status({ panel_id })');
    expectContainsCI(flat, 'running_count > 0');
    expectContainsCI(flat, 'at most one short status line');
    expectContainsCI(flat, 'no reviewer findings dump');
    expectContainsCI(flat, 'Never discover panel completeness');
    expectContainsCI(flat, 'run_panel.aggregate_not_ready');
  });

  it('keeps consolidation output compact and preserves full reviewer text in run records', async () => {
    const body = await loadBody();
    const section = sliceBetween(body, '### Aggregation and consolidation', '### Partial dispatch');
    const flat = flattenWhitespace(section);

    expectContainsCI(flat, 'severity');
    expectContainsCI(flat, '`file:line`');
    expectContainsCI(flat, 'one-line description');
    expectContainsCI(flat, 'which models agree');
    expectContainsCI(flat, 'Full reviewer text stays in run records');
    expectContainsCI(flat, 'not chat');
  });
});
