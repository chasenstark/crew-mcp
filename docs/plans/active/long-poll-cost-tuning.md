# Long-poll cost + UX tuning

**Status:** Phase 1 shipped 2026-05-06 — markdown initial response
(`run_agent` / `continue_run` tool result) + `[<agent>] `-prefixed,
line-split progress notifications bounded to 240 chars including the
prefix. Phase 2 (sections 2 + 3) parked pending field-time with the new
inline channel.
**Anchor commits:** `cc3bb09` — `feat(serve): async-first dispatch +
long-poll get_run_status + drop subprocess timeout`. Phase 1 commit
`c697efb`.
**Trigger to unpark Phase 2:** the cost-vs-UX tradeoff that motivated
sections 2 + 3 flipped once Phase 1 landed — #5 carries real inline
signal at zero captain inference cost, so going quieter on poll-return
no longer trades UX for cost. Re-evaluate after ~a week of dogfooding
the new payload: do users still report "appears hung," do per-poll
captain narrations still feel duplicative, does the captain need a
reliable host-streams-progress signal to branch on. Sections 1 + 4
remain on the original parked criteria (real cost pain or empirical
data on per-host MCP timeouts).

## Phase 1 — shipped 2026-05-06

Two surfaces, no schema changes, no captain-context cost.

- **#1 — markdown initial response.** `runDispatchAndRespond` in
  `src/cli/commands/serve.ts` now renders a markdown block
  (`**Dispatched** \`<agent>\` as run \`<id>\`...`) instead of
  `JSON.stringify(env, null, 2)`. `RunEnvelope.agent_id` added
  (optional, backward compat) so the captain — and any host UI
  reading `structuredContent` — can label the run without round-tripping
  through state.json. Cost: ~+20-50 tokens once per dispatch, sticky
  in captain context until compaction. Trivial.
