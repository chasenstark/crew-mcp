# Per-adapter event parsing

**Status:** Proposed 2026-05-06; revised 2026-05-06 (v2) after
codex round-1 review (run `c0cc53a8`, discarded). Replaces the
parked MCP Apps plan
(`docs/plans/parked/mcp-apps-dispatch-ux.md`) as the
universal-host approach to subagent insight.
**Anchor commits:** `c697efb` (Phase 1 of long-poll-cost-tuning —
markdown initial response + prefixed/folded progress chunks);
`cc3bb09` (async-first dispatch).
**Status-doc reconciliation:** if implemented, update
`docs/status/captain-flow-review-2026-04-29.md` (per AGENTS.md
rule that captain-flow changes reconcile that doc).

## Why this plan exists

The user's stated goal across the dispatch-UX investigation is:
**see what dispatched subagents are doing during a run**, not
just "dispatched, watching, done."

Today (after `c697efb`):
- `events_tail` from `get_run_status` is `string[]` of whatever
  the adapter emits via `task.onOutput`
  (`src/cli/commands/serve.ts:805`, the `run:stream` listener).
- Each adapter parses its own subprocess stream internally and
  emits processed strings, not raw subprocess output:
  - **Codex** (`src/adapters/codex.ts:194-360`): parses JSONL
    via `formatEventForStream(event: CodexEvent): string` and
    emits the formatted strings.
  - **Claude-code** (`src/adapters/claude-code.ts:177, 312`):
    extracts assistant text only; explicitly drops `tool_use`,
    `system`, `result` events.
  - **Gemini** (`src/adapters/gemini-cli.ts:280, 333`): uses
    `--output-format json` which only emits onOutput **after**
    the process returns — no live stream today.
- The captain skill body says "paraphrase the load-bearing
  parts; don't dump verbatim if long"
  (`skills/crew-captain.body.md:218`). The captain emits
  "Watching." / "Still working, no new output yet." — sparse,
  low-signal narration. Verified empirically in user's
  Claude Code session screenshot.

The MCP Apps direction (parked) would have delivered rich
insight via a host-rendered iframe — but conditional on host
support that we couldn't verify. This plan delivers insight by
**making each adapter emit semantic markdown lines** that the
captain renders verbatim per poll. Same captain text channel
that already works in every MCP host. Universal.

## What "insight" looks like

For a codex review run, today the captain says:

```
Dispatched as 31fe58a5. Watching.
Still working, no new output yet.
Done. Codex's review of c697efb...
```

After this plan, the captain says:

```
Dispatched as 31fe58a5. Watching.
[codex] reasoning: Looking at formatProgressLines edge cases
[codex] command: read serve.ts:830-870
[codex] reasoning: checking UTF-16 boundary in slice
[codex] command: grep -n PROGRESS_LINE_MAX_LEN
[codex] message: 2 medium issues to flag — UTF-16 split, MAX_LEN bounds body only
Done. Codex's review of c697efb...
```

Each line is adapter-pre-rendered. Captain echoes verbatim.
Same inference count as today; substantially higher
informational value per inference.

## v1 → v2 changelog (after first codex review)

