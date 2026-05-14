# `crew:iterate` skill — design plan (standalone)

**Status:** Draft v1 2026-05-14. Builds on the just-merged
[`peer-messages-parameter.md`](../completed/peer-messages-parameter.md)
and [`run-panel.md`](../completed/run-panel.md). Predecessor work:
captain-to-worker `peer_messages` parameter (shipped 2026-05-12,
anchor commits `bd14ebb1` → `e81688e1`) and the
`run_panel` / `get_panel_status` / `aggregate_panel` triad (shipped
2026-05-12, anchor commits in `docs/plans/completed/run-panel.md`).

This plan defines a SECOND captain-facing skill — `crew:iterate` —
that codifies the dispatch → dual-review → iterate → merge loop
the captain has been driving manually with the verbs the two
predecessor plans shipped. It's pure orchestration playbook;
nothing about the MCP wire surface changes.

---

## At a glance

**What.** A second installable skill named `crew:iterate` shipping
alongside the existing top-level `crew` skill. Auto-loads when the
user asks "implement X with review" or any verb framing that
implies an iterate-to-convergence loop. Teaches the captain the
4-step pattern (dispatch → dual-review → iterate-or-converge →
merge) plus two embedded rubrics (inline-vs-dispatched review,
1+1-vs-panel) so the loop is reproducible without re-deriving it
each session.

**Why.** The pattern was used to ship both predecessor plans this
week. Each session, captain had to re-discover (a) when to add a
dispatched second opinion vs trust the inline review, (b) when to
escalate to `run_panel` vs stay 1+1, (c) how to phrase the review
prompt, and (d) the stop condition for iteration. Codifying it as
a skill removes the re-derivation tax and gives future captains a
default playbook with explicit rubrics so they can deviate when
justified rather than improvising every time.

**What this plan does NOT ship.**

- No new MCP tools. The skill composes existing verbs
  (`run_agent`, `continue_run`, `run_panel`, `aggregate_panel`,
  `get_run_status`, `merge_run`, `discard_run`).
- No automation of the loop (no "auto-iterate until APPROVE"
  daemon). The captain remains the orchestrator.
- No changes to the canonical body of the existing `crew` skill.
  This is purely an additive second skill body + the plumbing to
  ship two skills under one plugin namespace.
- No changes to the auto-approval logic, install manifest schema,
  or `verify` semantics beyond what's needed to write a second
  skill file.

**Cost.** ~2–2.5 days across 3 phases. Phase 1 (renderer +
install plumbing for N skills, umbrella unchanged) is the bulk;
Phase 2 (write the body) is mostly prose with embedded rubrics;
Phase 3 is dogfood on a real task to validate the rubrics catch
the right cases.

### One-direction flow (skill body's mental model)

```
USER: "implement X. have it reviewed."
  |
  v
CAPTAIN (with crew:iterate loaded):
  |
  | 1. DISPATCH IMPLEMENTER
  |    run_agent({agent_id: <impl>, prompt: "implement X",
  |               effort: <appropriate>, peer_messages?: [...]})
  |    -> run A (implementer worktree W_A)
  |    end turn; spawn watcher (Claude Code) or yield (Codex/Gemini)
  |
  | 2. DUAL-REVIEW (inline + dispatched, in parallel)
  |    Inline: read A.summary + diff, form a verdict.
  |    Dispatched: run_agent({agent_id: <reviewer>,
  |                            read_only: true,
  |                            working_directory: W_A,
  |                            peer_messages: [{body: A.summary,
  |                                             files: A.files_changed,
  |                                             kind: "review",
  |                                             from_label: "implementer"}],
  |                            prompt: <REVIEW_PROMPT_TEMPLATE>})
  |    -> run R1 (read-only on W_A)
  |    (or run_panel for >1 dispatched reviewer)
  |
  | 3. ITERATE OR CONVERGE
  |    Collect both verdicts. Each is APPROVE / CHANGES_NEEDED / BLOCKING.
  |    If any non-APPROVE:
  |      continue_run({run_id: A,
  |                    peer_messages: <aggregated reviewer findings>,
  |                    prompt: "address these findings"})
  |      discard R1 (read-only, won't auto-clean), repeat from step 2.
  |    Else (both APPROVE): go to step 4.
  |    Stop condition: convergence OR round_count >= 3 -> flag to user.
  |
  | 4. MERGE
  |    Ask user to merge (concrete prompt).
  |    On affirmative: merge_run({run_id: A, confirmed: true,
  |                               commit_title: ..., commit_body: ...})
  |    Discard remaining reviewer runs (cleanup).
```

---

## Goal

A captain in any host CLI (Claude Code, Codex, Gemini) that has
crew installed can say "have Claude implement X and review it"
and get a default loop that:

