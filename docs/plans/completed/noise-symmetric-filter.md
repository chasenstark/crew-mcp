# Symmetric noise filter — apply `filterEventsTailNoise` to wakeup + cursor paths

**Status:** Shipped 2026-05-08. **Anchor commits:** `e9cacf8`
(`perf(captain-ctx): minimize multi-turn poll payload + filter codex
receipts`) introduced the response-side filter; this plan extended
it to the wakeup + cursor-advance paths that the same commit left
unchanged. **Related plan:** `noise-filter-at-source.md` (the
upstream-at-adapter alternative — still active; kept as the proper
end-state with this filter as defense-in-depth). **Sibling plan:**
`long-poll-cost-tuning.md`.

## What shipped

- `RunStateStore.readSignalEventsSince(runId, sinceLine)` in
  `src/orchestrator/run-state.ts` — filtered variant that drops
  receipt lines from the returned slice but advances `nextLine`
  against the raw file offset.
- `serve.ts` fast-return (was `serve.ts:541`) now uses
  `readSignalEventsSince`; receipt-only windows fall through to the
  long-poll wait.
- `waitForRunChange` `run:stream` listener (was `serve.ts:1248`)
  gates on `filterEventsTailNoise([info.chunk])` — receipts no
  longer wake the captain. Terminal events (`run:complete` /
  `run:failed` / `run:cancelled`) still wake unconditionally.
- `GET_RUN_STATUS_DESCRIPTION` updated to document the new wake-up
  contract (`src/orchestrator/tools/get-run-status.ts`).
- 5 new unit tests for `readSignalEventsSince` in
  `test/orchestrator/run-state.test.ts`.
- 2 new integration tests in `test/cli/commands/serve.test.ts`:
  `long-poll does NOT wake on adapter receipt chunks…` and
  `long-poll fast-return waits when only receipts have arrived…`.

Full suite: 711 passed / 3 skipped (pre-existing skips). `tsc
--noEmit` clean.

## Field report

Date: 2026-05-08. Captain dispatched a read-only docs-review run
to codex (`d6038a22-…`). The run took ~4.5 minutes. The captain
made ~40 `get_run_status` calls in that window; every running poll
returned `events_tail: []` and a `next_event_line` advance of 1–8
lines. Cursor crawled 0 → 121 in tiny increments. The user
intervened once they saw the context burn pattern.

## Diagnosis

`filterEventsTailNoise` (`src/orchestrator/events-filter.ts:57`)
strips ~88% of codex receipt lines from the response payload's
`events_tail`. It does **not** touch:

1. `tool-dispatcher.ts:78` — every chunk emits `run:stream`
   regardless of content.
2. `serve.ts:1248` — the `waitForRunChange` listener resolves on
   *any* `run:stream` for the run.
3. `serve.ts:541-551` — the "already-have-data" fast-return
   counts unfiltered raw log lines via
   `runStateStore.readEventsSince(runId, cursor)`.

Net effect on a chatty codex run:

- Receipt arrives → emits `run:stream` → wakes the long-poll.
- `get_run_status` call returns: `events_tail: []` (filter
  stripped the receipt) but `next_event_line` advanced (raw log
  did include it).
- Captain immediately polls again with the new cursor.
- `readEventsSince(cursor)` finds the next receipt past the cursor
  → fast-return, no wait.
- Repeat for every receipt the run emits.

Same number of round-trips as if the filter didn't exist; each one
carries zero signal. The filter trades visible payload for
invisible wakeup churn — strictly worse for context cost. Quiet
adapters (claude-code, gemini-cli) emit signal-dense chunks where
wakeup-per-event is correct, so they are unaffected.

## Proposal

Apply `filterEventsTailNoise` symmetrically at both wakeup gates.
The filter spec stays in one file
(`src/orchestrator/events-filter.ts`); call sites import it.

### Changes

1. **`runStateStore.readEventsSince` — add a filtered variant.**
   New helper, e.g.,
   `readSignalEventsSince(runId, cursor): { lines, nextCursor }`
   that runs `filterEventsTailNoise(rawLines)` before returning.
   Keep `readEventsSince` raw — `events_log_path` consumers (users
   tail-following the file) still get unfiltered chronology.
   Decide cursor accounting:
   - Option A: advance the cursor on raw lines (matches today's
     file offset). Captain's cursor stays in sync with the on-disk
     file; filtered helper just returns *fewer* lines. **Pick this.**
   - Option B: cursor counts only signal lines. Decouples on-disk
     position from logical progress; complicates log inspection.

