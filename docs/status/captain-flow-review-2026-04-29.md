# Captain Flow State Review - 2026-04-29

This report captures the current state of the `crew` codebase as reviewed on
Wednesday, April 29, 2026. It is intended to be updated after major captain-flow
changes so the team does not need to rediscover the same context from plans,
logs, and source code each time.

## Baseline

- Branch state reviewed: `main` at `829385b` (`docs(plans): update codex-captain-performance with shipped state`).
- Local status at review time: clean worktree.
- Local branch position: ahead of `origin/main` by 6 commits.
- Runtime state reviewed:
  - `.crew/captain/session.json`
  - `.crew/captain/events.log`
  - `.crew/state.json`
  - `.crew/logs/run-*.log`
  - stale `.crew/worktrees/*` worktrees
- Planning/docs reviewed:
  - `docs/plans/active/codex-captain-performance.md`
  - `docs/plans/active/usage-aware-routing.md`
  - `docs/plans/completed/redesign/*`
  - `docs/architecture/*`
- Source areas reviewed:
  - `src/captain/*`
  - `src/captain/tools/*`
  - `src/adapters/*`
  - `src/cli/commands/run.ts`
  - `src/cli/ui/App.tsx`
  - `test/captain/*`
  - `test/cli/*`

## Verification Snapshot

Commands run after creating this report:

- `npm run lint`: passed.
- `npm run test:run`: failed.

Vitest result:

- 80 test files passed.
- 1 test file was skipped.
- 1 test file failed.
- 695 tests passed.
- 3 tests skipped.
- 4 tests failed.

The failing tests are all timeout failures in
`test/cli/ui/PromptInput.test.tsx`:

- `calls onSubmit with typed value on enter`
- `trims whitespace before submit`
- `navigates down through history and restores draft at newest`
- `does not add consecutive duplicate history entries`

This report change is documentation-only, so these failures should be treated
as current baseline instability rather than a regression from this report. They
are still relevant to the broader responsiveness theme because they sit in the
interactive input surface.

## Executive Summary

The codebase has mostly completed the architectural transition described in the
redesign docs. The legacy pipeline/controller concept is gone from production
runtime. The current product is built around a durable captain conversation,
the `SessionLoop`, the 8-tool captain surface, provider adapters, and a
dispatcher for long-running tool calls.

The main remaining problems are not broad architectural confusion. They are
specific control-flow and responsiveness issues:

1. The captain still pays an avoidable extra model turn after `finish`.
2. `finish` semantics are underspecified when dispatched tools are pending or
   in flight.
3. The CLI and UI do not expose dispatcher progress consistently.
4. Real smoke evidence is weaker than the implementation state suggests.
5. Some architecture docs now lag behind the actual code.
6. Native MCP is still deferred, so the current tool loop is an adapter-level
   JSON/schema loop rather than a true provider-native tool surface.

Recommended immediate focus: ship a terminal tool-result path for `finish`,
define and enforce finish-with-pending-work semantics, bridge dispatcher events
into both interactive and non-interactive progress output, and replace template
smoke logs with real run evidence.

## Current Architecture

### Runtime Shape

The production runtime is now:

- `JudgmentRunner`
- `SessionLoop`
- `CaptainSession`
- `ToolDispatcher`
- the 8-tool captain catalog
- provider adapters for Claude, Codex, Gemini, generic, and OpenAI-compatible
  CLIs/APIs

The old concrete `Pipeline` runner no longer exists in source. Captain events
were relocated to `src/captain/events.ts`, and the loop behavior now lives in
`src/captain/session-loop.ts`.

### Captain Tool Surface

The current captain tool set is exactly the M3 8-tool surface:

- `run_agent`
- `list_agents`
- `ask_user`
- `message_user`
- `plan_tasks`
- `analyze_output`
- `compress_context`
- `finish`

This is centralized in `src/captain/tools/catalog.ts` and is the right source
of truth for prompt rendering and adapter schemas.

### Tool Dispatch Model

Tools split into two execution modes:

- Inline/synchronous:
  - `list_agents`
  - `message_user`
  - `plan_tasks`
  - `analyze_output`
  - `compress_context`
  - `finish`
- Dispatched/long-running:
  - `run_agent`
  - `ask_user`

`SessionLoop` applies tool calls after each assistant turn. Dispatched calls
are started through `ToolDispatcher`; synchronous calls return results directly
to the adapter loop.

### Provider Sessions

Codex is now on the intended fast path for current constraints:

- `executeWithTools` routes through the adapter prompt tool loop.
- Codex inner turns use `codex exec`.
- Follow-up turns use `codex exec resume <threadId>`.
- Provider session state is threaded through the durable captain session.

