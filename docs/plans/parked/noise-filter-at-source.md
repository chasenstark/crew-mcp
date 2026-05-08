# Filter noise at the adapter source — don't emit `run:stream` for receipts

> **PARKED 2026-05-08.** The captain-context burn this plan was
> meant to solve was resolved by `noise-symmetric-filter.md`
> shipping in `bf9f71c` — receipts no longer wake the captain or
> trip the fast-return. Remaining benefits are operational polish:
> readable `tail -F events.log`, slimmer disk usage, and an
> "adapters emit only signal" contract that lets `events-filter.ts`
> retire to pure defense-in-depth. None of those are urgent.
>
> Also: the predicate pseudocode in this plan as written
> (`event.kind === 'command' && event.phase === 'started'`) does
> NOT match the real `CodexEvent` shape — actual discriminators
> are `event.type` ('item.started' / 'item.completed') with
> nested `event.item.type` ('command_execution', 'agent_message',
> 'reasoning', 'file_change'). The third NOISE_PATTERN
> (`item.(started|completed)\/...`) catches the catch-all
> `codexEventFallback` path for unknown item.types (web_search,
> future protocol additions); the predicate translation has to
> enumerate "known signal" item.types and treat the rest as
> receipts. Fix the pseudocode before unparking.
>
> **Trigger to revisit:** a real signal that operational hygiene
> matters here — e.g., a user reports `tail -F events.log` is
> unusable, or disk pressure on long codex runs becomes a real
> issue, or a new noisy adapter is added and the registry-of-
> patterns approach starts feeling brittle. Until then, the
> response-side filter + the symmetric wakeup gate are doing
> the load-bearing work.