2. **`serve.ts:541` — fast-return uses the filtered helper.**
   Replace `runStateStore.readEventsSince` call with
   `readSignalEventsSince`. If only receipts have been written
   since the cursor, fall through to the long-poll wait instead of
   returning instantly.

3. **`serve.ts:1248` — filter at the listener.** In
   `waitForRunChange`, wrap the `run:stream` listener so it only
   `finish()`es when the chunk would survive the filter. Cheap —
   it's a regex pass per event:
   ```ts
   args.dispatcher.onEvent('run:stream', (info) => {
     if (!matches(info)) return;
     if (filterEventsTailNoise([info.chunk]).length === 0) return;
     finish();
   })
   ```
   Terminal events (`run:complete` / `run:failed` /
   `run:cancelled`) are unchanged — they always wake.

4. **Tests.**
   - Unit test for `readSignalEventsSince`: mixed receipt + signal
     lines, cursor advances over receipts but only signal is
     returned; cursor matches raw file offset.
   - `waitForRunChange` test that emits a sequence of receipt
     chunks then one signal chunk; resolve fires only on the
     signal chunk (within `waitMs`); resolve also fires on
     terminal even if no signal chunks ever arrived.
   - End-to-end serve test: simulate a codex stream of N
     receipts followed by one assistant message; assert the
     captain's `get_run_status({ wait_for_change_ms })` returns
     once with the assistant message in `events_tail`, not N
     times empty.

5. **Docs.** Update
   `GET_RUN_STATUS_DESCRIPTION` (`src/orchestrator/tools/get-run-status.ts`)
   to mention that filtered-noise lines do not wake long-polls —
   captain skill body wording stays the same; this is server-side
   semantics, not captain discipline. Add a one-paragraph note in
   `docs/architecture/runners.md` (or its replacement after the
   docs-drift plan lands) describing the wakeup contract.

### Out of scope

- Adapter-side filtering at the source. Tracked in
  `noise-filter-at-source.md`. The two are not mutually exclusive
  — filtering at the source is strictly better but requires
  per-adapter changes; this plan is a one-day fix that sits where
  the filter already lives.
- Adding a `verbose: true` opt-out for the filter. Already parked
  in `docs/captain-context-backlog.md` — separate concern.

## Risk

- **Low.** Filter spec already exists and is tested
  (`test/orchestrator/events-filter.test.ts`). Both call sites are
  small. The only new behavior is "long-poll waits longer when a
  run only emits receipts" — which is the desired outcome, and is
  bounded by `MAX_LONG_POLL_MS` (60s) so a worst-case "run that
  only ever emits receipts until terminal" still wakes regularly.
- **Edge case:** a long run that emits *only* receipts for >60s
  then a terminal event. With the filter, the captain hits the
  `waitMs` ceiling and gets a snapshot with `events_tail: []`.
  Same as today's status quo for that snapshot. Acceptable.
- **Test coverage gap risk:** the existing
  `test/cli/commands/serve.test.ts` long-poll tests assert wakeup
  on first stream chunk; they need to be updated to assert wakeup
  on first **signal** stream chunk. Sweep before merging.

## Validation plan

1. Re-run a docs-audit dispatch (same prompt as `d6038a22`) and
   count `get_run_status` calls + cursor jumps. Target: ≤5 polls
   for the same run length, vs. ~40 today.
2. Re-run a claude-code dispatch (e.g., a code-review) and
   confirm wakeups still fire on every assistant chunk —
   no regression for signal-dense adapters.
3. Verify `events.log` on disk is unchanged (full chronology,
   tail-followable).

## Effort

~1–2 hours. Single-file logic in `serve.ts` + one helper in
`run-state.ts` + tests. No schema changes, no captain skill
changes, no adapter changes.

## Open questions

- Should `readSignalEventsSince` also expose the raw count so a
  future "running" payload can include a `noise_skipped: N`
  diagnostic? Would help confirm the fix worked in the field
  without hunting through `events.log`. Probably not worth the
  payload bytes — defer until evidence.
