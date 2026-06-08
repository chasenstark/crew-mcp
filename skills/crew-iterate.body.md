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
turn-blocking on any one defeats the chat-available default. This bans
MCP long-poll waits on crew runs — **not** the bounded synchronous
host-review subagent of Step 2b, which blocks one turn by design on
hosts whose native subagent can't background, and only after the crew
panel is already dispatched async. That is the deliberate exception,
not a violation of this invariant.

**Crew before captain-side work (when independent).** When a round
both dispatches crew and does captain-side work — a native subagent,
or your own inline review — issue the crew dispatch(es) FIRST so the
workers run concurrently; prefer `run_in_background: true` for native
subagents. **Exception:** if the captain-side work produces the crew
dispatch's input (e.g. a reviewer's `peer_messages` built from the
implementer's `summary` / `files_changed`, per Step 2), it's a
prerequisite, not a peer — do it first. Otherwise crew-second
serializes the round, and the loop accumulates 6–10 dispatches, so
serializing any of them wastes the most wall-clock.

**3. Escape hatch.** If the user says "stop / cancel / abandon /
discard / pause" at any point: stop dispatching new runs, `cancel_run`
any in-flight runs they name, and ask whether to discard or keep
their worktrees. Use the host's structured-question tool
(AskUserQuestion on Claude Code) to present the discard/keep options
and capture the choice when available; if the host exposes no such
tool, surface the options as prose and wait for a free-text reply.
Either way, **Silence is not consent.** The escape hatch wins over any
in-flight round.

**4. Tool availability.** Before dispatching, call `list_agents` to
confirm the chosen agent is `available: true`. Unavailable agents
(unauthenticated, rate-limited, etc.) surface a reason — ask for an
alternative rather than retrying silently. Never invent an `agent_id`
absent from `list_agents`.

**5. Do NOT Crew-dispatch your own host product.** If you are running
on Claude Code, do not `run_agent` / `run_panel` `claude-code` as
implementer or reviewer. Same rule for Codex → Codex, Gemini →
Gemini. Crew is for cross-product delegation; same-host crew
dispatches lose the heterogeneity that makes review valuable and can
cause nested-session resource conflicts. This bans **Crew dispatch**,
not native subagents: the host model still reviews, via a native
subagent (Step 2), and that native review is not a crew run — it won't
appear in `list_runs` or `aggregate_panel`.

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
before any dispatch. Use the structured-question surface below for
discrete choices; keep genuinely open-ended scope questions as prose
unless the host question tool includes an explicit Other/free-text
escape. **Silence is not consent.**

### Structured-choice surface

For every discrete-choice confirmation or decision gate in this loop:
Use the host's structured-question tool (AskUserQuestion on Claude
Code) to present the options and capture the choice when available; if
the host exposes no such tool, surface the options as prose and wait
for a free-text reply. Either way, **Silence is not consent.**

Genuinely open-ended asks are different. If the captain needs the user
to define scope, "done", or another free-form requirement, either keep
the ask as a prose question or use the host question tool only with an
explicit Other/free-text escape.

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
reference the same persisted set. Skip this step and you have no
defined "done".

Read the user's request. Derive 3–7 criteria. **Every criterion must
be tagged with one of three TYPE labels** — these are MANDATORY
because the type decides *who* establishes the criterion's truth: `[M]`
is verified by running the command in a writable tree (the implementer
reports it, the captain re-runs to confirm — Step 3), while `[B]`/`[N]`
are scored by the reviewers reading the diff:

- **`[M]` Mechanical**: a test command, lint check, file-content
  assertion, or build step producing a binary signal. The captain owns
  this signal — it re-runs the command itself in the implementer's
  worktree (Step 3). Do NOT rely on a dispatched reviewer to run it: a
  read-only Codex reviewer's sandbox blocks the temp-dir writes Vitest
  needs, so it physically cannot run the suite and would FAIL the
  criterion environmentally.
  Example: **Skill-renderer tests pass** `[M]` —
  `pnpm test src/install/skill-renderer.test.ts` exits 0.
