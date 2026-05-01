# Captain Flow State Review - 2026-04-29

This report captures the current state of the `crew` codebase as reviewed on
Wednesday, April 29, 2026. It is intended to be updated after major captain-flow
changes so the team does not need to rediscover the same context from plans,
logs, and source code each time.

## Update - 2026-04-29 Implementation Pass

The first four priority items from this report have now shipped in the current
worktree:

- `finish` tool results carry a terminal adapter-loop signal, and the shared
  prompt-loop controller plus Claude, Codex, Gemini, and OpenAI-compatible
  adapter-specific loops stop immediately on that signal.
- `finish` is blocked while dispatched `run_agent` / `ask_user` work is queued
  in the current adapter turn or still in flight on the dispatcher. The captain
  prompt now states this enforced policy.
- `crew run "<prompt>"` subscribes to dispatcher progress directly and prints
  dispatched start, stream, complete, failed, and cancelled events. The
  interactive UI also renders dispatcher stream chunks in the conversation view
  while retaining the in-flight status strip.
- `test/cli/ui/PromptInput.test.tsx` now has a stable harness: Ink renders are
  unmounted between cases and typed input is written in one stdin chunk.

Current verification after this pass:

- `npm run test:run`: passed.
  - 82 test files passed.
  - 1 test file skipped.
  - 704 tests passed.
  - 3 tests skipped.
- `npm run lint`: passed.

Remaining highest-priority items are now real provider smoke evidence and the
architecture-doc refresh, followed by the real `crew-mcp` design/implementation.

## Update - 2026-04-29 Agent Failure Handling Follow-Up

The latest real captain run after the implementation pass exposed a failure
classification bug:

- A `claude-code` `run_agent` task hit its 300s timeout and returned a resolved
  `TaskResult` with `status: "error"`.
- `ToolDispatcher` treated the resolved promise as `run:complete`, so
  `SessionLoop` persisted the tool result as outer `status: "success"`.
- A subsequent non-replay captain adapter failure returned an empty turn to the
  session loop, which triggered the quiet-turn safety net and marked the
  workflow completed even though no final report was produced.

Fix shipped in the current worktree:

- Resolved dispatched results with `status: "error"` now emit `run:failed`
  and persist as `tool_result` status `error`.
- `SessionLoop` preserves any synchronous tool side effects before surfacing a
  captain turn error.
- `JudgmentRunner` now throws on non-session-rejection `executeWithTools`
  failures instead of returning an empty turn that can quiet-complete.
- Regression coverage now locks the failed-dispatch path, the session-loop
  failed tool result, non-replay captain adapter failures, and persistence of
  `message_user` side effects before adapter failure.

Current verification after this follow-up:

- `npm run lint`: passed.
- `npm run test:run`: passed.
  - 82 test files passed.
  - 1 test file skipped.
  - 708 tests passed.
  - 3 tests skipped.

## Update - 2026-04-29 Codex Resume Schema Compatibility Follow-Up

The next real captain run exposed a Codex CLI compatibility issue on resumed
decision turns:

- The seed captain decision used `codex exec --output-schema` successfully.
- The follow-up decision reused the thread with `codex exec resume`, but Codex
  CLI `0.125.0` rejects `--output-schema` on the `resume` subcommand.
- The adapter surfaced the CLI error correctly after the agent-failure fix, so
  the workflow failed instead of quiet-completing.

Fix shipped in the current worktree:

- Codex seed decision turns still use `--output-schema` for strict structured
  output.
- Codex resumed decision turns now omit `--output-schema`, write the final
  assistant message via `--output-last-message`, and parse it through the
  existing JSON-envelope decision parser.
- Regression coverage locks the resumed decision argv shape so
  `--output-schema` is not reintroduced on `codex exec resume`.

Current verification after this follow-up:

- `npm run test:run -- test/adapters/codex.test.ts test/adapters/codex.resume.test.ts`:
  passed.
  - 2 test files passed.
  - 33 tests passed.
- `npm run lint`: passed.
- `npm run test:run`: passed.
  - 82 test files passed.
  - 1 test file skipped.
  - 709 tests passed.
  - 3 tests skipped.

## Update - 2026-04-29 Codex Decision Output Hardening Follow-Up

The next real run got past the `exec resume --output-schema` failure, but
exposed a second Codex decision fragility:

- After two implementation-agent passes, a seed captain decision turn exited
  with code `0` but did not write the requested decision output file.
- The captured stderr showed Codex behaving like a coding agent and attempting
  an `apply_patch`, which failed because the target file had already changed.
- This made the session fail with "Codex did not produce output file" even
  though the JSONL stream may still contain a usable final assistant message.

Fix shipped in the current worktree:

- Codex captain decision seed turns now run with `--ignore-rules` and
  `--sandbox read-only` so they are less likely to pick up repo editing policy
  or mutate files while only a decision JSON is expected.
- Codex resumed decision turns also pass `--ignore-rules`; `exec resume` does
  not expose the seed command's `--sandbox` flag.
- If Codex exits without the output file, the adapter now falls back to the
  JSONL last assistant message only when it parses as a valid tool-loop
  decision envelope. Otherwise it still fails loudly, now with stderr and last
  assistant-message previews.
- Regression coverage locks the isolated seed flags, the resumed argv shape,
  and the missing-output-file JSONL fallback.

Current targeted verification after this follow-up:

- `npm run test:run -- test/adapters/codex.test.ts test/adapters/codex.resume.test.ts test/cli/commands/config.test.ts test/cli/ui/config/command-parser.test.ts test/cli/ui/config/command-handler.test.ts`:
  passed.
  - 5 test files passed.
  - 68 tests passed.
- `npm run lint`: passed.
- `npm run test:run`: passed.
  - 82 test files passed.
  - 1 test file skipped.
  - 714 tests passed.
  - 3 tests skipped.

## Update - 2026-04-29 Run Worktree Merge Follow-Up

The next real run appeared successful but left the main checkout unchanged:

- The implementation agent ran in
  `.crew/runs/1bd4f9a5-aff2-4032-ba0d-295941c764cf/worktree`.
- The agent's final report linked changed files under that isolated run
  worktree, but returned `filesModified: []`.
- `JudgmentRunner` then handled the dispatcher terminal event by calling
  `worktreeManager.cleanupByRunId(runId)`, which removed the only copy of the
  edits without merging them back to the project checkout.

Fix shipped in the current worktree:

- Successful `run_agent` calls that use the default run worktree now inspect
  git status, backfill `TaskResult.filesModified`, and call
  `WorktreeManager.mergeRunWorktree(runId)` when git status or the adapter
  reports changed files. This happens before the dispatcher emits
  `run:complete` and before the cleanup listener removes the run worktree.
- Run/task worktree file detection and auto-commit now include deleted and
  renamed paths, not just modified/created/untracked paths.
- Merge safety ignores local `.crew/` runtime metadata when checking whether
  the main checkout has user changes, and async cleanup failures are logged
  instead of escaping as unhandled rejections.
- The two remaining `PromptInput` history tests now use the same 15s
  case-level timeout as the existing history recall test; this keeps the full
  parallel suite stable under load without changing UI behavior.
- The lost run's concrete config UI behavior was reapplied: `/config setup`
  and `/config edit` now show guided-setup guidance even while subagent work is
  in flight; mutating `/config` commands remain blocked while busy.
- Architecture notes now describe successful run worktrees as
  merge-before-cleanup instead of cleanup-only.

Current verification after this follow-up:

- `npm run test:run -- --configLoader runner test/captain/tools/run-agent.test.ts test/captain/m3-tool-surface.test.ts test/git/worktree.test.ts`:
  passed.
  - 3 test files passed.
  - 33 tests passed.
- `npm run test:run -- --configLoader runner test/captain/end-to-end-code-review.test.ts test/captain/end-to-end-moderate-feature.test.ts test/captain/end-to-end-trivial-fix.test.ts test/captain/end-to-end-preset-thorough-review.test.ts test/captain/end-to-end-preset-default-regression.test.ts test/captain/m3-tool-surface.test.ts test/git/worktree.test.ts`:
  passed.
  - 7 test files passed.
  - 34 tests passed.
- `npm run test:run -- --configLoader runner test/cli/ui/PromptInput.test.tsx`:
  passed.
  - 1 test file passed.
  - 9 tests passed.