1. Dispatches the implementer.
2. Sets up dual review (always inline; usually also one dispatched
   reviewer; sometimes a `run_panel`).
3. Folds reviewer findings back into the implementer via
   `peer_messages` until both verdicts converge on APPROVE.
4. Asks the user to merge once convergence is reached; never
   auto-merges.

The captain follows this loop without the user having to teach it
each session, AND the captain can justify deviations from the
defaults using the embedded rubrics (not vibes).

## Non-goals

- **No "review-only" sub-skill** for code-review work that doesn't
  go through an implementer. The existing `pr-review-toolkit`
  family covers that; `crew:iterate` is for the
  implement-then-review loop specifically.
- **No auto-merge or auto-discard.** Skill body re-asserts the
  merge boundary from the canonical `crew` skill: never call
  `merge_run` / `discard_run` without explicit user approval.
- **No new MCP verbs.** This is a skill-only change.
- **No changes to how the existing `crew` skill auto-loads.**
  Both skills must coexist; user's existing flows continue to
  trigger the umbrella `crew` skill.
- **No body-content duplication.** Reusable phrases (escape
  hatch, dispatch lifecycle, merge boundary) stay in the umbrella
  body and the iterate body cross-references rather than copying.
- **No "iterate-driven" auto-cancellation** of in-flight reviewers
  when the implementer fails. Existing per-reviewer
  `cancel_run` is fine.

## Open design questions

1. **Skill auto-load matcher.** Claude Code's skill matcher
   currently keys on the `description:` frontmatter line. With two
   skills under the `crew` namespace, what description text reliably
   triggers `crew:iterate` for "implement X with review" framing
   WITHOUT poaching loads that should hit umbrella `crew` (raw
   dispatch, single review, panel-only, etc.)? **Hypothesis:**
   `crew:iterate` description leads with "implement-then-review",
   "iterate to convergence", "ship-quality loop"; umbrella `crew`
   stays on "dispatch coding work". Test in Phase 3.

2. **Sub-skill path layout per host.** Claude Code's skill
   convention seems to be `~/.claude/skills/<plugin>/SKILL.md`
   today. Plugin sub-skills appear to be loaded via
   `~/.claude/skills/<plugin>/<skill>/SKILL.md` (analogous to
   `pr-review-toolkit:review-pr`). **To verify in Phase 1**:
   confirm Claude Code's matcher actually indexes the nested
   directory; if not, fall back to a flat `~/.claude/skills/crew-iterate/SKILL.md`
   (no namespace, different name). Same question for
   `~/.codex/skills/` and `~/.gemini/extensions/`. Today's adapter
   skill paths are all flat single-file.

3. **Iteration cap.** Default cap = 3 rounds before flagging to the
   user. Tradeoff: a higher cap risks the captain looping
   indefinitely on flaky tests / disagreeing reviewers; a lower
   cap risks bailing on legitimately-converging work. v1 picks 3
   as a defensible middle; Phase 3 dogfood may reveal a better
   number.

4. **What counts as "non-trivial work" for the inline-vs-dispatched
   rubric?** Below the threshold, only inline review runs. Today's
   weak proxy: "≥1 production-code file changed AND ≥10 lines
   modified." Better signals welcome — open for v1 to refine.

5. **Reviewer effort default.** v1: reviewer dispatches use the
   same `effort` as the implementer. Alternative: reviewer
   defaults to `high` regardless (review is cheaper than
   implementation; spending more on review than on the implementer
   is fine). Decision: default to mirroring implementer; let the
   user override.

6. **Should `crew:iterate` reference `crew-captain.body.md`
   explicitly?** A new captain loading `crew:iterate` may not have
   the umbrella body in context (host matcher might not co-load).
   Options: (a) duplicate the load-bearing rules in `crew:iterate`
   body, (b) require co-load by explicit cross-reference in the
   description, (c) ship a small "everything below is in addition
   to the umbrella `crew` skill body" preamble and trust the
   captain to load both. v1 picks (c); revisit if Phase 3 shows
   it doesn't work.

---

## Skill body sketch — `crew:iterate`

This is the body content (`skills/crew-iterate.body.md`) the
implementation will ship in Phase 2. Stripped of HTML-comment
metadata at render time, same as `skills/crew-captain.body.md`.

### Auto-load description (frontmatter)

```yaml
name: crew:iterate
description: |
  Iterate an implementation to ship-quality via dual review.
  Loads when the user wants to implement-and-review, ship a
  reviewed change, or run an implementation through a
  convergence loop (e.g. "implement X with review",
  "have it reviewed before merging", "run the iterate loop").
  Composes run_agent, continue_run, run_panel, aggregate_panel,
  merge_run from the umbrella `crew` skill.
```

### Body content (target ~300 lines)

#### Preamble — what this skill assumes