- **`[B]` Behavioral**: a property a reviewer can verify by reading
  the diff.
  Example: **Manifest entries well-formed** `[B]` — SKILL_MANIFEST
  entries each have a unique id and a bodyFile present on disk.
- **`[N]` Negative**: a "doesn't break X" clause for load-bearing
  code the change touches.
  Example: **v1 fixtures still parse** `[N]` — existing v1
  install-manifest fixtures still parse via the v1→v2 migration path.

Avoid pure-vibes criteria ("looks idiomatic", "feels clean") unless
paired with a concrete signal. Avoid criteria the reviewer can't
check from the diff alone (don't say "performance regresses by <5%"
unless you also dispatch a benchmark).

**Criteria-store flow.** When the criteria tools are present, they are
the source of truth. Use them in this order:

1. Call `create_criteria({criteria})` with each criterion as a
   structured item: `title`, `type` (`mechanical`, `behavioral`, or
   `negative`), exactly one of `detail` or `subCriteria`, and `signal`
   for `[M]` criteria when there is a concrete command or assertion.
2. Surface the returned `rendered_block` verbatim to the user. Do not
   hand-format a parallel criteria list.
3. Use the host's structured-question tool (AskUserQuestion on Claude
   Code) to present Confirm / Edit / Add options and capture the choice
   when available; Edit and Add must allow free-text details. If the
   host exposes no such tool, surface the options as prose and wait for
   a free-text reply. Either way, **Silence is not consent.**
4. If the user explicitly OKs with no edits, call
   `confirm_criteria({criteria_set_id})`.
5. If the user explicitly OKs and includes edits in the same message,
   translate the edits into `CriteriaEditOps` (`add`, `update`,
   `removeIds`, `order`) and call
   `confirm_criteria({criteria_set_id, ops})`.
6. If the user gives edits without explicit OK, do **not** call
   `confirm_criteria`: confirmation is the point of no return and
   always sets `status: "confirmed"`. Hold the pending ops, re-surface
   the proposed criteria in prose, and wait for OK.

`create_criteria`, `confirm_criteria`, and `revise_criteria` may return
`criteria.invalid` for malformed criteria or edit ops. That is a
criteria-tool validation error, not a dispatch-time criteria error.

**Store-backed contract.** After confirmation, retain the
`criteria_set_id` and pass it on every `run_agent`, `run_panel`, and
`continue_run` call in this loop. Do **not** restate criteria inline
and do **not** pass acceptance criteria through `peer_messages`; the
server injects the confirmed criteria as a non-droppable contract. The
dispatch-time criteria errors are exactly `criteria.unknown`,
`criteria.not_confirmed`, `criteria.cross_repo`,
`criteria.unparsable`, `criteria.unknown_schema_version`,
`criteria.linkage_mismatch`, and `criteria.contract_too_large`.

**Warning scope.** The server emits
`criteria.peer_message_without_criteria_set_id` only when a dispatch has
no `criteria_set_id` and at least one `peer_messages[].from_label`
matches `/acceptance criteria/i`. Avoid that fallback shape when the
criteria tools exist.

**Tools-absent fallback.** Only when the criteria tools are genuinely
absent from the MCP surface, fall back to the legacy prose criteria
block: derive the same 3–7 `[M]`/`[B]`/`[N]` criteria, surface the
numbered list to the user, use the host's structured-question tool
(AskUserQuestion on Claude Code) to present Confirm / Edit / Add
options and capture the choice when available, and carry that confirmed
block in prompts/peer messages for the rest of the loop. If the host
exposes no such tool, surface the options as prose and wait for a
free-text reply. Either way, **Silence is not consent.**
This fallback is a compatibility path, not the normal contract.

**Criteria revision mid-loop (new-epoch rule).** If a later round
reveals a criterion is malformed or impossible:

1. **Stop dispatching.** Cancel any in-flight reviewers (they were
   scoring against the old criteria). Either cancel the implementer's
   in-flight `continue_run` and re-dispatch with revised criteria, or
   wait for it to terminate and then `continue_run` after the revised
   criteria are confirmed.