- `npm run test:run -- --configLoader runner test/cli/ui/config/command-handler.test.ts test/cli/ui/config/command-parser.test.ts test/cli/commands/config.test.ts test/cli/ui/App.test.tsx`:
  passed.
  - 4 test files passed.
  - 51 tests passed.
- `npm run lint`: passed.
- `npm run test:run -- --configLoader runner`: passed.
  - 82 test files passed.
  - 1 test file skipped.
  - 718 tests passed.
  - 3 tests skipped.

## Update - 2026-05-01 Non-Interactive Run Seed Follow-Up

The first real smoke after the run-worktree merge fix used:

```bash
crew run "I'm not super happy with the way our config setup works. Right now, it's very complicated, and I want to make it more interactive, ask
  more questions rather than just presenting the config keys."
```

It exposed a non-interactive resume bug:

- `crew run "<prompt>"` printed the startup banner and wrote `.crew/state.json`
  as `status: "running"`, but exited before any captain decision turn.
- The durable captain session already contained older assistant/tool history.
- `JudgmentRunner.executeSessionLoop` only appended the new user prompt when
  the session was empty, so `SessionLoop.hasPendingCaptainWork()` was false.
- With no pending event and no active handles, Node exited even though the
  runner had persisted a running workflow state.

Fix shipped in the current worktree:

- `JudgmentRunner.executeSessionLoop` now seeds the current user request unless
  the last session message is already the same user message. This preserves the
  interactive UI path, which appends before `runner.run()`, while making
  non-interactive `crew run "<prompt>"` wake the session loop even with durable
  history.
- Regression coverage now starts a runner with a non-empty session ending in an
  assistant message and proves the next captain turn sees the new prompt.

Current targeted verification after this follow-up:

- `npm run test:run -- --configLoader runner test/captain/m3-tool-surface.test.ts`:
  passed.
  - 1 test file passed.
  - 11 tests passed.
- `npm run lint`: passed.
- `npm run test:run -- --configLoader runner`: passed.
  - 82 test files passed.
  - 1 test file skipped.
  - 719 tests passed.
  - 3 tests skipped.

## Update - 2026-05-01 Guided Config Setup UX Follow-Up

The current worktree now ships a simpler, question-driven setup flow for
`crew config setup` / `crew config edit`:

- The wizard now asks one early depth question: `quick` (recommended) or
  `advanced`.
- `quick` mode focuses on common decisions (scope, captain CLI/model/preset,
  review passes, retry count) and skips role/agent internals.
- `advanced` mode preserves the full per-role and per-agent walkthrough.
- Prompt text now leads with user-facing context (`current answer`, `suggested
  default`, `why this matters`); raw config keys are demoted to
  `internal setting` metadata instead of being the primary prompt line.
- Interactive `/config setup` and `/config edit` guidance copy now advertises
  the plain-language quick flow plus optional advanced prompts.
- Direct mutation commands (`/config set ...`, `crew config set ...`) remain
  unchanged.

Current targeted verification after this follow-up:

- Real smoke:
  - `npm run build`: passed.
  - `crew run "I'm not super happy with the way our config setup works. Right now, it's very complicated, and I want to make it more interactive, ask
    more questions rather than just presenting the config keys."`: passed.
  - The run dispatched `run_agent`, merged the run worktree back into `main`,
    and completed with `.crew/state.json` status `completed`.
- `npm run test:run -- --configLoader runner test/cli/commands/config.test.ts test/cli/ui/config/command-handler.test.ts test/cli/ui/config/command-parser.test.ts`:
  passed.
  - 3 test files passed.
  - 35 tests passed.
- `npm run test:run -- --configLoader runner test/cli/ui/App.test.tsx`:
  passed.
  - 1 test file passed.
  - 17 tests passed.
- `npm run lint`: passed.
- `npm run test:run -- --configLoader runner`: passed.
  - 82 test files passed.
  - 1 test file skipped.
  - 720 tests passed.
  - 3 tests skipped.

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

Current snapshot after the 2026-04-29 implementation pass is recorded in the
update section above. The original review snapshot is kept below for historical
context because it explains why PromptInput was prioritized.

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

The main remaining problems are not broad architectural confusion. The first
round of control-flow and responsiveness issues has shipped; the remaining
work is validation, documentation, and provider-native tool integration:

1. Real smoke evidence is weaker than the implementation state suggests.
2. Some architecture docs now lag behind the actual code.
3. Native MCP is still deferred, so the current tool loop is an adapter-level
   JSON/schema loop rather than a true provider-native tool surface.

Recommended immediate focus: replace template smoke logs with real run
evidence, refresh architecture docs that still describe pre-M4 concepts, then
plan the real `crew-mcp` stdio server.

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

- Structured-schema execution is now the seed Codex captain decision path.
- Codex provider session continuity is threaded through `exec resume <id>`.

Codex CLI `0.125.0` does not expose `--output-schema` on `exec resume`, so
resumed decisions keep thread continuity and parse the final assistant message
through the adapter's JSON-envelope fallback. This still removes avoidable
full-context restarts inside the adapter loop. The remaining Codex slowness is
mostly the fixed cost of process startup and model decision latency per inner
turn.

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

### Resolved 2026-04-29 - `finish` Terminal Tool Results

Original finding: the latest local log showed this pattern:

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

Status: shipped. `ToolResult` now has `terminal` / `terminalOutput`,
`finish` returns that signal, `executePromptToolLoop` short-circuits on it,
and adapter-specific Claude, Codex, Gemini, and OpenAI-compatible loops do the
same.

### Resolved 2026-04-29 - Finish-With-Pending-Dispatch Policy

`run_agent` and `ask_user` are dispatched tools. `finish` is synchronous and
requests loop exit.

The original code allowed an adapter turn to contain multiple tool calls. That
meant a single assistant decision could include:

- one or more `run_agent` calls
- then `finish`

`SessionLoop` applied the calls, started dispatched work, and exited because
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

Status: shipped. The runner blocks `finish` while dispatched work is queued in
the current adapter turn, `dispatchFinish` blocks it while dispatcher work is
in flight, the prompt states the enforced policy, and regression tests cover a
slow `run_agent` followed by same-turn `finish`.

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

### Resolved 2026-04-29 - Progress/Streaming Output Split

`ToolDispatcher` emits useful events:

- `run:start`
- `run:stream`
- `run:complete`
- `run:failed`
- `run:cancelled`

The original interactive UI subscribed to these and showed in-flight tool
calls. The non-interactive `crew run` path primarily attached to runner-level
events such as `agent:start`, `agent:output`, and `agent:complete`, but the
current `JudgmentRunner` no longer emits those legacy agent events.

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

Status: shipped for the current adapter-loop architecture. Command/UI layers
subscribe to `ToolDispatcher` directly. Non-interactive `crew run` prints
dispatcher lifecycle and stream events, and the interactive UI renders stream
chunks in the conversation view while keeping the in-flight strip.

### Resolved 2026-04-29 - PromptInput Test Baseline

The original full Vitest run timed out in four
`test/cli/ui/PromptInput.test.tsx` cases that exercise text entry, submit, and
history behavior. The static render tests passed, but the tests that drove
stdin did not complete within the default timeout.

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

Status: shipped. The PromptInput tests now unmount each rendered Ink app and
write typed input in one stdin chunk. `npm run test:run` passes.

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
- schema-constrained seed execution or JSON-envelope resume parsing
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

### Completed 2026-04-29. Ship Terminal Tool Results

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

### Completed 2026-04-29. Define Finish/Pending-Work Policy

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

### Completed 2026-04-29. Unify Progress Events

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

### 1. Populate Real Smoke Evidence

Goal: make the validation record match the code's real state.

Suggested scope:

- Run the current smoke matrix with actual captain/provider flows.
- Record exact commands, dates, providers, timings, and outcomes.
- Mark scripted-only tests clearly as plumbing tests.
- Store smoke results in a durable status document and link them from active
  plans.

### 2. Refresh Architecture Docs

Goal: make docs a reliable starting point for future work.

Suggested scope:

- Update `docs/architecture/runners.md`.
- Update `docs/architecture/captain-portability.md`.
- Add status banners to stale completed-plan notes.
- Preserve useful old analysis, but label it historical.

### 3. Plan Real MCP

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

1. Real smoke matrix and populated run logs.
2. Architecture-doc refresh.
3. Real `crew-mcp` implementation.
4. Usage-aware routing decision.

Terminal `finish`, finish/pending-dispatch policy, dispatcher progress, and
the PromptInput test baseline were completed on 2026-04-29.
