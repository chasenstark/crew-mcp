<!--
  Canonical skill body for `crew-iterate`. Per-host templates wrap this
  in the appropriate frontmatter. Single source of truth — edit here,
  re-run `crew-mcp install` to propagate.

  This skill is INDEPENDENT of `crew-captain.body.md` (the umbrella
  `crew` skill). No host co-loads both bodies into context at the same
  time, so the safety invariants from the umbrella are restated below.
  When in doubt, the invariants in this preamble win.
-->

## Crew — iterate-to-acceptance playbook

This skill loads when the user wants a **multi-agent loop that keeps
working on an implementation until acceptance criteria pass and
reviewers approve** — "keep working on X with review", "implement X
and review until it's good", "iterate to convergence", "ship-quality
loop", "use two agents to push this until criteria pass".

The mechanic: captain derives **acceptance criteria** from the user's
request, the user confirms them, those criteria become the contract
for every downstream prompt (implementer, reviewer, stop condition),
and the loop iterates until every criterion is PASS and every
reviewer's overall verdict is APPROVE. Pure orchestration playbook;
the MCP wire surface is unchanged from the umbrella `crew` skill.

### Standalone safety invariants

This skill is independent of the umbrella `crew` body. The eight
invariants below are restated here so iterate works standalone. If
any invariant conflicts with later instructions, the invariant wins.