This skill assumes the umbrella `crew` skill is also loaded. The
load-bearing rules from that body (escape hatch, merge boundary,
dispatch lifecycle, agent picking) still apply; this skill ADDS a
default playbook for the implement-then-review case. If the
umbrella body isn't loaded, ask the user to confirm crew is
installed and re-trigger.

#### When to use this skill (vs the umbrella `crew` skill alone)

Use `crew:iterate` when ALL of the following hold:

- The user wants an implementation (not just a one-shot review of
  existing code).
- The change should land via `merge_run` once it converges.
- The user expects "good quality" framing — they referenced
  review, iteration, convergence, or "ship-ready".

Fall back to umbrella `crew` semantics when:

- The user is dispatching a one-shot agent run with no review
  expected.
- The work is review-only on existing code (no implementer).
- The user explicitly says "no review, just implement" — then
  follow the umbrella's normal flow.

#### The 4-step loop

##### Step 1 — Dispatch implementer

`run_agent({agent_id: <implementer>, prompt: <precise>,
effort: <see umbrella>, peer_messages?: [...] })`.

Hand-off responsibilities:

- Write the prompt the implementer sees verbatim. Include
  acceptance criteria (test commands, behavior expectations) so
  the reviewer's job is well-defined.
- Pick `effort` per the umbrella's rubric. For implement-then-
  review, prefer one level higher than for a raw implementation —
  the review catches mid-effort regressions but can't recover from
  a low-effort foundation.
- Confirm dispatch with `[tail in side terminal](<tail_url>)`,
  end turn, spawn the watcher on Claude Code.

##### Step 2 — Dual-review (inline + dispatched, parallel)

When the implementer reaches terminal, ALWAYS run two reviews:

**(a) Inline review (mandatory, free).** Read `A.summary`,
`A.files_changed`, and the diff (`get_run_status` returns enough
for a sketch; the full diff is available via the worktree path).
Form a verdict using the same checklist the dispatched reviewer
will use (below). Inline review costs zero MCP round-trips and
sees the full diff in your context window.

**(b) Dispatched review (default-on; see rubric for skip).** Pick
one or more reviewer agents from `list_agents` (different model
than the implementer when possible — heterogeneity surfaces
different bugs). Dispatch as `read_only: true,
working_directory: <A.worktree_path>` with the implementer's
output forwarded via `peer_messages`. The dispatched reviewer
gets a fresh context window and applies a different model's
strengths.

When to skip the dispatched reviewer (inline-only):

- Typo / comment / pure-doc commit (<10 LOC, no production-code
  changes).
- The user said "no review" out loud.
- The implementer dispatch already returned `partial` / `error`
  and you're routing back to the user without a review.

Otherwise: ALWAYS dispatch the second-opinion review. The cost
(~30–60s + ~$0.01) is dwarfed by the cost of merging a regression
the inline review missed because of context bias.

**Choosing 1+1 vs panel (`run_panel`):**

- 1+1 (one inline + one dispatched): SINGLE review dimension.
  E.g., "is this correct?" or "is this idiomatic?" but not both.
  Default to 1+1 for narrow changes (single file, single
  concern).
- Panel (one inline + N dispatched via `run_panel`): MULTIPLE
  review dimensions. E.g., correctness + style + security on an
  auth change. Use when the change crosses concerns and you'd
  otherwise have to pick which dimension to favor. Panel
  per-reviewer cost is the same as a single dispatch, so 3
  reviewers = 3x the single-dispatched cost.
- Heuristic: 2 reviewer dimensions → consider panel. 3+ → almost
  always panel (you can't keep three review dimensions distinct
  in one prompt without prompt bloat).
- Anti-heuristic: if all reviewers would use the same checklist
  with the same agent, don't panel — that's just expensive
  triplication.

##### Review prompt template (use this verbatim)

```
You are reviewing changes made by ${implementer_label} against
${target_repo}. The implementer's working directory contains the
proposed changes (you are running in read-only mode at that
worktree path). The implementer's own summary is included in
peer_messages above.

Your job is to apply this checklist and produce ONE of three
verdicts:

  APPROVE        — no changes needed, ready to merge.
  CHANGES_NEEDED — concrete fixes required, but the approach
                   is sound.
  BLOCKING       — the approach itself is wrong; recommend a
                   rethink before another iteration.

Checklist:
  - Correctness: does the change accomplish the stated goal?
  - Tests: are new behaviors covered? do existing tests still
    cover what they did before?
  - ${reviewer_specialty}: ${specialty-specific checks, e.g.
                            "style adheres to repo conventions",
                            "no regressions in error paths",
                            "no new security exposure"}
  - Scope: did the implementer stay within the stated change,
    or did unrelated edits leak in?

Output format (mandatory):

  ## Verdict: <APPROVE | CHANGES_NEEDED | BLOCKING>

  ## Findings
  - [SEVERITY] <one-line finding>: <2-3 sentence justification>
    File: <path>:<line-range or "N/A">
    Recommendation: <concrete action>

  ## Recommended action
  <one paragraph: what should the implementer do next?>

Severity rubric:
  CRITICAL — correctness bug, security flaw, data loss risk.
  MAJOR    — non-trivial design issue that will compound.
  MINOR    — style, naming, comment quality.
  NIT      — taste, optional polish.

Only CRITICAL and MAJOR findings should drive CHANGES_NEEDED or
BLOCKING verdicts.

Do not edit files. If you find yourself wanting to write,
describe the edit instead — you are read-only by design.
```

