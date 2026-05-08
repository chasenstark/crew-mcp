# Captain context — parked follow-ups

Backlog of context-shrinkage opportunities for crew-mcp's captain-facing
surface (MCP tool descriptions, get_run_status payloads, dispatch
markdown, skill body). Items here were explicitly deprioritized during
the May 2026 audit cycle; reasons captured per item so future readers
can revisit with full context.

## Already shipped (May 2026 cycle)

Commits `2c62509`, `007cfba`, `e9cacf8`:

- 7 MCP tool descriptions trimmed (`run_agent`, `merge_run`,
  `get_run_status`, `continue_run`, `list_agents`, `cancel_run`,
  `discard_run`); load-bearing imperatives kept verbatim.
- `DEFAULT_MAX_EVENTS_TAIL`: 50 → 10.
- `events_tail` build skipped on `discarded` runs.
- Dispatch markdown parenthetical rationale removed.
- Per-turn `summary` dropped from `get_run_status` terminal payload
  (top-level `summary` still carries the latest turn's output).
- Codex command-receipt noise filtered from terminal `events_tail`
  via `src/orchestrator/events-filter.ts`.
- Dist parity test added (`test/install/dist-parity.test.ts`).
- Summary length distribution documented in `markTerminal` JSDoc.

## Parked items

### Surgical skill body trim

- **Where:** `skills/crew-captain.body.md` (~398 lines / ~5K tokens
  loaded every session that matches the skill).
- **Estimated savings:** 2-3K tokens per session.
- **Why parked:** the memory feedback record
  `feedback_skill_ask_user_enforcement` says the "ask the user" gates
  need *strengthening*, not trimming. A naive section-deletion pass
  risks weakening the very prose that's load-bearing.
- **If pursued:** tighten gate prose in place (drop hedges, condense
  sentences) rather than deleting sections like "Worked shape" or
  "How users follow progress". A/B against a few real dispatches to
  verify dispatch-vs-inline judgment + polling discipline aren't
  regressed.

### Dispatch markdown structural collapse

- **Where:** `renderDispatchMarkdown` in `src/cli/commands/serve.ts`.
- **Estimated savings:** ~250 chars per dispatch.
- **Why parked:** the markdown is also user-visible in the Claude
  Code tool-output panel when expanding a collapsed tool call.
  Collapsing to one line regresses human display. The parenthetical
  rationale trim already shipped (`007cfba`); the structural collapse
  is what's left.
- **If pursued:** verify Claude Code's tool-panel rendering of
  `structuredContent` vs `content[0].text`. Possibly dedupe
  individual fields (`run_id`, `status`) between markdown and
  envelope rather than gutting the markdown.

### Drop `tail_command_path` from dispatch envelope

- **Where:** `RunEnvelope.tail_command_path` in `serve.ts:139`.
  Redundant with `tail_command_url`, which carries the same info
  pre-encoded.
- **Estimated savings:** ~100 chars per dispatch.
- **Why parked:** the field has 7 test refs in `serve.test.ts`
  (including an entire test that uses it as the entry point for
  verifying the `tail.command` helper file's existence/perms/contents)
  and 2 doc refs. Cleanup churn outweighs the per-dispatch savings.
- **If pursued:** rewrite the helper-file test to compute the
  expected path independently via `runStateStore.tailCommandPath()`
  rather than reading it back from the envelope; update field-shape
  tests at `serve.test.ts:957, 990` and the `docs/status/captain-flow-review-2026-04-29.md`
  references.

### Resume-delta prompts (subagent-side)

- **Where:** `buildDecisionPrompt` in
  `src/adapters/tool-loop/transcript.ts:50`; call sites at
  `src/adapters/claude-code.ts:888`, `src/adapters/gemini-cli.ts:497`.
  On resume, adapters re-send the full system text + adapter
  protocol; only delta + a short reminder is needed.
- **Estimated savings:** per-resume turn savings on multi-turn
  dispatched runs; affects subagent token bill, not captain context.
- **Why parked:** off-target for the captain-context audit. Worth
  pursuing on its own merits but tracked separately.
- **Risk:** medium-high — subagents that lose track of the protocol
  on resume could break tool-loop reliability mid-run.
- **If pursued:** prototype with claude-code first; assert protocol
  awareness via existing tool-loop tests; expand to gemini after
  claude-code holds.

### Generic adapter-loop transcript compaction (subagent-side)

- **Where:** `src/adapters/tool-loop/constants.ts:1` (24 messages ×
  1500 chars budget); `src/adapters/tool-loop/controller.ts:160`
  (raw tool-output append). Affects fallback/local adapters that go
  through the generic tool-loop.
- **Estimated savings:** variable by adapter; biggest on long
  fallback/local-model dispatches with many tool calls.
- **Why parked:** off-target — subagent-side, not captain. Tool-loop
  adapters reason from raw tool output; crude summarization degrades
  reasoning.
- **If pursued:** start with type-aware budgets (different cap per
  message type — assistant text gets more headroom than tool
  results); then summarized tool-result replay. Lock with a
  reasoning-quality regression test.

### Summary truncation (conditional)

- **Where:** `markTerminal` summary field in
  `src/orchestrator/run-state.ts`. Currently uncapped.
- **Trigger to revisit:** real compaction problems on captain runs
  that include very long single-turn summaries.
- **Why parked:** the May 2026 distribution sample (70 runs) showed
  p50=2K, p90=5.9K, p99=9.9K, max=12K chars. Adapters front-load
  synthesis (verdict + key findings appear early); a hard cap risks
  hiding the conclusion of long reviews.
- **If pursued:** keep top-level `summary` uncapped; add a
  `summary_truncated_at` marker when an adapter's output exceeds a
  configurable cap. Tests must verify a load-bearing verdict at the
  end of a long review survives the truncation strategy.

### `verbose: true` opt-out for events_tail filter

- **Where:** `get_run_status` input schema; `filterEventsTailNoise`
  in `src/orchestrator/events-filter.ts` currently runs
  unconditionally on the terminal poll-return.
- **Trigger to revisit:** a real signal-loss complaint where a
  captain or user missed something the filter dropped.
- **Why parked:** speculative — no evidence yet that the filter
  hides anything load-bearing. `events.log` on disk is unchanged;
  users who want raw chronology can `tail -F` directly.
- **If pursued:** add `verbose?: boolean` to the input schema; skip
  `filterEventsTailNoise` when true. Document in
  `GET_RUN_STATUS_DESCRIPTION` (~30-char cost).

## How to use this file

When an item starts costing real context (e.g., long multi-turn runs
slow down because of subagent token spend; a captain reports missing
context after compaction), revisit the relevant entry. Update the "Why
parked" section with the current evidence, re-evaluate the trade-off,
and either ship it or strengthen the parking rationale.

Items that ship move to "Already shipped" above with commit SHA(s) and
drop from "Parked".
