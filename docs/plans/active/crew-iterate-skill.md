# `crew:iterate` skill — design plan (standalone)

**Status:** Draft v5 2026-05-16 — finalized post-Phase-0. The
empirical probes (see
[`crew-iterate-spike-findings.md`](./crew-iterate-spike-findings.md)
§"Probe results") invalidated v4.1's plugin-layout proposal for
Claude Code and produced a major simplification: **sibling-flat
personal-skills layout on all three hosts**. No plugin manifests,
no Claude/Codex migrations (current paths are canonical), only
Gemini relocates. Plan size shrunk substantially from v4.1.
Earlier drafts iterated through 3 panel-review rounds
(claude-code + codex, plumbing + body lenses) since v2. v4 closes the
remaining round-2 MAJORs: out-of-scope verdict rule, plugin manifest
plurality, lock staleness, criteria audit trail, N-A escape hatch.
Folds in
[`crew-iterate-spike-findings.md`](./crew-iterate-spike-findings.md)
(per-host layout resolution + co-load behavior) AND a refocus to
make **acceptance-criteria-driven iteration** the load-bearing
mechanic, not a side-rubric. Predecessor work: captain-to-worker
`peer_messages` parameter (shipped 2026-05-12, anchor commits
`bd14ebb1` → `e81688e1`) and the `run_panel` /
`get_panel_status` / `aggregate_panel` triad (shipped 2026-05-12,
anchor commits in `docs/plans/completed/run-panel.md`).

This plan defines a SECOND captain-facing skill — `crew:iterate` —
that turns crew into a **"keep working until acceptance criteria
pass"** orchestrator. Captain derives criteria up-front, user
confirms them, then captain pushes implementer + reviewers around
the loop until every criterion is PASS and every reviewer's overall
verdict is APPROVE. Pure orchestration playbook; nothing about the
MCP wire surface changes.

---

## The core promise (why this skill matters)

This skill is the answer to: *"I want Claude, Codex, Gemini, and
local models to keep working on something until the captain says
it's good."* It is the headline use case for crew — the thing that
makes a multi-agent MCP qualitatively different from one-shot
dispatch.

The mechanic is straightforward:

1. **Captain derives a set of acceptance criteria** from the user's
   request, surfaces them as a numbered checklist, and waits for
   user confirmation/edits before any dispatch.
2. **Criteria become the single source of truth** for the loop:
   they're embedded in the implementer's prompt, in every
   reviewer's prompt, and in the captain's stop condition.
3. **The loop keeps pushing** — implementer → reviewers → fold
   findings back → implementer — until every criterion scores
   PASS *and* every reviewer's overall verdict is APPROVE.
4. **Out-of-scope reviewer findings rule (single source of truth):**
   CRITICAL or MAJOR severity out-of-scope findings DO block
   convergence — the reviewer must verdict CHANGES_NEEDED on them
   (the template enforces this). The loop iterates until either
   the implementer addresses the finding OR the user explicitly
   accepts/defers it via the cap-or-revision options at the round
   limit. MINOR/NIT out-of-scope findings are suppressed at the
   reviewer template and never reach the captain.

Acceptance criteria are not aspirational. They are *the contract*
between user, captain, implementer, and reviewers. The loop is
mechanical: parse each reviewer's per-criterion score and overall
verdict; if all pass, ask the user to merge; if not, fold the
findings into `continue_run` and dispatch the reviewers again.

---

## At a glance

**What.** A second installable skill named `crew:iterate` shipping
alongside the existing top-level `crew` skill. Auto-loads on
"implement X with review", "keep working on X until …", "ship-
quality X", or any framing implying an iterate-to-convergence loop.
Teaches the captain a 5-step pattern (criteria → dispatch →
dual-review → iterate-or-converge → merge) plus three embedded
rubrics: criteria-derivation, inline-vs-dispatched review, and
1+1-vs-panel.

**Why.** Every session before this skill landed, the captain had to
re-discover (a) when to add a dispatched second opinion vs trust
the inline review, (b) when to escalate to `run_panel` vs stay 1+1,
(c) how to phrase the review prompt, and (d) the stop condition for
iteration. Even worse, the captain often dispatched WITHOUT deriving
acceptance criteria, leaving the reviewer to invent its own rubric
and the loop with no defined stop condition. Codifying criteria-
driven iteration as a skill removes the re-derivation tax and turns
"keep iterating until done" from vibes into a checkable contract.

**What this plan does NOT ship.**

- No new MCP tools. The skill composes existing verbs
  (`run_agent`, `continue_run`, `run_panel`, `aggregate_panel`,
  `get_run_status`, `merge_run`, `discard_run`).
- No automation of the loop (no "auto-iterate until APPROVE"
  daemon). The captain remains the orchestrator.
- No changes to the canonical body of the existing `crew` skill.
  This is purely an additive second skill body + the plumbing to
  ship two skills under one plugin namespace.
- No changes to the auto-approval logic beyond what's needed to
  write a second skill file. (Note: this plan DOES change the
  install manifest schema (v1→v2) and extends `verify` semantics
  to union tool references across skills and warn on known-broken
  v1 layouts. The earlier v2 draft's "no changes" claim here was
  inconsistent with the plumbing required by the spike findings;
  corrected 2026-05-16.)

**Cost.** ~2 days across 3 phases (down from ~3d in v4.1 after
Phase 0 simplified the install plumbing). Phase 1 (renderer +
install plumbing for N skills) is mostly bookkeeping plus the
Gemini relocation; Phase 2 (write the body) is prose with
embedded rubrics including the criteria-derivation and
criteria-scoring sections; Phase 3 is dogfood on a real task to
validate the rubrics and criteria flow.

