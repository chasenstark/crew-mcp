# Captain Flow State Review - 2026-04-29

This report captures the current state of the `crew` codebase as reviewed on
Wednesday, April 29, 2026. It is intended to be updated after major captain-flow
changes so the team does not need to rediscover the same context from plans,
logs, and source code each time.

## Update - 2026-05-10 crew-wait Watch Notifications (Tier 5 N3/N7)

`crew-wait <run_id>` remains a per-run process so Claude Code still receives one
synthetic turn per backgrounded Bash invocation. The normal wait path now uses
directory `fs.watch` notifications around `<crewHome>/runs/<run_id>/state.json`
instead of a 1s polling loop. Directory watching preserves the atomic
tmp-plus-rename state write contract and also covers the initial missing-file
race by watching the nearest existing parent until the run directory/state file
appears.

Polling is now only a fallback for unsupported or failed `fs.watch` setup. The
fallback base interval is 2s, configurable with `CREW_WAIT_POLL_INTERVAL_MS`,
and backs off toward a 5s cap while state contents do not change. The Node
process cold-start cost per dispatch is unchanged; that remains the accepted
tradeoff for Claude Code's per-invocation synthetic-turn completion behavior.

Item #8 (events.log incremental reads) shipped in `__COMMIT__`: the terminal
tail reader now scans `events.log` once in bounded chunks, retains only the
filtered tail ring, and shares that pass with `next_event_line` cursor
advancement on terminal `get_run_status` calls. The per-run mtime/byte-offset
cursor cache remains deferred per the audit.

## Update - 2026-05-10 Deferred Stale-Run Sweeper (Tier 5 N2)

`buildCrewMcpServer` now schedules the repoRoot-scoped stale-run sweeper with
`setImmediate` instead of running it synchronously on the server construction
path. Server-ready latency no longer grows with the number of historical
`<crewHome>/runs/` records. A module-local single-flight promise prevents
concurrent sweeps; strict callers can await the in-flight sweep through
`getStaleRunSweep()`, while default tool calls continue without paying that
wait.

The accepted v1 tradeoff is a short race after server readiness: until the
deferred sweep completes, `list_runs` can still observe abandoned records as
`running`. The sweeper preserves the prior status transition behavior and still
leaves records without `serverPid` untouched.

## Update - 2026-05-10 Server-Side Progress Prefix Authority (Tier 3 #13)

Progress stream prefixes now have one authority: `crew-mcp serve`.
Codex and Claude Code adapters emit semantic chunks such as
`command: started ...` or `message: ...` without `[adapter]` prefixes. The
server renders `[<agent>] ...` once via `formatProgressLines()`, writes those
same bounded lines to `events.log`, and sends them through
`notifications/progress`.

This supersedes the May 6 detail that `events.log` was the adapter-emitted
source of truth for Codex/Claude progress lines. `events_tail` now matches the
server-rendered progress surface, while the adapter parsers remain responsible
only for semantic `kind: summary` formatting.

## Update - 2026-05-10 Lazy CLI Command + Adapter Loading (Tier 2 #11)

Tier 2 item #11 from `docs/plans/active/perf-context-audit-merged.md`. The
`crew-mcp` entrypoint now builds the Commander command shape without
importing each command module; every subcommand action dynamically imports
only the selected implementation. `install` no longer imports `serve.ts` just
to record the version; both use the thin `src/cli/version.ts` constant.

`AdapterRegistry` now registers lazy adapter entries instead of importing and
constructing every built-in adapter at registry creation. `load(name)` loads
and caches the requested adapter module, while `loadAll()` is used by
`list_agents` / health-check paths where loading all adapters is expected.
The MCP server still registers the full tool names and schemas eagerly at
startup; only adapter modules and non-selected CLI command implementations are
deferred.

Timing evidence from rebuilt `dist/` on this machine (15 runs, first
discarded): `node dist/index.js serve --help` mean moved from 128ms to 38ms;
`node dist/index.js install --help` mean moved from 128ms to 38ms.

## Update - 2026-05-10 Dispatch Envelope Trim

Dispatch `structuredContent` now defaults to the captain-essential fields:
`run_id`, `tail_url`, `summary`, `files_changed`, and optional `warnings`.
The prior full structured envelope fields (`agent_id`, `status`,
`worktree_path`, `events_log_path`, `tail_command_path`, and
`tail_command_url`) remain available for legacy structured consumers only when
`CREW_FULL_ENVELOPE=1` is set.