Substitute `${reviewer_specialty}` with the reviewer's domain
(correctness / style / security / perf) so a panel of reviewers
each gets a distinct lens.

##### Step 3 — Iterate or converge

Once both verdicts are in (inline + dispatched, or inline + panel
aggregate):

- **Both APPROVE.** Go to Step 4 (merge).
- **Any CHANGES_NEEDED.** Aggregate findings into `peer_messages`
  and `continue_run` the implementer:
  ```
  continue_run({
    run_id: A,
    peer_messages: [
      {body: inline_review_findings, kind: "review",
       from_label: "captain inline review"},
      {body: dispatched_review.summary, kind: "review",
       from_label: "${reviewer_agent_id} review",
       files: dispatched_review.files_changed},
      // ...one per reviewer if panel
    ],
    prompt: "Address these review findings. Reply with a brief
             summary of what changed."
  })
  ```
  For panels, just call `aggregate_panel({panel_id})` and pass
  the result directly as `peer_messages`.

  After `continue_run` reaches terminal, discard the read-only
  reviewer runs (they don't auto-clean) and re-dispatch the same
  reviewers against the new diff. Round count increments by 1.

- **Any BLOCKING.** Stop the loop. Surface the BLOCKING verdict
  to the user with the reviewer's `Recommended action`. Ask:
  "rethink the approach, discard, or continue anyway?" Do NOT
  silently continue-run on a BLOCKING verdict — the cost of a
  wrong rethink is much higher than a clarifying question.

- **Iteration cap reached (default 3 rounds).** If you'd be
  about to start round 4, stop and flag to the user. Phrase:
  "We've iterated 3 rounds; reviewers still see CHANGES_NEEDED.
  Continue, switch reviewers, or hand off?" The cap prevents
  unbounded iteration on flaky tests or reviewer disagreements
  that need human arbitration.

**Reviewer disagreement (one APPROVE, one CHANGES_NEEDED).**
This is signal, not noise. Default: treat as CHANGES_NEEDED
(conservative). Forward both verdicts to the implementer in the
`peer_messages` so it sees the disagreement explicitly. If the
disagreement persists across two rounds, flag to user.

##### Step 4 — Merge

Once both reviews converge on APPROVE, ask the user to merge.
Follow the umbrella `crew` skill's merge boundary verbatim:
concrete merge prompt, `merge_run({confirmed: true, ...})` only
after explicit affirmative, meaningful `commit_title` derived
from the implementer's summary + reviewer findings.

After merge, `discard_run` the reviewer runs (cleanup) and
acknowledge to the user.

#### Cross-host degradation notes

- **Claude Code:** full flow works as described. Watcher overlay
  fires synthetic turns on reviewer + implementer terminations.
- **Codex / Gemini:** no watcher; each terminal status surfaces on
  the next user turn via `list_runs` + `get_run_status`. The loop
  still works but takes more user turns to drive — Step 2's
  reviewer terminal might not surface until the user types again.
  Tell the user this upfront if you detect a Codex/Gemini host.
- **Same-host product as implementer.** Already prohibited by the
  umbrella body's "don't dispatch to your own host" rule. For the
  iterate loop, this means: when running on Claude Code, the
  implementer can't be claude-code via crew (use native subagents
  for that; dispatch a *different* product as reviewer).

#### Operating guardrails (delta from umbrella)

- Reviewer effort defaults to mirror the implementer's effort.
  When you override, restate in the reviewer's prompt.
- Inline review is mandatory; you can't "skip the inline review
  because the dispatched one is more thorough." The inline read
  is fast, free, and catches the obvious stuff.
- Do not pre-allocate reviewer runs before the implementer
  terminates. Reviewer needs `working_directory: <A.worktree>`,
  and `A.worktree` is only stable post-terminal.
- For panel dispatches, use `run_panel` once after implementer
  terminates — do not call `run_agent` N times manually; you'll
  lose the `panel_id` / aggregation hook.
- When the implementer terminates with `partial` or `error`,
  STILL run the dispatched review unless the user asks otherwise.
  Reviewers often see why the implementer stalled.

---

## Plumbing changes

