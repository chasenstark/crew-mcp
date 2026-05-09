# Await-run terminal wait

**Status:** Proposed.
**Created:** 2026-05-09.
**Related:** `docs/plans/active/long-poll-cost-tuning.md`,
`docs/status/captain-flow-review-2026-04-29.md`.

## Problem

The current dispatch lifecycle is async-first:

1. `run_agent` / `continue_run` returns `status: "running"`
   immediately.
2. The captain repeatedly calls `get_run_status` with
   `wait_for_change_ms`.
3. `get_run_status` wakes on signal stream events or terminal events,
   then returns a lean running payload until the run finishes.

This is portable and correct, but the tool name and loop shape teach
the captain to think in terms of polling. Even with server-side
long-polling, long runs can still produce repeated captain turns. The
user-facing behavior we actually want is simpler: dispatch once, then
wait until the run is terminal.

## Decision

Add a new MCP tool named `await_run` as the default post-dispatch wait
primitive.

`await_run` should block server-side until the run reaches a terminal
state or the wait timeout elapses. It should ignore stream events as
wakeups. Progress still flows through the existing side channels:

- MCP `notifications/progress` when the host supplies a progress token.
- `events.log`, `tail_url`, and `tail.command` for every host.

Keep `get_run_status` for compatibility, snapshots, debugging, and
lower-level clients that want cursor-based state reads.

## Proposed API

```ts
await_run({
  run_id: string,
  wait_for_terminal_ms?: number,
  max_events_tail?: number
})
```

Recommended captain usage:

```text
run_agent(...) -> { status: "running", run_id, tail_url }

await_run({ run_id, wait_for_terminal_ms: 60000 })
  -> terminal result when complete
  -> lean running result with timed_out: true if still running
```

`wait_for_terminal_ms` should be clamped by the server-side long-poll
cap so hosts with shorter MCP tool-call timeouts are not forced into
unsafe waits.

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
  "timed_out": true,
  "next_event_line": 123
}
```

The captain may immediately call `await_run` again with the same
`run_id`. No cursor is required for the default flow because terminal
responses return the recent full-log tail.

## Non-goals

- Do not remove `get_run_status`.
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

1. Add a new tool module:
   - `src/orchestrator/tools/await-run.ts`
   - zod schema
   - `AWAIT_RUN_DESCRIPTION`
   - exported `AwaitRunInput` type

2. Wire the tool catalog:
   - Export from `src/orchestrator/tools/index.ts`.
   - Add to `src/install/tool-catalog.ts`.
   - Ensure install/verify parity includes `await_run`.

3. Register the MCP handler in `src/cli/commands/serve.ts`:
   - Read `state.json` with `RunStateStore.read(run_id)`.
   - Unknown run id returns an MCP error.
   - Already-terminal runs return immediately.
   - Running runs wait on terminal dispatcher events only.
   - Timeout returns `{ status: "running", timed_out: true,
     next_event_line }`.

4. Share terminal response shaping:
   - Reuse or extract the terminal projection currently built for
     `get_run_status`.
   - Keep the terminal payload contract identical between
     `get_run_status` and `await_run` where possible.
   - Preserve terminal `events_tail` filtering and `max_events_tail`
     behavior.

5. Update the captain skill:
   - Edit `skills/crew-captain.body.md`.
   - Make the default lifecycle:
     `run_agent` / `continue_run` -> `await_run` until terminal.
   - Reframe `get_run_status` as a fallback/snapshot/debug tool.
   - Keep the tail-link guidance and merge/discard confirmation rules.

6. Update docs:
   - Update `docs/plans/active/long-poll-cost-tuning.md` to mark the
     terminal-only wait path as the chosen direction.
   - Update `docs/status/captain-flow-review-2026-04-29.md` if the
     implementation materially changes the current captain-flow
     baseline.
   - Update architecture docs if the live tool surface or lifecycle
     tables are changed.

## Tests

Add or update tests for:

- `await_run` appears in `listTools`.
- install catalog parity includes `await_run`.
- unknown `run_id` errors.
- already-terminal run returns immediately.
- running run does not return on stream chunks.
- running run returns terminal payload when the adapter completes.
- timeout returns `{ status: "running", timed_out: true }`.
- cancelled run returns terminal `cancelled`.
- terminal payload honors `max_events_tail` and skipped marker behavior.
- skill renderer includes the `await_run` default flow.

## Acceptance Criteria

- Captains can use `await_run` as the normal post-dispatch wait tool.
- A run with continuous stream output does not cause repeated captain
  wakeups before terminal.
- The user can still observe progress through existing progress
  notifications or tail links.
- `get_run_status` remains available and backward compatible.
- `npm run test:run` and `npm run lint` pass.

## Open Questions

- Should `wait_for_terminal_ms` default to the current
  `MAX_LONG_POLL_MS`, or should the captain skill always pass it
  explicitly?
- Should there be an environment override for the wait cap before this
  ships, or should that remain part of the separate long-poll tuning
  plan?
- Should `await_run` include `events_log_path` or other static dispatch
  fields on timeout, or keep timeout payloads as lean as running
  `get_run_status` payloads?