**1. Merge boundary.** Never call `merge_run` without explicit user
affirmative. Surface a concrete merge prompt with the proposed commit
title and body; act only on explicit "yes / go / merge". Silence is
not consent. `discard_run` is similarly gated for the IMPLEMENTER run
and for any reviewer the user explicitly invested in. **Carve-out:**
read-only reviewer runs that have already produced their findings are
metadata cleanup — the captain may `discard_run` them automatically
as part of the iterate cycle (see invariant #7).

**2. Dispatch lifecycle (do NOT long-poll).** After `run_agent` /
`continue_run` / `run_panel`, do NOT long-poll `get_run_status`
in-turn. Confirm dispatch with the inline `tail_url` markdown, end
the turn, and:
- Claude Code: `Bash({{CREW_WAIT_COMMAND}} <run_id>, run_in_background: true)`
  to spawn the watcher. The host will fire a synthetic next-turn
  prefixed with `CREW_WAIT_TERMINAL run_id=... status=... worktree=...`
  when the run reaches terminal. Parse that line on receipt, then
  call `get_run_status({run_id})` for the full envelope. Without the
  synthetic-turn handling, the loop deadlocks: dispatched and ended
  the turn but never recognizes the resume.
- Codex / Gemini: no watcher. Discover terminal runs on the next user
  turn via `list_runs({status: ["success","partial","error"]})`.

**Iterate-specific: never use the foreground-wait opt-in.** Unlike
one-shot dispatches in the umbrella body, iterate runs MUST NOT use
the foreground-wait params (`wait_for_terminal_only`, long
`wait_for_change_ms`). The loop accumulates 6–10 dispatches;
turn-blocking on any one defeats the chat-available default.

**3. Escape hatch.** If the user says "stop / cancel / abandon /
discard / pause" at any point: stop dispatching new runs, `cancel_run`
any in-flight runs they name, and ask whether to discard or keep
their worktrees. The escape hatch wins over any in-flight round.

**4. Tool availability.** Before dispatching, call `list_agents` to
confirm the chosen agent is `available: true`. Unavailable agents
(unauthenticated, rate-limited, etc.) surface a reason — ask for an
alternative rather than retrying silently. Never invent an `agent_id`
absent from `list_agents`.

**5. Do NOT dispatch to your own host product.** If you are running
on Claude Code, do not dispatch `claude-code` as implementer or
reviewer (use the host's native subagents). Same rule for Codex →
Codex, Gemini → Gemini. Crew is for cross-product delegation;
same-host crew dispatches lose the heterogeneity that makes review
valuable and can cause nested-session resource conflicts.

**6. Never shell out to `crew-mcp`.** Use the MCP tool surface
(`mcp__crew__*`). The MCP server is the authoritative interface;
shelling out bypasses dispatch tracking, watcher registration, and
worktree allocation.

**7. Read-only reviewer dispatches do not auto-clean.** After a
reviewer's read-only run terminates, you must explicitly `discard_run`
it. Iteration rounds accumulate read-only runs; forgetting to discard
them leaves clutter in `list_runs`. This cleanup is the carve-out in
invariant #1 — no user prompt required.

**8. Ask the user before dispatching on ambiguity.** Step 0 is the
natural disambiguation gate. If criteria are unclear, scope is
fuzzy, or multiple interpretations are equally defensible, ask
before any dispatch. **Silence is not consent.**

### When to use this skill (vs umbrella `crew` alone)

Use `crew-iterate` when ANY hold:
- User used "review", "iterate", "until good", "keep working",
  "ship-ready", or similar quality-loop framing.
- User wants multiple agents pushing on something until criteria
  pass.
- The change should land via `merge_run` once it converges.

Fall back to umbrella `crew` when:
- One-shot dispatch with no review expected.
- Review-only work on existing code (no implementer).
- User explicitly says "no review, just implement".

When in doubt: ask. "Do you want me to iterate this until review
passes, or just dispatch once?"

**Cross-host trigger.** All hosts use `name: crew-iterate`; only the
slash prefix differs (`/crew-iterate` on Claude Code; `crew-iterate`
on Codex/Gemini). Auto-load matches the `description:` phrase on any
host. On Codex/Gemini the loop still works but each terminal status
surfaces on the next user turn (no watcher overlay) — tell the user
upfront if you detect that host.

## The 5-step loop

### Step 0 — Derive and confirm acceptance criteria

**Mandatory. Do not skip. Do not dispatch without user-confirmed
criteria.** Acceptance criteria are the contract for every downstream
step — implementer prompt, reviewer prompt, and stop condition all
reference them. Skip this step and you have no defined "done".

Read the user's request. Derive 3–7 criteria. **Every criterion must
be tagged with one of three TYPE labels** — these are MANDATORY
because they make the mechanical-evidence rule (Step 3)
machine-checkable from reviewer output alone:

- **`[M]` Mechanical**: a test command, lint check, file-content
  assertion, or build step producing a binary signal.
  Example: `[M] pnpm test src/install/skill-renderer.test.ts exits 0`.
- **`[B]` Behavioral**: a property a reviewer can verify by reading
  the diff.
  Example: `[B] SKILL_MANIFEST entries each have a unique id and a
  bodyFile present on disk`.
- **`[N]` Negative**: a "doesn't break X" clause for load-bearing
  code the change touches.
  Example: `[N] existing v1 install-manifest fixtures still parse via
  the v1→v2 migration path`.

Avoid pure-vibes criteria ("looks idiomatic", "feels clean") unless
paired with a concrete signal. Avoid criteria the reviewer can't
check from the diff alone (don't say "performance regresses by <5%"
unless you also dispatch a benchmark).

Surface to the user verbatim:

> Before I dispatch, here are the acceptance criteria I'll iterate
> against (`[M]` mechanical, `[B]` behavioral, `[N]` negative):
> 1. [M] <criterion 1>
> 2. [B] <criterion 2>
> 3. [N] <criterion 3>
>
> Confirm, edit, or add criteria. I'll dispatch once you OK.

Wait for OK or edit. **Silence is not consent.** If the user edits,
restate the final list and ask again. The final list becomes the
**user-confirmed criteria** — the contract for all downstream prompts.

**Captain audit-trail rule.** Include the user-confirmed criteria
block VERBATIM in every downstream prompt — implementer, reviewers,
continue_run, merge surfacing. Format:

```
## User-confirmed acceptance criteria (Step 0)
1. [M] <criterion>
2. [B] <criterion>
...
```

The reviewer template's **Audit check** rejects criteria drift
across rounds: if the current round's block differs from a prior
round's (other than a documented unilateral clarification), the
reviewer replies `criteria drift detected` and the captain must
re-confirm. This protects against post-hoc fabrication.

**Criteria revision mid-loop (new-epoch rule).** If a later round
reveals a criterion is malformed or impossible:

1. **Stop dispatching.** Cancel any in-flight reviewers (they were
   scoring against the old criteria). Either cancel the implementer's
   in-flight `continue_run` and re-dispatch with revised criteria, or
   wait for it to terminate and then `continue_run` with the revised
   criteria carried in `peer_messages`.
2. **Flag to user; propose revision; wait for confirmation.** Silence
   is not consent.
3. **Invalidate prior PASSes.** After approval, all prior reviewer
   scores on the revised criterion are stale and MUST NOT be carried
   forward. Next round re-scores the FULL revised list; `peer_messages`
   include the note "criteria were revised; previous scores are
   invalid; rescore everything."
4. **Start a new loop epoch.** The revised criteria define a fresh
   epoch with its own round counter starting at 0. Total rounds across
   all epochs are bounded by an **epoch-aware safety cap (default 9
   total, no more than 3 in any one epoch)**. This prevents both the
   unfair cap-out where a revision at round 3 immediately hits cap
   AND infinite revisions becoming a perpetual-motion machine.

What counts as a "revision": any change altering a criterion's
testable predicate. Pure wording clarifications that preserve the
predicate (typo fixes) can be applied unilaterally with a one-line
note; prior PASSes remain valid; counter does not reset.

### Step 0.5 — Confirm agent picks

**Mandatory. Do not dispatch until the user OKs the picks.** Agent
choice is part of the loop contract, not an invisible captain
preference. This gate parallels the Review panels gate in the
umbrella `crew` body.

**Preferences win — this is the overriding rule of this step.** The
user's configured defaults and bans are the decision, not hints you
weigh against your own taste for model variety. Heterogeneity is a
distant tiebreaker used only to fill a role the user left open. Never
trade a user preference for "a different model would surface different
bugs."

1. Call `list_agents`.
2. Call `get_crew_preferences({scope: "iterate"})`. **Not optional
   when the tool exists** — you cannot honor preferences you never
   read. Only skip it (and fall back to the heuristic) if the tool is
   genuinely absent from this install.
3. **Apply `iterate.banList` as an absolute filter.** Every id in the
   banList is removed from every candidate pool — implementer,
   reviewers, fallbacks, all of it. A banned agent is NEVER proposed,
   never offered as an alternative, and never used to satisfy
   heterogeneity or availability, even if it is the only remaining
   option. If banning empties a role, leave that role unfilled and ask
   the user — do NOT reach for a banned agent to fill it.
4. Also remove your own host product (invariant #5) and any
   `available: false` agents.
5. Fill each role by this precedence, highest first:
   a. **Per-run override** the user states in this conversation.
   b. **Configured preference** — `iterate.implementer` for the
      implementer; `iterate.reviewers` (in order) for reviewers. Use
      them as-is. If the user configured the same product for multiple
      roles, honor that — do NOT inject a different model for variety.
   c. **Fallback heuristic** — only for a role no preference covers.
      Mechanical-heavy criteria fit a fast-iteration implementer
      profile; behavioral-heavy fit a careful-reasoning profile.
      Heterogeneity (different product for implementer vs reviewer) is
      a tiebreaker among otherwise-equal candidates here — never a
      reason to override (a) or (b).

Surface to the user verbatim:

> Agents for this iteration:
> - Implementer: <id> <reason: "your default" | "heuristic: ...">
> - Reviewer(s): <id, id> <reason: "your default" | "heuristic: ...">
> - Inline reviewer: captain <reason: "free, always">
> [if a role is unfilled because bans excluded every candidate:]
> - <role>: unfilled — your banList excludes all remaining
>   candidates. Name an agent or lift a ban.
>
> Override (e.g., "swap implementer to <id>", "drop reviewer <id>",
> "use <id> for both") or OK.

Wait for OK. **Silence is not consent.** If the user overrides, restate
the final picks and ask again.

#### Override grammar

Recognize these phrases consistently:
- `swap implementer to <id>` → set implementer.
- `add reviewer <id>` / `drop reviewer <id>` → mutate reviewer set.
- `use only <id>` / `use <id> for both` → collapse picks.
- `no <id>` / `never <id>` → session-scoped ban only; do not persist.

After confirmation, include this block VERBATIM in every downstream
prompt, immediately after the acceptance criteria block:

```
## Agent-pick (Step 0.5)
Implementer: <id> (<reason>)
Dispatched reviewer(s): <id, id> (<reason>)
Inline reviewer: captain (free, always)
This block is included in downstream prompts so reviewers can audit agent-drift across rounds.
```

If a later round uses different picks without a documented user
override, stop and re-confirm. Reviewers can then detect agent drift
the same way they detect criteria drift.

### Step 1 — Dispatch implementer

```
run_agent({
  agent_id: <implementer>,
  prompt: <task description, restating the criteria inline>,
  effort: <one level higher than for raw implementation, clamped at "max">,
  peer_messages: [
    { body: <numbered criteria list, verbatim from Step 0>,
      kind: "note", from_label: "acceptance criteria" },
    { body: <agent-pick block, verbatim from Step 0.5>,
      kind: "note", from_label: "agent picks" }
  ]
})
```

- Restate criteria in the prompt itself; models comply with criteria
  read inline more reliably than criteria buried in peer-message
  history.
- Pick `effort` one level higher than for a raw implementation
  (**clamped at `max`**) — review catches mid-effort regressions but
  can't recover from a low-effort foundation.
- Use the implementer confirmed in Step 0.5. If that pick came from
  the fallback heuristic (no user default covered it), match the
  criteria profile: mechanical-heavy → fast-iteration profile;
  behavioral-heavy → careful-reasoning profile. Heterogeneity between
  implementer and reviewer is only a tiebreaker for heuristic picks —
  never a reason to deviate from a confirmed Step 0.5 pick.
- Confirm dispatch with `[tail in side terminal](<tail_url>)`, end
  the turn, spawn the watcher on Claude Code (per invariant #2).

### Step 2 — Dual-review (inline + dispatched, parallel)

When the implementer reaches terminal, **always run inline review**
plus (default-on) at least one dispatched reviewer. Both review
against the SAME acceptance criteria from Step 0.

**(a) Inline review (mandatory, free).** Read `A.summary`,
`A.files_changed`, and the diff via the worktree path. Score
**every criterion** PASS/FAIL/N-A plus an overall verdict using the
SAME schema the dispatched reviewer uses (§"Review prompt template"
below). Inline review costs zero MCP round-trips and sees the full
diff in your context window.

**(b) Dispatched review (default-on).** Use the reviewer(s) confirmed
in Step 0.5 — do not re-pick here, and do not swap in a different
model for variety. (If Step 0.5 left the reviewer to the fallback
heuristic, heterogeneity with the implementer was already its
tiebreaker.)

```
run_agent({
  agent_id: <reviewer>,
  read_only: true,
  working_directory: <A.worktree_path>,
  peer_messages: [
    { body: <acceptance criteria>, kind: "note",
      from_label: "acceptance criteria" },
    { body: <agent-pick block>, kind: "note",
      from_label: "agent picks" },
    { body: A.summary, files: A.files_changed,
      kind: "review", from_label: "implementer" }
  ],
  prompt: <REVIEW_PROMPT_TEMPLATE>
})
```

When to skip the dispatched reviewer (inline-only):
- User said "no review" out loud.
- Typo / comment / pure-doc commit (<10 LOC, no production-code
  changes) AND all criteria are behavioral (no mechanical signals).

**Always dispatch (override skip) when:** any criterion is
mechanical. The dispatched reviewer can actually run the test command
from the worktree, which inline reading can't do reliably. Criteria
type is a stronger signal than diff size for whether a dispatched
reviewer earns its keep.

**Always review on `partial` / `error`.** When the implementer
terminates with `partial` or `error`, the reviewer's read often
diagnoses why it stalled — diagnostic signal worth $0.01 even when
the captain plans to route the run back to the user.

Otherwise: always dispatch. The cost (~30–60s + ~$0.01) is dwarfed
by the cost of merging a regression the inline review missed.

**1+1 vs panel:**
- **1+1** (one inline + one dispatched): one full review from a
  single dispatched model. Default for narrow changes.
- **Panel** (one inline + N dispatched via `run_panel`): each model
  does a **full review** of the entire diff, then the captain
  consolidates findings and cross-checks for agreement and
  disagreement across models. Use when you want multiple models'
  independent perspectives on the same diff.
- **Large-diff splitting.** When a diff is large enough that a
  single agent can't review it thoroughly in one pass, split that
  model's review across multiple agents of the same model. Together
  they constitute one full review from that model. Each distinct
  model in the panel still reviews the whole diff. See
  §"Intra-model split mechanics" below for how to partition, prompt,
  and merge.
- Anti-heuristic: do NOT split the review into concern-based slices
  (correctness, style, security) across different reviewers. Every
  reviewer does a full review covering all concerns. The captain
  identifies cross-model agreement and disagreement during
  consolidation — that's where the value of heterogeneity lives.

### Intra-model split mechanics (large diffs)

When a single model's review needs to be split across multiple
agents of that model, the captain partitions, dispatches, and
merges as follows.

**When to split.** Use judgment: a 200-file / 5000-line diff is a
reasonable threshold where a single agent's review quality degrades.
Smaller diffs should stay as one agent per model. When in doubt,
don't split — a slightly less thorough single-pass review is better
than a poorly partitioned split.

**How to partition files.**

1. **Group by module/directory.** Keep files from the same directory
   or logical module together. Never split a file across two agents —
   the split boundary is always at the file level.
2. **Keep test + implementation paired.** If `foo.ts` is in partition
   A, `foo.test.ts` must also be in partition A. The reviewer needs
   to see both to assess coverage.
3. **Shared files go to every partition.** Config files, type
   definitions, and other files touched by multiple partitions are
   included in every sub-agent's file list (marked as shared context,
   not exclusive). Each sub-agent reviews them in the context of its
   own partition.
4. **Aim for roughly equal partitions** by file count, but respect
   module boundaries over strict equality.

**Prompt for sub-agents.** Each sub-agent gets:
- The full acceptance criteria (verbatim from Step 0).
- The implementer's full summary (not partitioned).
- A scoped file list: "Your partition covers these files: [list].
  Other partitions cover the remaining files — focus your review on
  your partition but note any cross-partition concerns you spot."
- The same review prompt template as a single-agent reviewer.

**Merging sub-agent results into one per-model review.** Before
cross-model consolidation, the captain merges sub-agent outputs
into a single per-model review:

1. **Union of criteria scores.** Each sub-agent scores every
   criterion against its partition. A criterion is PASS for the
   model only if every sub-agent scored it PASS (or N-A). Any FAIL
   from any sub-agent → the criterion is FAIL for that model.
2. **Union of findings.** Deduplicate findings that reference the
   same file:line. When two sub-agents flag the same shared file,
   keep the more detailed finding.
3. **Overall verdict.** Worst-case across sub-agents: any
   CHANGES_NEEDED → model verdict is CHANGES_NEEDED; any BLOCKING →
   model verdict is BLOCKING.
4. **The merged per-model review** is what enters cross-model
   consolidation (§"Cross-model consolidation" in Step 3).

**`run_panel` dispatch shape for splits:**

```
run_panel({
  implementer_run_id: "A",
  reviewers: [
    // Model 1: split across 2 agents
    { agent_id: "codex", prompt: "<full review prompt>\n\nYour partition: [files A–M list]. Other files are covered by another codex reviewer." },
    { agent_id: "codex", prompt: "<full review prompt>\n\nYour partition: [files N–Z list]. Other files are covered by another codex reviewer." },
    // Model 2: single agent (diff small enough for one pass)
    { agent_id: "claude-code", prompt: "<full review prompt>" },
  ],
})
```

The captain tracks which `run_id`s belong to the same model so it
can merge sub-agent results before cross-model consolidation.

### Review prompt template (use verbatim)

```
You are reviewing changes made by ${implementer_label} against
${target_repo}. The implementer's working directory contains the
proposed changes (you are running in read-only mode at that worktree
path). The implementer's own summary and the acceptance criteria are
included in peer_messages above.

Your job has TWO parts:

PART 1 — Score every acceptance criterion. For each numbered criterion
the captain gave you in peer_messages, decide:

  PASS  — the change meets this criterion. State why in 1 line. For
          MECHANICAL criteria (test command, lint, file content), you
          MUST cite the evidence: the command you ran AND its exit
          code, or the file:line you read AND what it said. "PASS —
          tests pass" without evidence is treated as FAIL by the
          captain.
  FAIL  — the change does not meet this criterion. State the gap in
          1-2 lines, cite file:line where relevant.
  N-A   — the criterion truly does not apply to this diff (extremely
          rare). Say why. The captain prompts the user for explicit
          acceptance before treating N-A as PASS.

PART 2 — Produce an overall verdict:

  APPROVE        — every criterion is PASS (or N-A) and you have no
                   CRITICAL/MAJOR out-of-scope concerns.
  CHANGES_NEEDED — at least one criterion FAILs, OR you have one or
                   more CRITICAL/MAJOR out-of-scope findings.
  BLOCKING       — the approach itself is wrong; criteria can't be
                   made to pass without a rethink.

Out-of-scope rule (single source of truth, do not improvise):
- CRITICAL or MAJOR severity out-of-scope finding → set Verdict to
  CHANGES_NEEDED (or BLOCKING if foundational).
- MINOR or NIT severity out-of-scope finding → omit from Findings
  entirely unless the captain asked for them explicitly. Do NOT let
  MINOR out-of-scope concerns affect Verdict.

Output format (mandatory, strict):

  ## Criteria scoring
  - [1] <verbatim criterion label>: PASS|FAIL|N-A — <one-line reason
        with evidence for mechanical PASS>
  - [2] <verbatim criterion label>: PASS|FAIL|N-A — <one-line reason>
  - ... one line per criterion, in the captain's order.

  ## Verdict: <APPROVE | CHANGES_NEEDED | BLOCKING>

  ## Findings
  - [SEVERITY] <one-line finding>: <2-3 sentence justification>
    Criterion: <criterion number if tied to one, else "out-of-scope">
    File: <path>:<line-range or "N/A">
    Recommendation: <concrete action>

  ## Recommended action
  <one paragraph: what should the implementer do next? Anchor
  recommendations to failing criteria first; CRITICAL/MAJOR
  out-of-scope suggestions last.>

Severity rubric:
  CRITICAL — correctness bug, security flaw, data loss risk.
  MAJOR    — non-trivial design issue that will compound.
  MINOR    — style, naming, comment quality.
  NIT      — taste, optional polish.

Score-vs-finding consistency rule: if you score criterion N as PASS,
you MUST NOT file a Finding with `Criterion: N`. If the PASS has
caveats, downgrade to FAIL and state the gap. PASS + Criterion-N
finding is treated as malformed by the captain (re-dispatch).

Do not edit files. If you find yourself wanting to write, describe
the edit instead — you are read-only by design.

If you cannot find the criteria in peer_messages: STOP. Reply with
"no criteria provided; cannot score" — the captain skipped Step 0
and needs to fix that first.

Audit check (cross-round): if peer_messages contains a prior round's
`## User-confirmed acceptance criteria (Step 0)` block or
`## Agent-pick (Step 0.5)` block AND the current round's corresponding
block has different content (other than a documented unilateral
clarification or user-approved override), STOP. Reply with
"criteria drift detected; previous and current blocks differ" or
"agent drift detected; previous and current picks differ" — the
captain may have silently mutated criteria or agent choice without
re-confirmation.
```

Specialty-specific concerns belong INSIDE the acceptance criteria
themselves (Step 0). If the user wants a security-lens reviewer,
they should have a "no new security exposure on auth handlers"
criterion.

### Step 3 — Iterate or converge

Once both verdicts are in, parse each reviewer's criteria scoring +
overall verdict. The stop condition is mechanical.

**Converged (go to Step 4).** ALL of:
- **every criterion** is scored PASS by every reviewer, OR N-A by
  every reviewer **with explicit user acceptance** (see N-A guard
  below — N-A is not free); no FAILs, no unscored, no malformed
  sections, no PASS+Criterion-N contradictions;
- every reviewer's overall verdict is APPROVE.

Because the reviewer template forces CRITICAL/MAJOR out-of-scope
findings into CHANGES_NEEDED, an APPROVE verdict is sufficient
evidence that no unresolved CRITICAL/MAJOR out-of-scope concerns
exist. MINOR/NIT out-of-scope findings are suppressed at the template
and never reach Step 3 — if you see one in Findings, treat the
reviewer as malformed and re-dispatch.

**Iterate (run another round).** ANY of:
- one or more criteria FAILed by any reviewer, OR
- one or more reviewer overall verdicts is CHANGES_NEEDED.

**N-A guard (user-confirmation gate).** N-A is the escape hatch a
lazy reviewer can use to skip hard criteria; treating it as silent
PASS lets a reviewer N-A every difficult criterion and produce a
structurally valid APPROVE.

- If ANY reviewer scores N-A on ANY criterion, surface to the user
  before Step 4: "Reviewer X scored criterion N as N-A: '<reason>'.
  Accept N-A (treat as PASS), revise the criterion, override (treat
  as FAIL and continue iterating), or hand off?" Wait for explicit
  choice. **Silence is not consent.**
- Treat N-A as malformed if the reviewer gave no reason or only a
  generic one — follow the malformed-output re-dispatch path.
- ≥2 N-A scores on the same criterion across rounds, OR ≥3 N-A
  scores spanning different criteria in one round, force a
  criteria-revision prompt — the criteria are likely malformed.

Do not soften this guard; do not skip the user prompt because the
N-A "looks reasonable."

**Cross-model consolidation (panels).** When using a panel, the
captain must produce a consolidated review report before iterating:

1. **Per-criterion agreement matrix.** For each criterion, list every
   model's score (PASS/FAIL/N-A). Flag disagreements — one model
   PASS, another FAIL on the same criterion is a signal worth
   surfacing.
2. **Finding deduplication.** Group findings that identify the same
   issue across models. Agreement (multiple models flag the same
   problem) increases confidence; unique findings from a single model
   are still valid but noted as single-source.
3. **Consolidated verdict.** The conservative rule applies: if ANY
   model's verdict is CHANGES_NEEDED or BLOCKING, the consolidated
   verdict is the worst case. Disagreement on verdict is surfaced
   explicitly.
4. **Keep the panel running** until the captain has a complete
   consolidated review covering the full diff. If any reviewer's
   output is incomplete or malformed, re-dispatch that reviewer
   before consolidating.

The consolidated report feeds into the iterate path below.

**Iterate path.** Aggregate FAILing criteria + CHANGES_NEEDED
findings into `peer_messages` and `continue_run` the implementer:

```
continue_run({
  run_id: A,
  peer_messages: [
    { body: <acceptance criteria>, kind: "note",
      from_label: "acceptance criteria (unchanged)" },
    { body: <agent-pick block>, kind: "note",
      from_label: "agent picks (unchanged)" },
    { body: <inline review's failing criteria + findings>,
      kind: "review", from_label: "captain inline review" },
    { body: <dispatched review's failing criteria + findings>,
      kind: "review", from_label: "${reviewer_agent_id} review",
      files: dispatched_review.files_changed },
    // one per reviewer if panel
  ],
  prompt: "Address these review findings. Specifically, make the
           FAILing criteria PASS. Reply with a brief summary of what
           changed and which criteria you believe now pass."
})
```

For panels, call `aggregate_panel({panel_id})` and pass the result
as `peer_messages` (also re-pass the criteria peer-message).

After `continue_run` reaches terminal, `discard_run` the read-only
reviewer runs (they don't auto-clean per invariant #7) and re-dispatch
the same reviewers against the new diff. Round count increments by 1.

### Step 3 — Edge cases

- **Malformed reviewer output — re-dispatch the REVIEWER, not the
  implementer.** Missing `## Criteria scoring` section, score-vs-finding
  contradiction (PASS + Criterion-N finding), or skipped criteria → the
  fault is with the reviewer. Cancel/discard the malformed run,
  re-dispatch the same reviewer with `peer_messages` noting "your
  previous output was malformed; re-review the same diff at
  <worktree_path> per the template." If a reviewer fails the
  structural check twice, replace with a different agent and flag.
- **`no criteria provided; cannot score`.** Captain skipped Step 0
  or dropped the criteria block. Do NOT re-dispatch the reviewer.
  Re-derive Step 0 with the user, then re-dispatch with the
  user-confirmed block.
- **`criteria drift detected`.** Treat as captain audit failure:
  stop, surface to user, re-confirm the canonical criteria list,
  resume with the correct block.
- **Mechanical-PASS without evidence — treat as FAIL.** Mechanical
  criterion scored PASS without command + exit code or file:line +
  content → criterion is FAIL. Implementer needs no fix; reviewer
  needs to re-run with evidence (malformed-output re-dispatch path).
- **BLOCKING verdict.** Stop the loop. Surface the reviewer's
  Recommended action. Ask: "rethink the approach, revise the
  criteria, discard, or continue anyway?" Do NOT silently continue.
- **Iteration cap reached (default 3 rounds per epoch; 9 total).**
  Reframe with criteria context: "We've iterated 3 rounds; criteria
  still failing: [2, 4]. Options: revise criteria → starts a new
  epoch (epoch-aware total cap still applies); switch implementer →
  continues current epoch; accept failing finding(s) and merge →
  carries into Step 4 as user-accepted/deferred (recorded in commit
  body); hand off → captain stops dispatching."
- **Reviewer disagreement (one PASS, one FAIL on criterion N).**
  Treat as FAIL (conservative). Forward both reviewers' reasoning to
  the implementer. If disagreement persists across two rounds on the
  same criterion, flag — the criterion may be ambiguous and need
  revision.
- **Implementer `error` mid-iteration.** Treat as a BLOCKING verdict
  from the implementer itself. Surface to user with the error
  summary; do NOT auto-discard.
- **Implementer `partial` (truncated, etc.).** Read what you can from
  summary; if the verdict line is missing, treat as CHANGES_NEEDED
  with the partial summary as the finding. Surface "implementer
  truncated; verdict unclear" to user before iterating.
- **User merges manually mid-iteration.** If you notice the branch
  landed (via git log or merge_run rejection), stop the loop and ask.
  Don't continue dispatching against a merged worktree.

### Step 4 — Merge

Once converged (every criterion PASS + every verdict APPROVE), hand
off to the user. **Do not auto-merge.**

Step 4 should receive a clean convergence: the reviewer template
forces CRITICAL/MAJOR out-of-scope findings into CHANGES_NEEDED, and
the captain re-dispatches malformed reviewers. Two cases DO reach
Step 4 with out-of-scope material:

1. **User accepted/deferred at round-cap.** Carries into the commit
   body as accepted-with-notes:
   ```
   commit_body includes:
   "Deferred out-of-scope findings (user-accepted at round cap):
    - [CRITICAL] <finding>
    - [MAJOR] <finding>"
   ```
2. **N-A user acceptance.** Recorded similarly:
   `"Accepted N-A scores on criteria: N, M (user-confirmed)."`

**Merge prompt** (concrete, with proposed commit text):

> Ready to merge `<run_id>` (<N> files changed): `<commit_title>`
> into `<target_branch>`?

Wait for explicit "yes / go / merge". Then:

```
merge_run({
  run_id: A,
  confirmed: true,
  commit_title: <derived from criteria + implementer summary, ≤72 chars>,
  commit_body: <mentions criteria-driven loop, round count,
                deferred/accepted findings if any>
})
```

`commit_title` should describe what the run accomplished, not "merge
crew run abc123…". `Crew-Run: <run_id>` trailer is appended
automatically — don't add it manually.

After merge, `discard_run` the read-only reviewer runs (cleanup) and
acknowledge to the user.

## Operating guardrails (delta from umbrella)

- Reviewer effort defaults to mirror the implementer's. When you
  override, restate in the reviewer's prompt.
- Inline review is mandatory; you can't "skip the inline review
  because the dispatched one is more thorough." Inline is fast,
  free, and catches the obvious stuff.
- Do not pre-allocate reviewer runs before the implementer
  terminates. Reviewer needs `working_directory: <A.worktree>`, and
  `A.worktree` is only stable post-terminal.
- For panel dispatches, use `run_panel` once after implementer
  terminates — do not call `run_agent` N times manually; you'll lose
  the `panel_id` / aggregation hook.

## Tools

The MCP surface this skill composes:

{{TOOL_LIST}}