The existing skill renderer assumes ONE canonical body (`skills/crew-captain.body.md`)
and ONE template per host. Shipping a second skill requires a
small generalization. Concrete touchpoints:

### `skills/` directory layout (new)

Current:
```
skills/
  crew-captain.body.md             # umbrella `crew` skill body
  targets/
    claude-code.md.tmpl            # frontmatter + {{BODY}}
    codex.md.tmpl
    gemini.md.tmpl
```

Proposed:
```
skills/
  crew-captain.body.md             # umbrella `crew` skill body (unchanged)
  crew-iterate.body.md             # NEW — `crew:iterate` body
  targets/
    claude-code.md.tmpl            # unchanged (reusable for both skills)
    codex.md.tmpl                  # unchanged
    gemini.md.tmpl                 # unchanged
```

The per-host templates are already body-agnostic — they take a
`{{BODY}}` placeholder and emit frontmatter. Reusing them for the
`crew:iterate` skill requires only swapping the body file and the
description. If the description needs to vary per host (it
shouldn't — Claude Code's matcher is the only one that cares
deeply), templates can take a per-skill description override.

### `src/install/skill-renderer.ts` (extend)

Today's `renderSkill` takes `{templatePath, tools, packageRoot?,
crewWaitCommand?}` and bakes in `crew-captain.body.md` via the
hardcoded `loadCanonicalBody` path. Generalize:

```ts
// NEW: per-skill manifest entry.
export interface SkillManifestEntry {
  /** Skill ID — `crew` for the umbrella, `crew:iterate` for the sub-skill. */
  readonly id: string;
  /** Path (relative to packageRoot/skills/) to the body file. */
  readonly bodyFile: string;             // e.g. 'crew-captain.body.md'
  /** Description string for the host matcher. */
  readonly description: string;
  /** Optional override for the frontmatter `name:` field. */
  readonly frontmatterName?: string;     // defaults to the trailing segment of id
}

// NEW: the canonical list of skills crew installs.
export const SKILL_MANIFEST: readonly SkillManifestEntry[] = [
  {
    id: 'crew',
    bodyFile: 'crew-captain.body.md',
    description: SKILL_DESCRIPTION,       // existing constant; unchanged
    frontmatterName: 'crew',
  },
  {
    id: 'crew:iterate',
    bodyFile: 'crew-iterate.body.md',
    description: ITERATE_SKILL_DESCRIPTION, // NEW constant; tuned phrase
    frontmatterName: 'crew:iterate',
  },
];

// MODIFIED: renderSkill now takes the manifest entry.
export interface RenderSkillArgs {
  readonly templatePath: string;
  readonly skill: SkillManifestEntry;
  readonly tools: readonly SkillTool[];
  readonly crewWaitCommand?: string;
  readonly packageRoot?: string;
}

export async function renderSkill(args: RenderSkillArgs): Promise<string> {
  // body loaded from args.skill.bodyFile instead of hardcoded path
  // description from args.skill.description instead of hardcoded constant
  // {{TOOL_LIST}} still rendered (both skills reference the same tools)
  // {{CREW_WAIT_COMMAND}} unchanged
}
```

Backward compatibility: the existing single-arg call site can be
migrated to pass `SKILL_MANIFEST[0]` directly. No public API
removed; one new field added.

### Host adapter `skillPath` becomes plural (`skillPaths`)

Today each adapter has `skillPath: (home) => string`. With two
skills it becomes `skillPaths: (home) => { [skillId: string]: string }`
OR a method `skillPathFor(home, skillId)`. The latter composes
better with the manifest loop.

**Per-host skill path proposal** (subject to Open Question 2):

| Host | Umbrella `crew` | Sub-skill `crew:iterate` |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/crew/SKILL.md` | `~/.claude/skills/crew/iterate/SKILL.md` |
| Codex | `~/.codex/skills/crew/SKILL.md` | `~/.codex/skills/crew/iterate/SKILL.md` |
| Gemini | `~/.gemini/extensions/crew/SKILL.md` | `~/.gemini/extensions/crew/iterate/SKILL.md` |

**Risk:** if any host's matcher does NOT index nested
sub-directories under `<plugin>/`, the sub-skill won't auto-load.
Mitigation: probe in Phase 1 (write a test SKILL.md, verify the
host loads it on session start). If a host doesn't support
nested layout, fall back to a sibling-flat layout (e.g.
`~/.claude/skills/crew-iterate/SKILL.md` with `name: crew-iterate`
in the frontmatter — losing the namespace but preserving the
auto-load behavior). The fallback layout is purely cosmetic; the
body content is identical.

### `src/install/install-manifest.ts` (mild extension)

Today's `InstalledTarget` tracks `skillPath: string`. With N
skills this becomes either:

- `skillPaths: Record<string, string>` (skill id → file path), OR
- `skills: Array<{id: string, path: string}>` (more verbose but
  symmetric with the manifest entries).