2. **Flag to user; propose revision ops; wait for confirmation.**
   Use the host's structured-question tool (AskUserQuestion on Claude
   Code) to present Confirm revision / Edit revision / Hand off options
   and capture the choice when available; Edit revision must allow
   free-text details. If the host exposes no such tool, surface the
   options as prose and wait for a free-text reply. Either way,
   **Silence is not consent.** If the user edits the proposal without
   explicitly OKing it, hold the pending ops and ask again.
3. After explicit approval, call
   `revise_criteria({criteria_set_id, ops, note})`. This bumps
   `epoch`, returns `status: "proposed"`, snapshots the old epoch, and
   clears prior review state. Surface the returned `rendered_block`.
4. Require explicit re-confirmation with `confirm_criteria` before any
   new dispatch. The next round re-scores the FULL revised list.
5. **Start a new loop epoch.** The revised criteria define a fresh
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
4. Remove any `available: false` agents, and remove your own host
   product from the **crew** candidate pools (invariant #5). Don't
   drop the host from the review plan, though: unless it's banned or
   the user excluded it, carry it as the **host reviewer** — a native
   subagent run outside Crew (Step 2).
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

**How many reviewers — scale the count to the change.** The number of
dispatched reviewers is the captain's call, sized to complexity and
risk (this is in addition to the host reviewer — your native subagent):

- **1 dispatched reviewer** (the default): narrow, localized, low-risk
  change — a handful of files, no load-bearing code.
- **2 distinct-model reviewers**: moderate complexity, OR a small but
  high-risk change — auth, migrations, money, concurrency, public API,
  security, anything where a regression is expensive — where a second
  independent model earns its keep.
- **3 distinct-model reviewers**: large AND high-risk AND cross-cutting
  (touches several subsystems). Stop at ~3 distinct models; beyond that
  is diminishing returns. For a very large diff, keep the model count
  and use intra-model splitting (Step 2) rather than adding more
  distinct models.

A panel's value is distinct **models** reviewing the same diff, so add
different products — never repeats of one model (repeats exist only for
intra-model splitting of a huge diff). Draw extra reviewers from the
eligible pool (non-banned, available, not your host product). If that
pool has only one model, you cannot scale the distinct-model count past
one — say so rather than padding.

Configured `iterate.reviewers` is the baseline roster. You MAY propose
more reviewers than configured for a high-complexity change, or fewer
for a trivial one — but the user confirms the final count below, so
always show the count you chose and the one-line complexity reason.

Surface to the user verbatim:

> Agents for this iteration:
> - Implementer: <id> <reason: "your default" | "heuristic: ...">
> - Crew reviewer(s): <id, id> <reason: "your default" | "complexity:
>   <why this many>">
> - Host reviewer: <host via native subagent | host foreground native |
>   host inline fallback | omitted>
>   <reason: "fresh same-host review" | "synchronous subagent → foreground" |
>   "no native subagent → inline fallback" | "excluded by preference">
> [if a role is unfilled because bans excluded every candidate:]
> - <role>: unfilled — your banList excludes all remaining
>   candidates. Name an agent or lift a ban.
>
> Override (e.g., "swap implementer to <id>", "add reviewer <id>",
> "drop reviewer <id>", "drop host reviewer", "just one reviewer",
> "use <id> for both") or OK.

Use the host's structured-question tool (AskUserQuestion on Claude
Code) to present OK / Override options and capture the choice when
available; Override must allow free-text details. If the host exposes
no such tool, surface the options as prose and wait for a free-text
reply. Either way, **Silence is not consent.** If the user overrides,
restate the final picks and ask again with the same structured-choice
surface.

#### Override grammar

Recognize these phrases consistently:
- `swap implementer to <id>` → set implementer.
- `add reviewer <id>` / `drop reviewer <id>` → mutate reviewer set.
- `just one reviewer` / `add another reviewer` / `<N> reviewers` →
  resize the reviewer count (pull from / add distinct eligible models).