The human-facing dispatch markdown is unchanged: it still includes the
worktree line, the macOS `tail_url` link when applicable, and the manual
`tail -F <events.log>` fallback. Captains should continue using the markdown
tail link / `tail_url` for dispatch confirmation and `get_run_status` for
terminal payloads.

## Update - 2026-05-10 crew-wait Binary + Claude Allowlist Overlay (phase 3)

Phase 3 of the non-blocking captain plan added the packaged `crew-wait`
binary. `crew-wait <run_id>` resolves the active crew home through
`resolveCrewHome()`, polls `<crewHome>/runs/<run_id>/state.json`, tolerates the
initial missing-file race, and prints a single `CREW_WAIT_TERMINAL ...` metadata
line when the run reaches `success`, `partial`, `error`, `cancelled`, or a
post-terminal action state.

Packaging now builds both `src/index.ts` and `src/cli/wait.ts`, and the npm bin
map exposes `crew-mcp` plus `crew-wait`. Claude Code install adds an idempotent
`Bash(crew-wait:*)` permission when `crew-wait` is PATH-visible, otherwise it
falls back to an absolute path from the new platform-aware
`resolveCrewWaitBinary()` helper; uninstall removes both PATH and absolute
forms while leaving the npm package binary in place.

The live Claude Code / Codex / Gemini empirical gates from the plan remain
deferred from this sandbox: the implementation is ready for the captain to run
the actual allowlist matcher, synthetic-turn stdout, and foreground wait tests
inside those host runtimes before merge.

## Update - 2026-05-10 list_runs Recovery Surface (phase 1A)

Phase 1A of the non-blocking captain plan added the `list_runs` MCP tool and
documented the public `state.json` contract. `list_runs` walks
`<crewHome>/runs/`, filters implicitly to the current `crew-mcp serve` repo
root, can opt into legacy records without `repoRoot`, supports status arrays,
`completedAfter`, and `limit`, and returns newest-first run summaries with
`lastError` fallback when no prompt summary exists.

The run-state contract is now documented at
`docs/architecture/run-state-contract.md`, including atomic tmp-plus-rename
writes, the distinction between `markTerminal()` statuses
(`success`, `partial`, `error`, `cancelled`) and post-terminal user actions
(`merged`, `merge_conflict`, `discarded`), and the guarantee that the top-level
`status` string remains stable for simple readers such as `crew-wait`.

## Update - 2026-05-10 Chat-Available Dispatch Skill Body (phase 2)

Phase 2 of `docs/plans/active/non-blocking-captain.md` rewrote the captain
skill's default dispatch lifecycle from same-turn long-polling to
dispatch-and-yield. Captains now confirm the `run_id`, include the tail link,
spawn the Claude Code `crew-wait` watcher overlay when available, and end the
turn so the user can keep chatting. Codex/Gemini default recovery happens on
the next captain turn by checking known pending run IDs with `get_run_status`
and using `list_runs` after `/clear` or unknown references.

`get_run_status` is now described as an on-demand status read. Its
`wait_for_change_ms` and `wait_for_terminal_only` options remain available as
advanced/legacy opt-in waiting primitives, but they are no longer the default
captain flow.

## Update - 2026-05-10 Lifecycle Running-Guards + Stale-Run Sweeper (phase 1B)

Phase 1B of `docs/plans/active/non-blocking-captain.md` added server-side
guards for lifecycle tools while a run is in flight. `continue_run`,
`merge_run`, and `discard_run` now refuse `status: "running"` and direct the
captain to call `cancel_run` first. `continue_run` also refuses
`merge_conflict`; `merge_run` and `discard_run` remain available on
`merge_conflict` for the documented retry and cleanup recovery paths.

`buildCrewMcpServer` now runs a repoRoot-scoped stale-run sweeper at startup.
Only `running` records whose `repoRoot` matches the current project root are
marked `error` with `lastError: "abandoned (server restart)"`; records from
other repos and legacy records missing `repoRoot` are left untouched. The v1
same-repo multi-session false-positive limitation remains accepted.

## Update - 2026-05-09 Terminal-Only Get Run Status Wait

`get_run_status` now has a `wait_for_terminal_only?: boolean` input flag.
When set with `wait_for_change_ms`, the server waits only for terminal
dispatcher events (`run:complete`, `run:failed`, `run:cancelled`) and does
not subscribe to `run:stream`; stream chunks continue to flow through progress
notifications and `events.log`/tail side channels without waking the captain.