Either way: schemaVersion bump to 2; reader handles v1 by
treating the existing `skillPath` as `{crew: <path>}` and
returning a v2-shaped manifest. v1→v2 is a forward-only migration
on the first re-install; uninstall on a stale v1 manifest still
works because the path is preserved.

### `src/install/hosts/index.ts` + `claude-code.ts` / `codex.ts` / `gemini.ts`

Each adapter gains a `skillPathFor(home, skillId)` method OR a
`skillPaths(home): Record<string, string>` getter. Existing
`skillPath` stays as a thin wrapper for backward compatibility
during Phase 1, removed once all callers migrate.

### Install command (`src/install/...` orchestration)

The top-level install command loops over `SKILL_MANIFEST`, calls
`renderSkill` per entry, and writes each rendered output to the
adapter's `skillPathFor(home, skill.id)`. Existing single-skill
behavior is the loop's degenerate case (one entry).

### `verify` command parity

Today `verify` parses `mcp__crew__*` references out of the
installed skill to assert parity with the live MCP catalog. With
two skills, verify must parse BOTH files and union the tool
references — both files reference the same toolset, so parity
is: live catalog ⊆ (skill A tools ∪ skill B tools). If a tool
appears only in skill B, that's fine (each skill can reference a
subset); the failure mode is a live tool absent from BOTH.

---

## New file inventory

Concrete files this plan's implementation creates or modifies:

**New:**
- `skills/crew-iterate.body.md` — the body sketched in §"Skill
  body sketch" above.
- `docs/plans/active/crew-iterate-skill.md` — this plan (already
  created).

**Modified:**
- `src/install/skill-renderer.ts` — manifest support, renderSkill
  args generalization, new `ITERATE_SKILL_DESCRIPTION` constant.
- `src/install/hosts/types.ts` — `HostAdapter.skillPathFor` (or
  equivalent multi-skill path resolution).
- `src/install/hosts/claude-code.ts` — `skillPathFor` impl;
  nested path for sub-skills.
- `src/install/hosts/codex.ts` — same.
- `src/install/hosts/gemini.ts` — same.
- `src/install/install-manifest.ts` — schemaVersion bump,
  `skills` field shape, v1→v2 migration.
- `src/install/interactive-target.ts` (likely) — wherever the
  install command writes the skill file, loop over manifest.
- `src/cli/commands/verify.ts` (if it parses skill files) —
  union tool references across all skill files.

**Tests:**
- `test/install/skill-renderer.test.ts` (existing) — extend with
  manifest-iteration cases, two-skill render parity.
- `test/install/host-adapters.test.ts` (existing) — extend with
  per-host nested-path assertions.
- `test/install/install-manifest.test.ts` (existing) — v1→v2
  migration test.
- `test/skills/crew-iterate-body.test.ts` (NEW) — assert
  load-bearing phrases present (verdict labels, severity rubric,
  iteration cap, "always run inline review", etc.), mirroring
  any existing `crew-captain.body.md` content tests.

**Untouched:**
- `skills/crew-captain.body.md` — umbrella body unchanged (no
  cross-references added; iterate body references it by name,
  not by inline copy).
- `skills/targets/*.md.tmpl` — body-agnostic templates work
  unchanged.
- All `src/orchestrator/*` (no MCP wire surface changes).

---

## Edge cases

1. **Host matcher doesn't index nested sub-skills.** Per Open
   Question 2 + plumbing's risk note. Fallback: sibling-flat
   layout (`<host>/skills/crew-iterate/`). Discovered in Phase 1
   adapter probe; fallback wired before Phase 2 ships the body.

2. **Both reviewers fail to dispatch.** `run_panel` already
   handles this (records `failed_reviewers`, the rest still run).
   For 1+1 dispatch via plain `run_agent`, the dispatched-review
   call may fail — fall back to inline-only review for that
   round and tell the user. The loop still progresses.

3. **Implementer reaches `error` mid-iteration.** Treat as a
   BLOCKING verdict from the implementer itself. Surface to user
   with the error summary; ask for guidance. Do NOT auto-discard.

4. **Reviewer terminated with `partial` (truncated context, etc.).**
   Read what you can from `summary`; if the verdict line is
   missing, treat as `CHANGES_NEEDED` with the partial summary
   as the finding. Surface "reviewer truncated; verdict unclear"
   to the user before iterating.

5. **Tests fail intermittently mid-iteration.** The reviewer
   will record this as a CHANGES_NEEDED finding. If it persists
   across rounds (same flaky test in multiple verdicts), flag to
   user — don't iterate indefinitely on a flake.

6. **One APPROVE, one CHANGES_NEEDED.** Treat as CHANGES_NEEDED
   (conservative). Forward both verdicts to implementer so it
   sees the disagreement. If disagreement persists across 2
   rounds, flag to user. (Already covered in body, listed here
   for traceability.)