Phase 0 probes (2026-05-16) eliminated the plugin-manifest
plumbing entirely: Claude Code's plugin discovery doesn't load
sideloaded plugins from `~/.claude/skills/` (requires marketplace
install), so the plan reverts to sibling-flat personal-skills
layout on all three hosts. Claude and Codex migrations are
pure-add (current v1 paths ARE the canonical paths). Only Gemini
relocates from `~/.gemini/extensions/crew/` (which Phase 0 probe
1 confirmed isn't loading anyway) to `~/.gemini/skills/`.

The iterate body still self-contains the load-bearing rules from
the umbrella because no host co-loads.

### One-direction flow (skill body's mental model)

```
USER: "keep working on X with Claude + Codex until it's good."
  |
  v
CAPTAIN (with crew:iterate loaded):
  |
  | 0. DERIVE ACCEPTANCE CRITERIA  <-- NEW: the contract
  |    Produce a numbered list of testable criteria from the
  |    user's request. Surface them: "Before I dispatch, here
  |    are the criteria I'll iterate against. Confirm or edit:
  |      1. <criterion>
  |      2. <criterion>
  |      ..."
  |    WAIT for user OK/edit. Do not dispatch on silence.
  |    Each criterion must be one of:
  |      - mechanical (test command exits 0 / lint passes /
  |        file X contains Y)
  |      - behavioral (reviewer can verify by reading the diff)
  |    Avoid vibes-only criteria ("looks clean", "is idiomatic")
  |    unless paired with a concrete signal.
  |
  | 1. DISPATCH IMPLEMENTER
  |    run_agent({agent_id: <impl>, prompt: "implement X",
  |               effort: <appropriate>,
  |               peer_messages: [{kind: "note",
  |                                from_label: "acceptance criteria",
  |                                body: <numbered criteria list>}]})
  |    -> run A (implementer worktree W_A)
  |    end turn; spawn watcher (Claude Code) or yield (Codex/Gemini)
  |
  | 2. DUAL-REVIEW (inline + dispatched, in parallel)
  |    Inline: read A.summary + diff, score each criterion + verdict.
  |    Dispatched: run_agent({agent_id: <reviewer>,
  |                            read_only: true,
  |                            working_directory: W_A,
  |                            peer_messages: [
  |                              {body: <acceptance criteria>,
  |                               kind: "note", from_label: "criteria"},
  |                              {body: A.summary, files: A.files_changed,
  |                               kind: "review", from_label: "implementer"}],
  |                            prompt: <REVIEW_PROMPT_TEMPLATE>})
  |    -> run R1 (read-only on W_A)
  |    (or run_panel for >1 dispatched reviewer)
  |
  | 3. ITERATE OR CONVERGE  <-- driven by criteria scoring
  |    Collect both reviewers' outputs. Each reports:
  |      - per-criterion score (PASS / FAIL / N-A)
  |      - overall verdict (APPROVE / CHANGES_NEEDED / BLOCKING)
  |      - findings list (incl. out-of-scope findings)
  |    Stop condition (all true):
  |      - every criterion scored PASS by every reviewer, AND
  |      - every reviewer's overall verdict is APPROVE.
  |    Otherwise: aggregate per-criterion FAILs + CHANGES_NEEDED
  |    findings into peer_messages and continue_run the implementer.
  |    Discard read-only reviewer runs, re-dispatch on new diff.
  |    Round cap: 3 (default) -> flag to user.
  |    Any BLOCKING verdict: stop, surface to user, ask.
  |
  | 4. MERGE
  |    Convergence (Step 3) guarantees no unresolved CRITICAL/MAJOR
  |    OOS findings — the reviewer template forced CHANGES_NEEDED
  |    on them. Step 4 only surfaces findings the user explicitly
  |    accepted/deferred at round-cap, or N-A scores the user
  |    accepted, recorded in commit_body.
  |    Ask user to merge with concrete commit_title / commit_body.
  |    On user OK: merge_run({run_id: A, confirmed: true,
  |                            commit_title: ..., commit_body: ...})
  |    Discard read-only reviewer runs (metadata cleanup, no
  |    user prompt — see invariant #1 carve-out).
```

---

## Goal

A captain in any host CLI (Claude Code, Codex, Gemini) that has
crew installed can say "keep working on X with review until it's
good" and get a default loop that:

0. **Derives acceptance criteria** from the user's request and
   confirms them with the user before any dispatch.
1. Dispatches the implementer with criteria embedded in
   `peer_messages`.
2. Sets up dual review (always inline; usually also one dispatched
   reviewer; sometimes a `run_panel`), with criteria embedded in
   each reviewer's prompt.
3. Collects per-criterion scores and overall verdicts; folds
   findings back via `peer_messages`; loops until criteria-pass +
   verdict-APPROVE convergence.
4. Surfaces any out-of-scope reviewer findings to the user, asks
   to merge; never auto-merges.

The captain follows this loop without the user having to teach it
each session, AND the captain can justify deviations from the
defaults using the embedded rubrics (not vibes).

## Non-goals

- **No "review-only" sub-skill** for code-review work that doesn't
  go through an implementer. The existing `pr-review-toolkit`
  family covers that; `crew:iterate` is for the
  implement-then-review loop specifically.
- **No auto-merge.** Skill body re-asserts the merge boundary:
  never call `merge_run` without explicit user approval.
- **No auto-discard of user-visible work.** Never `discard_run`
  the implementer run or any reviewer the user explicitly
  invested in without approval. **Carve-out:** read-only reviewer
  runs that have produced their findings are metadata cleanup —
  the captain may `discard_run` them automatically as part of the
  iterate cycle (see invariant #1 in the body). This carve-out
  exists because the loop accumulates 6–10 reviewer runs;
  per-cleanup user prompts would defeat chat-availability.
- **No new MCP verbs.** This is a skill-only change.
- **No changes to how the existing `crew` skill auto-loads.**
  Both skills must coexist; user's existing flows continue to
  trigger the umbrella `crew` skill.
- ~~No body-content duplication.~~ **REVERSED 2026-05-16.** The
  spike findings prove no host co-loads the umbrella body, so the
  iterate body MUST self-contain its safety invariants. Duplication
  is now a design requirement, not an anti-goal. The drift risk
  (umbrella rule changes don't propagate) is mitigated by a
  single-source-of-truth invariant block generated at render time
  (see §Plumbing changes).
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
   `crew:iterate` description leads with "keep iterating until
   acceptance criteria pass", "implement-then-review", "ship-quality
   loop"; umbrella `crew` stays on "dispatch coding work". Test in
   Phase 3.

2. ~~Sub-skill path layout per host.~~ **RESOLVED 2026-05-16** by
   the Phase 0 empirical probes. Sibling-flat personal-skills
   layout on all three hosts; no plugin manifests; trigger names
   converge to `crew-iterate`. See §"Per-host skill layout
   (Phase 0 resolved)" above and the spike findings for evidence.

3. **Iteration cap.** Default cap = 3 rounds before flagging to the
   user. Tradeoff: a higher cap risks looping indefinitely on flaky
   tests / disagreeing reviewers / criteria that can't actually be
   met; a lower cap risks bailing on legitimately-converging work.
   v1 picks 3; Phase 3 dogfood may reveal a better number. **New
   consideration with criteria:** if the user accepts the captain's
   criteria, the cap exists to surface "these criteria look hard to
   meet — should we revise them?" rather than a generic
   "convergence failed" message.

4. **What counts as "non-trivial work" for the inline-vs-dispatched
   rubric?** Below the threshold, only inline review runs. Today's
   weak proxy: "≥1 production-code file changed AND ≥10 lines
   modified." Better signals welcome — open for v1 to refine.
   Acceptance criteria *might* be a better signal: if any criterion
   is "tests pass" or "lint passes", a dispatched reviewer earns
   its keep.

5. **Reviewer effort default.** v1: reviewer dispatches use the
   same `effort` as the implementer. Alternative: reviewer
   defaults to `high` regardless (review is cheaper than
   implementation; spending more on review than on the implementer
   is fine). Decision: default to mirroring implementer; let the
   user override.

6. ~~Should `crew:iterate` reference `crew-captain.body.md`
   explicitly?~~ **RESOLVED 2026-05-14** by the spike findings: NO
   host co-loads the umbrella body. Take option (a): duplicate the
   load-bearing rules (escape hatch, merge boundary, dispatch
   lifecycle) at the top of the iterate body. Cost ~30 lines.
   Phrased as "this skill is independent of the umbrella `crew`
   body; the following safety invariants are restated here so it
   works standalone."

7. **Criteria-derivation rubric.** How does the captain decide
   what makes a "good" set of criteria? Working principles for v1:
   (a) every criterion must be testable by either a mechanical
   signal (test command, lint, file content) or a reviewer's read
   of the diff; (b) avoid pure-vibes criteria ("looks clean",
   "feels idiomatic") unless paired with a concrete signal; (c)
   include at least one "doesn't break X" criterion when the
   change touches load-bearing code; (d) 3–7 criteria typical, >10
   suggests the task is too broad. Test in Phase 3.

8. **Criteria revision mid-loop.** What if, after round 1, it's
   clear a criterion was malformed or impossible? Default: captain
   flags to user, proposes a revision, waits for confirmation
   before continuing. Do NOT silently mutate the criteria; the
   user-confirmed criteria are the contract. Open: does this
   handshake also trip on minor wording fixes ("PASS this
   criterion if X OR Y")? v1 says yes — any criterion change
   requires re-confirmation.

9. **Per-criterion reviewer scoring format.** Each reviewer must
   return a score per criterion (PASS / FAIL / N-A) plus an overall
   verdict. The captain parses this. Format: structured markdown
   under a `## Criteria scoring` heading, one line per criterion,
   format `- [n] CRIT-LABEL: PASS|FAIL|N-A — <one-line reason>`.
   Reviewers that fail to produce this section get treated as
   CHANGES_NEEDED with a finding "reviewer omitted criteria
   scoring section". Open: are reviewer models reliable at this
   level of output discipline? Phase 3 measures.

---

## Per-host skill layout (Phase 0 resolved 2026-05-16)

Phase 0 empirical probes (see
[`crew-iterate-spike-findings.md`](./crew-iterate-spike-findings.md)
§"Probe results") established that the only viable cross-host
layout is **sibling-flat personal-skills**. Plugin layouts are
unviable on Claude Code (which requires marketplace install for
plugin discovery; sideloaded plugin layouts under `~/.claude/skills/`
are silently ignored) and unnecessary for Codex (whose 6-deep BFS
also discovers personal-skill files at the root). Gemini's
user-skills tier is sibling-flat by design.

### Canonical layout (all three hosts)

| Host | Umbrella `crew` | Sub-skill `crew-iterate` | Frontmatter `name:` | Slash trigger |
| --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/skills/crew/SKILL.md` | `~/.claude/skills/crew-iterate/SKILL.md` | `crew` / `crew-iterate` | `/crew`, `/crew-iterate` |
| Codex | `~/.codex/skills/crew/SKILL.md` | `~/.codex/skills/crew-iterate/SKILL.md` | `crew` / `crew-iterate` | `crew`, `crew-iterate` |
| Gemini | `~/.gemini/skills/crew/SKILL.md` | `~/.gemini/skills/crew-iterate/SKILL.md` | `crew` / `crew-iterate` | `crew-iterate` |

Notes:
- The current v1 Claude install at `~/.claude/skills/crew/SKILL.md`
  IS already the canonical Phase 1 location. Only the new
  `crew-iterate/SKILL.md` sibling is added.
- Codex same story: `~/.codex/skills/crew/SKILL.md` is canonical;
  only the new sibling is added.
- Gemini relocates from `~/.gemini/extensions/crew/SKILL.md`
  (which Phase 0 probe 1 confirmed is not loading today — the
  `gemini` CLI logs `Warning: Skipping extension ... Configuration
  file not found at .../gemini-extension.json`) to
  `~/.gemini/skills/crew/SKILL.md`.

### Cross-host trigger-name note

The slash trigger has trivial divergence — Claude prepends `/`,
Codex/Gemini don't:
- Claude Code: `/crew-iterate`
- Codex: `crew-iterate`
- Gemini: `crew-iterate`

All three use the same `name: crew-iterate` frontmatter; the
auto-load `description:` text drives loading, not slash names.
The body documents the slash prefix difference in one line.

### Phase 0 outcomes (informational; closes prior open questions)

Phase 0 ran 8 probes on 2026-05-16. Summary:

- Probe 1 (Gemini current-install): **FAIL** — empirical
  `gemini -p` shows `Warning: Skipping extension ... gemini-extension.json
  not found`. Relocation is pure improvement.
- Probe 2 (Claude plugin-layout multi-skill): **FAIL** on Claude
  empirically — plugin layouts sideloaded under
  `~/.claude/skills/` are silently ignored. **PASS on Codex**
  empirically.
- Probe 3 (Claude sibling-flat fallback): **PASS**.
- Probe 4 (Codex sibling-flat fallback): **PASS**.
- Probe 5 (Gemini extension convention): **PASS** by source.
- Probe 6 (Claude plugin min-fields): **N/A** for Claude (moot
  given Probe 2); **PASS for all field-set variants on Codex
  including empty `{}` manifest**.
- Probe 7 (Codex v1/v2 plugin/personal coexistence): **double-load
  confirmed** (different names; v1 personal-root and v2 namespaced
  both appear). N/A with sibling-flat layout since no plugin
  manifest is written.
- Probe 8 (Claude v1/v2 coexistence): **v2 plugin path never
  registers; only v1 personal-skill loads**. With sibling-flat
  Phase 1, no migration needed on Claude.

Full evidence, source references, and Phase 1 implications are
in
[`crew-iterate-spike-findings.md`](./crew-iterate-spike-findings.md)
§"Probe results" and §"Next steps for Phase 1".

---

## Skill body sketch — `crew:iterate`

This is the body content (`skills/crew-iterate.body.md`) the
implementation will ship in Phase 2. Stripped of HTML-comment
metadata at render time, same as `skills/crew-captain.body.md`.

### Auto-load description (frontmatter)

All three hosts use the same frontmatter (Phase 0 collapsed the
per-host divergence):

```yaml
name: crew-iterate
description: |
  Keep iterating on an implementation until acceptance criteria
  pass and reviewers approve. Loads when the user wants to
  ship-quality something via a multi-agent loop — phrasings like
  "keep working on X with review", "implement X and review until
  it's good", "iterate to convergence", "ship-quality loop",
  "use Claude + Codex to push this until criteria pass". The
  captain derives acceptance criteria, confirms with the user,
  dispatches an implementer with criteria embedded, runs dual
  review (inline + dispatched) scoring per criterion, and folds
  findings back via continue_run until every criterion is PASS
  and every reviewer's overall verdict is APPROVE. Composes
  run_agent, continue_run, run_panel, aggregate_panel, merge_run.
```

#### Preamble — standalone safety invariants

This skill is independent of the umbrella `crew` body. Because no
host co-loads the umbrella, the following safety invariants are
restated here so iterate works standalone. (Spike finding
2026-05-14: Claude Code, Codex, and Gemini all keep skill bodies
out of context until the specific skill activates.) These
invariants are the load-bearing rules every iterate captain must
hold; deviating from them breaks the contract with the user.

**1. Merge boundary.** Never call `merge_run` without explicit
user affirmative. Surface a concrete merge prompt with the
proposed commit title and body; act only on explicit "yes / go /
merge" or similar. Silence is not consent.

`discard_run` has a narrower rule: explicit user affirmative is
required for the IMPLEMENTER run (discarding their work is
destructive) AND for any reviewer the user explicitly invested in
(e.g., "make codex review this"). However, **read-only reviewer
runs that have already produced their findings are metadata
cleanup** — the captain may `discard_run` them automatically as
part of the iterate cycle (see invariant #7). This carve-out
exists because the iterate loop accumulates 6–10 reviewer runs;
requiring a user prompt for each cleanup defeats the
chat-available default.

**2. Dispatch lifecycle (do NOT long-poll).** After `run_agent` /
`continue_run` / `run_panel`, do NOT long-poll `get_run_status`
in-turn. Confirm dispatch with the inline `tail_url` markdown, end
the turn, and:
- Claude Code: `Bash({{CREW_WAIT_COMMAND}} <run_id>, run_in_background: true)`
  to spawn the watcher. The host will fire a synthetic next-turn
  with prefix `CREW_WAIT_TERMINAL run_id=... status=...
  worktree=...` when the run reaches terminal. **Parse that line
  on receipt** to discover which run terminated, then call
  `get_run_status({run_id})` for the full envelope. Without this,
  the loop deadlocks: the captain dispatched and ended the turn
  but never recognizes the synthetic resume.
- Codex / Gemini: no watcher. Discover terminal runs on the next
  user turn via `list_runs({status: ["success","partial","error"]})`
  or by snapshotting specific run_ids.

**Iterate-specific: never use the foreground-wait opt-in.** Unlike
one-shot dispatches in the umbrella body (which may sometimes opt
into `get_run_status({wait_for_terminal_only: true, ...})`),
iterate runs MUST NOT use the foreground-wait params. The loop
accumulates 6–10 dispatches; turn-blocking on any of them defeats
the chat-available default and surfaces a stuck captain to the
user.

**3. Escape hatch.** If the user says "stop", "cancel", "abandon",
"discard", "pause", at any point in the loop: stop dispatching new
runs, `cancel_run` any in-flight runs they name, and ask whether
to discard or keep their worktrees. The escape hatch wins over any
in-flight iteration round.

**4. Tool availability & agent picking.** Before dispatching any
new agent, call `list_agents` to confirm availability (the agent
may be unauthenticated, rate-limited, or unavailable). If
`available: false`, surface the reason to the user and ask for an
alternative. Do not retry dispatch silently. Do not invent an
`agent_id` not present in `list_agents`.

**5. Do NOT dispatch to your own host product.** If you are
running on Claude Code, do not dispatch `claude-code` as an
implementer or reviewer (use the host's native subagents for that
instead). Same rule for Codex on Codex, Gemini on Gemini. Crew is
for *cross-product* delegation; same-host dispatch via crew loses
the heterogeneity that makes review valuable AND can cause
nested-session resource conflicts.

**6. Never shell out to `crew-mcp` directly.** Use the MCP tool
surface (`mcp__crew__*`). Do not call the `crew-mcp` binary via
Bash; the MCP server is the authoritative interface and shelling
out bypasses dispatch tracking, watcher registration, and worktree
allocation.

**7. Read-only reviewer dispatches do not auto-clean.** After a
reviewer's read-only run terminates, you must explicitly
`discard_run` it (or `merge_run`, which is not the right verb for
review-only). Iteration rounds accumulate read-only runs;
forgetting to discard them leaves clutter in `list_runs` output.

**8. Ask the user before dispatching on ambiguity.** If the user's
request is ambiguous (scope unclear, multiple plausible
interpretations, multiple criteria sets possible), ask before any
dispatch. Step 0 (criteria derivation) is the natural disambiguation
gate — derive criteria, surface them, wait for user confirmation
**(silence is not consent)**.

(End preamble. The rest of this body is the iterate-specific
playbook. If any of these invariants conflicts with later
instructions, the invariants win.)

#### When to use this skill (vs the umbrella `crew` skill alone)

Use `crew:iterate` when ANY of the following hold:

- The user wants an implementation that should reach "ship quality"
  — they used words like "review", "iterate", "until good", "keep
  working", "ship-ready".
- The user wants multiple agents (Claude + Codex + …) to push on
  something until criteria pass.
- The change should land via `merge_run` once it converges.

Fall back to umbrella `crew` semantics when:

- The user is dispatching a one-shot agent run with no review
  expected.
- The work is review-only on existing code (no implementer).
- The user explicitly says "no review, just implement" — then
  follow the umbrella's normal flow.

When in doubt: ask. "Do you want me to iterate this until review
passes, or just dispatch once?"

**Cross-host invocation note.** All hosts use the same skill name
`crew-iterate`; only the slash prefix differs:
- Claude Code: `/crew-iterate`
- Codex: `crew-iterate` (mention or natural-language match)
- Gemini: `crew-iterate`

The auto-load `description:` fires on phrasing in any host, so
explicit invocation matters mainly for discoverability.

#### The 5-step loop

##### Step 0 — Derive and confirm acceptance criteria

**This step is mandatory. Do not skip it. Do not dispatch without
user-confirmed criteria.** Acceptance criteria are the contract for
every downstream step — the implementer prompt, the reviewer
prompt, and the loop's stop condition all reference them. If you
skip this step, you have no defined "done".

Read the user's request. Derive 3–7 criteria. Each criterion must
be tagged with a TYPE label that the captain uses downstream to
enforce evidence requirements:

- **`[M]` Mechanical**: a test command, lint check, file content
  assertion, or build step that produces a binary signal. Example:
  `[M] pnpm test src/install/skill-renderer.test.ts exits 0`.
- **`[B]` Behavioral**: a property a reviewer can verify by reading
  the diff. Example: `[B] the new SKILL_MANIFEST type has unique
  ids and each bodyFile is present on disk`.
- **`[N]` Negative**: a "doesn't break X" clause for load-bearing
  code the change touches. Example: `[N] existing v1
  install-manifest fixtures still parse via the v1→v2 migration
  path`.

The `[M]` / `[B]` / `[N]` tags are MANDATORY. They make the
mechanical-evidence rule (Step 3) machine-checkable from reviewer
output alone — a reviewer scoring `[M] PASS` without citing
command + exit code or file:line + content is automatically
flagged as malformed.

Avoid pure-vibes criteria ("looks idiomatic", "feels clean") unless
paired with a concrete signal. Avoid criteria the reviewer can't
check from the diff alone (don't say "performance regresses by
<5%" unless you also dispatch a benchmark).

Surface criteria to the user verbatim:

> Before I dispatch, here are the acceptance criteria I'll iterate
> against (`[M]` mechanical, `[B]` behavioral, `[N]` negative):
> 1. [M] <criterion 1>
> 2. [B] <criterion 2>
> 3. [N] <criterion 3>
> …
>
> Confirm, edit, or add criteria. I'll dispatch once you OK.

Wait for the user to OK or edit. Silence is NOT consent at this
step. If the user edits, restate the final list and ask again. The
final list becomes the **user-confirmed criteria** — the contract
for all downstream prompts.

**Captain audit-trail rule: include the user-confirmed criteria
block VERBATIM in every downstream prompt.** Implementer prompt,
reviewer prompts, continue_run prompts, and the merge surfacing
all carry the same block, prefixed with:

```
## User-confirmed acceptance criteria (Step 0)
1. [M] <criterion>
2. [B] <criterion>
...
```

This prevents the captain from drifting / fabricating criteria
post-Step-0. The reviewer template requires this block in
`peer_messages`; if it's missing or contents drift from a prior
round's block, the reviewer flags it (see template § "Audit
check").

**Criteria revision mid-loop (new-epoch rule).** If a later round
reveals a criterion is malformed or impossible:

1. **Stop dispatching.** Cancel any in-flight reviewer runs (they
   were scoring against the old criteria). If the implementer has
   an in-flight `continue_run` working against stale criteria,
   either cancel and re-dispatch with revised criteria, or wait
   for the in-flight to terminate and then `continue_run` with
   revised criteria carried in `peer_messages`.
2. **Flag to user.** Propose the revision. Wait for confirmation.
   Silence is not consent.
3. **Invalidate prior PASSes.** After the user approves a revision,
   all prior reviewer scores on the revised criterion are stale
   and MUST NOT be carried forward. The next round must re-score
   the FULL revised criteria list; reviewers in the next round get
   the full revised list in peer_messages with a note "criteria
   were revised; previous scores are invalid; rescore everything."
4. **Start a new loop epoch.** The revised criteria define a fresh
   epoch with its own round counter starting at 0. The total
   number of rounds across all epochs is bounded by an
   **epoch-aware safety cap** (e.g., 9 rounds total, no more than
   3 in any single epoch). This prevents both (a) the unfair
   cap-out where a revision happens at round 3 and the user
   immediately hits cap on the next round, AND (b) infinite
   revisions becoming a perpetual-motion machine.

What counts as a "revision": any change that alters a criterion's
testable predicate. Pure wording clarifications that preserve the
predicate (typo fixes, rephrasing without changing what passes)
can be applied unilaterally with a one-line note to the user;
prior PASSes remain valid; counter does not reset.

##### Step 1 — Dispatch implementer

```
run_agent({
  agent_id: <implementer>,
  prompt: <precise task description including acceptance criteria>,
  effort: <one level higher than for raw implementation>,
  peer_messages: [
    {
      body: <numbered acceptance criteria list, verbatim from Step 0>,
      kind: "note",
      from_label: "acceptance criteria"
    }
  ]
})
```

Hand-off responsibilities:

- The implementer's prompt MUST restate the criteria (don't rely on
  `peer_messages` alone — restate inline). Models comply with
  criteria they read in-line more reliably than criteria buried in
  peer-message history.
- Pick `effort` one level higher than for a raw implementation
  (clamped at `max`) — review catches mid-effort regressions but
  can't recover from a low-effort foundation.
- Pick the implementer agent by skill match. Heuristic: if criteria
  are mostly mechanical (tests pass, lint clean), Codex's
  fast-iteration profile wins; if criteria are mostly behavioral
  (design judgment, readability), Claude Code's careful-reasoning
  profile wins. Mixed criteria default to Codex with Claude as
  reviewer (or vice versa) so heterogeneity shows up at the review
  step.
- Confirm dispatch with `[tail in side terminal](<tail_url>)`,
  end turn, spawn the watcher on Claude Code.

##### Step 2 — Dual-review (inline + dispatched, parallel)

When the implementer reaches terminal, ALWAYS run two reviews. Both
review against the SAME acceptance criteria from Step 0.

**(a) Inline review (mandatory, free).** Read `A.summary`,
`A.files_changed`, and the diff (`get_run_status` returns enough
for a sketch; the full diff is available via the worktree path).
Score each criterion (PASS / FAIL / N-A) plus an overall verdict
using the SAME schema the dispatched reviewer uses below. Inline
review costs zero MCP round-trips and sees the full diff in your
context window.

**(b) Dispatched review (default-on; see rubric for skip).** Pick
one or more reviewer agents from `list_agents` (different model
than the implementer when possible — heterogeneity surfaces
different bugs). Dispatch with criteria in peer_messages:

```
run_agent({
  agent_id: <reviewer>,
  read_only: true,
  working_directory: <A.worktree_path>,
  peer_messages: [
    { body: <acceptance criteria>, kind: "note",
      from_label: "acceptance criteria" },
    { body: A.summary, files: A.files_changed,
      kind: "review", from_label: "implementer" }
  ],
  prompt: <REVIEW_PROMPT_TEMPLATE — see below>
})
```

The dispatched reviewer gets a fresh context window AND applies a
different model's strengths. Critically: they score the SAME
criteria the user confirmed in Step 0.

When to skip the dispatched reviewer (inline-only):

- The user said "no review" out loud.
- Typo / comment / pure-doc commit (<10 LOC, no production-code
  changes) AND all criteria are behavioral (no mechanical
  signals).

**Always review on `partial` / `error`.** When the implementer
terminates with `partial` or `error`, the reviewer's read often
diagnoses why the implementer stalled — that's diagnostic signal
worth $0.01 even when the captain plans to route the run back to
the user. (Earlier draft phrased this as a skip rule; corrected
2026-05-16 per round-2 review.)

**Always dispatch (override skip) when:** any criterion is
mechanical (a test command, lint check, file content assertion,
build step). The dispatched reviewer can actually run the
mechanical check from the worktree, which the captain can't do
reliably from inline reading alone. Criteria type is a stronger
signal than diff size for whether a dispatched reviewer earns
its keep.

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
worktree path). The implementer's own summary and the acceptance
criteria are included in peer_messages above.

Your job has TWO parts:

PART 1 — Score every acceptance criterion. For each numbered
criterion the captain gave you in peer_messages, decide:

  PASS  — the change meets this criterion. State why in 1 line.
          For MECHANICAL criteria (test command, lint, file
          content), you MUST cite the evidence: the command you
          ran AND its exit code, or the file:line you read AND
          what it said. "PASS — tests pass" without evidence is
          treated as FAIL by the captain.
  FAIL  — the change does not meet this criterion. State the
          gap in 1-2 lines, cite file:line where relevant.
  N-A   — the criterion truly does not apply to this diff
          (extremely rare). Say why. The captain treats N-A as
          equivalent to PASS for the stop condition, but flags
          it to the user — multiple N-A scores across rounds
          suggest the criterion was malformed.

PART 2 — Produce an overall verdict:

  APPROVE        — every criterion is PASS (or N-A) and you have
                   no CRITICAL/MAJOR out-of-scope concerns.
  CHANGES_NEEDED — at least one criterion FAILs, OR you have
                   one or more CRITICAL/MAJOR out-of-scope
                   findings.
  BLOCKING       — the approach itself is wrong; criteria can't
                   be made to pass without a rethink.

Out-of-scope rule (single source of truth, do not improvise):
- CRITICAL or MAJOR severity out-of-scope finding → set Verdict to
  CHANGES_NEEDED (or BLOCKING if the issue is foundational).
- MINOR or NIT severity out-of-scope finding → omit from Findings
  entirely unless the captain asked for them explicitly. Do NOT
  let MINOR out-of-scope concerns affect Verdict.

Output format (mandatory, strict):

  ## Criteria scoring
  - [1] <verbatim criterion label>: PASS|FAIL|N-A — <one-line reason with evidence for mechanical PASS>
  - [2] <verbatim criterion label>: PASS|FAIL|N-A — <one-line reason>
  - ... one line per criterion, in the order the captain listed them.

  ## Verdict: <APPROVE | CHANGES_NEEDED | BLOCKING>

Worked example (illustrative; replace with your actual scoring):

  ## Criteria scoring
  - [1] `pnpm test src/install/skill-renderer.test.ts` exits 0: PASS — ran command, exit code 0, 47 tests passing.
  - [2] SKILL_MANIFEST has unique ids: PASS — read src/install/skill-renderer.ts:42; entries are 'crew' and 'iterate', no duplicates.
  - [3] No regression in v1 manifest parsing: FAIL — test/install/install-manifest.test.ts:118 throws on v1 fixture; the v1→v2 migration path is not implemented at install-manifest.ts:55.

  ## Verdict: CHANGES_NEEDED

  ## Findings
  - [SEVERITY] <one-line finding>: <2-3 sentence justification>
    Criterion: <criterion number if tied to one, else "out-of-scope">
    File: <path>:<line-range or "N/A">
    Recommendation: <concrete action>

  ## Recommended action
  <one paragraph: what should the implementer do next? Anchor
  recommendations to the failing criteria first; CRITICAL/MAJOR
  out-of-scope suggestions go last.>

Severity rubric (umbrella standard):
  CRITICAL — correctness bug, security flaw, data loss risk.
  MAJOR    — non-trivial design issue that will compound.
  MINOR    — style, naming, comment quality.
  NIT      — taste, optional polish.

Score-vs-finding consistency rule: if you score criterion N as PASS,
you MUST NOT file a Finding with `Criterion: N`. If your PASS has
caveats, downgrade to FAIL and state the gap. The captain treats
PASS+Criterion-N-finding as a malformed score (re-dispatch).

Do not edit files. If you find yourself wanting to write,
describe the edit instead — you are read-only by design.

If you cannot find the criteria in peer_messages: STOP. Do not
produce a verdict. Reply with "no criteria provided; cannot
score" — the captain skipped Step 0 and needs to fix that first.

Audit check (cross-round): if peer_messages contains a prior
round's `## User-confirmed acceptance criteria (Step 0)` block AND
the current round's block has different content (other than a
documented unilateral clarification, see Step 0 revision rule),
STOP. Reply with "criteria drift detected; previous and current
blocks differ" — the captain may have silently mutated criteria
without re-confirmation. This protects against post-hoc
fabrication.
```

Substitute `${implementer_label}` and `${target_repo}` per
dispatch. Reviewer specialty is no longer in the template —
specialty-specific concerns belong inside the acceptance criteria
themselves (Step 0). If the user wants a security-lens reviewer,
they should have a "no new security exposure on auth handlers"
criterion.

##### Step 3 — Iterate or converge

Once both verdicts are in (inline + dispatched, or inline + panel
aggregate), parse the criteria scoring + overall verdict from each
reviewer's output. The stop condition is mechanical:

**Converged (go to Step 4).** ALL of:
- every criterion is scored PASS by every reviewer, OR N-A by
  every reviewer **with explicit user acceptance** (see N-A guard
  below — N-A is not free); no FAILs, no unscored, no malformed
  scoring sections, no PASS-with-Criterion-N-finding
  contradictions,
- every reviewer's overall verdict is APPROVE.

Because the reviewer template forces CRITICAL/MAJOR out-of-scope
findings into CHANGES_NEEDED, an APPROVE verdict is sufficient
evidence that no unresolved CRITICAL/MAJOR out-of-scope concerns
exist. MINOR/NIT out-of-scope findings are suppressed at the
template and never reach Step 3 (verify this by scanning the
reviewer's Findings section; if you see a MINOR/NIT out-of-scope
finding, treat the reviewer as malformed and re-dispatch).

**Step 4 only handles out-of-scope findings the user explicitly
accepted or deferred** at the round-cap or via a criteria-revision
prompt. Out-of-scope findings never "leak past" convergence
silently.

**Iterate (run another round).** ANY of:
- one or more criteria scored FAIL by any reviewer, OR
- one or more reviewer overall verdicts is CHANGES_NEEDED (which
  means either a FAIL or a CRITICAL/MAJOR out-of-scope finding).

**Malformed reviewer output — re-dispatch the REVIEWER, not the
implementer.** If a reviewer's output is missing the structured
`## Criteria scoring` section, contains a PASS score with a
corresponding `Criterion: N` finding (score-vs-finding
contradiction), or skipped criteria the captain provided, the
fault is with the reviewer, NOT the implementer. Do NOT route this
to `continue_run`; the implementer can't fix a reviewer's output.
Instead:
1. Cancel/discard the malformed reviewer's run.
2. Re-dispatch the same reviewer with `peer_messages` including
   the original criteria PLUS a note: "Your previous output was
   malformed (missing scoring section / score contradicted
   finding / criteria skipped). Re-review the same diff at
   <worktree_path> and produce the required structured output
   per the template."
3. If a reviewer fails the structural check twice, replace the
   reviewer with a different agent and flag to user.

**Special case: reviewer replies "no criteria provided; cannot
score".** The fault is the captain — Step 0 was skipped or the
criteria block was dropped from `peer_messages`. Do NOT re-dispatch
the reviewer. Instead: re-derive Step 0 criteria with the user
(running through the full criteria-derivation rubric), then
re-dispatch with the user-confirmed block.

**Special case: reviewer replies "criteria drift detected".** A
prior round's criteria block differs from the current round's
without a documented revision. Treat as a captain audit failure:
stop, surface to user, re-confirm the canonical criteria list,
and resume with the correct block.

**Mechanical-PASS without evidence — treat as FAIL.** If a
reviewer scores a mechanical criterion (test command, lint, file
content) PASS without citing the evidence the template requires
(command + exit code, or file:line + content), treat the criterion
as FAIL. The implementer doesn't need to fix anything; the
reviewer needs to re-run with evidence. Follow the malformed-output
re-dispatch path above.

**N-A scoring guard (user-confirmation gate).** N-A is the escape
hatch a lazy reviewer can use to skip hard criteria — if treated
as silent PASS, a reviewer could N-A every difficult criterion and
produce a structurally valid APPROVE. The guard:

- **If ANY reviewer scores N-A on ANY criterion**, the captain
  MUST NOT silently treat it as PASS-for-convergence. Instead,
  before Step 4 surfacing or any merge prompt:
  - Surface to the user: "Reviewer X scored criterion N as N-A:
    '<reason>'. The reviewer claims this criterion does not apply
    to this diff. Accept N-A (treat as PASS), revise the
    criterion, override (treat as FAIL and continue iterating),
    or hand off?"
  - Wait for explicit user choice. Silence is not consent.
- Treat N-A as malformed if the reviewer gave no reason or the
  reason is generic ("not applicable" without specifics) — follow
  the malformed-output re-dispatch path.
- **Multiple N-A guard.** ≥2 N-A scores on the same criterion
  across rounds, OR ≥3 N-A scores spanning different criteria in
  one round, force a criteria-revision prompt (the criteria are
  likely malformed). Do NOT accept silent.

This guard is what prevents the lazy-reviewer escape hatch. Do
not soften it; do not skip the user prompt because the N-A
"looks reasonable."

**Iterate path (criteria FAIL or CHANGES_NEEDED verdict).**
Aggregate the FAILing criteria and CHANGES_NEEDED findings into
`peer_messages` and `continue_run` the implementer:

```
continue_run({
  run_id: A,
  peer_messages: [
    { body: <acceptance criteria>, kind: "note",
      from_label: "acceptance criteria (unchanged)" },
    { body: <inline review's failing criteria + findings>,
      kind: "review", from_label: "captain inline review" },
    { body: <dispatched review's failing criteria + findings>,
      kind: "review", from_label: "${reviewer_agent_id} review",
      files: dispatched_review.files_changed },
    // one per reviewer if panel
  ],
  prompt: "Address these review findings. Specifically, make the
           FAILing criteria PASS. Reply with a brief summary of
           what changed and which criteria you believe now pass."
})
```

For panels, call `aggregate_panel({panel_id})` and pass the result
as `peer_messages` (also re-pass the criteria peer-message).

After `continue_run` reaches terminal, **discard the read-only
reviewer runs** (they don't auto-clean) and re-dispatch the same
reviewers against the new diff. Round count increments by 1.

**BLOCKING verdict (stop the loop).** Any reviewer's overall
verdict of BLOCKING — typically meaning "criteria can't be made to
pass without a rethink." Surface to user with the reviewer's
`Recommended action`. Ask: "rethink the approach, revise the
criteria, discard, or continue anyway?" Do NOT silently
continue-run on BLOCKING.

**Iteration cap reached (default 3 rounds per epoch; 9 total).**
Reframe with criteria context: "We've iterated 3 rounds in this
epoch; criteria still failing: [2, 4]. The implementer may need
different criteria, a different agent, or human help. Options:
- Revise criteria → starts a new epoch with fresh round counter
  (subject to the 9-round total cap; epoch-aware).
- Switch implementer → continues the current epoch with a new
  agent.
- Accept the failing finding(s) and merge → carries them into
  Step 4 as user-accepted/deferred (recorded in commit body).
- Hand off → captain stops dispatching; user takes over."
The cap exists to surface "maybe the criteria are wrong" as a
hypothesis, not just "convergence failed". The epoch-aware total
cap (9 rounds default) prevents endless revisions.

**Reviewer disagreement (one says PASS on criterion N, other says
FAIL).** Treat the criterion as FAIL (conservative). Forward both
reviewers' reasoning to the implementer so it sees the
disagreement explicitly. If the disagreement persists across two
rounds on the same criterion, flag to user — the criterion may be
ambiguous and need revision.

(Reviewer-malformed-output is covered above under "Malformed
reviewer output — re-dispatch the REVIEWER". Do NOT silently fill
in scores from the prose; the structured section is load-bearing
for the loop's machine-checkable stop condition.)

##### Step 4 — Merge

Once converged (all criteria PASS + all verdicts APPROVE), the
captain hands off to the user.

**Step 4 receives a clean convergence.** Because the template
forces CRITICAL/MAJOR out-of-scope findings into CHANGES_NEEDED
verdicts (and the captain re-dispatches malformed reviewers),
Step 4 should not normally receive any unresolved out-of-scope
findings.

**Two cases that DO reach Step 4 with out-of-scope findings:**

1. **User accepted/deferred at round-cap.** If the iteration cap
   hit and the user chose "merge as-is, record findings in PR
   description" or "address in a follow-up", those findings carry
   into Step 4 as accepted-with-notes. Surface them in the
   commit body, not as a re-prompt:
   - `commit_body` includes: "Deferred out-of-scope findings
     (user-accepted at round cap):\n - [CRITICAL] <finding>\n
     - [MAJOR] <finding>".

2. **N-A user acceptance.** If the user accepted N-A scores in
   the N-A guard, record them similarly in the commit body:
   "Accepted N-A scores on criteria: N, M (user-confirmed)."

**Normal converged case (no findings reach Step 4):** ask the
user to merge with a concrete prompt. `commit_title` derived from
the criteria + implementer summary; `commit_body` mentions the
criteria-driven loop and round count.

**Merge prompt** (when user is ready):

Follow the merge boundary verbatim: concrete merge prompt with
proposed `commit_title` and `commit_body`, `merge_run({confirmed:
true, ...})` only after explicit affirmative. `commit_title` should
reflect the change (derived from criteria + implementer summary);
`commit_body` should mention the criteria-driven loop and any
out-of-scope findings deferred.

After merge, `discard_run` the read-only reviewer runs (cleanup)
and acknowledge to the user.

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
- (`partial` / `error` → always review: see the "Always review"
  rule in §Step 2; restated here only as a guardrail summary.)

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
  crew-captain.body.md             # umbrella `crew` skill body (content unchanged)
  crew-iterate.body.md             # NEW — `crew:iterate` body
  targets/
    claude-code.md.tmpl            # same path; content edited to add {{NAME}} placeholder
    codex.md.tmpl                  # same path; content edited to add {{NAME}} placeholder
    gemini.md.tmpl                 # same path; content edited to add frontmatter block (today has none)
```

The per-host templates are body-agnostic in that they use a
`{{BODY}}` placeholder, but the v3-spotted gap is that:
- Claude/Codex templates today hardcode `name: crew` — must be
  replaced with `{{NAME}}` so the iterate skill renders as
  `name: iterate`.
- Gemini template has NO frontmatter block at all today (just a
  markdown heading + `{{BODY}}`). v4 install requires Gemini's
  SKILL.md to carry `name: crew` / `name: crew-iterate`
  frontmatter — so the Gemini template must add a `---\nname:
  {{NAME}}\ndescription: {{DESCRIPTION}}\n---` block.

Description currently doesn't need to vary per host (Claude
Code's matcher is the only one that cares deeply), but the
template gains a `{{DESCRIPTION}}` placeholder for symmetry —
each skill carries its own description string.

### `src/install/skill-renderer.ts` (extend)

Today's `renderSkill` takes `{templatePath, tools, packageRoot?,
crewWaitCommand?}` and bakes in `crew-captain.body.md` via the
hardcoded `loadCanonicalBody` path. Generalize:

**Per-host frontmatter name resolution.** The frontmatter `name:`
diverges per host (spike: Claude/Codex want bare `iterate` because
the namespace comes from `.claude-plugin/plugin.json`; Gemini wants
`crew-iterate` because it sanitizes colons). The manifest entry
therefore carries a stable `slug` (the trailing segment of the id
in plugin terms), and each adapter computes the actual frontmatter
name from `slug` + host rules. The manifest entry does NOT carry a
frontmatter name directly.

```ts
// NEW: per-skill manifest entry.
export interface SkillManifestEntry {
  /** Skill ID, including namespace. `crew` for the umbrella, `crew:iterate` for the sub-skill. */
  readonly id: string;
  /** The bare name after the namespace prefix. For `crew:iterate` this is `iterate`; for `crew` this is `crew` itself. */
  readonly slug: string;
  /** Path (relative to packageRoot/skills/) to the body file. */
  readonly bodyFile: string;             // e.g. 'crew-captain.body.md'
  /** Description string for the host matcher. */
  readonly description: string;
}

// NEW: the canonical list of skills crew installs.
export const SKILL_MANIFEST: readonly SkillManifestEntry[] = [
  {
    id: 'crew',
    slug: 'crew',
    bodyFile: 'crew-captain.body.md',
    description: SKILL_DESCRIPTION,
  },
  {
    id: 'crew:iterate',
    slug: 'iterate',
    bodyFile: 'crew-iterate.body.md',
    description: ITERATE_SKILL_DESCRIPTION,
  },
];

// NEW: per-host install spec computed by each adapter.
// (Post-Phase-0 simplification: no plugin manifests; sibling-flat
// on all three hosts.)
export interface SkillInstallSpec {
  /** Final on-disk path for the rendered SKILL.md. */
  readonly skillPath: string;
  /** The literal value written to the frontmatter `name:` field. */
  readonly frontmatterName: string;
  /** Legacy paths the install must remove (v1 SKILL.md locations). Empty for Claude/Codex (current paths ARE canonical); populated for Gemini (relocates ~/.gemini/extensions/crew/SKILL.md). */
  readonly legacyPathsToRemove: readonly string[];
}

// Each host adapter exposes:
//   skillInstallSpecFor(home: string, skill: SkillManifestEntry): SkillInstallSpec
// Per-host frontmatter rule (post-Phase-0):
//   - Claude Code: frontmatterName = skill.id.replace(':', '-')  (sibling-flat personal-skills; e.g. "crew-iterate")
//   - Codex:       frontmatterName = skill.id.replace(':', '-')  (sibling-flat personal-skills under ~/.codex/skills/)
//   - Gemini:      frontmatterName = skill.id.replace(':', '-')  (sibling-flat user-skills under ~/.gemini/skills/)
// All three hosts use the same id-with-hyphens form; no plugin namespace.

// MODIFIED: renderSkill now takes the manifest entry AND the install spec.
export interface RenderSkillArgs {
  readonly templatePath: string;
  readonly skill: SkillManifestEntry;
  readonly spec: SkillInstallSpec;       // adapter-resolved per-host fields
  readonly tools: readonly SkillTool[];
  readonly crewWaitCommand?: string;
  readonly packageRoot?: string;
}

export async function renderSkill(args: RenderSkillArgs): Promise<string> {
  // {{NAME}} in template substituted with args.spec.frontmatterName
  // {{DESCRIPTION}} substituted with args.skill.description
  // {{BODY}} loaded from args.skill.bodyFile
  // {{TOOL_LIST}} still rendered
  // {{CREW_WAIT_COMMAND}} unchanged
}
```

**Template change required (all three hosts).** Today the
Claude/Codex templates hardcode `name: crew`. Replace with
`{{NAME}}` placeholder and substitute per-skill. Without this,
the iterate file renders with `name: crew` and either silently
fails to load or double-loads as a duplicate umbrella.

**Gemini template needs frontmatter added today** — it currently
emits just a markdown heading + `{{BODY}}` with no `---` block at
all. v4 install requires the Gemini SKILL.md to carry frontmatter
(`name: crew` / `name: crew-iterate` plus a description), so the
gemini.md.tmpl must add:

```
---
name: {{NAME}}
description: {{DESCRIPTION}}
---
```

at the top. Add a Gemini-template snapshot test alongside the
Claude/Codex one.

Backward compatibility: the existing single-arg call site migrates
to pass `SKILL_MANIFEST[0]` plus the adapter-resolved spec.

### Host adapter `skillInstallSpecFor` (single accessor)

Each adapter exposes one method returning the per-skill install
spec:

- `skillInstallSpecFor(home: string, skill: SkillManifestEntry): SkillInstallSpec`

Returning `{skillPath, frontmatterName, legacyPathsToRemove}`.
The existing `skillPath: (home) => string` becomes an internal
alias for `skillInstallSpecFor(home, SKILL_MANIFEST[0]).skillPath`
during the migration period.

**Per-host install spec (Phase 0 finalized 2026-05-16):**

| Host | Umbrella `crew` SKILL.md | Sub-skill `crew-iterate` SKILL.md | Frontmatter `name:` | Legacy paths to remove |
| --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/skills/crew/SKILL.md` | `~/.claude/skills/crew-iterate/SKILL.md` | `crew` / `crew-iterate` | (none — v1 path IS canonical) |
| Codex | `~/.codex/skills/crew/SKILL.md` | `~/.codex/skills/crew-iterate/SKILL.md` | `crew` / `crew-iterate` | (none — v1 path IS canonical) |
| Gemini | `~/.gemini/skills/crew/SKILL.md` | `~/.gemini/skills/crew-iterate/SKILL.md` | `crew` / `crew-iterate` | `~/.gemini/extensions/crew/SKILL.md` (relocates from non-loading v1 path) |

**Migrations the install command must run (simplified post-Phase-0):**

The canonical ordering for every host migration is uniform:

1. Acquire `home` install lock (POSIX `flock`).
2. Preflight collision check: refuse if a target SKILL.md exists
   and is not crew-owned (per install manifest's `writtenPaths`).
3. **Remove `legacyPathsToRemove` FIRST** (before staging the new
   files). For Gemini, this removes the broken v1 file at
   `~/.gemini/extensions/crew/SKILL.md`. For Claude/Codex,
   `legacyPathsToRemove` is empty; the current v1 path IS canonical
   and is overwritten in place during the atomic swap.
4. Stage all rendered SKILL.md files to a temp directory.
5. Atomically swap staged files into final positions.
6. Update install manifest (`writtenPaths`, `skills` map).
7. Release lock.

Per-host specifics:

1. **Claude Code.** Files written: `~/.claude/skills/crew/SKILL.md`
   (overwrite — current v1 IS canonical), `~/.claude/skills/crew-iterate/SKILL.md`
   (new). No plugin manifest. No legacy paths to remove.

2. **Codex.** Files written: `~/.codex/skills/crew/SKILL.md`
   (overwrite — current v1 IS canonical), `~/.codex/skills/crew-iterate/SKILL.md`
   (new). No plugin manifest. No legacy paths to remove.

3. **Gemini.** Files written: `~/.gemini/skills/crew/SKILL.md`
   (new path), `~/.gemini/skills/crew-iterate/SKILL.md` (new).
   Legacy path removed: `~/.gemini/extensions/crew/SKILL.md` (the
   non-loading v1 location). Also remove the containing
   `~/.gemini/extensions/crew/` directory if empty after the
   SKILL.md removal — but **only files crew wrote**; do not touch
   `gemini-extension.json` or any other unrelated extension state.

**Atomicity & locking requirements:**

- All file writes use a temp+rename helper (`writeFileAtomic`)
  rather than direct `fs.writeFile`. A host that restarts mid-
  write must observe either the old file or the complete new file,
  never a partial write.
- **Per-`home` install lock via POSIX `flock`** on
  `~/.crew/.install-lock`. Use `flock(LOCK_EX)` on an open file
  descriptor; the kernel auto-releases on process exit, including
  SIGKILL / OOM / kernel panic, eliminating the stale-lock
  deadlock risk that a PID-in-lockfile or timestamp-expiry scheme
  would introduce. Fall back to `O_EXCL` create + PID staleness
  check on platforms without flock (Windows future-proofing).
  Concurrent installs serialize cleanly.
- Install order matches the canonical 7-step list above.
- Rollback: if the atomic swap fails partway, attempt to restore
  the pre-install state by removing staged files; if step (6) —
  install manifest write — fails after files are on disk, log
  loudly so the user can reconcile manually via `crew verify`.

### `src/install/install-manifest.ts` (significant extension)

Today's `InstalledTarget` tracks `skillPath: string`. With N skills
the v2 shape tracks every file the install owns (no plugin manifest
field, post-Phase-0):

```ts
export interface InstalledTargetV2 {
  readonly host: HostId;
  readonly schemaVersion: 2;
  /** Skill ID → final SKILL.md path. */
  readonly skills: Record<string, string>;
  /** EVERY file/dir crew wrote during install — for thorough uninstall cleanup. */
  readonly writtenPaths: readonly string[];
  /** Other existing fields (config edits, etc.) preserved. */
  // ...
}
```

`writtenPaths` is the authoritative cleanup list. Uninstall
iterates it and removes each entry, then prunes empty parent
directories up to the host-skills root (but never above it).

**v1→v2 migration cases (each requires a test fixture):**

| Live state | Reader behavior |
| --- | --- |
| Fresh (no manifest) | Write v2 directly. |
| Clean v1 (`schemaVersion: 1` + `skillPath`) | Map `skillPath` to `skills: {crew: <path>}`; `writtenPaths` populated from the same path; `pluginManifests: []`. |
| v1 with `skillPath` missing | Read other fields; treat skills as empty (warn). |
| v1 with unknown `host` value | Reject (not a known host adapter). |
| v1 with extra hand-edited fields | Preserve unknown keys at the top level; do not fail. |
| Manifest missing but v1 files on disk | Discover via known v1 paths; produce a synthetic v1-shaped entry, then migrate. |
| Schema version newer than reader supports | Reject with "manifest schema is newer than this crew-mcp; upgrade crew-mcp." |

Add test fixtures covering each row in the table above. The v1→v2
migration is forward-only on first re-install; uninstall on a v1
manifest is supported (uses the `skillPath` directly) so users who
never re-install can still uninstall cleanly.

### `src/install/hosts/index.ts` + `claude-code.ts` / `codex.ts` / `gemini.ts`

Pick one adapter accessor signature and use it everywhere — the
two-alternative draft from v2 ratcheted complexity. Commit to:

- `skillInstallSpecFor(home: string, skill: SkillManifestEntry): SkillInstallSpec`

which returns the full per-skill install spec (path, frontmatter
name, plural plugin manifests (`PluginManifestSpec[]`), legacy paths to remove). The
existing `skillPath: (home) => string` becomes an internal alias
for `skillInstallSpecFor(home, SKILL_MANIFEST[0]).skillPath`
during the migration period.

### Install command (`src/install/...` orchestration)

The top-level install command loops over `SKILL_MANIFEST`, calls
`renderSkill` per entry, and writes each rendered output to the
adapter's `skillPathFor(home, skill.id)`. Existing single-skill
behavior is the loop's degenerate case (one entry).

### `verify` command parity

Today `verify` parses `mcp__crew__*` references out of the
installed skill to assert parity with the live MCP catalog. With
two skills, verify must:

1. **Compute the union of tool references across BOTH skill
   files FIRST**, then compare to the live catalog. Restructure
   the loop: collect all references, union them, then check
   missing/extras once. A tool present only in skill B is fine;
   the failure mode is a live tool absent from EVERY skill file.
2. **Detect known-broken v1 layout** for Gemini and surface a
   one-line warning per affected target: "skill recorded at
   `~/.gemini/extensions/crew/SKILL.md` is not loaded by Gemini
   (no gemini-extension.json); run `crew-mcp install --target
   gemini` to relocate." Claude and Codex paths don't change
   under v5, so no warning needed for those.
3. **Assert post-install file inventory.** For each manifest
   target, every path in `writtenPaths` must exist; if any is
   missing, the install is corrupt and verify reports it.

Parity rule: live catalog ⊆ (∪ over all skill files of tools).

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
- `skills/targets/*.md.tmpl` — same paths; content edited per
  §Plumbing: Claude/Codex templates gain `{{NAME}}` substitution;
  Gemini template gains a full frontmatter block (`---\nname:
  {{NAME}}\ndescription: {{DESCRIPTION}}\n---`) that didn't
  exist before.
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
  entry. Body / description / tool list / `CREW_WAIT_COMMAND` /
  `{{NAME}}` substitutions all work.
- Unit: `SKILL_MANIFEST` is well-formed (each entry has unique
  id, unique slug, body file exists, description is non-empty).
- Unit: per-host `skillInstallSpecFor(home, skill)` returns
  expected `{skillPath, frontmatterName, pluginManifests:
  PluginManifestSpec[], legacyPathsToRemove}`. Snapshot-test
  paths, frontmatter names, AND the full plugin-manifest array
  per host (length 0 for Gemini, 1 for Claude, 2 for Codex);
  future divergence surfaces as test diff.
- Unit: install-manifest v1 → v2 migration covers each row of the
  migration-cases table (fresh, clean v1, missing skillPath,
  unknown host, hand-edited extras, manifest-missing-files-present,
  schema-newer-than-reader).
- Unit: plugin manifest content snapshot — assert the rendered
  `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`
  match expected JSON. Catches accidental schema drift.
- **NEW: Integration file-layout migration test
  (`test/install/migration.test.ts`).** For each host: stage a
  tmp `home` with v1 layout (just the v1 SKILL.md, no plugin
  manifest). Run install. Assert: (a) v1 file removed; (b) v2
  files present at expected per-host paths; (c) plugin manifest
  written and parses as expected JSON (Claude/Codex only); (d)
  install-manifest `writtenPaths` records every file we wrote;
  (e) `crew-mcp verify` reports clean. Then run uninstall and
  assert the entire crew-owned tree (down to the host-skills
  root) is gone — including empty plugin dirs.
- **NEW: Idempotency test.** Running `crew-mcp install <host>`
  twice in a row leaves the same state as one install
  (filesystem and manifest both byte-identical).
- **NEW: Concurrent-install lock test.** Two `crew-mcp install`
  invocations against the same `home` serialize correctly; the
  second waits or fails-cleanly with a "lock held" message.
- **NEW: Stale-lock recovery test.** Hold the install lock from
  a subprocess, SIGKILL the subprocess mid-lock, then assert a
  second `crew-mcp install` acquires the lock cleanly without
  manual intervention. This test asserts the kernel-auto-release
  property of POSIX `flock` that the v4 lock-choice justification
  leans on; without it the claim "SIGKILL doesn't brick future
  installs" is unverified.
- **NEW: Conflict detection test.** If `~/.claude/skills/crew/.claude-plugin/plugin.json`
  exists with foreign content, install aborts with a clear
  error and does NOT overwrite.
- **NEW: Atomic-write test.** Simulate a process crash mid-write
  (kill between staging and rename) and assert the host sees
  either the old file or the complete new file, never a partial.
- Integration: `crew-mcp install <host>` writes both skill files
  + plugin manifest where applicable. `crew-mcp uninstall <host>`
  removes everything. `crew-mcp verify` reports parity for both.
- **NEW: `verify` parity union test.** A tool referenced only in
  skill B but present in the live catalog does NOT trigger an
  "extra" warning.
- **NEW: `verify` v1-broken warning test.** When the manifest
  recorded path matches a known-broken v1 location (Gemini
  extensions/crew, Claude personal skill, Codex root SKILL.md
  coexisting with v2), verify emits a migrate-hint warning.
- Smoke (manual, Phase 1 exit gate): on a real Claude Code /
  Codex / Gemini install, verify each host LOADS both skills.

**Phase 2 (body content):**

- Unit: `crew-iterate.body.md` contains load-bearing phrases —
  "acceptance criteria", "Step 0", "PASS|FAIL|N-A", "Criteria
  scoring", "every criterion", "out-of-scope", "iteration cap",
  "always run inline review", "do not auto-merge", "Silence is
  not consent", "synthetic-turn", "CREW_WAIT_TERMINAL",
  "Mechanical-PASS without evidence", "score-vs-finding",
  "criteria drift detected", "Audit check", "new epoch" (or
  "new loop epoch"), "foreground-wait", "clamped at", "[M]",
  "[B]", "[N]". The last 7 cover v4-introduced rules (criteria
  drift audit, new-epoch revision, iterate-specific foreground
  ban, effort clamp, criteria type tags). Failing any assert
  means a future edit accidentally dropped one of these rules
  from the body.
- Unit: standalone preamble contains all 8 numbered invariants
  (merge boundary, dispatch lifecycle, escape hatch, tool
  availability, own-host prohibition, never-shell-out, read-only
  cleanup, ask-on-ambiguity).
- ~~Unit: assert no copy-paste of umbrella-body paragraphs.~~
  **REMOVED 2026-05-16.** Duplication is now a design
  requirement (no host co-loads), not an anti-goal. Replace with:
  - Unit: assert the body's preamble invariants STAY IN SYNC with
    the umbrella body's same-named rules via a generated
    shared-invariants block at render time (single source of
    truth, identical bytes across both rendered SKILL.md files).
- Integration: render the body through the per-host templates;
  assert the rendered output parses as valid markdown +
  frontmatter, with the correct per-host `name:` value (`iterate`
  on Claude/Codex; `crew-iterate` on Gemini).

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

### Phase 0 — empirical probes (~~~0.35d~~ COMPLETE 2026-05-16)

All 8 probes executed; results in
[`crew-iterate-spike-findings.md`](./crew-iterate-spike-findings.md)
§"Probe results". **Major outcome: plugin-layout proposal
invalidated for Claude; plan simplified to sibling-flat on all
three hosts.** See §"Per-host skill layout" above and the
spike-findings doc for evidence and adjusted Phase 1 directions.

### Phase 1 — renderer + install plumbing (~0.75d, simplified post-Phase-0)

Goal: ship the multi-skill manifest with only the existing
umbrella `crew` skill in the manifest list (behavior identical to
today on Claude/Codex; Gemini gets the relocation as a strict
improvement). No plugin manifests.

Touchpoints:
- `src/install/skill-renderer.ts` — `SkillManifestEntry`,
  `SKILL_MANIFEST` (single entry today), generalized
  `renderSkill`. Template `{{NAME}}` substitution per skill.
- `src/install/hosts/types.ts` + each adapter —
  `skillInstallSpecFor(home, skill)` returning the per-skill
  `SkillInstallSpec` (path, frontmatter name, legacy paths to
  remove). No `pluginManifests` field.
- `src/install/hosts/claude-code.ts` — write
  `~/.claude/skills/crew/SKILL.md` (overwrite v1 in place).
- `src/install/hosts/codex.ts` — same pattern, writes
  `~/.codex/skills/crew/SKILL.md`.
- `src/install/hosts/gemini.ts` — write
  `~/.gemini/skills/crew/SKILL.md` AND remove the broken v1 at
  `~/.gemini/extensions/crew/SKILL.md`.
- `skills/targets/gemini.md.tmpl` — add the `---\nname:
  {{NAME}}\ndescription: {{DESCRIPTION}}\n---` frontmatter block
  (template has none today; Gemini relocation requires it).
- `skills/targets/claude-code.md.tmpl` and `codex.md.tmpl` — add
  `{{NAME}}` placeholder (today they hardcode `name: crew`).
- `src/install/install-manifest.ts` — v1→v2 migration with
  `writtenPaths` tracking.
- Install command — loop over manifest, atomic writes via
  `writeFileAtomic`, POSIX flock lock.
- All tests for the above.

Exit criteria:
- `crew-mcp install/uninstall/verify` round-trips work for each
  host AT THE NEW LAYOUT.
- v1→v2 install-manifest migration leaves no stale files.
- For Gemini, the v1 `~/.gemini/extensions/crew/SKILL.md` is
  removed during install and `gemini -p '/skills list'` shows
  `crew` in the available-skills list (the broken state from
  Phase 0 probe 1 is fixed).
- Renderer can produce N skills given an N-entry manifest, but
  ships exactly 1 today.

### Phase 2 — add `crew:iterate` body (~1d)

Goal: ship the second skill's body content via the manifest,
including the criteria-driven loop.

Touchpoints:
- `skills/crew-iterate.body.md` — NEW file, content sketched in
  §"Skill body sketch" above. Includes the standalone-safety
  preamble (~30 lines duplicating umbrella load-bearing rules,
  per spike's co-load resolution).
- `src/install/skill-renderer.ts` — append second entry to
  `SKILL_MANIFEST`, add `ITERATE_SKILL_DESCRIPTION` constant.
- `test/skills/crew-iterate-body.test.ts` — NEW unit test for
  load-bearing phrases: "acceptance criteria", "PASS/FAIL/N-A",
  "verdict", "every criterion", "out-of-scope", iteration cap,
  merge boundary, dispatch lifecycle, escape hatch.

Exit criteria:
- `crew-mcp install <host>` writes both skill files at the
  resolved per-host layout.
- Empirical: on a real Claude Code session, asking "keep working
  on X with Claude + Codex until acceptance criteria pass"
  auto-loads `crew-iterate` (visible in tool-result inspection
  or `/skills`). Note: trigger is `crew-iterate` (no colon, per
  Phase 0 simplification), invoked as `/crew-iterate` on Claude
  Code and `crew-iterate` on Codex/Gemini.
- **Body length target: ≤ 450 lines.** The body sketch in this
  plan is ~726 lines; Phase 2 must apply the concrete cuts
  below to land under the target before merging. The body-content
  unit test asserts load-bearing phrases survive the trim; if any
  phrase grep fails, the trim cut too much.

**Phase 2 trim plan (concrete line-saving cuts to land ≤ 450):**

- Collapse Step 3's BLOCKING + cap-reached + reviewer-disagreement
  + malformed paragraphs into a single "Edge cases" subsection
  with one bullet per case (~15 lines saved).
- Compress preamble invariants to "Rule. One reason sentence."
  Currently averaging 8–10 lines apiece (e.g., invariant #7 is
  5 lines for a 1-line rule). Save ~25 lines across all 8.
- Condense Step 2's panel-sizing heuristic (~18 lines) to a
  3-bullet decision list (~10 lines saved).
- Trim Step 1 hand-off bullets to 3; drop the "Pick the
  implementer by skill match" paragraph and link to umbrella's
  adapter-strengths guidance instead (~12 lines).
- Step 4 options-list compression: collapse the two CRITICAL/MAJOR
  vs N-A user-accepted blocks into one unified options-list
  (~12 lines).
- Reviewer specialty rationale (currently appended to the
  template) is plan justification, not skill body — strike from
  body or compress to one line (~5 lines).

Total ~80 lines saved → ~645. Further compression of guardrails
and degradation can take it to ~580. If still over 450 after
these cuts, the body has more to teach than the target permits
and the target should be re-baselined in this plan (not just
deferred).

### Phase 3 — dogfood + refine (~0.75d)

Goal: drive a real task end-to-end with `crew:iterate`; refine
rubrics + phrasings (especially the criteria-derivation prompt
and the per-criterion scoring discipline) based on what the
captain actually picks.

Process:
- Pick a contained task (1-file change, well-bounded). Suggest:
  start with a task that has obvious mechanical criteria (test
  command, lint) so the loop's stop condition has clear signal.
- Run the loop. Capture every captain decision-point where the
  body's rubric was silent, ambiguous, or wrong. Pay specific
  attention to:
  - Were the captain's auto-derived criteria good? (testable?
    not vibes? not too broad / too narrow?)
  - Did reviewers reliably produce the structured "Criteria
    scoring" section? If a reviewer omitted it, was the
    re-dispatch handled well?
  - Did the loop stop at the right time? Was the user-prompt at
    the cap clear?
- Edit `skills/crew-iterate.body.md` to address each captured
  gap.
- Re-run on a SECOND task with different criteria shape
  (mechanical-heavy first, behavioral-heavy second) to confirm
  fixes hold across criteria types.

Exit criteria: two real tasks driven end-to-end via
`crew:iterate` with no captain re-derivation AND no malformed-
scoring re-dispatches in the second task. Plan moves to
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

- **2026-05-16 v5 (current — Phase 0 complete).** Major simplification
  driven by Phase 0 empirical probes. The headline finding:
  **Claude Code does NOT load sideloaded plugin layouts in
  `~/.claude/skills/`** — plugins must come from marketplace
  install (`claude plugin install <plugin>@<marketplace>`). The
  fallback that v4.1 documented as a contingency becomes the
  canonical path for all three hosts.

  Simplifications:
  - **Sibling-flat personal-skills layout on all three hosts**:
    `~/.<host>/skills/crew/SKILL.md` + `~/.<host>/skills/crew-iterate/SKILL.md`.
    No plugin manifests. No Claude/Codex migration (current v1
    paths ARE canonical). Only Gemini relocates from the broken
    `~/.gemini/extensions/crew/SKILL.md` path.
  - **Trigger names converge to `crew-iterate`** (Claude prepends
    `/`; Codex/Gemini don't). Skill `name:` frontmatter is
    `crew-iterate` everywhere; description is shared verbatim.
  - **Dropped from plan:** `PluginManifestSpec` type, `.claude-plugin/plugin.json`
    writes, `.codex-plugin/plugin.json` writes, Claude umbrella
    SKILL.md "move from root to skills/crew/", Codex restructure,
    plugin-manifest minimum-field probe, the 8-probe Phase 0
    section (probes are done; outcomes recorded in spike
    findings).
  - **InstalledTargetV2** drops the `pluginManifests` field;
    keeps `skills` map + `writtenPaths` for uninstall cleanup.
  - **SkillInstallSpec** drops `pluginManifests`; keeps
    `skillPath`, `frontmatterName`, `legacyPathsToRemove`.
  - **Phase 1 cost** drops from ~1.25d to ~0.75d (no plugin
    manifest write/read code, no plugin migration tests, no
    plugin schema concerns).
  - **`verify` warning** simplifies: only Gemini's v1 path needs
    a v1-broken-layout warning; Claude/Codex v1 paths are still
    correct.

  Closed Open Questions:
  - Open Q2 (sub-skill path layout): resolved by Phase 0.

  New plan: `docs/plans/active/host-mcp-schema-compatibility.md`
  (side finding from Phase 0 probing: crew's MCP tool schemas
  are rejected by Gemini and partially by Codex due to a Zod
  `tuple()` construct in `peer_messages.excerpts.range`).

- **2026-05-16 v4.1 (earlier today).** Targeted drift cleanup
  from round-3 verification panel (claude + codex). All
  load-bearing findings addressed; remaining unknowns are
  empirical (Phase 0 probe outcomes, model behavior on criteria
  scoring), not design review.
  - Flow diagram (line ~173): rewrote Step 4 description to
    reflect the v4 single-OOS rule (no findings normally reach
    Step 4 unless user accepted/deferred). Removed the leaky
    "if any out-of-scope findings exist, surface them" line.
  - §Non-goals (line ~213): split "no auto-merge or auto-discard"
    into two bullets with the read-only-reviewer carve-out
    explicit (mirrors invariant #1 in the body).
  - §Plumbing: replaced singular `pluginManifestPath(home)`
    adapter method with `pluginManifestSpecsFor(home)` returning
    a `PluginManifestSpec[]` (length 0 for Gemini, 1 for Claude,
    2 for Codex). Scrubbed singular `pluginManifestPath` /
    `pluginManifestContent` references in test specs and adapter
    descriptions.
  - §File inventory: corrected `skills/targets/*.md.tmpl` from
    "templates work unchanged" to explicit per-file content edits.
  - §Phase 0 exit text: removed conditional "if probes 7 or 8
    reveal silent double-load, must remove v1 first" wording —
    the canonical remove-v1-first ordering is unconditional in
    v4; probe outcomes only refine diagnostic messages.
  - Phase 1 tests: added stale-lock recovery test (SIGKILL the
    lock-holding subprocess, assert next install acquires) so
    the POSIX `flock` kernel-auto-release claim is verified.
  - Phase 2 body-content test: added missing v4-introduced
    phrases to the grep-list ("criteria drift detected",
    "Audit check", "new epoch", "foreground-wait", "clamped
    at", "[M]", "[B]", "[N]") — closes the test-doesn't-catch-
    body-drift failure mode the round-3 reviewer flagged.
  - **Phase 2 body trim moved up from Phase 3.** Concrete cuts
    listed under Phase 2 exit criteria; target ≤ 450 lines.
    Test asserts load-bearing phrases survive the trim.

- **2026-05-16 v4 (earlier today).** Folds in panel-review findings
  from round 2 (2 panels × 2 reviewers). Both panels returned
  CHANGES_NEEDED on v3 with 6+ MAJOR findings each.

  Body changes:
  - **Out-of-scope rule reconciled** across §core promise (line 46),
    Step 3 convergence rule (line ~873), and Step 4. Single rule:
    CRITICAL/MAJOR OOS findings force CHANGES_NEEDED verdict at
    the reviewer template → loop iterates. Step 4 only handles
    user-accepted/deferred OOS (post-round-cap or post-revision)
    and surfaces them in the commit body, not as a re-prompt.
  - **N-A guard added.** Any reviewer N-A score forces a user-
    confirmation prompt before convergence (not just before
    merge). Multiple N-A scores trigger criteria-revision prompt.
    Closes the lazy-reviewer escape hatch.
  - **Criteria type tags + verbatim audit block.** Step 0 now
    requires `[M]` / `[B]` / `[N]` tags on every criterion. The
    user-confirmed list is included VERBATIM in every downstream
    prompt (implementer, reviewer, merge surfacing). Reviewer
    template's audit check rejects criteria drift across rounds.
  - **discard_run carve-out** for read-only reviewer cleanup
    (invariant #1) — eliminates the conflict with read-only
    cleanup (invariant #7).
  - **partial/error always-review** rule made canonical;
    contradicting skip-bullet in §guardrails removed.
  - **Criteria revision = new epoch** (round counter restarts at
    0, total bounded by epoch-aware safety cap of 9 rounds).
    Replaces the v3 "reset to current round" wording that could
    cap users out immediately.
  - **Effort clamped at max** on Step 1's "one level higher" rule.
  - **No-criteria reviewer reply** captain recovery path added
    (re-derive Step 0 with user, then re-dispatch).
  - **Foreground-wait disabled** in iterate runs (invariant #2)
    — turn-blocking on 6–10 dispatches defeats chat-availability.

  Plumbing changes:
  - **`SkillInstallSpec.pluginManifests` plural** — replaces the
    singular `pluginManifestPath?` so Codex can carry both
    `.claude-plugin/` AND `.codex-plugin/` manifest specs.
  - **".codex-plugin/ optional" hedge fully removed.** Both
    manifests are written on Codex; per-host table updated;
    `SkillInstallSpec` type matches.
  - **Migration ordering canonical: remove v1 FIRST, then stage
    v2.** Replaces the v3 "stage v2, swap, then remove v1, OR
    conservatively remove first" ambiguity that left a double-
    load window on crash. Removing v1 first means a crash
    leaves the user with no skill (no double-load); `verify`
    surfaces this.
  - **Install lock via POSIX `flock`** — kernel auto-releases
    on process exit, eliminating the stale-lock deadlock risk
    that PID-in-lockfile or timestamp-expiry would introduce.
    Concurrent installs serialize; SIGKILL doesn't brick future
    installs.
  - **Gemini template needs frontmatter added.** v3 only
    flagged Claude/Codex template `{{NAME}}` substitution;
    Gemini template has NO `---` block today and v4 install
    requires `name:` / `description:` — template gap called out
    explicitly with a snapshot-test requirement.
  - **Stale text scrubbed.** Header was "Draft v2" → now v4.
    "Five empirical probes" references at lines 234-236 and
    1841 → "eight". §Non-goals "no changes to install manifest
    schema or verify semantics" → corrected with explanatory
    note (the plan DOES change both).
  - **Conflict-detection extended to Gemini** (refuse if target
    SKILL.md exists and is not crew-owned per writtenPaths
    lookup).
  - **§"templates unchanged" annotation** in §directory layout
    corrected to "same path; content edited per §plumbing".

- **2026-05-16 v3 (earlier today).** Folds in panel-review findings
  from 2 panels × 2 reviewers (claude-code + codex) run on v2.
  Both panels returned CHANGES_NEEDED; this rev addresses all
  6 MAJOR + 1 CRITICAL plumbing findings and all 5 MAJOR body
  findings.

  Body changes:
  - Preamble expanded from 4 invariants to 8: added own-host
    prohibition, synthetic-turn (`CREW_WAIT_TERMINAL`) handling
    to avoid deadlock on Claude Code, tool-availability rule,
    never-shell-out-to-`crew-mcp`, read-only-discard cleanup,
    ask-on-ambiguity (replacing the soft Step 0 cross-reference).
  - Cross-host trigger divergence note added to the body itself
    (was only in the plan).
  - Review prompt template: added evidence-required rule for
    mechanical PASS (command + exit code, or file:line + content);
    out-of-scope verdict semantics consolidated into a single
    rule (CRITICAL/MAJOR → CHANGES_NEEDED; MINOR/NIT omitted);
    score-vs-finding consistency rule explicit (PASS + finding
    on Criterion N → re-dispatch); worked example added.
  - Step 3 stop condition tightened: N-A counted as PASS for stop
    but flagged; mechanical-PASS-without-evidence → FAIL;
    score-vs-finding contradictions → re-dispatch REVIEWER (not
    implementer); malformed reviewer output → re-dispatch
    reviewer; CRITICAL/MAJOR out-of-scope blocks convergence per
    the unified out-of-scope rule.
  - Step 0 criteria-revision: added hard-reset rule (invalidate
    prior PASSes, force full rescore, reset round counter); added
    definition of what counts as a "revision" (predicate change)
    vs. a unilateral clarification.
  - Step 4: MINOR/NIT out-of-scope wording removed (template
    suppresses them); copy now says "by definition CRITICAL/MAJOR".
  - Inline-vs-dispatched rubric: mechanical criteria are an
    always-dispatch override (criteria type beats diff size).
  - §Non-goals: "no body-content duplication" REVERSED — the
    spike resolution requires duplication.

  Plumbing changes:
  - `SkillManifestEntry.frontmatterName` REPLACED with
    `slug` + adapter-computed per-host name. Resolves the bug
    where `frontmatterName: 'crew:iterate'` would render
    incorrectly on every host.
  - Added `SkillInstallSpec` returned by adapter's
    `skillInstallSpecFor`, carrying per-host frontmatter name,
    plugin manifest path/content, and legacy paths to remove.
  - Per-host migration steps made explicit; Codex v1 removal
    enumerated (was missing — double-load risk per Codex's 6-
    level BFS).
  - Atomicity: temp+rename writes, per-`home` install lock,
    explicit migration ordering (preflight → stage → swap →
    remove v1 → record manifest → release lock).
  - InstalledTarget v2: adds `pluginManifests` and `writtenPaths`
    fields; uninstall iterates `writtenPaths` for thorough
    cleanup including plugin manifests and empty parent dirs.
  - v1→v2 migration cases expanded to table covering fresh,
    clean v1, missing-skillPath, unknown-host, hand-edited
    extras, manifest-missing-files-present, schema-newer-than-
    reader.
  - Plugin manifest co-write: `.claude-plugin/plugin.json` AND
    `.codex-plugin/plugin.json` both written on Codex (was
    "optional" — hedge dropped).
  - Plugin manifest minimum field set: probe 6 (NEW) enumerates
    required fields before Phase 1 locks the schema.
  - Phase 0 probes: 5 → 8. Added multi-skill-per-plugin
    discovery (probe 2 expanded), plugin-manifest min-fields
    (probe 6), v1/v2 coexistence behavior on Codex (probe 7)
    and Claude (probe 8).
  - `verify` enhancements: union tool references across skills
    BEFORE flagging extras; v1-broken-layout warning surface;
    post-install file-inventory assertion via `writtenPaths`.
  - Test coverage: NEW file-layout migration test, idempotency
    test, concurrent-install lock test, conflict-detection test,
    atomic-write test, `verify` parity-union test, v1-broken
    warning test.

  Outstanding for Phase 3 (dogfood): MINOR/NIT items from
  review — body-size target may shift from ~300 to ~360 lines
  given the criteria-flow content; trim if it overshoots ~400.
- **2026-05-16 v2 (earlier today).** Major rewrite to integrate
  [`crew-iterate-spike-findings.md`](./crew-iterate-spike-findings.md)
  AND reframe the skill around **acceptance-criteria-driven
  iteration** (rather than a generic "review → iterate" loop).
  Changes:
  - Added §"The core promise" — this skill is the headline crew
    use case (multi-agent loop until criteria pass).
  - Added Step 0 to the loop: captain derives criteria, user
    confirms before any dispatch.
  - Rewrote Steps 1–4 around criteria-as-contract: criteria
    flow into implementer prompt, reviewer prompts, and the stop
    condition.
  - New review-prompt template with mandatory per-criterion
    scoring section; reviewer specialty subsumed into criteria.
  - Added §"Per-host skill layout (from spike findings)" with
    the resolved layouts (Claude Code: plugin manifest +
    moved umbrella body; Codex: same plugin layout; Gemini:
    flat user-skills relocation from current extensions install).
  - Marked Open Questions 2 and 6 RESOLVED. Added Open Questions
    7–9 for criteria-derivation rubric, mid-loop criteria
    revision, and per-criterion reviewer scoring format.
  - Updated plumbing section with per-host migration steps and
    plugin-manifest path resolution.
  - Cost bumped from ~2–2.5d to ~3d for the additional layout
    plumbing and the criteria-flow body content.
- **2026-05-14 v1 (initial draft).** Captures the pattern
  empirically used to ship `peer-messages-parameter` and
  `run-panel`. Open questions (matcher auto-load, nested-path
  host support, iteration cap default, co-load behavior).
