# Captain skill body — sections retired during item #9 (2026-05-10)

Snapshot of prose removed from `skills/crew-captain.body.md` during the
condensation pass for `docs/plans/active/perf-context-audit-merged.md`
row #9. The pre-cut body is recoverable via `git show`; this file
preserves the verbatim text inline so future captain-flow work can
revisit *why* each section was written before deciding whether to bring
it back.

The audit row called for a "careful condensation, not a 180-line slash"
and a realistic ~300–350 line target validated by behavior, not blind
line-count. We landed on a conservative trim (~75 lines) to ~430 lines,
preserving every load-bearing rule and sub-section. Each cut below was
selected because the prose was overlap-with-elsewhere, hedge that
weakened a downstream rule, or rationale duplicating the rule it
supported.

Companion docs:
- `docs/captain-context-backlog.md:28–41` — parked-work entry that
  warned naive section-deletion risks weakening load-bearing prose.
- `feedback_skill_ask_user_enforcement` (memory) — preference to
  *strengthen* "ask the user" gates rather than trim them. Strengthening
  was applied during this same pass; see Cut 8.

---

## Cut 1 — "Decision order — the spine" (was a top-level section)

```
## Decision order — the spine

Run this in your head before reaching for any tool. Each step has its
own section below; this list is the ordering glue.

1. **Inline or dispatch?** No signal in the list above → inline; stop here.
2. **Ask first?** If any rubric item below fires, ask one question and wait.
3. **Dispatch.** `list_agents` → `run_agent` (or `continue_run` to resume an existing run).
4. **Iterate or surface.** Read the result; iterate inline (`continue_run` / second opinion) or summarize for the user.
5. **Merge / discard.** Only on explicit user approval. Never call `merge_run` or `discard_run` unprompted.
```

**Removed because:** numbered-list overlap with the "Default flow"
walkthrough that immediately follows. The 5 abstract steps and the 5
concrete steps narrate the same path twice; the concrete one is more
useful and load-bearing for fresh captains.

**Restore if:** captains in the field skip the walk-through and only
read the spine, or a future protocol step has no natural home in the
"Default flow" narrative.

---

## Cut 2 — "Don't dispatch to your own host product" rationale bullets

```
Why this matters:

- **Quota.** Both calls bill the same subscription / API key. A
  crew dispatch to your own product double-charges the user for
  the same model family.
- **Latency.** Native subagents skip the worktree allocation
  (~30–60s) and the merge/discard ceremony.
- **Context.** Native subagents return their result inline with
  no merge step; crew runs require an explicit merge or discard.
```

**Removed because:** rationale duplicates the rule above. The rule
"don't crew-dispatch to your own host" stands on its own; a captain
that needs to be told why double-billing matters is not the captain we
should write the playbook for.

**Restore if:** field reports show captains routing same-host work to
crew because the rule lacks teeth without rationale.

---

## Cut 3 — Merge boundary good/bad/worse `commit_title` examples

```
> Good: `commit_title: "fix(parser): handle empty-line input
correctly"` `commit_body: "Adds the empty-line guard to
parseLine() with a regression test."`
>
> Bad: `commit_title: "Codex did the parser fix"`
>
> Worse: omitting commit_title and letting it fall back to
> `Merge crew run <id>`.
```

**Removed because:** the rule above ("compose a conventional-style
subject … describing what the run accomplished, not that it was a crew
run") is concrete enough on its own. The triple-example was rhetorical
amplification, not new information.

**Restore if:** `git log` reads on merged runs start showing crew-prefix
subjects again.

---

## Cut 4 — Watcher allowlist explainer expansion

Original (~7 lines):

```
**Use `{{CREW_WAIT_COMMAND}}` exactly as written above** — the
install renders the literal command path your allowlist accepts
(either the bare `crew-wait` name when it's PATH-visible, or an
absolute path like `/usr/local/bin/crew-wait` when the install
fell back). Do not improvise the spelling — a different form will
not match the `Bash(...)` allowlist entry and the watcher will
fail to spawn.
```

Replaced with (~2 lines):

```
Use `{{CREW_WAIT_COMMAND}}` exactly as rendered — improvising the
spelling (bare name vs absolute path) will miss the `Bash(...)`
allowlist entry and the watcher won't spawn.
```

**Removed because:** the explainer about *why* the literal path
matters (PATH-visible vs install-fallback) is install-implementation
detail. The captain only needs the rule "use it as rendered or it
won't spawn."

**Restore if:** captains in the field improvise the command spelling
because the compressed form is too terse to convey the constraint.

---

## Cut 5 — "How users follow progress" rationale

Original (~20 lines):

```
### How users follow progress (not your problem)

Two side channels carry live progress without burning your context:

- **The inline tail link in your dispatch confirmation** — the
  `[tail in side terminal](<tail_url>)` markdown link you emit
  opens a side terminal on macOS via the `crew-tail://`
  handler. This is the user's main progress channel; surfacing it
  inline is the whole point of including the link in your reply
  rather than relying on the tool-result panel. If the handler
  isn't installed, the click does nothing useful — but the same is
  true of the `file://` fallback (Claude Code intercepts it into
  the editor), so `tail_url` is still the right choice; the user
  can manually run the `tail -F` command from the tool-result panel
  in that case.
- `tail.command` / `events.log` is the only default live-progress
  UX. Inline MCP `notifications/progress` chunks only exist while a
  tool call is in flight; the chat-available default flow ends the
  tool turn, so those inline notifications don't fire.

Both happen without you. Don't duplicate them by rendering events
into your reply.
```

Replaced with (~7 lines):

```
### How users follow progress (not your problem)

The inline `[tail in side terminal](<tail_url>)` link in your
dispatch confirmation is the user's main live-progress channel.
Don't duplicate it by rendering events into your reply. Inline
`notifications/progress` only fire while a tool call is in flight;
the chat-available default flow ends the turn, so those don't
apply here.
```

**Removed because:** the rationale (handler-fallback behavior, why
inline-notifications don't fire) is implementation detail. The rule
"don't duplicate the tail-link channel by rendering events inline" is
what's load-bearing.

**Restore if:** captains start re-rendering events into chat because
the compressed form doesn't connect "don't duplicate" to a concrete
mechanism.

---

## Cut 6 — Effort bullet rough-mapping table

Original (~19 lines):

```
- **Effort.** `run_agent` / `continue_run` accept
  `effort: "low" | "medium" | "high" | "xhigh" | "max"` (codex's
  `model_reasoning_effort` set), and `list_agents` surfaces the
  per-machine default. When you accept the default, pass nothing
  and don't add effort framing to the prompt. **When you
  intentionally choose or override the level**, do BOTH:
  1. Pass `effort: "<level>"` in the tool call (lets codex flip its
     native knob; claude-code / gemini-cli / openai-compatible
     ignore the constraint, but the call is harmless).
  2. Restate it in the prompt in one short line, e.g. `Apply
<level> reasoning effort: <one phrase about what that means
for this task>.`

  Without the prompt line, dispatching `effort: "high"` to
  claude-code does nothing — for those adapters the prompt is the
  only signal the model sees. Rough mapping:
  - `low`: classification, typo fixes, mechanical changes, quick sanity checks.
  - `medium`: ordinary implementation or review.
  - `high`: cross-file reasoning, non-trivial refactors, root-cause triage.
  - `xhigh` / `max`: correctness-critical work (auth, money, migrations), architectural changes, or when the user explicitly asks for an exhaustive pass.
```

Replaced with (~10 lines): preserves the do-BOTH rule, the per-adapter
caveat (codex has the native knob; others see only the prompt), and a
compressed mapping.

**Removed because:** prose around the rule was longer than the rule
itself. The 4-line mapping table compressed to 3 lines without losing
the practical guidance.

**Restore if:** captains start dispatching at the wrong effort tier
because the compressed mapping is too terse.

---

## Cut 7 — Read-only dispatches caveat prose

Compressed inline rather than removed wholesale: the four caveat
items (no-FS-isolation, merge_run-refuses, discard-reviewer-runs,
continue_run-stickiness, no-flag-wastes-worktree) are all preserved.
Cuts were limited to introductory prose and rationale around each
caveat (~8 lines saved).

**Restore if:** captains miss any of the caveats because the
compression dropped a load-bearing word.

---

## Cut 8 — strengthening (additions, not removals)

Per `feedback_skill_ask_user_enforcement` memory, the
"if you're unsure, default to inline" hedge in Dispatch-vs-inline
was replaced with concrete trigger language:

```
Default to inline whenever zero of the four dispatch signals applies
cleanly. Maybe-fits should not dispatch — they should ask. A 30–60s
dispatch followed by a discard is worse than a 5-second clarifying
question.
```

This strengthens the pre-dispatch gate without removing the
obvious-ask escape later in the rubric (which the memory explicitly
preserved as desirable).

---

## Net change

- Pre-cut: 508 lines / 24,466 bytes
- Post-cut: ~430 lines / ~20K bytes
- Reduction: ~75 lines (~15%)
- Sections preserved verbatim or load-bearing-equivalent: watcher
  overlay rules, synthetic-turn parse contract, `list_runs` fallback,
  multi-terminations rule, foreground opt-in hard gate, cancellation,
  Worked shape, all 5 ask-user rubric items, all 4 read-only caveats.
- Sections strengthened: dispatch-vs-inline hedge replaced with
  concrete trigger.

The audit's stated 300–350 target was rejected because it would have
required folding Worked shape into the Default flow narrative or
compressing the synthetic-turn / `list_runs` fallback subsections —
both load-bearing for chat-availability and `/clear`-recovery
behavior respectively.