**Status:** Parked 2026-05-08. **Anchor commits:** `e9cacf8`
(response-side filter introduced); `bf9f71c` (symmetric wakeup gate
shipped — see `docs/plans/completed/noise-symmetric-filter.md`).
**Related plan:** `per-adapter-event-parsing.md` (which already
touches the codex adapter's stream parsing).

## Why this plan exists

`noise-symmetric-filter.md` patches the wakeup + cursor paths so
receipt lines stop waking the captain. That fixes the symptom but
keeps a registry of "noise patterns" that has to know about each
adapter's stream shape. The cleanest end-state is: **adapters
don't emit receipts as `run:stream` chunks in the first place.**

Consequences if we get there:

- `run:stream` becomes "the agent has new signal" rather than
  "the agent's subprocess wrote a line". Wakeup logic stays
  trivially correct without a filter pass.
- `events.log` no longer accumulates 88% receipt noise. `tail -F`
  on the side channel becomes readable without log-style filtering.
- `events-filter.ts` can shrink to a defensive backstop or be
  retired entirely. Filter spec lives next to the parser, not in a
  separate registry.
- The contract gets stronger: every `run:stream` chunk is meant to
  be read by a human or captain.

## Today's emission sites

- **Codex** (`src/adapters/codex.ts:482-491`): parses JSONL via
  `parseJsonlEvent`, formats with
  `formatEventForStream(event: CodexEvent): string`
  (`src/adapters/codex.ts:242`), and emits the formatted strings
  via `task.onOutput`. The filter rules in
  `src/orchestrator/events-filter.ts:37` map 1:1 to event shapes
  this formatter already distinguishes:
  - `command: started X` ↔ `event.kind === 'command_started'`
    (or however the codex protocol names it; verify).
  - `command: ... (exit 0)` ↔ `event.kind === 'command_exited'`
    && `event.exitCode === 0`.
  - `event: item.(started|completed)/...` ↔ tool/web-search
    lifecycle frames.
- **Claude-code** (`src/adapters/claude-code.ts:177, 312`):
  already drops `tool_use`, `system`, `result` events; only
  emits assistant text. No-op for this plan.
- **Gemini-cli** (`src/adapters/gemini-cli.ts:280, 333`):
  `--output-format json` returns once at end-of-process — no live
  stream. No-op for this plan.
- **OpenAI-compatible / generic**: pass model output through;
  receipt-style noise is rare. Audit before changing.

## Proposal

### Change 1 — codex adapter: skip receipt events at the parser seam

In `src/adapters/codex.ts:484-494` (`emitBufferedLine`), classify
the parsed event and gate the emit:

```ts
const event = parseJsonlEvent(trimmed);
if (!event) return;
if (isReceiptEvent(event)) {
  // Still durable in events.log via the side channel? No — the
  // side channel writes from the dispatcher's onStream listener,
  // which is exactly what we're suppressing. See "events.log
  // chronology" below for the trade-off.
  return;
}
const chunk = formatEventForStream(event);
if (chunk) task.onOutput!(chunk);
```

Add `isReceiptEvent(event: CodexEvent): boolean` next to
`formatEventForStream` in `src/adapters/codex.ts`. Keep its
predicate list close to today's `NOISE_PATTERNS` semantics:

```ts
function isReceiptEvent(event: CodexEvent): boolean {
  if (event.kind === 'command' && event.phase === 'started') return true;
  if (event.kind === 'command' && event.phase === 'exited' && event.exitCode === 0) return true;
  if (event.kind === 'item' && (event.phase === 'started' || event.phase === 'completed')) return true;
  return false;
}
```

(Exact `CodexEvent` shape may differ — verify against
`src/adapters/codex.ts` types before final wiring. The named
discriminators above are illustrative.)

### Change 2 — `events.log` chronology

`events.log` is written from
`installRunLifecycleListeners`'s `run:stream` listener
(`serve.ts:888`: `args.runStateStore.appendEvent(args.runId,
info.chunk)`). Suppressing receipt emits at the adapter means they
stop reaching `events.log` too — the `tail -F` user loses the
chronology of which commands ran.

Three options, in order of preference:

- **(A) Accept it.** The user-facing `tail.command` is for
  *progress narration*; the receipt chronology is debugging-grade
  data that lives in adapter-native logs (e.g.,
  `~/.codex/log/...`) anyway. Document the trade in the dispatch
  envelope's tail-helper text.
- **(B) Two streams.** Emit receipts via a separate dispatcher
  channel (`run:trace`?) that writes to events.log but does NOT
  fire the wakeup listener. Adds complexity to the dispatcher but
  keeps the on-disk chronology.
- **(C) Adapter writes its own log.** Adapter writes a
  `events.codex.log` next to `events.log` for full chronology;
  `events.log` becomes signal-only.

Recommend (A) for v1 — simpler and matches the architectural
direction of "MCP server is signal, adapter logs are debug."
Revisit if a user reports needing the chronology.

### Change 3 — retire `events-filter.ts`?

If receipts never enter the system from the codex parser, the
response-side filter has no input to act on. Options:

- **Keep as defensive backstop.** Cheap (one regex sweep on
  ~10 lines per terminal poll). Catches future bugs where an
  adapter regresses and starts emitting receipts. Recommend
  keeping.
- **Retire.** Saves ~60 lines of code + tests but loses the
  defense-in-depth.

Recommend keep. Add a JSDoc note saying the primary suppression
happened upstream and this is the second line of defense; mark the
file as low-traffic / no expected new rules.

### Change 4 — does `noise-symmetric-filter.md` still ship?

Three viable orderings:

- **Sequential, this plan first.** Better end-state, but each
  adapter is its own change. Slow.
- **Sequential, the symmetric filter first.** Quick relief; this
  plan ships later, after which the response-side filter becomes
  defense-in-depth.
- **Both ship — filter-at-source removes the producer; symmetric
  filter remains as a backstop.** Ships fastest, end-state is
  belt-and-suspenders.

Recommend the third. Ship `noise-symmetric-filter.md` first
(<1 day, low risk, immediate captain-context relief) and treat
this plan as the proper architectural fix that retires the
filter's day job.

## Tests

- Codex adapter unit tests: feed JSONL fixtures with a mix of
  receipts and assistant messages; assert `task.onOutput` is
  called only on signal events. Use the existing flush test at
  `test/adapters/codex.test.ts` (path approximate — verify) as a
  starting shape.
- Integration: dispatch a real codex run against a no-op prompt;
  assert `events.log` line count drops by ~88% vs. today's
  baseline. (Requires a baseline measurement first.)
- No regression for claude-code / gemini-cli — their stream
  shapes don't change.

## Risk

- **Medium.** Codex's event shape is the only thing this plan
  has to get right; mis-classifying a signal event as a receipt
  would silently drop information. Mitigation: be conservative —
  the `NOISE_PATTERNS` regexes today are narrow (3 patterns) and
  the predicate translation should mirror them precisely. Add a
  test fixture covering at least: command-started, command-exited
  exit 0, command-exited exit 1, web_search.started,
  web_search.completed, item.completed for a non-tool item, plus
  a normal assistant message.
- **Concern: non-zero exits.** `NOISE_PATTERNS` keeps `(exit 1)`
  intentionally. The predicate must not drop them. Test
  explicitly.
- **Concern: future codex protocol drift.** A version bump that
  renames event kinds will silently un-filter (better than
  silently dropping signal). Consider a version-aware
  `isReceiptEvent` or a comment pointing at the codex protocol
  doc/version anchor.

## Effort

~half-day for the codex adapter changes + tests. More if
`CodexEvent` discriminators don't already separate phase from
kind cleanly — may need a small parser refactor.

## Open questions

- Do we want a fallback "bypass filter" mode for support cases
  where someone reports lost output? `verbose: true` on
  `get_run_status` won't help if the lines never entered
  `events.log`. Maybe a `CREW_CODEX_RAW_STREAM=1` env knob that
  flips `isReceiptEvent` to always-false. Defer until evidence.
- Should we extend the same predicate-at-source pattern to a
  hypothetical noisy adapter we add later? The contract should
  be: *adapters emit only signal*; the dispatcher trusts that.
  Adding an adapter implies writing the predicate. Document this
  in `docs/architecture/adapters.md` (after the docs-drift plan
  rewrites it) as a hard rule, not a recommendation.