- **#5 — prefixed/folded progress payload.** `installRunLifecycleListeners`
  threads agent name into the stream handler and runs each chunk
  through `formatProgressLines(agent, chunk)` before sending. Splits
  on newlines (multi-line buffer flushes become multiple discrete
  notifications), drops empty lines, prefixes `[<agent>] `, and
  truncates the body as needed so the complete notification is at most
  240 chars including prefix and `…`. `events_tail` retains the
  verbatim chunk — only the host-UI surface is bounded. Cost: zero
  captain inference tokens (`notifications/progress` is server→host UI,
  not appended to the captain's conversation context).
- **Verification scaffolding for `progressToken` presence.** Per-call
  info log unchanged (`progress token (agent=...): <value>`), but
  the FIRST occurrence each session now elevates to warn-level (on
  absence) or info (on presence) so the "is my host wired up?"
  question has a hard-to-miss startup answer. State lives on
  `buildCrewMcpServer`, so tests start clean.

Did NOT change: `events_tail` shape (still `string[]` of raw subprocess
output), captain skill-body narration guidance, `MAX_LONG_POLL_MS`,
or the request/response shape of `get_run_status`. Phase 2 is where
those would move.

## Context

The 2026-05-05 dispatch-architecture rewrite replaced the prior
sync-window-with-snapshot-poll model with **async-first dispatch +
long-poll `get_run_status` + dropped subprocess timeouts**:

- `run_agent` / `continue_run` always return
  `{ status: "running", run_id }` immediately.
- The captain drives lifecycle via
  `get_run_status({ run_id, wait_for_change_ms: 30000,
  since_event_line: <cursor> })` in a loop. The server holds each
  call open until: (a) any `run:stream | run:complete |
  run:failed | run:cancelled` event fires for this run, or (b)
  `wait_for_change_ms` elapses (server-clamped to
  `MAX_LONG_POLL_MS = 60_000`).
- Adapters no longer wall-clock-kill subprocesses; cancellation is
  captain-driven via `cancel_run` → `AbortController`.

The architecture works. The remaining tension is **cost vs. UX**
on long runs:

- Token cost during a 30s long-poll wait is zero (no inference
  happens while the tool call is in-flight). But each poll RETURN
  triggers one Claude turn (input = full context + new
  events_tail; output = Claude's response). For a 30-min Codex
  run with 30s polls, that's ~60 inference turns. With the 60s
  cap, ~30. Per-turn cost is small; accumulated is real.
- The user's host CLI shows a spinner during the in-flight tool
  call. Claude Code surfaces MCP `notifications/progress` inline
  inside that spinner area — so for hosts that supply
  `progressToken`, the user is already seeing live chunks during
  the long-poll wait. Codex (as of 2026-05, codex-cli 0.128.0)
  doesn't supply `progressToken`, so the captain's `events_tail`
  rendering is the only feedback channel there.
- The "conversation appears open" feel is just the spinner. It's
  correct; some users read it as hung.

## Options on the table (do not pick yet)

### 1. Bump `MAX_LONG_POLL_MS` (minimal change)

`src/cli/commands/serve.ts` constant. Currently 60s. Bumping to
120s or 180s halves or thirds inference-turn count for long runs
with no other change.

- **Pros:** one-line change. Captains pass arbitrary
  `wait_for_change_ms`; server clamps. Bumping the cap lets
  larger waits actually take effect.
- **Cons:** risk of tripping the host's MCP tool-call timeout.
  Codex's timeout is unknown but observably > 60s. Claude Code is
  generous (likely > 5min). A misbehaving host could close the
  request mid-wait, and we'd have wasted listener installs.
- **Mitigation:** make it configurable via `CREW_MAX_LONG_POLL_MS`
  env var (default still 60s), so power users can bump per-host.
- **Open question:** what's a safe default that won't break
  anyone? Need to test against codex + claude-code + gemini-cli
  empirically before bumping the global default.

### 2. Skill-body nudge: stay quiet during silent long-polls

**Post-Phase 1:** the framing here flips. Pre-#5 this section traded
visibility for cost ("the user is *technically* seeing progress
inline, so the captain doesn't need to re-render"). Post-#5 the inline
channel actually carries labeled, bounded, multi-line signal — going
quiet stops being a UX sacrifice and becomes a clean cost harvest.
Pair tightly with section 3: the captain can only safely stay quiet
on hosts that stream progress, so it needs a reliable signal to branch
on. Ready to ship when we have field-evidence that #5's inline payload
is doing the load-bearing work.

When the host streams progress notifications inline, the captain
re-rendering `events_tail` is duplicate output (and a Claude
inference turn). Skill body could say:

> If the user's host streams MCP `notifications/progress` inline
> (Claude Code does; codex CLI 0.128.0 doesn't), you don't need to
> re-render `events_tail` — they're already seeing it. Only speak
> on status change or to flag something the user should act on.
> Silent polls with progress streaming is the right UX, not a
> hung conversation.

- **Pros:** reduces per-poll output tokens significantly. Claude
  often won't speak at all on a poll-return that brought no new
  status, just freshly-rendered chunks the user already saw.
- **Cons:** the captain has to know whether the host streams
  progress. Today the only signal is the operator-facing stderr
  log we added (`progress token: <value>`). Captains can't read
  stderr. Two options:
  - Hardcode in the skill body the per-host status as of a
    specific date (works today, ages poorly).
  - Have `get_run_status` surface a `host_streams_progress: bool`
    field so the captain can branch reliably. Cheap to add.
- **Open question:** which option? Surface flag or static guidance?

### 3. Diagnostic surface in `get_run_status` response

**Post-Phase 1:** value goes up. Pre-#5 the captain's branch was
roughly symmetric (raw chunks rendered similarly across hosts);
post-#5 the two branches diverge meaningfully — inline-rendering hosts
get rich live UX free while non-inline hosts (codex CLI 0.128.0) still
need the captain to narrate verbatim. The flag becomes the right
primitive for that fork. Section 2 is the consumer of this signal,
so pair them.

Let `get_run_status` return a `host_streams_progress: bool`
alongside the cursor + status. The captain reads it on each poll
and decides whether to render `events_tail` or stay quiet. Server
knows the answer because it's the one tracking
`extra._meta?.progressToken` on each tool call.

- Storage: per-run, set on the first
  `run_agent` / `continue_run` and persisted to state.json.
- **Pros:** Claude doesn't have to guess.
- **Cons:** another `RunStateV1` field. Marginal complexity for
  marginal benefit if (2) already covers the common case.
- **Open question (resolved post-Phase 1):** surface flag, not static
  guidance. Static guidance ages poorly as host-streaming behavior
  drifts; the flag is cheap and stays correct.

### 4. `wait_for_terminal_only` flag on `get_run_status`

A boolean that says "block until status is terminal; ignore
stream events." For hosts that surface progress notifications
(Claude Code), the captain doesn't need wake-on-stream — it just
wants to know "is it done yet?" One long wait per poll instead of
many.

- **Pros:** cleanest separation. Progress notifications = user
  UX; long-poll-on-terminal = captain bookkeeping.
- **Cons:** API surface growth. Today the captain can simulate it
  by passing a high `wait_for_change_ms` and ignoring intermediate
  returns — but stream events still wake it, so it doesn't fully
  reduce poll-return count.
- **Open question:** is the API surface worth the simplicity? Or
  is the simulation good enough?

### 5. Background-CLI dispatch (rejected for now)

The user asked "should this happen in a background terminal?" The
shape would be: `crew-mcp wait-for-terminal <run_id>` as a CLI
subcommand the captain spawns via `Bash` in background mode. When
the run terminates, Claude wakes (one inference) and proceeds.

**Why rejected:** doesn't compose cleanly. Bash can't call MCP
tools directly, so we'd be reading state.json off disk through a
parallel API. The captain still needs to inference at the end to
take next steps. And the user loses live progress notifications
(which only fire during an active in-flight tool call). Net: more
complexity, less UX. Reconsider only if (1)–(4) prove insufficient
and inference cost becomes load-bearing.

## Decision criteria when we revisit

**Phase 2 (sections 2 + 3 paired)** — the post-#5 cost harvest.
Re-evaluate after ~a week of dogfooding the new inline payload:

- Does the captain's per-poll narration of `events_tail` still feel
  duplicative against the rich inline progress? (If yes, ship 2 + 3.)
- Are users still saying "appears hung" even with the labeled
  `[<agent>] ` chunks streaming inline? (If yes, the inline channel
  is doing its job and section 2 is safe to flip; if no, leave
  parked — visible captain narration is buying real reassurance.)
- Has any host besides codex CLI shown progress-notification gaps?
  (Drives whether section 3's flag is load-bearing or theoretical.)

**Sections 1 + 4** — original criteria still apply:

- Has long-run inference cost become load-bearing in real dogfooding
  (e.g., a multi-hour Codex run inflated costs noticeably)? Drives
  section 1 (`MAX_LONG_POLL_MS` bump).
- Do we have empirical data on per-host MCP tool-call timeouts so
  we can pick a safe default? Same.
- Does section 4's `wait_for_terminal_only` API actually simplify
  captain code beyond what the long `wait_for_change_ms` simulation
  gives us? Need a concrete code-shape comparison before adding API
  surface.

## Out of scope

- Anything that changes the dispatch lifecycle shape. Async-first
  is the durable architecture; this plan is purely cost/UX
  tuning on top.
- A general MCP server-push mechanism (server-initiated
  notifications outside of in-flight tool calls). MCP doesn't
  natively support that and we're not the right shape to extend it.
