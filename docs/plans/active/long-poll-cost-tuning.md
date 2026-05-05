# Long-poll cost + UX tuning

**Status:** parked. Not ready to decide. Revisit after more
field-time with the async-first architecture (commit `cc3bb09`).
**Anchor commit:** `cc3bb09` — `feat(serve): async-first dispatch +
long-poll get_run_status + drop subprocess timeout`.
**Trigger to unpark:** if real captain inference cost on long runs
becomes painful, or if the "appears hung but isn't" UX hits the
wrong people more than once.

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

- Has long-run inference cost become load-bearing in real
  dogfooding (e.g., a multi-hour Codex run inflated costs
  noticeably)?
- Has the "appears hung but isn't" UX confused users beyond a
  one-time learning moment?
- Do we have empirical data on per-host MCP tool-call timeouts so
  we can pick a safe `MAX_LONG_POLL_MS` default?
- Has any other host besides codex shown progress-notification
  gaps?

If any of those is "yes" with weight, ship (1) + (2) as a pair.
(3) and (4) are escalations only if (1) + (2) prove insufficient.

## Out of scope

- Anything that changes the dispatch lifecycle shape. Async-first
  is the durable architecture; this plan is purely cost/UX
  tuning on top.
- A general MCP server-push mechanism (server-initiated
  notifications outside of in-flight tool calls). MCP doesn't
  natively support that and we're not the right shape to extend it.