The long-poll cap remains `MAX_LONG_POLL_MS = 60_000`. On terminal-only
timeout while the run is still running, the response is deliberately lean:
`{ status: "running", timed_out: true }` with no `next_event_line` or
`events_tail`. Captains keep the cursor they already had and re-call the same
terminal-only wait. Already-terminal runs still return the normal terminal
payload immediately.

Superseded by the 2026-05-10 Phase 2 update above: the captain skill no longer
uses this terminal-only polling loop as its default flow. The
`wait_for_terminal_only` capability remains available for advanced/legacy
opt-in waits.

## Update - 2026-05-09 Architecture Docs Drift Refresh

The live architecture docs under `docs/architecture/` were rewritten against the
v0.2 MCP-server runtime and now use dated source-anchor headers. The v0.1
runner/session/preset docs were moved to `docs/architecture/v0.1-archive/` as
historical artifacts.

Supersedes one stale detail in the 2026-05-06 note below: the live
`get_run_status.max_events_tail` default is now 10 lines, capped at 500
(`src/orchestrator/tools/get-run-status.ts:34`, `:42`), not the earlier
50-line default.

## Update - 2026-05-08 CrewTail URL Scheme Handler

Dispatch envelopes now include `tail_url` alongside the existing
`tail_command_url`. `tail_url` points directly at the run's `events.log` with a
`crew-tail://` custom scheme; `tail_command_url` remains a `file://` link to
`tail.command` for structured consumers and backward compatibility.

On macOS, dispatch markdown now links to `tail_url` so clicks can route through
the optional `CrewTail.app` LaunchServices handler instead of being intercepted
as editor-owned `file://` links. The manual `tail -F <events.log>` line remains
the universal fallback, and non-darwin markdown still omits the clickable
custom-scheme link.

The handler is installed explicitly with `crew-mcp install-tail-handler`; it is
source-built from `scripts/tail-handler/` via `osacompile`, ad-hoc signed, copied
to `~/Applications/CrewTail.app`, and registered with LaunchServices.

## Update - 2026-05-06 MCP Progress Payload Hardening

Phase 4 of per-adapter event parsing wired the semantic event stream into the
captain-facing tool contract:

- Dispatch envelopes now include `events_log_path` and `tail_command_path`.
  Dispatch markdown shows a macOS clickable `tail.command` `file://` link plus
  a manual `tail -F <events.log>` snippet for power users.
- `get_run_status` responses include `events_log_path`, `tail_command_path`,
  and `next_event_line`. Running polls advance the cursor but return
  `events_tail: []`; terminal polls return the recent full-log tail with a
  default 50-line cap (`max_events_tail`, max 500, can override). If the
  terminal tail is over cap, the response includes a skipped-events marker.
- The captain skill body now instructs captains to coordinate while runs are
  running, not narrate progress. Terminal `events_tail` is evidence for a
  synthesized completion summary, not text to print back verbatim.

`crew-mcp serve` progress formatting now treats the full
`notifications/progress` message as the bounded surface:

- `[<agent>] ` prefixes count against the 240-character cap.
- Truncation is code-point safe and avoids lone UTF-16 surrogates.
- CRLF, LF, and lone CR spinner overwrites are all progress-line delimiters.
- Markdown dispatch results escape inline-code values containing backticks or
  newlines.
- `events.log` remains the adapter-emitted progress source of truth. For Codex
  and Claude Code this is now semantic markdown (`[adapter] kind: summary`);
  `events_tail` exposes it only on terminal polls, while the host inline
  notification surface is separately shortened.

`progressToken` diagnostics remain per `buildCrewMcpServer` instance, which is
effectively per-client for the current stdio transport. Future SSE or other
multi-client transports should revisit that storage.

## Update - 2026-05-06 Codex Worktree Commit Sandbox

Codex write-mode dispatches now pass the run worktree's minimum git commit
write surface as workspace-write roots, using a single
`-c sandbox_workspace_write.writable_roots=[...]` config override:

- The linked worktree gitdir from `<run>/worktree/.git`.
- The common git object database (`.git/objects`).
- The run-branch ref directory (`.git/refs/heads/crew-run`).
- The matching run-branch reflog directory (`.git/logs/refs/heads/crew-run`).

The fix intentionally does not grant the parent repository's entire `.git/`,
hooks, config, non-crew branch refs, or other unrelated git internals. The
practical ref/reflog grant is the `crew-run` namespace because current run
branch names are `crew-run/<token>-<suffix>`, and `git commit` creates lock
files beside the branch ref.

### 2026-05-07 follow-up: switched grant flag from `--add-dir` to `-c`