- `use only <id>` / `use <id> for both` → collapse picks.
- `drop host reviewer` / `no host reviewer` → omit the host native
  subagent for this iteration (one-run exclusion, not a ban).
- `no <id>` / `never <id>` → session-scoped ban only; do not persist.

After confirmation, include this agent-pick block in downstream
`peer_messages` and host-native prompts. The acceptance criteria
contract travels separately via `criteria_set_id` when the tools are
present, so do not paste the criteria beside this block except in the
tools-absent fallback:

```
## Agent-pick (Step 0.5)
Implementer: <id> (<reason>)
Crew reviewer(s): <id, id> (<reason>)
Host reviewer: <host via native subagent | foreground native | inline fallback | omitted> (<reason>)
This block is included in downstream prompts so reviewers can audit agent-pick consistency across rounds.
```

If a later round uses different picks without a documented user
override, stop and re-confirm before dispatching again.

### Step 1 — Dispatch implementer

The implementer runs in its own worktree under `workspace-write`, so it
is the one place the `[M]` commands can actually run before the captain
re-checks. Make the task description require it: for every `[M]`
criterion, run the command and report the exact command + its exit code
in the run summary. That reported run is the captain's first mechanical
signal (corroborated, not trusted blindly — Step 3).

```
run_agent({
  agent_id: <implementer>,
  criteria_set_id: <confirmed criteria_set_id>,
  prompt: <task description, ending with
    "Before you finish: run every [M] criterion's command and report
     the command + exit code in your summary.">,
  effort: <one level higher than for raw implementation, clamped at "max">,
  peer_messages: [
    { body: <agent-pick block, verbatim from Step 0.5>,
      kind: "note", from_label: "agent picks" }
  ]
})
```

- Do not restate criteria inline or in `peer_messages`; `criteria_set_id`
  makes the server prepend the non-droppable criteria contract to the
  composed prompt.
- Pick `effort` one level higher than for a raw implementation
  (**clamped at `max`**) — review catches mid-effort regressions but
  can't recover from a low-effort foundation.
- Use the implementer confirmed in Step 0.5. If that pick came from
  the fallback heuristic (no user default covered it), match the
  criteria profile: mechanical-heavy → fast-iteration profile;
  behavioral-heavy → careful-reasoning profile. Heterogeneity between
  implementer and reviewer is only a tiebreaker for heuristic picks —
  never a reason to deviate from a confirmed Step 0.5 pick.
- If dispatch rejects the criteria contract, the dispatch-time criteria
  errors are exactly `criteria.unknown`, `criteria.not_confirmed`,
  `criteria.cross_repo`, `criteria.unparsable`,
  `criteria.unknown_schema_version`, `criteria.linkage_mismatch`, and
  `criteria.contract_too_large`. `criteria.invalid` belongs to
  `create_criteria` / `confirm_criteria` / `revise_criteria`
  validation, not dispatch.
