# Get-run-status terminal-only wait

**Status:** Active implementation 2026-05-09. Do not move to
`docs/plans/completed/` until the implementing commit exists, so the
required plan-lifecycle anchor SHA can be recorded.
**Created:** 2026-05-09.
**Related:** `docs/plans/parked/long-poll-cost-tuning.md`,
`docs/status/captain-flow-review-2026-04-29.md`.

## Decision update — 2026-05-09

Post-evaluation direction changed from a new `await_run` MCP tool to a
`wait_for_terminal_only?: boolean` option on the existing
`get_run_status` tool.

Chosen behavior:

- Do not add a new tool. The runtime keeps one wait verb and one
  captain mental model.
- Keep `MAX_LONG_POLL_MS = 60_000`; captains still re-enter about
  every 60s for long runs. The win is that stream chunks no longer wake
  the captain between those capped waits.
- When `wait_for_terminal_only: true` times out while the run is still
  running, return `{ "status": "running", "timed_out": true }`.
  Suppress `next_event_line` and `events_tail` on that timeout path
  because terminal-only callers keep their prior cursor and terminal
  responses ignore the cursor anyway.
- Already-terminal runs still return the normal terminal
  `get_run_status` payload immediately.

## Problem

The current dispatch lifecycle is async-first:

1. `run_agent` / `continue_run` returns `status: "running"`
   immediately.
2. The captain repeatedly calls `get_run_status` with
   `wait_for_change_ms`.
3. `get_run_status` wakes on signal stream events or terminal events,
   then returns a lean running payload until the run finishes.

This is portable and correct, but wake-on-stream means long runs with
steady output can still produce repeated captain turns. The user-facing
behavior we actually want is simpler: dispatch once, then keep
server-side waits open until either the run is terminal or the
server-side long-poll cap elapses.

## Decision

Add `wait_for_terminal_only?: boolean` to `get_run_status`.

When set with `wait_for_change_ms`, `get_run_status` blocks
server-side until the run reaches a terminal state or the wait timeout
elapses. It ignores stream events as wakeups. Progress still flows
through the existing side channels:

- MCP `notifications/progress` when the host supplies a progress token.
- `events.log`, `tail_url`, and `tail.command` for every host.

Leave flag-off `get_run_status` behavior unchanged for compatibility,
snapshots, debugging, and lower-level clients that want cursor-based
state reads that can wake on signal stream chunks.

## Proposed API

```ts
get_run_status({
  run_id: string,
  since_event_line?: number,
  wait_for_change_ms?: number,
  wait_for_terminal_only?: boolean,
  max_events_tail?: number
})
```

Recommended captain usage:

```text
run_agent(...) -> { status: "running", run_id, tail_url }

get_run_status({
  run_id,
  wait_for_change_ms: 30000,
  since_event_line: cursor,
  wait_for_terminal_only: true
})
  -> terminal result when complete
  -> lean running result with timed_out: true if still running
```

`wait_for_change_ms` remains clamped by the server-side long-poll cap
(`MAX_LONG_POLL_MS = 60_000`) so hosts with shorter MCP tool-call
timeouts are not forced into unsafe waits.

## Behavior

If the run is already terminal, return immediately with the same
synthesis surface as terminal `get_run_status`:

- `status`
- `summary`
- `filesChanged`
- `prompts`
- `events_tail`
- `events_tail_skipped` when applicable
- `lastError`, `warnings`, `mergeStatus`, `readOnly` when present

If the run is still running, wait for one of:

- `run:complete`
- `run:failed`
- `run:cancelled`
- timeout

Do not wake on `run:stream`. Stream output is for progress surfaces, not
captain coordination.

On timeout, return a lean payload:

```json
{
  "status": "running",
  "timed_out": true
}
```

The captain immediately calls `get_run_status` again with the same
`run_id` and the same cursor it already had. No new cursor is returned
on terminal-only timeout because terminal responses return the recent
full-log tail and ignore the cursor.

## Non-goals

- Do not remove or rename `get_run_status`.
- Do not add a permanent `await_run` tool.
- Do not implement a shell background process such as
  `crew-mcp wait-for-terminal <run_id> &`.
- Do not require the dispatched agent to write status files directly.
  Crew remains the owner of `state.json` and `events.log`.
- Do not change merge/discard safety rules.

## Why not a skill-only background process?

A skill can instruct the captain to run shell commands, but it cannot
guarantee the host wakes the model when a background process prints.
That approach is host-specific, adds shell permission friction, and
would duplicate the MCP API by reading `~/.crew/runs/<runId>/state.json`
directly. The stronger design is to keep the wait inside the MCP server
and expose it as a normal tool result.

## Implementation Plan

1. Extend `src/orchestrator/tools/get-run-status.ts`:
   - Add `wait_for_terminal_only?: boolean` to the zod schema.
   - Update `GET_RUN_STATUS_DESCRIPTION` with the terminal-only wait
     contract.

2. Update the existing `get_run_status` MCP handler in
   `src/cli/commands/serve.ts`:
   - Read `state.json` with `RunStateStore.read(run_id)`.
   - Unknown run id returns an MCP error.
   - Already-terminal runs return immediately.
   - Flag-off behavior remains unchanged.
   - Flag-on running runs skip the already-have-signal fast-return and
     wait on terminal dispatcher events only.
   - Timeout returns `{ status: "running", timed_out: true }`.

3. Reuse terminal response shaping:
   - Reuse or extract the terminal projection currently built for
     `get_run_status`.
   - Keep the terminal payload contract identical to existing terminal
     `get_run_status`.
   - Preserve terminal `events_tail` filtering and `max_events_tail`
     behavior.

4. Update the captain skill:
   - Edit `skills/crew-captain.body.md`.
   - Make the default lifecycle call
     `get_run_status({ run_id, wait_for_change_ms: 30000,
     since_event_line: cursor, wait_for_terminal_only: true })`.
   - On `timed_out: true`, re-call with the prior cursor.
   - Keep the tail-link guidance and merge/discard confirmation rules.

5. Update docs:
   - Update `docs/plans/parked/long-poll-cost-tuning.md` to mark the
     terminal-only wait path as the chosen direction.
   - Update `docs/status/captain-flow-review-2026-04-29.md` if the
     implementation materially changes the current captain-flow
     baseline.
   - Update architecture docs if the live tool surface or lifecycle
     tables are changed.

## Tests

Add or update tests for:

- unknown `run_id` errors.
- already-terminal run returns immediately.
- running run does not return on stream chunks.
- running run returns terminal payload when the adapter completes.
- timeout returns `{ status: "running", timed_out: true }` without
  `next_event_line` or `events_tail`.
- cancelled run returns terminal `cancelled`.
- terminal payload honors `max_events_tail` and skipped marker behavior.
- signal events already present past the cursor do not fast-return in
  terminal-only mode.
- flag-off long-poll behavior remains unchanged.
- install catalog parity still passes without a new tool entry.
- skill renderer includes the terminal-only default flow.

## Acceptance Criteria

- Captains can use `get_run_status` terminal-only mode as the normal
  post-dispatch wait path.
- A run with continuous stream output does not cause repeated captain
  wakeups before terminal, except for capped timeout re-entry.
- The user can still observe progress through existing progress
  notifications or tail links.
- `get_run_status` remains available and backward compatible.
- `npm run test:run` and `npm run lint` pass.

## Open Questions

- Should there be an environment override for the wait cap before this
  ships, or should that remain part of the separate long-poll tuning
  plan? Current decision: keep `MAX_LONG_POLL_MS = 60_000` unchanged.
