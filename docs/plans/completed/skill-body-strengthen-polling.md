# Strengthen captain skill: forbid turn-ending waits during a `running` dispatch

**Status:** applied 2026-05-05.
**Anchor commit:** `cc3bb09` — async-first dispatch + long-poll
`get_run_status`. **Related plan:** `long-poll-cost-tuning.md`
(parked). **Source skill:** `skills/crew-captain.body.md`.

## Field report

Date: 2026-05-05. User running Claude Code as captain to manage a
multi-branch Graphite stack against the assembled repo. Captain
dispatched `codex` for Branch 1, said "Polling.", made one
`get_run_status` call, then emitted:

> "I'll poll back in ~4 minutes (staying inside the prompt-cache
> window)."
> `✻ Sautéed for 2m 57s`

Run `117b294f-…` was genuinely running on the new build the whole
time — `events.log` accumulated 11 narration lines (sandbox
blockers, test failures, vet output) while the captain was idle.
The user broke the silence by typing `re-read the crew skill`.

## Diagnosis

Build, install, and server-side run state were all correct:

- `dist/index.js` mtime `2026-05-05 15:42`, contains
  `wait_for_change_ms` / `waitForRunChange` / `MAX_LONG_POLL_MS`
  (8 hits), zero `asyncFallbackMs` references.
- `~/.claude/skills/crew/SKILL.md` (May 5 15:42) carries the
  current `## Polling lifecycle — every dispatch` block with the
  `wait_for_change_ms: 30000` instruction and a "don't go silent"
  line.
- Run `117b294f-…` `state.json` `status: "running"` with worktree
  alive and `events.log` streaming new lines normally.

The captain was not blocked by infrastructure. It read the skill,
chose to interpret "poll in a loop" as "schedule a wake-up", and
rationalized the choice via prompt-cache economics — exactly the
trade-off `long-poll-cost-tuning.md` parked as **not** the default.

Root cause: Claude Code captains have `ScheduleWakeup`, `/loop`
dynamic mode, and `CronCreate` in their tool inventory and a
strong native bias toward minimizing idle inference cost. The
current skill body says "don't go silent" but does not name those
specific anti-patterns. The gap between "don't go silent" (a UX
constraint) and "stay in the same turn" (a mechanical constraint)
is what the captain walked through.

## Proposed change

Replace the `## Polling lifecycle — every dispatch` block in
`skills/crew-captain.body.md` with a version that:

1. Adds an explicit **"stay in the same turn"** subsection naming
   `ScheduleWakeup`, `/loop`, `CronCreate`, and "check back in N
   minutes" patterns by name. Frames the long-poll tool call
   itself as the wait, not a thing to optimize around.
2. Pre-empts the prompt-cache / token-cost rationalization with a
   pointer to `long-poll-cost-tuning.md` — a captain that wants
   to relitigate the cost question knows where the conversation
   lives, but doesn't get to relitigate it inline by violating
   the default.
3. Adds a **worked example** showing three successive
   `get_run_status` calls in one turn. Concrete shape — captains
   pattern-match on examples better than on prose rules.
4. Keeps existing content (cancellation, progress notifications)
   verbatim under their own subheadings.

### Drafted body

```markdown
## Polling lifecycle — every dispatch

`run_agent` and `continue_run` are **async-first**: they always
return `{ status: "running", run_id }` immediately. You drive the
lifecycle from `get_run_status`. There is no "fast path" that
returns terminal inline — even sub-second runs come back as
`running` and you make one quick poll to terminal.

### Hard rule: stay in the same turn

While a run is `running`, **do not end your turn**. Do not use
`ScheduleWakeup`, `/loop` dynamic mode, `CronCreate`, "I'll check
back in N minutes" patterns, or any other mechanism that hands
control back to the user and resumes later. The long-poll
`get_run_status` call **is** the wait. Holding the turn open
through repeated long-polls is the intended design — not a token
leak to optimize away.

If you find yourself reasoning about "prompt-cache windows" or
"saving tokens by waking up later": **stop**. That trade-off has
already been considered (see
`docs/plans/parked/long-poll-cost-tuning.md` in the crew-mcp
repo) and explicitly rejected as the default. The user is
watching a render loop; silence reads as hung.

### The polling loop

1. Dispatch. Confirm the run_id back to the user briefly (one line).
2. Call `get_run_status({ run_id, wait_for_change_ms: 30000,
   since_event_line: <last cursor> })`. Start the cursor at 0; on
   each response, update it from `next_event_line`.
3. **Each response either has new content or the run terminated.**
   Server-side the call blocks until either: (a) new events
   appear, (b) the run reaches a terminal status, or (c) the 30s
   wait expires. Surface the `events_tail` lines (paraphrase the
   load-bearing parts; don't dump verbatim if long).
4. **Immediately call `get_run_status` again** with the updated
   cursor. Same turn. No wakeups, no scheduled returns.
5. Exit the loop when `status` is `success | partial | error |
   cancelled` (or — for read-only runs — also `discarded`).
6. Surface the final summary (latest prompt's `summary`) and ask
   about merge / iterate / discard.

If a 30s poll returns with no new events, say one short line
("still working, no new output yet") and re-poll in the same
turn. The model's instinct to minimize idle cost by ending the
turn is wrong here — override it.

### Worked shape

```
run_agent(...)              → { status: "running", run_id: R }
"Dispatched as R. Watching."
get_run_status({R, wait_for_change_ms: 30000, since_event_line: 0})
  → events_tail: [...], next_event_line: 4, status: "running"