7. **User merges manually mid-iteration.** If the captain
   notices the implementer's branch already landed (via `git log`
   or because `merge_run` rejects with "branch already merged"),
   stop the loop and ask for guidance. Don't continue dispatching
   reviewers against a merged worktree.

8. **Watcher overlay missing on Claude Code.** Same as the
   umbrella body's fallback: discover newly-terminal runs via
   `list_runs` on the next user turn. The iterate loop adds a
   wrinkle: multiple reviewers may terminate near-simultaneously;
   `list_runs` returns all of them and the captain coalesces
   into a single verdict-collection pass.

9. **Sub-skill loaded without umbrella.** Per Open Question 6.
   Fallback: re-derive a minimal version of the umbrella's
   merge boundary + dispatch lifecycle inline at the top of the
   `crew:iterate` body. Cost: ~30 lines of duplicated prose. v1
   trusts co-load; Phase 3 verifies.

---

## Risks

1. **Skill renderer drift.** Generalizing `renderSkill` for N
   skills introduces a manifest-list of skills that can fall
   out of sync with the actual body files on disk (e.g., body
   file deleted, manifest entry stale). Mitigation: renderer
   throws clearly on missing body file; install command runs
   the full manifest at install time so missing files surface
   immediately.

2. **Captain skill body bloat.** Each new skill adds another
   ~300 lines of body content to the host's context window
   (when loaded). Two skills is fine; ten skills would be a
   problem. Mitigation: this plan ships exactly one new skill;
   future skill additions should cite this same plumbing and
   require a "why a new skill vs extending an existing one"
   justification.

3. **Auto-load matcher poaching.** `crew:iterate`'s description
   could accidentally trigger on cases the umbrella `crew` is
   the right load for, or vice versa. Mitigation: tuned
   descriptions (Phase 1 starts with conservative phrasing);
   Phase 3 dogfood validates; revisit if false-fire rate is
   high.