Recent logs show the thread resume work is active. In the latest local run,
the first Codex decision turn captured a `threadId` and the next turn used it
as `resumedThreadId`.

## What Is Working

### The Major Redesign Has Landed

The codebase now matches the conversation-first direction from the product
vision:

- Interactive captain sessions persist across turns.
- User input can be appended while the runner is active.
- The captain can launch subagents without blocking prompt input.
- Presets exist as prompt-only policy overlays rather than a workflow DSL.
- The production captain surface is small and centralized.

### Codex Performance Work Has Improved the Shape

The active Codex performance plan records two shipped wins:

- Structured-schema execution is now the primary Codex captain path.
- Codex provider session continuity is threaded through `exec resume <id>`.

This removed avoidable full-context restarts inside the adapter loop. The
remaining Codex slowness is mostly the fixed cost of process startup and model
decision latency per inner turn.

### Test Coverage Is Broad for Scripted Behavior

The test tree has strong coverage for:

- tool-catalog stability
- config loading
- adapter schema conversion
- session replay
- scripted M3/M4/M5 captain flows
- slash-command routing
- preset behavior
- state migration

The scripted tests are valuable plumbing coverage. They are not a substitute
for real provider smoke evidence.

## Key Findings

### P0 - `finish` Still Costs an Avoidable Extra Model Turn

The latest local log shows the current pattern:

1. User asks a trivial question.
2. Codex decision turn takes about 20 seconds.
3. Codex calls `mcp__crew__finish`.
4. The adapter immediately starts a second decision turn to process the
   synthetic tool result.

This is the active plan's parked A.3 issue. The shared adapter contract only
has:

```ts
type ToolResult = {
  output: unknown;
};
```

There is no way for `finish` to tell the adapter loop: "this tool result is
terminal; do not ask the model what to do next." The shared prompt-loop
controller therefore appends the tool result and continues unless the model
itself returns a top-level `finish`.

Impact:

- Every successful captain workflow can pay one extra model/process turn.
- For Codex, this is especially visible because each inner turn starts a CLI
  process and waits for a model decision.
- The active plan estimates roughly 5-10 seconds saved per workflow; local logs
  show the shape clearly, even when exact latency varies.

Recommended fix:

- Extend adapter `ToolResult` with a terminal/control signal.
- Make `finish` return that terminal signal.
- Teach the shared prompt-loop controller to stop immediately on terminal tool
  results.
- Apply the same contract to native/resume loops in Claude, Gemini, and
  OpenAI-compatible adapters where they bypass the shared controller.

### P0/P1 - Finish-With-Pending-Dispatch Semantics Are Underspecified

`run_agent` and `ask_user` are dispatched tools. `finish` is synchronous and
requests loop exit.

The current code allows an adapter turn to contain multiple tool calls. That
means a single assistant decision can theoretically include:

- one or more `run_agent` calls
- then `finish`

`SessionLoop` applies the calls, starts dispatched work, and exits because
`finish` requested completion. After exit it only drains in-flight work for a
short bounded period. That is okay for fast fakes in tests, but it is not a
clear production policy for real long-running agents.

Impact:

- A captain could finish while useful agent work is still running.
- Late tool results may not be reflected in the durable conversation once the
  loop listeners are disposed.
- CLI/UI state can look complete while background work is still unresolved.

Recommended fix:

- Define the policy explicitly:
  - either `finish` is invalid while dispatched calls are pending/in-flight, or
  - `finish` cancels pending work, or
  - `finish` waits for a configured drain/settle condition.
- Enforce that policy in `SessionLoop` or `JudgmentRunner`, not just in prompt
  text.
- Add tests for "run_agent then finish in one turn" with a slow dispatched
  task.

Pragmatic recommendation: block or defer `finish` while there are pending or
in-flight dispatched tools unless the captain explicitly cancels them first.
That matches the user's expectation that the final report includes the work the
captain launched.

### P1 - Native MCP Is Still Deferred

`ToolCatalog.toMcpServers()` currently returns an empty list by design. The
comment explains that the old `crew-mcp` placeholder caused Codex to attempt
MCP startup and hang.

The current model is therefore:

- render the tool catalog into the captain prompt/schema
- have the adapter parse structured decisions
- invoke local handlers via `onToolCall`
- feed results back through the adapter loop

This is workable, and it has unblocked the product, but it is not equivalent to
native MCP tool use.

Impact:

- Provider-specific tool behavior is emulated in adapters.
- Tool calls are more fragile than native MCP/function-calling surfaces.
- Codex pays extra adapter-loop overhead.
- Documentation that implies MCP is fully wired can mislead future planning.

