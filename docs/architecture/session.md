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
  a `DispatchedToolCall` whose `run()` invokes `adapter.execute` and
  merges successful default-worktree edits when git status or the adapter
  reports changed files before the dispatcher publishes the terminal result.
  `ask_user` wraps `waitForUserResponse`.

## Worktree lifecycle (M1.5-14 + M3-5)

- Each `run_agent` call allocates `.crew/runs/<runId>/worktree/` via
  `WorktreeManager.createRunWorktree(runId)`.
- Successful `run_agent` calls that used the default run worktree inspect git
  status before returning their `TaskResult`; when git status or the adapter
  reports changed files, the run worktree merges through
  `WorktreeManager.mergeRunWorktree(runId)`, and `filesModified` is
  backfilled from git status when the adapter did not report file changes.
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

**Preset changes are explicitly NOT drift sources.** A preset is prompt
material, so switching presets via `/preset` or `/config set
captain.preset` does NOT invalidate `providerSessionRef` — native
session resume continues as normal. See `docs/architecture/presets.md`
for the invariant.

## Session snapshot schema (M5-4)

`session.json` carries `schemaVersion: 2` as of M5. v1 snapshots load
cleanly — the reader accepts either version and normalizes in memory,
so existing sessions on disk survive the bump. Writes always stamp v2.

Fields added at v2:

- `activePreset?: string` — the name of the session's active preset
  override (set via `/preset <name>`). Storing the name (not the
  resolved `PresetConfig`) means a hint edit in `workflow.yaml` between
  sessions takes effect on the next turn without a session-side
  migration.

`CaptainSession.setActivePreset(name | undefined)` is synchronous +
atomic: the in-memory field, the persisted snapshot, and the
`preset_changed` SessionEvent all land in the same tick. A crash
between the mutation and the next turn cannot leave the session
half-updated — either the write landed and the next load sees the new
value, or it didn't and the next load sees the old one.

The `preset_changed` event is observability-only. The session loop does
NOT react to it; per-turn resolution reads `session.activePreset`
directly at turn start.

## Config lockfile (Gemini)

Claude + Codex pass MCP config per-invocation (inline JSON / argv
overrides), so they self-heal on catalog drift. Gemini reads settings
from `~/.gemini/settings.json`, so preflight keeps that file in sync
with the catalog via `.crew/config.lock.json` — see M3-9 in
`src/captain/catalog-lock.ts` + `src/cli/runtime/preflight.ts:syncGeminiSettingsFromCatalog`.

## Compression advisories

M4-2 adds a one-line nudge to the captain-system prompt's guardrails
when the session has accumulated enough history to warrant calling
`compress_context`. The helper `shouldAdviseCompression(session)`
(`src/captain/session-loop.ts`) fires only when BOTH thresholds trip:

- ≥ 15 messages since the last `compress_context` tool call, AND
- ≥ 100 KB of accumulated message-log bytes (JSON-stringified).

Either one alone is ignored — a short session with a few large tool
results doesn't need compression, and a long session that just
compressed also doesn't. The thresholds are module-level constants
tagged `// M4 tunable`, so M5 presets can thread a per-preset override
through without a schema bump.

The advisory rides along `BuildCaptainSystemPromptArgs.advisory`, which
`renderGuardrails()` appends as an extra bullet. It is prompt material,
not tool schema — rendering it cannot invalidate `providerSessionRef`.
The helper is scan-on-demand via `CaptainSession.messagesSinceToolCall`;
no state file changes, and loads re-scan automatically.