The v1 plan put parsing on the **server** (a registry-by-adapter-id
in `serve.ts`'s `run:stream` listener). Codex's round-1 review
correctly flagged this as architecturally wrong: adapters already
parse JSON internally and emit only text via `onOutput`, so the
server has nothing to parse. **v2 moves parsing into the adapters.**
This matches the existing boundary; each adapter already knows its
own stream format.

Other v1 → v2 corrections:

- **Codex event taxonomy was wrong in v1.** Real events confirmed
  via `test/adapters/fixtures/codex-live-0.121.jsonl`:
  - Top-level types: `thread.started`, `turn.started`,
    `turn.completed`, `turn.failed`, `error`.
  - `item.completed` envelopes with item types: `agent_message`,
    `reasoning`, `command_execution`, `file_change`.
  - **NOT** `function_call`, `function_call_output`,
    `task_started`, `task_complete` (v1's sketch).
- **Existing parser infra**: the codex adapter already has
  `formatEventForStream` (`src/adapters/codex.ts:194`) and
  `test/adapters/codex.parser.test.ts`. v2 **extends** what
  exists rather than greenfielding a new parser.
- **Stale line ref fixed**: the `run:stream` listener is at
  `src/cli/commands/serve.ts:805`, not 1037-1056 (1037 is the
  long-poll waiter).
- **Gemini live-streaming is a real refactor**, not a small
  parser change. Currently `--output-format json` emits onOutput
  after the process returns. Switching to `stream-json` touches
  execution behavior, parsing, and tests. **Scoped as optional
  Phase 3** in v2 — codex + claude-code are the load-bearing
  adapters; gemini deferred.
- **Drops the `parsed.log` split.** v1 proposed two append-only
  files (raw + parsed). v2 doesn't need this — adapters already
  emit processed text to `onOutput`, which lands in events.log.
  We just make the processed text *better* (semantic markdown
  shape). events.log becomes the semantic stream; no separate
  parsed.log.
- **Other blockers from round-1** are tracked as known
  implementation concerns in the "Known issues for
  implementation" section below, not separate plan phases.
  They're real but addressable inside Phases 1-4 without
  separate design rounds.

## Architecture

### Where parsing lives: in the adapter

Each adapter is responsible for converting its own raw stream
events into pre-rendered semantic markdown lines and emitting
them via `task.onOutput`. The server-side `run:stream` listener
(`src/cli/commands/serve.ts:805`) is a passthrough — appends to
events.log, forwards to `notifications/progress`. No
server-side parser registry; no `parsed.log` sidecar.

Why this is cleaner than v1's server-side approach:
- The adapter already has the parsing logic. v1's idea of a
  separate server-side parser was a duplication.
- The adapter has access to richer event metadata (timing,
  tool names, file paths) that doesn't survive the
  `string` boundary of `onOutput`.
- `onOutput` semantics stay simple: one string in → one
  semantic line emitted (or zero if the event type is dropped).
- events.log (cursor-driven) becomes the canonical insight
  channel without an additional file.

### Line shape

```
[<agent>] <kind>: <summary>
```

- `<agent>`: adapter id (`codex`, `claude-code`, `gemini`).
- `<kind>`: short noun describing the event (`reasoning`,
  `command`, `message`, `file`, `error`, `turn`).
- `<summary>`: human-readable, ≤ ~120 chars after the prefix.

Length is bounded by `PROGRESS_LINE_MAX_LEN`
(`src/cli/commands/serve.ts:847`, today 240 inclusive of
prefix). Adapters truncate before emitting.

### What each adapter emits

#### Codex (priority — highest signal subagent for the user today)

Extend `formatEventForStream(event: CodexEvent): string`
(`src/adapters/codex.ts:194`) to produce semantic lines based on
the actual event taxonomy. Map per Phase 0 fixture capture; a
starting table:

| Codex event | Output line |
|---|---|
| `thread.started` | `[codex] turn: thread started` |
| `turn.started` | `[codex] turn: started` |
| `turn.completed` | `[codex] turn: completed` |
| `turn.failed` | `[codex] turn: failed (<reason>)` |
| `error` | `[codex] error: <message>` |
| `item.completed` (agent_message) | `[codex] message: <preview>` |
| `item.completed` (reasoning) | `[codex] reasoning: <preview>` |
| `item.completed` (command_execution) | `[codex] command: <command preview>` |
| `item.completed` (file_change) | `[codex] file: <op> <path>` |
| (unknown) | `[codex] event: <type>` (bounded fallback per round-1 review) |

The exact mapping is finalized during Phase 0 against current
codex 0.128 output (existing fixture is 0.121).

#### Claude-code

Currently `claude-code.ts:177` drops `tool_use`, `system`,
`result` events. Extend the stream extraction at
`claude-code.ts:312` to emit semantic lines for those event
types as well:

| stream-json event | Output line |
|---|---|
| `assistant` (text) | `[claude-code] message: <preview>` |
| `assistant` (tool_use) | `[claude-code] tool: <name>(<args preview>)` |
| `tool_result` | `[claude-code] result: <ok\|error>` |
| `system` | `[claude-code] system: <event>` (bounded; may filter noise) |
| `result` (terminal) | `[claude-code] turn: completed` |

Final mapping during Phase 0 against current claude-code 2.1.131.

#### Gemini (optional — Phase 3, can defer)

Live streaming requires switching dispatched gemini from
`--output-format json` to `stream-json`
(`gemini-cli.ts:280, 333`). Bigger scope: changes execution
behavior, response parsing, and tests. Scoped optional in this
plan; can ship codex + claude-code first and tackle gemini
separately if user reports it's worth the refactor.

#### Generic / openai-compatible

Passthrough — today's behavior. These adapters don't have
structured streams to parse. `[<agent>] <truncated raw line>`
is what they emit today via `formatProgressLines` for
notifications/progress; events_tail mirrors that.

### Skill body update

Today's polling lifecycle section
(`skills/crew-captain.body.md:215-227`) instructs paraphrase.
Replace with verbatim render:

> Each response either has new content or the run terminated.
> New `events_tail` lines are pre-rendered semantic markdown
> like `[codex] command: read serve.ts`. Print them verbatim,
> one per line. Do NOT paraphrase — the adapter already did the
> summarization. Cap at ~10 lines per poll-return; if more
> arrived, render the first 10 and say "(N more events)".

Guardrails:
- Render only when events_tail is non-empty.
- Cap lines per poll (~10) to bound assistant output if a
  parser bug emits noise.
- Keep the existing short silent-poll behavior ("still
  working, no new output yet") for empty polls
  (`crew-captain.body.md:223`).

### Token cost analysis

| | Today | After this plan |
|---|---|---|
| Inference count per 30-min run | ~30 | ~30 (unchanged) |
| Per-call input tokens | ~5K (full events_tail of formatted strings) | ~3K (semantic lines, smaller) |
| Per-call output tokens | ~200 (paraphrase) | ~100 (verbatim render, capped) |
| Insight per inference | low (paraphrase loses signal) | high (semantic events) |

Net: **slight token win, large insight win**. Same inference
cadence; better content per cadence.

## Known issues for implementation

Round-1 review surfaced these blockers besides the architecture
fix. They're real but addressable inside the implementation
phases below; flagged here so they're not forgotten:

1. **Long-poll wake alignment.** Today the long-poll wakes on
   any `run:stream` event (`serve.ts:1050`). With semantic
   emission, dropped/unknown events still produce a chunk
   (the bounded-unknown fallback above), so wake behavior is
   preserved. **Implementation must verify** this in tests —
   the captain shouldn't wake with empty events_tail.

2. **Per-poll output cap.** `readEventsSince` returns every
   line from cursor to head (`run-state.ts:347`); a chatty
   adapter could spam the captain. Skill-body cap (~10
   lines/poll) is one defense; consider also a server-side
   max in `buildGetRunStatusResponse` so the wire bounds it.

3. **Failure isolation.** Today `appendEvent` is wrapped in a
   try/catch (`serve.ts:807`) so logging cannot break dispatch.
   Adapter parsing changes (e.g., a JSON.parse throwing on a
   malformed event) must preserve this property — parser bugs
   degrade UX, never fail dispatch.

4. **Existing test churn.** Tests at
   `test/cli/commands/serve.test.ts:1291, 1481, 1654` assert
   `events_tail` is raw/unprefixed. Those need updates. Plus
   `test/adapters/codex.parser.test.ts` (existing) needs
   extension or replacement to cover the new semantic
   emission.

5. **Versioned fixtures.** Existing codex fixture is for
   0.121.0; user's local binary is 0.128.0. Phase 0 captures
   current fixtures; subsequent versions may need parser
   updates as taxonomies drift.

## Phases

Sized in days assuming one engineer; rough order-of-magnitude.

### Phase 0 — gating fixture capture (~1 day)

**Promoted to gating per round-1 review.** Output: a
fixture corpus + taxonomy table the implementation phases
implement against.

- Run a representative task through codex 0.128.0 (priority);
  capture raw subprocess stdout/stderr to a fixture. Compare
  against `test/adapters/fixtures/codex-live-0.121.jsonl`.
- Same for claude-code 2.1.131.
- For gemini, decide go/no-go on the live-stream refactor; if
  go, capture stream-json output. Otherwise, gemini stays
  passthrough.
- Document the per-adapter taxonomy table (event type →
  semantic line) in
  `docs/plans/active/per-adapter-event-parsing/taxonomies.md`
  or as fixture-adjacent comments.
- Identify any taxonomy drift between current binary and
  existing fixtures.

**Gate:** if codex 0.128's output is materially different
from 0.121's, update fixtures + revisit Phase 1 scope.

### Phase 1 — codex semantic emission (~2 days)

- Extend `formatEventForStream` at `codex.ts:194` to produce
  the semantic line shape per the Phase 0 taxonomy.
- Apply `PROGRESS_LINE_MAX_LEN` truncation (or use a shared
  helper).
- Bounded-unknown fallback (`[codex] event: <type>`) for
  events not in the taxonomy.
- Try/catch around per-event formatting so a malformed event
  doesn't crash dispatch.
- Update `test/adapters/codex.parser.test.ts` to assert the
  new shape against current fixtures.

### Phase 2 — claude-code semantic emission (~1.5 days)

- Extend stream extraction at `claude-code.ts:177, 312` to
  emit semantic lines for tool_use, tool_result, system,
  result events (currently dropped).
- Apply same length cap + try/catch isolation.
- Tests against `test/adapters/fixtures/claude-success.json`
  and any new fixtures from Phase 0.

### Phase 3 — gemini live + emission (~2 days, OPTIONAL)

- Switch dispatched gemini from `--output-format json` to
  `stream-json` (`gemini-cli.ts:280`).
- Update execution path so onOutput fires per stream event,
  not at process exit (`gemini-cli.ts:333`).
- Implement semantic emission per Phase 0 taxonomy.
- Tests + manual QA on a real gemini dispatch.

**This phase is optional** — codex + claude-code carry the
load-bearing user value. Gemini can stay non-streamed in v1
and ship as a follow-up if user reports it's worth the
refactor.

### Phase 4 — wiring + skill body + tests (~1 day)

- `RunEnvelope.events_log_path: string` added so power users
  can `tail -f` events.log directly. Surfaced in initial
  dispatch markdown + on `get_run_status` responses.
- Server-side per-poll cap on events_tail (defense in depth
  alongside skill-body cap).
- Update existing serve.test.ts assertions
  (`:1291, :1481, :1654`) to expect semantic lines.
- Update `skills/crew-captain.body.md` polling lifecycle
  section per the spec above.

### Phase 5 — cleanup, plan re-anchor, status doc (~half-day)

- Update `long-poll-cost-tuning.md` to mark sections 2 + 3 as
  partially superseded — captain DOES narrate, but renders
  semantic events. Section 1 stays parked under original
  criteria.
- Update `docs/status/captain-flow-review-2026-04-29.md` per
  AGENTS.md.

**Total realistic effort: ~5-6 days for codex + claude-code +
wiring + skill body + cleanup. +2 days if gemini Phase 3 is in
scope.**

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Codex 0.128 taxonomy differs from 0.121 fixture | Medium | Phase 0 captures current. If wide drift, Phase 1 scope expands to cover new types. |
| Adapter parsing change breaks dispatch on malformed event | Medium | Try/catch around per-event formatting (preserve `appendEvent`'s isolation property). Bounded-unknown fallback for unrecognized events. |
| Captain rendering chatty parser produces wall of assistant output | Medium | Skill-body cap (~10 lines/poll) + server-side cap in `buildGetRunStatusResponse` for defense in depth. |
| Existing tests assume events_tail is raw/unprefixed | Low | Phase 4 includes test updates. Mock-adapter tests use simple text chunks; passthrough behavior preserved for those. |
| Gemini live-stream refactor is bigger than estimated | Low | Phase 3 is optional. Defer if it bloats. |
| Adapter-internal try/catch hides real bugs from logs | Low | Caught errors logged at warn level; tests cover happy path. |

## Out of scope

- MCP Apps iframe. Parked at
  `docs/plans/parked/mcp-apps-dispatch-ux.md`. Revisit if
  rich-UI needs surface beyond captain narration.
- Lifecycle redesign (captain ends turn, gets re-engaged on
  terminal). Different architecture; not pursued.
- Replacing the long-poll `get_run_status` primitive. Stays.
- Generic structured event API on `RunEnvelope`. events_tail
  stays `string[]`; structure is in the strings.
- LLM-driven summarization of events. Phase 0 captures via
  parsing rules; LLM summarization defeats the
  zero-extra-inference goal.
- Separate `parsed.log` file. v1's idea; v2 doesn't need it
  because adapters already do the processing.

## Sources

- `src/cli/commands/serve.ts:805` (run:stream listener),
  `:807` (appendEvent isolation pattern),
  `:847` (PROGRESS_LINE_MAX_LEN),
  `:1050` (long-poll wake on stream events),
  `:1003` (buildGetRunStatusResponse).
- `src/adapters/codex.ts:194` (formatEventForStream — extend
  here),
  `:350-360` (current onOutput call site).
- `src/adapters/claude-code.ts:177` (drops tool_use/system/result),
  `:312` (current text extraction).
- `src/adapters/gemini-cli.ts:280, 333` (json mode, no live
  stream).
- `src/orchestrator/run-state.ts:340-355` (events.log read/write),
  `:347` (readEventsSince — full cursor-to-head).
- `src/orchestrator/tools/get-run-status.ts:25` (current
  schema).
- `skills/crew-captain.body.md:218` (paraphrase guidance to
  drop), `:223` (silent-poll behavior to keep).
- `test/adapters/codex.parser.test.ts` (existing parser tests
  to extend).
- `test/adapters/fixtures/codex-live-0.121.jsonl` (existing
  fixture, may need refresh to 0.128).
- `test/cli/commands/serve.test.ts:1291, 1481, 1654` (tests
  asserting events_tail is raw/unprefixed — need updates).
- Anchor: `c697efb` (Phase 1 of long-poll-cost-tuning).
- Parked architectural alternative:
  `docs/plans/parked/mcp-apps-dispatch-ux.md`.
- Codex round-1 review: run `c0cc53a8` (discarded; findings
  preserved in this changelog).