"<paraphrase of events>"
get_run_status({R, wait_for_change_ms: 30000, since_event_line: 4})
  → events_tail: [...], next_event_line: 9, status: "running"
"<paraphrase>"
get_run_status({R, wait_for_change_ms: 30000, since_event_line: 9})
  → events_tail: [...], next_event_line: 11, status: "success",
    summary: "..."
"Done. <summary>. Merge / iterate / discard?"
```

All of that happens inside one captain turn. The user types
nothing between the dispatch and the merge prompt.

### Cancellation

`cancel_run({ run_id })` aborts the in-flight dispatch. The status
will land as `cancelled` on the next poll.

### Progress streaming via MCP

Some hosts also surface `notifications/progress` (chunks render
inline in the host UI without you doing anything). That's parallel
to — not a replacement for — the polling loop. Always poll.
```

## Risks / open questions

- **Tool-name coupling.** `ScheduleWakeup` / `CronCreate` /
  `/loop` are Claude Code captain tools, not universal. Naming
  them in a portable skill body is fine (Codex captains will
  ignore the names; the prose still constrains them) but ages
  poorly if the tool surface drifts. Acceptable cost — the
  alternative is generic prose the captain reinterprets, which
  is exactly the failure mode we're patching.
- **Pointer back into crew-mcp repo from skill.** The drafted
  text references `docs/plans/parked/long-poll-cost-tuning.md`
  in the crew-mcp repo. Captains running in arbitrary host repos
  can't follow that path. That's intentional — the pointer is a
  signal to the captain that the trade-off has been adjudicated,
  not a Read target. Could be reworded as "the crew-mcp project
  has explicitly considered this trade-off" if the path
  reference reads as misleading.
- **Length.** The skill body is already long; this adds ~40
  lines. Could trim the worked example or move it to a separate
  reference doc loaded on demand. Lean toward keeping inline:
  the worked example is doing the load-bearing work for the
  pattern-matcher case.
- **Codex captain compliance.** Need to confirm the same
  reformulation lands well in `~/.codex/prompts/crew.md`. The
  Codex prompt template wraps the same body, so yes by
  construction, but worth verifying the rendered output reads
  cleanly there too.
- **Dogfood verification.** After applying, want to dispatch a
  Claude-captained run against a slow target (10+ min) and
  confirm the captain stays in-turn through the full lifecycle.
  Single-trial verification is weak — captain compliance is
  probabilistic — but a clean trial after a bad trial is real
  signal.

## Decision criteria

Ship when:
- We've decided the field-report failure mode is bad enough to
  warrant a skill change (consensus: yes — the user lost ~3
  minutes of progress visibility on a 30-minute run).
- We're not about to do a broader skill-body restructure that
  would conflict.
- We're prepared to rebuild + re-install the skill in the user's
  active session (`npm run build` → `crew-mcp install --target
  all` → restart Claude Code / Codex).

Hold if:
- A larger skill restructure is queued (avoid double-edit churn).
- We want to gather one more field report before deciding the
  exact wording (e.g., to see if other anti-patterns surface
  that should also be named).

## Out of scope

- Server-side enforcement of long-poll discipline (e.g.,
  rejecting `ScheduleWakeup`-style usage by detecting per-run
  poll frequency). The skill is the right lever; server-side
  policing is over-engineered.
- Reopening the cost / UX trade-off in `long-poll-cost-tuning.md`.
  This plan is purely about making the existing default stick;
  if the cost concern returns, it goes there, not here.
- Editing the broader skill body structure (dispatch-vs-inline
  rubric, escape hatch, merge boundary). Those have settled
  through their own revision cycles.