The first attempt (commit `dadb4b4`, 2026-05-06) used Codex CLI's documented
`--add-dir <DIR>` flag, on the assumption that this would append to
`sandbox_workspace_write.writable_roots` without replacing user config. In
practice, dispatched runs still hit `Operation not permitted` writing
`<host>/.git/worktrees/<wt>/index.lock`, and the codex error message said
"outside the writable root."

Investigation showed Codex 0.128.0 surfaces two distinct mechanisms:

- `writable_roots` (config-loaded; baked into the seatbelt profile when it is
  generated).
- `additional_writable_root` (a runtime-approval modification of the active
  permission profile, surfaced as `ActivePermissionProfileModification`).

`--add-dir` drives the latter, and the runtime-approval channel does not
auto-approve in non-interactive `codex exec` — so the grant silently fails
for paths outside cwd. The 2026-05-07 fix (commit `2729658`) drops the
`--add-dir` flags and emits a single
`-c sandbox_workspace_write.writable_roots=[...]` config override instead,
which puts the path into the seatbelt profile before sandbox enforcement
starts. The trade-off is that the override **replaces** any
user-per-machine `writable_roots` for the dispatch; this is acceptable
because crew owns the sandbox contract for dispatched runs and the user's
interactive codex config has no business leaking into a worktree-isolated
run.

## Update - 2026-05-06 Codex Semantic Progress Parsing

The Codex adapter's JSONL stream formatter now emits bounded semantic markdown
lines for the observed Codex 0.128 event taxonomy instead of raw assistant text
plus suppressed lifecycle events:

- Top-level `thread.started`, `turn.started`, `turn.completed`,
  `turn.failed`, and `error` events produce `[codex] turn:` or
  `[codex] error:` lines.
- `item.completed` envelopes produce `[codex] message:`, `[codex] reasoning:`,
  `[codex] command:`, and `[codex] file:` lines.
- New Codex 0.128 `item.started` command executions produce a separate
  `[codex] command: started ...` line before the completion line.
- Unknown or malformed event objects produce bounded `[codex] event: ...`
  fallbacks instead of silent empty stream gaps.
- Codex stream lines are capped at 240 characters including the `[codex] `
  prefix, matching the current progress notification bound.

Current targeted verification after this parser pass:

- `npx vitest run test/adapters/codex.parser.test.ts`: passed.
  - 1 test file passed.
  - 20 tests passed.
- `npx tsc --noEmit`: passed.

## Update - 2026-05-03 Interactive Startup Responsiveness + Status UX

Interactive startup now renders Ink immediately and runs required adapter
readiness checks inside the UI lifecycle:

- `crew run` (interactive) no longer blocks first render on
  `assertRequiredAgentsReady`.
- The App mounts first, then runs startup health checks asynchronously.
- Prompt input is temporarily disabled only while startup checks are active and
  now shows a visible spinner/status line: `Checking adapter status...`.
- If startup checks fail, the error is shown in the conversation and the input
  stays blocked with a clear status hint to run `crew status`.

Status visibility and logging behavior were also tightened:

- Prompt status text now renders even when input is enabled, so step/busy
  status remains visible during normal interaction.
- Dispatcher `run:stream` chunk logging was removed from both interactive and
  non-interactive event wiring to avoid high-volume log noise while preserving
  start/complete/fail/cancel lifecycle logs.

Current targeted verification after this follow-up:

- `npm run test:run -- test/cli/commands/run.test.ts test/cli/ui/App.test.tsx test/cli/ui/PromptInput.test.tsx`:
  passed.
- `npm run lint`: passed.

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

## Update - 2026-05-01 Config Wizard Refactor and Model Alias Follow-Up

The config setup flow has now been reworked from a mostly linear prompt block
into a replayable question-by-question wizard:

- Each question is displayed on its own cleared terminal screen.
- Users can go back with `back` / `b` in text mode or the `[Back]` menu item in
  TTY selection mode. The wizard replays prior answers into a draft config, so
  changing an earlier answer updates later defaults/options.
- Quick mode still skips role-model and per-agent internals.
- Advanced mode no longer asks obvious built-in backend questions such as which
  backend the `codex` agent should use. Backend/command/args/capability prompts
  are limited to custom or generic agents.
- Model prompts now explain that custom/newer model IDs can be entered when the
  underlying CLI supports them.

Model defaults and compatibility were also updated:

- Claude presets now use the Claude CLI's latest-model aliases (`sonnet` and
  `opus`) instead of pinned full model IDs.