Recommended fix:

- Keep the current adapter loop as the stable fallback.
- Build a real `crew-mcp` stdio server before public v1.
- Re-enable MCP registration only when a provider can start the server and call
  the actual tools reliably.

### P1 - Progress/Streaming Output Is Split Across Event Systems

`ToolDispatcher` emits useful events:

- `run:start`
- `run:stream`
- `run:complete`
- `run:error`
- `ask:start`
- `ask:complete`

The interactive UI subscribes to these and shows in-flight tool calls. The
non-interactive `crew run` path primarily attaches to runner-level events such
as `agent:start`, `agent:output`, and `agent:complete`, but the current
`JudgmentRunner` no longer emits those legacy agent events.

Impact:

- Interactive mode has partial progress visibility.
- Non-interactive mode can be too quiet during long subagent work.
- There are stale event listeners in UI/CLI code that no longer map cleanly to
  the production runner.
- Streaming chunks are shown as a small status strip rather than first-class
  conversation/progress output.

Recommended fix:

- Establish one progress event contract for captain runtime.
- Either bridge dispatcher events through `JudgmentRunner`, or let command/UI
  layers subscribe to the dispatcher explicitly.
- Update non-interactive `crew run` to show dispatched work progress.
- Remove or replace stale legacy runner event listeners.
- Add tests around progress events for a fake long-running agent.

### P1 - PromptInput Test Baseline Is Currently Failing

The full Vitest run currently times out in four
`test/cli/ui/PromptInput.test.tsx` cases that exercise text entry, submit, and
history behavior. The static render tests pass, but the tests that drive stdin
do not complete within the default timeout.

Impact:

- The interactive input surface does not have a clean regression signal.
- Future responsiveness work in `PromptInput` or `App` will be harder to trust
  until this baseline is repaired.
- These failures may be test harness fragility, component behavior, or a
  dependency interaction; they need a focused diagnosis before being dismissed.

Recommended fix:

- Reproduce the failing file alone with verbose output.
- Check whether `ink-text-input` stdin handling changed under the installed
  dependency versions.
- Ensure tests unmount rendered Ink apps and do not leave active input handlers.
- Add a small regression test for submit and history once the harness is stable.

### P1 - Smoke Evidence Is Incomplete

Several smoke-log documents under `docs/plans/completed/redesign/` are
templates rather than populated run evidence. The tests make clear that scripted
captain flows validate plumbing and prompt contracts, not real LLM behavior.

Impact:

- The implementation is probably ahead of the documented validation state.
- Future contributors may rerun already-settled debates because the smoke
  record is not authoritative.
- Regressions in real-provider behavior can slip through scripted tests.

Recommended fix:

- Create a real captain smoke matrix with current providers and record actual
  outputs, timings, and failure modes.
- Include at least:
  - trivial answer
  - trivial code edit
  - moderate code edit
  - review-style task
  - long-running subagent task
  - user input while agent work is active
  - preset override behavior
- Store the results under `docs/status/` or update the existing smoke logs with
  a clear "real run evidence" section.

### P2 - Architecture Docs Have Drifted

Examples found during review:

- `docs/architecture/runners.md` still describes the old concrete `Pipeline`
  runner even though `src/captain/pipeline.ts` has been deleted.
- `docs/architecture/captain-portability.md` can be read as implying MCP
  registration is fully active, while `ToolCatalog.toMcpServers()` intentionally
  returns `[]`.
- Some completed-plan/review notes still contain old terms and paths such as
  `orchestrator`, `.orchestra`, and `crew resume`.
- `docs/plans/completed/2026-04-16-adapter-review-findings.md` is stored under
  completed but still reads like an active review note; many findings have been
  resolved by later work.

Impact:

- New work starts from stale assumptions.
- The codebase appears less settled than it is.
- Debugging time gets spent distinguishing current truth from historical notes.

Recommended fix:

- Update `docs/architecture/runners.md` to describe the current
  `JudgmentRunner`/`SessionLoop` split.
- Clarify the current MCP status in `docs/architecture/captain-portability.md`.
- Add a short status banner to historical review notes that are no longer
  active.
- Move or delete stale worktree analysis only after preserving anything still
  useful.

### P2 - Codex Is Improved but Still Structurally Slow

The recent performance work made Codex materially better, but each Codex inner
turn still involves:

- process startup
- schema-constrained execution
- JSON output parsing
- optional resume-thread handoff

The current performance bottleneck is therefore per-turn latency. The highest
ROI fix is reducing turns, not micro-optimizing prompt text.

Recommended fix order:

