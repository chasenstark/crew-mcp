# Captain session runtime

The M3 captain runtime is event-driven. Three modules anchor it:

- `src/captain/session.ts` — durable conversation log (messages +
  providerSessionRef + cliVersionTag + toolSchemaHash). Persisted via
  `SessionStore` under `.crew/captain/session.json`.
- `src/captain/tool-dispatcher.ts` — concurrent task runner; one
  AbortController per dispatched tool call; terminal events
  (`run:complete`, `run:failed`, `run:cancelled`) are the authority for
  tool_result writes.
- `src/captain/session-loop.ts` — serializes captain turns (at most one
  in flight), schedules tool calls via a caller-provided scheduler, and
  reacts to session events to drive the next turn.

## Lifecycle per event

1. Event arrives on `session.events()` (user_message, tool_completed,
   tool_failed, tool_cancelled) or via `session.subscribe(listener)`.
2. The loop wakes; if a turn is already running, it flags `pendingTurn`
   and returns — the running turn re-checks on exit.
3. If no turn is running, the loop starts one. The captain sees the full
   `session.toToolLoopMessages()` plus `providerSessionRef` for resume.
4. The captain emits `assistantText` + `toolCalls`. Assistant text lands
   as a `SessionMessage`. Each toolCall is resolved either synchronously
   by the scheduler (for local actions like `finish`) or started on the
   dispatcher (for long-running actions like `run_agent`). In the
   dispatched case, the turn ENDS with a pending placeholder; the real
   tool_result arrives later as a tool_completed event.
5. On turn exit, loop re-checks `pendingTurn` and loops if needed.

## The M3 scheduler + captain-turn

`judgment-runner.buildM3SessionLoopPair` constructs both halves:

- **Captain turn** — wraps `adapter.executeWithTools` with the 8-tool
  catalog. Synchronous tools (`list_agents`, `message_user`,
  `plan_tasks`, `analyze_output`, `compress_context`) run inline via
  `handleM3ToolCallFromAdapter`. Dispatched tools (`run_agent`,
  `ask_user`) return a placeholder `{status: 'dispatched', toolCallId}`
  and are recorded for the session-loop to schedule. `finish` runs
  inline, writes the summary assistant message, and signals exit via
  `SessionLoop.requestExit(summary)`.
- **Scheduler** — handles the two dispatched-kind tools. `run_agent`
  calls `planRunAgent` to mint a runId, allocate a worktree, and return
  a `DispatchedToolCall` whose `run()` invokes `adapter.execute`.
  `ask_user` wraps `waitForUserResponse`.

## Worktree lifecycle (M1.5-14 + M3-5)

- Each `run_agent` call allocates `.crew/runs/<runId>/worktree/` via
  `WorktreeManager.createRunWorktree(runId)`.
- The session-loop wires dispatcher listeners that call
  `worktreeManager.cleanupByRunId(runId)` on terminal events.
- `run_agent`'s `task.run()` does NOT add a finally hook — single-owner
  cleanup avoids double-delete races.

## ProviderSessionRef invalidation

Environment drift drops `providerSessionRef` and replays on the next
turn. Drift sources:

- `cliVersionTag` change (new CLI version between turns).
- `toolSchemaHash` change (catalog tool-spec edit).

`CaptainSession.updateEnvironmentFingerprint` does the check + drop. The
session-loop retries ONCE automatically (N9 semantics): a second
consecutive rejection is a hard failure.

## Config lockfile (Gemini)

Claude + Codex pass MCP config per-invocation (inline JSON / argv
overrides), so they self-heal on catalog drift. Gemini reads settings
from `~/.gemini/settings.json`, so preflight keeps that file in sync
with the catalog via `.crew/config.lock.json` — see M3-9 in
`src/captain/catalog-lock.ts` + `src/cli/runtime/preflight.ts:syncGeminiSettingsFromCatalog`.