- The default general OpenAI/Codex model alias now resolves to `gpt-5.5`.
- Claude model validation still accepts full `claude-*` IDs, and Codex model
  validation accepts newer `gpt-*` and `o*` IDs instead of only the built-in
  preset strings.
- The wizard has an injectable model-option discovery hook and a conservative
  CLI-backed default. The installed Codex/Gemini CLIs do not expose reliable
  model-listing subcommands; Claude help does expose latest aliases, so those
  are offered when available.

Current verification after this follow-up:

- TTY smoke in a temporary project:
  - `npm run build`: passed.
  - `node dist/index.js config setup`: passed; selected `codex`, observed
    cleared one-question screens, and saved the temporary project config.
- `npm run test:run -- --configLoader runner test/cli/commands/config.test.ts test/cli/ui/config/command-handler.test.ts test/workflow/config-validation.test.ts test/workflow/config-service.test.ts test/workflow/loader.test.ts test/workflow/config-codec.test.ts test/workflow/config-path-registry.test.ts`:
  passed.
  - 7 test files passed.
  - 139 tests passed.
- `npm run test:run -- --configLoader runner test/adapters/claude-code.test.ts test/cli/runtime/preflight.test.ts test/cli/runtime/create-runner.test.ts`:
  passed.
  - 3 test files passed.
  - 54 tests passed.
- `npm run lint`: passed.
- `npm run test:run -- --configLoader runner`: passed.
  - 82 test files passed.
  - 1 test file skipped.
  - 723 tests passed.
  - 3 tests skipped.

## Update - 2026-05-01 Crew Profile Management Follow-Up

Crew config profiles have been promoted from hidden storage plumbing to a
first-class CLI surface:

- `crew profile` / `crew profile list` lists saved profiles, the active marker,
  scope, captain CLI/model, agent count, and backing file.
- `crew profile show [name]` displays profile details.
- `crew profile create <name> --from current|default|<profile>` snapshots an
  effective config into a project/global profile file.
- `crew profile use <name>` validates and persists the active profile.
- `crew profile copy <source> <target>` and `crew profile delete <name>` manage
  saved profile files.
- `crew profile setup <name>` creates a profile when needed and runs the guided
  config wizard against that profile.
- `crew run --profile <name>` loads a profile for one run without changing the
  active profile.
- `crew config setup/edit --profile <name>` can target a specific profile.

Runtime note: profiles currently select config only. Captain session/runtime
state remains project-scoped, not profile-scoped. If cross-profile conversation
carryover becomes confusing, the next follow-up should move captain session
storage under the selected profile.

Current verification after this follow-up:

- Built CLI smoke in a temporary project:
  - `node dist/index.js profile list`: passed.
  - `node dist/index.js profile create codex-first --from default --select`:
    passed.
  - `node dist/index.js config set captain.cli codex --profile codex-first`:
    passed.
  - `node dist/index.js profile show codex-first`: passed and showed
    `captain: codex`, `model: gpt-5.5`.
  - `node dist/index.js profile copy codex-first codex-copy`: passed.
  - `node dist/index.js profile show codex-copy`: passed and showed the copied
    Codex captain settings.
  - `node dist/index.js profile delete codex-copy --yes`: passed.
- `npm run build`: passed.
- `npm run lint`: passed.
- `npm run test:run -- --configLoader runner`: passed.
  - 83 test files passed.
  - 1 test file skipped.
  - 732 tests passed.
  - 3 tests skipped.

## Update - 2026-05-03 Terminal Log Noise Follow-Up

The terminal UI no longer renders runtime progress logs inline:

- Interactive Ink sessions no longer append step start/done messages to the
  conversation.
- Interactive Ink sessions no longer render dispatched agent stream chunks in
  the conversation view or in the in-flight tool strip. The strip remains as a
  compact "tool in flight" indicator with tool name and id.
- Non-interactive `crew run "<prompt>"` no longer prints dispatcher progress
  lines for run start, stream chunks, completion, failure, or cancellation.
- Runtime progress details are now written through the shared logger so they
  still land in `.crew/logs/run-*.log`.
- The default console log threshold is now `error`; `CREW_LOG_LEVEL=debug` or
  `--debug` still opt back into terminal log output when needed.

Current verification after this follow-up:

- `npm run test:run -- --configLoader runner test/cli/ui/App.test.tsx test/cli/runtime/attach-runner-events.test.ts test/utils/logger.test.ts test/cli/commands/run.test.ts`:
  passed.
  - 4 test files passed.
  - 22 tests passed.
- `npm run lint`: passed.

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