4. **Nested-skill-path host support uncertainty.** Per Open
   Question 2. Mitigation: empirical probe in Phase 1 before
   committing to the nested layout. If Codex or Gemini doesn't
   support it, fall back to flat layout (and document in this
   plan's update log).

5. **Install manifest v1→v2 migration breaks `uninstall` on a
   stale install.** Mitigation: v1 reader treats `skillPath` as
   `{crew: <path>}` and returns a v2-shaped result; uninstall
   loops over `skills` and removes all entries. Tested
   explicitly.

6. **Body-text rubrics encode current taste, not principles.**
   The "always do inline + dispatched" default is right TODAY; if
   a future captain product makes inline review free + instant +
   100% reliable, the rubric should update. Mitigation: body is
   a single file, easy to edit; Phase 3 dogfood will surface
   weak rubric phrasings.

7. **Iteration cap (3) is arbitrary.** Could be too tight for
   genuinely-converging-but-slow work, or too loose for flaky
   tests. Mitigation: Phase 3 dogfood. v2 may parameterize.

---

## Testing

**Phase 1 (renderer + install plumbing):**

- Unit: `renderSkill` returns expected output for each manifest
  entry. Body file substitution works. Description substitution
  works. Tool list substitution works. `CREW_WAIT_COMMAND`
  substitution works.
- Unit: `SKILL_MANIFEST` is well-formed (each entry has unique
  id, body file exists, description is non-empty).
- Unit: per-host `skillPathFor(home, skillId)` returns expected
  paths (snapshot-test the path strings; future host changes
  surface as test diffs).
- Unit: install-manifest v1 → v2 migration round-trips through a
  fixture v1 manifest, produces a v2 manifest with the existing
  `skillPath` mapped to `{crew: <path>}`.
- Integration: `crew-mcp install <host>` writes BOTH skill files
  to expected paths. `crew-mcp uninstall <host>` removes both.
  `crew-mcp verify` reports parity for both.
- Smoke (manual, Phase 1 exit gate): on a real Claude Code /
  Codex / Gemini install, verify each host LOADS both skills
  (e.g., umbrella's auto-load phrase fires; `crew:iterate`'s
  phrase fires when the user says "implement X with review").
  This is the empirical probe for Open Question 2.

**Phase 2 (body content):**

- Unit: `crew-iterate.body.md` contains load-bearing phrases —
  "verdict", "APPROVE / CHANGES_NEEDED / BLOCKING", "iteration
  cap", "always run inline review", "do not auto-merge". String
  search for each; failing the assert means the body lost a
  critical phrase.
- Unit: cross-references to the umbrella body are by NAME
  (e.g., "see umbrella `crew` skill's merge boundary"), not by
  inline duplication. Assert no copy-paste of umbrella-body
  paragraphs.
- Integration: render the body through the per-host templates;
  assert the rendered output parses as valid markdown +
  frontmatter (no broken YAML, no stray placeholders).

**Phase 3 (dogfood):**

- Pick a small in-flight task (~1 file, ~20 LOC). Use crew:iterate
  to drive it end-to-end. Verify:
  - The skill auto-loads on the implement-with-review phrase.
  - The captain follows the 4-step loop without re-derivation.
  - Reviewer dispatch uses the prompt template verbatim.
  - The aggregator hands findings back to implementer via
    `peer_messages`.
  - Both verdicts converge in ≤3 rounds OR the cap flags
    correctly.
- Capture any rubric-phrasing failures (where the captain picked
  the "wrong" default) and refine the body before merging
  Phase 3.

---

## Phasing

Small, bisect-friendly. Three phases; each lands on main before
the next starts.

### Phase 1 — renderer + install plumbing (~1d)

Goal: ship the multi-skill manifest, but with only the existing
umbrella `crew` skill in the manifest list (so behavior is
byte-identical to today). No new body content yet.

Touchpoints:
- `src/install/skill-renderer.ts` — `SkillManifestEntry`,
  `SKILL_MANIFEST` (single entry today), generalized
  `renderSkill`.
- `src/install/hosts/types.ts` + each adapter — `skillPathFor`.
- `src/install/install-manifest.ts` — v1→v2 migration.
- Install command — loop over manifest.
- All tests for the above.

Exit criteria: `crew-mcp install/uninstall/verify` round-trips
work byte-identical to pre-Phase-1 behavior. Renderer can
produce N skills given an N-entry manifest, but ships exactly
1 today.

### Phase 2 — add `crew:iterate` body (~0.75d)

Goal: ship the second skill's body content via the manifest.

Touchpoints:
- `skills/crew-iterate.body.md` — NEW file, content sketched in
  §"Skill body sketch" above.
- `src/install/skill-renderer.ts` — append second entry to
  `SKILL_MANIFEST`, add `ITERATE_SKILL_DESCRIPTION`.
- `test/skills/crew-iterate-body.test.ts` — NEW unit test for
  load-bearing phrases.

Exit criteria: `crew-mcp install <host>` writes both
`<host>/skills/crew/SKILL.md` AND
`<host>/skills/crew/iterate/SKILL.md` (or the resolved fallback
layout from Phase 1's probe). Empirical: on a real Claude Code
session, asking "implement X with review" auto-loads the
`crew:iterate` skill (visible in tool-result inspection or via
the host's skill-list panel).

### Phase 3 — dogfood + refine (~0.5–1d)

Goal: drive a real task end-to-end with `crew:iterate`; refine
rubrics + phrasings based on what the captain actually picks.

Process:
- Pick a contained task (1-file change, well-bounded).
- Run the loop. Capture every captain decision-point where the
  body's rubric was either silent, ambiguous, or wrong.
- Edit `skills/crew-iterate.body.md` to address each captured
  gap.
- Re-run on a second task to confirm fixes hold.

Exit criteria: two real tasks driven end-to-end via
`crew:iterate` with no captain re-derivation. Plan moves to
`docs/plans/completed/`.

---

## Future work (V2+)

- **Auto-size the panel.** Heuristic: number of changed files /
  changed concerns × reviewer count. v1 leaves this to the
  captain's judgment; a future skill version could surface "you
  changed auth + DB schema + UI — consider a 3-reviewer panel"
  as an explicit prompt.
- **Severity-weighted iteration count.** Iteration cap could be
  conditional on finding severity: BLOCKING / CRITICAL findings
  reset the round count; MINOR / NIT-only findings increment but
  hit the cap sooner. Bias the loop toward addressing the
  important stuff.
- **Reviewer ensemble memory.** Track which reviewer pairings
  produced the most converged-fast outcomes; suggest defaults
  per project. Crosses into preference-store territory; defer
  until the simple version proves out.
- **`crew:bisect` sibling skill.** Same plumbing pattern,
  different playbook (regression bisect via crew dispatches).
  Validates that the multi-skill plumbing scales beyond N=2.
- **In-skill rubric refinement loop.** Captain notes when the
  body's rubric was unclear; user-initiated `crew:refine-skill`
  command updates the body and re-installs. Probably overkill;
  the body is plain markdown and direct edits are fast.
- **Skill description A/B testing.** Different `description:`
  phrasings auto-load on different framings; metric is the
  user's "did the right skill load" judgment. Out of scope
  for v1.

---

## Update log

- **2026-05-14 v1 (this draft).** Initial design. Captures the
  pattern empirically used to ship `peer-messages-parameter` and
  `run-panel` this week. Three open questions (matcher
  auto-load, nested-path host support, iteration cap default)
  remain to resolve during Phase 1 / Phase 3 dogfood.