1. terminal `finish` short-circuit
2. avoid unnecessary follow-up turns after synchronous tools when the next
   action is already known
3. real MCP/native tool path
4. optional process warm-up only if measurements still justify it

### P3 - Usage-Aware Routing Is Blocked on Product Decision

`docs/plans/active/usage-aware-routing.md` remains blocked on upstream CLI
usage APIs. The fallback recommendation is a local token-budget proxy, but that
needs a product decision.

This should not block captain-flow responsiveness work. Revisit it after the
finish/progress/smoke issues are addressed.

## Recommended Next Work

### 1. Ship Terminal Tool Results

Goal: remove the extra post-`finish` model turn and make terminal tool behavior
explicit across adapters.

Suggested scope:

- Extend `ToolResult` with a terminal/control flag.
- Return terminal from `finish`.
- Short-circuit `executePromptToolLoop` on terminal results.
- Apply equivalent checks to adapter-specific loops that do not use the shared
  controller.
- Add regression tests proving `finish` does not trigger a second decision turn.

This is the best immediate responsiveness win.

### 2. Define Finish/Pending-Work Policy

Goal: prevent completed sessions from racing or discarding long-running work
they started.

Suggested scope:

- Track pending and in-flight dispatched tool calls at finish time.
- Reject/defer `finish` while dispatched work remains unresolved, or require an
  explicit cancellation path.
- Add a slow-dispatch test that would fail under the current short-drain
  behavior.
- Update the captain system prompt only after code enforces the behavior.

This should be done with or immediately after terminal tool results because
both touch the meaning of `finish`.

### 3. Unify Progress Events

Goal: make responsiveness visible to users, especially during long subagent
runs.

Suggested scope:

- Pick the canonical progress event API.
- Bridge `ToolDispatcher` events through `JudgmentRunner`, or subscribe to the
  dispatcher directly in both command/UI surfaces.
- Update `crew run` to print useful start/stream/complete progress for
  dispatched work.
- Improve interactive display so streaming output feels alive without
  overwhelming the conversation.
- Remove stale listeners for legacy `agent:*` events if they are no longer
  emitted.

### 4. Populate Real Smoke Evidence

Goal: make the validation record match the code's real state.

Suggested scope:

- Run the current smoke matrix with actual captain/provider flows.
- Record exact commands, dates, providers, timings, and outcomes.
- Mark scripted-only tests clearly as plumbing tests.
- Store smoke results in a durable status document and link them from active
  plans.

### 5. Refresh Architecture Docs

Goal: make docs a reliable starting point for future work.

Suggested scope:

- Update `docs/architecture/runners.md`.
- Update `docs/architecture/captain-portability.md`.
- Add status banners to stale completed-plan notes.
- Preserve useful old analysis, but label it historical.

### 6. Plan Real MCP

Goal: replace adapter-emulated tool use with a provider-native path where it
actually works.

Suggested scope:

- Design a real `crew-mcp` stdio server around the existing catalog.
- Keep JSON/schema adapter loop as fallback.
- Test startup, tool invocation, cancellation, and error reporting per provider.
- Update MCP registration docs once the implementation is real.

This is probably the right larger follow-up after the immediate responsiveness
work.

## Cleanup Items

- `.crew/worktrees/task-1-8deec01e` and `.crew/worktrees/task-2-6d7718e3`
  appear to be stale merged worktrees.
- `task-1-8deec01e` contains untracked
  `docs/analysis/config-setup-audit.md`; it should be reviewed or copied before
  deleting that worktree.
- `.crew/logs` are small and useful; keep recent logs until the smoke matrix is
  populated.
- The current `.crew/captain/session.json` only records a trivial "hey is this
  working?" session, so it should not be treated as broad runtime evidence.

## Maintenance Guidance

Keep this document current when any of the following happens:

- terminal tool results ship
- finish/pending-work semantics change
- dispatcher progress is replumbed
- real smoke matrix results are recorded
- MCP server work starts or ships
- architecture docs are refreshed

When updating, prefer adding a short dated changelog entry at the top or bottom
instead of rewriting history. Historical context is useful, but only if the
current state is clearly labeled.

## Proposed Priority Order

1. Terminal tool-result short-circuit for `finish`.
2. Enforced finish/pending-dispatch policy.
3. Unified dispatcher progress for CLI and UI.
4. Repair the `PromptInput` test baseline.
5. Real smoke matrix and populated run logs.
6. Architecture-doc refresh.
7. Real `crew-mcp` implementation.
8. Usage-aware routing decision.

This order targets responsiveness first, then correctness of the captain flow,
then documentation and larger portability work.