- Confirm dispatch with `[tail in side terminal](<tail_url>)`, end
  the turn, spawn the watcher on Claude Code (per invariant #2).

### Step 2 — Review (crew + host native subagent, parallel)

When the implementer reaches terminal, dispatch the crew reviewer(s)
**and** run the host's review via a native subagent. Both review
against the SAME confirmed criteria set from Step 0. Crew dispatches
pass `criteria_set_id`; the server injects the non-droppable criteria
contract. Order matters: dispatch crew **first** (async), then launch
the host reviewer — so the panel is underway regardless of how the
host review runs (invariant #2).

**(a) Crew review (default-on).** Dispatch the reviewer(s) confirmed
in Step 0.5 — the exact set and count the user OK'd. Do not re-pick or
resize here, and do not swap in a different model for variety. The
dispatch mechanism depends on the count:

- **One reviewer → `run_agent`** (single read-only dispatch, below).
- **Two or more reviewers → `run_panel`** (one call, all reviewers at
  once; see §"1+1 vs panel" and the `run_panel` dispatch shape). Never
  fan out N separate `run_agent` calls by hand — you'd lose the
  `panel_id` and the `aggregate_panel` consolidation hook.

**(b) Host review (default-on, via native subagent).** This is the
host model's review vote. Crew can't dispatch your own host product
(invariant #5), so run it as a native subagent (`Agent` / `Task`) —
**not** `run_agent`. Launch it **after** the crew dispatch so the
panel never waits on it. Hand it the SAME `REVIEW_PROMPT_TEMPLATE`,
agent-pick block, implementer summary, and worktree path the crew
reviewers get; tell it review-only, do not edit. Native subagents have
no `criteria_set_id` param or `peer_messages` channel, so immediately
before launching the host reviewer, call
`get_criteria({criteria_set_id})` and build the subagent prompt from
that returned `rendered_block` plus the agent-pick block, implementer
summary, and worktree path. This is the one residual captain-inserted
criteria block, and it must come from `get_criteria` rather than memory
or hand reformatting.

- **Background it if your host supports it** (e.g. Claude Code's
  `run_in_background: true`) so chat stays available while it reviews.
- **If the native subagent is synchronous,** run it in the
  **foreground**. The crew panel is already async, so this blocks only
  the current turn, not the panel — keep it bounded. On a very large
  diff, tell the user you're holding the turn for it (or ask whether to
  drop the host reviewer for this round). A foreground fresh-context
  vote still beats an inline self-review.
- **Inline review is the last resort** — only when the host exposes no
  native subagent tool at all: read `A.summary`, `A.files_changed`, and
  the diff via the worktree path, scoring every criterion with the same
  schema. It shares the captain's context, so it's the host vote only
  when no fresh-context option exists — never a second vote stacked on a
  subagent that already ran.

The captain ALSO reads the diff to consolidate (Step 3) — that read is
mandatory orchestration QA, not an extra same-model vote. Don't
double-count the captain's read and the host subagent's review.

Single-reviewer dispatch:

```
run_agent({
  agent_id: <reviewer>,
  criteria_set_id: <confirmed criteria_set_id>,
  read_only: true,
  working_directory: <A.worktree_path>,
  peer_messages: [
    { body: <agent-pick block>, kind: "note",
      from_label: "agent picks" },
    { body: A.summary, files: A.files_changed,
      kind: "review", from_label: "implementer" }
  ],
  prompt: <REVIEW_PROMPT_TEMPLATE>
})
```

Panel dispatch:

```
run_panel({
  implementer_run_id: A,
  criteria_set_id: <confirmed criteria_set_id>,
  reviewers: [
    { agent_id: <reviewer>, prompt: <REVIEW_PROMPT_TEMPLATE>,
      read_only: true,
      peer_messages: [
        { body: <agent-pick block>, kind: "note",
          from_label: "agent picks" }
      ] }
  ]
})
```

**Skip review entirely** (crew AND host) only when the user says "no
review" out loud.

When to skip just the **crew** reviewer (the host review still runs):
- Typo / comment / pure-doc commit (<10 LOC, no production-code
  changes). The host review still runs and the captain still verifies
  any `[M]` criteria itself (below).

**The captain owns mechanical verification — not the crew reviewer.**
A dispatched reviewer runs read-only, and a read-only Codex reviewer
cannot run the suite at all (sandbox EPERM on Vitest's temp dirs). So
never gate the crew-reviewer decision on whether a criterion is `[M]`,
and never treat a reviewer's `[M]` score as the mechanical signal. The
captain re-runs every `[M]` command itself in the implementer's
worktree (Step 3); the implementer's own reported run is the first
signal, the captain's re-run is authoritative. Crew reviewers earn
their keep on `[B]`/`[N]` judgment and out-of-scope findings — dispatch
them for that.

**Always review on `partial` / `error`.** When the implementer
terminates with `partial` or `error`, the reviewer's read often
diagnoses why it stalled — diagnostic signal worth $0.01 even when
the captain plans to route the run back to the user.

Otherwise: always dispatch. The cost (~30–60s + ~$0.01) is dwarfed
by the cost of merging a regression the host review alone missed.

**1+1 vs panel** (the reviewer count was decided in Step 0.5 by
complexity — this is how each shape dispatches):
- **1+1** (host native review + one crew dispatched): one full review
  from a single crew model alongside the host's. Step 0.5 sized the
  change as narrow/low-risk.
- **Panel** (host native review + N crew dispatched via `run_panel`):
  Step 0.5 sized the change as moderate-to-complex or high-risk and
  picked ≥2 distinct models. Each model does a **full review** of the
  entire diff, then the
  captain consolidates findings and cross-checks for agreement and
  disagreement across models. The independent perspectives are the
  whole point of scaling the count up.
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
- The same `criteria_set_id` contract as every other crew reviewer.
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
  criteria_set_id: <confirmed criteria_set_id>,
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
path). The acceptance criteria are provided as the non-droppable
criteria contract injected at the top of this prompt. For a host-native
subagent review, the captain inserted the current
get_criteria({criteria_set_id}).rendered_block because native subagents
cannot receive MCP params. The implementer's own summary is included in
peer_messages or inline host-review context.

Your job has TWO parts:

PART 1 — Score every acceptance criterion. For each numbered criterion
in the criteria contract, decide (a criterion may carry `-`
sub-bullets — they are facets of that one criterion; score the numbered
parent as a whole, PASS only if every sub-bullet holds):

  PASS  — the change meets this criterion. State why in 1 line. For a
          file-content / `[B]` / `[N]` criterion, cite the file:line you
          read AND what it said.
  FAIL  — the change does not meet this criterion. State the gap in
          1-2 lines, cite file:line where relevant.
  N-A   — the criterion truly does not apply to this diff (extremely
          rare). Say why. The captain prompts the user for explicit
          acceptance before treating N-A as PASS.

For `[M]` MECHANICAL criteria (test command, lint, build): do NOT run
the command yourself — you are read-only and your sandbox may block the
temp-dir writes the runner needs. The captain re-runs every `[M]`
command itself and owns that score. Score `[M]` from your read of the
diff plus the implementer's reported run (in peer_messages): PASS if the
two are consistent, FAIL only if the diff contradicts the claim (cite
file:line). NEVER FAIL an `[M]` criterion because you could not run the
command — that is an environment limit, not a defect.

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
  - [1] <verbatim criterion label>: PASS|FAIL|N-A — <one-line reason;
        file:line evidence for [B]/[N], implementer-run consistency for [M]>
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
```

Specialty-specific concerns belong INSIDE the acceptance criteria
themselves (Step 0). If the user wants a security-lens reviewer,
they should have a "no new security exposure on auth handlers"
criterion.

### Step 3 — Iterate or converge

Once the host review and all crew reviewer verdicts are in, parse each
reviewer's criteria scoring + overall verdict. The stop condition is
mechanical.

**Captain mechanical pass (do this FIRST, before reading verdicts).**
For every `[M]` criterion, the captain runs the command itself in the
implementer's worktree (`A.worktree_path`) and records the exit code.
The captain has full write access there — no sandbox — so the runner's
temp writes succeed; this is the authoritative mechanical signal. These
captain scores OVERRIDE any reviewer's `[M]` score: a read-only
reviewer that FAILed an `[M]` criterion only because its sandbox
blocked the suite is discarded as environmental, not a defect.
Cross-check against the implementer's reported run — if the captain's
re-run disagrees with what the implementer claimed, that gap is itself
iterate-worthy signal. Only `[B]`/`[N]` criteria are scored from
reviewer output.

**Converged (go to Step 4).** ALL of:
- **every `[M]` criterion** exits cleanly in the captain's mechanical
  pass (above);
- **every `[B]`/`[N]` criterion** is scored PASS by every reviewer, OR
  N-A by every reviewer **with explicit user acceptance** (see N-A
  guard below — N-A is not free); no FAILs, no unscored, no malformed
  sections, no PASS+Criterion-N contradictions;
- every reviewer's overall verdict is APPROVE.

Because the reviewer template forces CRITICAL/MAJOR out-of-scope
findings into CHANGES_NEEDED, an APPROVE verdict is sufficient
evidence that no unresolved CRITICAL/MAJOR out-of-scope concerns
exist. MINOR/NIT out-of-scope findings are suppressed at the template
and never reach Step 3 — if you see one in Findings, treat the
reviewer as malformed and re-dispatch.

**Iterate (run another round).** ANY of:
- one or more `[M]` criteria failed the captain's mechanical pass, OR
- one or more `[B]`/`[N]` criteria FAILed by any reviewer, OR
- one or more reviewer overall verdicts is CHANGES_NEEDED.

**N-A guard (user-confirmation gate).** N-A is the escape hatch a
lazy reviewer can use to skip hard criteria; treating it as silent
PASS lets a reviewer N-A every difficult criterion and produce a
structurally valid APPROVE.

- If ANY reviewer scores N-A on ANY criterion, surface to the user
  before Step 4: "Reviewer X scored criterion N as N-A: '<reason>'.
  Accept N-A (treat as PASS), revise the criterion, override (treat
  as FAIL and continue iterating), or hand off?" Use the host's
  structured-question tool (AskUserQuestion on Claude Code) to present
  those options and capture the choice when available; if the host
  exposes no such tool, surface the options as prose and wait for a
  free-text reply. Either way, **Silence is not consent.**
- Treat N-A as malformed if the reviewer gave no reason or only a
  generic one — follow the malformed-output re-dispatch path.
- ≥2 N-A scores on the same criterion across rounds, OR ≥3 N-A
  scores spanning different criteria in one round, force a
  criteria-revision prompt — the criteria are likely malformed.

Do not soften this guard; do not skip the user prompt because the
N-A "looks reasonable."

**Cross-model consolidation (panels).** When using a panel, the
captain must produce a consolidated review report before iterating.
The host native subagent's review is one of the models here — fold it
in alongside the crew reviewers (`aggregate_panel` won't return it):

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
  criteria_set_id: <confirmed criteria_set_id>,
  peer_messages: [
    { body: <agent-pick block>, kind: "note",
      from_label: "agent picks (unchanged)" },
    { body: <host native review's failing criteria + findings>,
      kind: "review", from_label: "<host> native subagent review" },
      // label "captain inline review" if you used the inline fallback
    { body: <crew review's failing criteria + findings>,
      kind: "review", from_label: "${reviewer_agent_id} review",
      files: dispatched_review.files_changed },
    // one per crew reviewer if panel
  ],
  prompt: "Address these review findings. Specifically, make the
           FAILing criteria PASS under the injected criteria contract.
           Re-run every [M] criterion's command and report the command
           + exit code in your summary. Reply with a brief summary of
           what changed and which criteria you believe now pass."
})
```

For panels, the crew reviewer entries come from
`aggregate_panel({panel_id})` — pass its result as `peer_messages`
rather than hand-building the crew entries. Pass the same
`criteria_set_id` to `continue_run` and **hand-append the host review**
as one synthetic entry; `aggregate_panel` won't include it.

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
- **Criteria contract dispatch errors.** Stop and fix the store,
  confirmation, repo linkage, or prompt-size issue before retrying.
  The dispatch-time criteria errors are exactly `criteria.unknown`,
  `criteria.not_confirmed`, `criteria.cross_repo`,
  `criteria.unparsable`, `criteria.unknown_schema_version`,
  `criteria.linkage_mismatch`, and `criteria.contract_too_large`.
  `criteria.invalid` is limited to `create_criteria`,
  `confirm_criteria`, and `revise_criteria` validation.
- **A reviewer's `[M]` score never converges the loop.** `[M]` truth
  is the captain's mechanical pass, not reviewer output. If a reviewer
  PASSes an `[M]` criterion that the captain's re-run FAILs, the
  captain's score wins (iterate). If a reviewer FAILs an `[M]`
  criterion only because its sandbox blocked the command, ignore it —
  that is environmental, not a defect, and is NOT a malformed-output
  re-dispatch.
- **BLOCKING verdict.** Stop the loop. Surface the reviewer's
  Recommended action. Ask: "rethink the approach, revise the
  criteria, discard, or continue anyway?" Use the host's
  structured-question tool (AskUserQuestion on Claude Code) to present
  those options and capture the choice when available; if the host
  exposes no such tool, surface the options as prose and wait for a
  free-text reply. Either way, **Silence is not consent.** Do NOT
  silently continue.
- **Iteration cap reached (default 3 rounds per epoch; 9 total).**
  Reframe with criteria context: "We've iterated 3 rounds; criteria
  still failing: [2, 4]. Options: revise criteria → starts a new
  epoch (epoch-aware total cap still applies); switch implementer →
  continues current epoch; accept failing finding(s) and merge →
  carries into Step 4 as user-accepted/deferred (recorded in commit
  body); hand off → captain stops dispatching." Use the host's
  structured-question tool (AskUserQuestion on Claude Code) to present
  those options and capture the choice when available; if the host
  exposes no such tool, surface the options as prose and wait for a
  free-text reply. Either way, **Silence is not consent.**
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

Use the host's structured-question tool (AskUserQuestion on Claude
Code) to present Merge / Do not merge options and capture the choice
when available; if the host exposes no such tool, surface the options
as prose and wait for a free-text reply. Either way, **Silence is not
consent.** Wait for explicit "yes / go / merge" or the equivalent
Merge selection. Then:

```
merge_run({
  run_id: A,
  confirmed: true,
  merge_strategy: "squash",
  commit_title: <derived from criteria + implementer summary, ≤72 chars>,
  commit_body: <mentions criteria-driven loop, round count,
                deferred/accepted findings if any>
})
```

`commit_title` should describe what the run accomplished, not "crew
run abc123…". The run lands as a single commit carrying this title —
no merge-commit wrapper, no machine trailer.

**Strategy for the iterate loop: default `squash`.** The loop inherently
produces an implementation commit plus per-round fixup commits
(`continue_run` turns), so collapsing to one titled commit is almost
always right. Use `merge_strategy: "preserve"` only if the user
explicitly wants the individual commits kept — and confirm it, since
the iteration fixups rarely make a clean standalone stack. See the
umbrella `crew` body's "Pick the merge strategy" for the full rule and
the `confirmBeforeMerge` interaction.

After merge, `discard_run` the read-only reviewer runs (cleanup) and
acknowledge to the user.

## Operating guardrails (delta from umbrella)

- Reviewer effort defaults to mirror the implementer's. When you
  override, restate in the reviewer's prompt.
- The host review is mandatory and default-on (via its own native
  subagent — see Step 2b); inline review is its fallback only when no
  fresh-context subagent is available. You can't drop the host vote
  because a crew reviewer "is more thorough." Separately, the
  captain's own diff read is mandatory consolidation QA, not a second
  same-model vote — don't double-count it against the host review.
- Do not pre-allocate reviewer runs before the implementer
  terminates. Reviewer needs `working_directory: <A.worktree>`, and
  `A.worktree` is only stable post-terminal.
- For panel dispatches, use `run_panel` once after implementer
  terminates — do not call `run_agent` N times manually; you'll lose
  the `panel_id` / aggregation hook.

## Tools

The MCP surface this skill composes includes the criteria-store tools
`create_criteria`, `confirm_criteria`, `get_criteria`, and
`revise_criteria`, plus dispatch tools whose inputs accept
`criteria_set_id` (`run_agent`, `run_panel`, and `continue_run`).
Dispatch-time criteria errors are exactly `criteria.unknown`,
`criteria.not_confirmed`, `criteria.cross_repo`, `criteria.unparsable`,
`criteria.unknown_schema_version`, `criteria.linkage_mismatch`, and
`criteria.contract_too_large`. `criteria.invalid` is a validation error
for `create_criteria`, `confirm_criteria`, and `revise_criteria`.

The rendered installed tool list follows:

{{TOOL_LIST}}
