# Long-poll cost + UX tuning

**Status:** Phase 1 shipped 2026-05-06 — markdown initial response
(`run_agent` / `continue_run` tool result) + `[<agent>] `-prefixed,
line-split progress notifications bounded to 240 chars including the
prefix. Phase 2's coordination model landed in `1a95fac`: running
polls return `events_tail: []`, captains coordinate rather than narrate,
and users follow progress through the side-channel (`tail.command` /
`events.log`). Section 3's host-progress diagnostic flag is superseded
for now because the captain no longer branches on running `events_tail`.
**Anchor commits:** `cc3bb09` — `feat(serve): async-first dispatch +
long-poll get_run_status + drop subprocess timeout`. Phase 1 commit
`c697efb`.
**Current dogfood trigger:** Phase 2 is no longer parked. Re-evaluate
after field-time with the side-channel model: do users still report
"appears hung," is `tail.command` discoverable enough on hosts without
inline progress, and do we need a future host-progress diagnostic for
some new branching behavior. Sections 1 + 4 remain on the original
parked criteria (real cost pain or empirical data on per-host MCP
timeouts).

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
  240 chars including prefix and `…`. `events.log` retains the
  verbatim chunk; `events_tail` now exposes the recent full-log tail
  only on terminal polls. Cost: zero captain inference tokens
  (`notifications/progress` is server→host UI, not appended to the
  captain's conversation context).
- **Verification scaffolding for `progressToken` presence.** Per-call
  info log unchanged (`progress token (agent=...): <value>`), but
  the FIRST occurrence each session now elevates to warn-level (on
  absence) or info (on presence) so the "is my host wired up?"
  question has a hard-to-miss startup answer. State lives on
  `buildCrewMcpServer`, so tests start clean.

Later change in `1a95fac`: `events_tail` is still a `string[]`, but it
is terminal-only; running polls intentionally return `[]`. The captain
skill body now tells captains to coordinate during the run and synthesize
at terminal, not re-render progress verbatim. `MAX_LONG_POLL_MS` did not
change.

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
  status/cursor snapshot; output = Claude's response). For a 30-min
  run with 30s polls, that's ~60 inference turns. With the 60s cap,
  ~30. Per-turn cost is small; accumulated is real, but running
  polls no longer carry progress text in `events_tail`.
- The user's host CLI shows a spinner during the in-flight tool
  call. Claude Code surfaces MCP `notifications/progress` inline
  inside that spinner area — so for hosts that supply
  `progressToken`, the user is already seeing live chunks during
  the long-poll wait. Codex (as of 2026-05, codex-cli 0.128.0)
  doesn't supply `progressToken`, so the generated `tail.command` /
  `events.log` side-channel is the feedback path there.
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

### 2. Skill-body nudge: stay quiet during silent long-polls — landed

`1a95fac` implemented the stronger version of this: `get_run_status`
returns `events_tail: []` while the run is `running`, so the captain
coordinates and does not narrate per-poll progress. Progress lives in
host `notifications/progress` when available and in the generated
`tail.command` / `events.log` side-channel for every host. Terminal
polls still return the recent full-log tail so the captain has evidence
for its final synthesis.

Historical proposal preserved: when the host streamed progress
notifications inline, the captain re-rendering `events_tail` was
duplicate output (and a Claude inference turn). The stronger
terminal-only `events_tail` contract replaced this host-specific nudge.

> If the user's host streams MCP `notifications/progress` inline
> (Claude Code does; codex CLI 0.128.0 doesn't), you don't need to
> re-render `events_tail` — they're already seeing it. Only speak
> on status change or to flag something the user should act on.
> Silent polls with progress streaming is the right UX, not a
> hung conversation.

- **Outcome:** landed as a server-enforced running-poll contract, not
  just captain guidance. The captain no longer needs to inspect host
  progress support before staying quiet during running polls.

### 3. Diagnostic surface in `get_run_status` response — superseded

The proposed `host_streams_progress` flag is not needed for the model
that landed in `1a95fac`: the captain no longer branches on whether to
render running `events_tail`, because running `events_tail` is always
empty. Revisit only if we reintroduce host-specific captain narration.

Historical proposal preserved: let `get_run_status` return a
`host_streams_progress: bool` alongside the cursor + status. The
captain would read it on each poll and decide whether to render
`events_tail` or stay quiet. The terminal-only `events_tail` contract
removed that branch.

- Storage: per-run, set on the first
  `run_agent` / `continue_run` and persisted to state.json.
- **Pros:** Claude doesn't have to guess.
- **Cons:** another `RunStateV1` field. Marginal complexity for
  marginal benefit if (2) already covers the common case.
- **Outcome:** superseded until a future design needs host-specific
  captain behavior again.

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

**Phase 2 (sections 2 + 3 paired)** — landed/superseded by `1a95fac`.
Dogfood the implemented side-channel model instead:

- Does the absence of per-poll `events_tail` narration feel too quiet
  on hosts without inline progress?
- Are users still saying "appears hung" even with the labeled
  `[<agent>] ` chunks streaming inline or the `tail.command` helper
  available in the dispatch markdown?
- Has any host besides codex CLI shown progress-notification gaps?
  (Drives whether a future diagnostic flag becomes load-bearing again.)

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
