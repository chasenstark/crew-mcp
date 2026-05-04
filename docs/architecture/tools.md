# Captain tool surface

M3 replaced the 11-verb controller with an 8-tool surface the captain
drives via each CLI's native tool-loop. M4 tightened that surface into
"write your prompt inline; call wrappers only when you genuinely need
them." The tool names + schemas are declared in one place —
`src/captain/tools/catalog.ts` — and projected into three shapes:

1. `CaptainActionServer` (the `mcp__crew__<name>`-prefixed tool list the
   captain sees).
2. Per-CLI MCP wiring (Claude inline JSON, Gemini allowed-names, Codex
   argv overrides — see `docs/architecture/captain-portability.md`).
3. The prompt-side "agent inventory" block rendered into
   `buildCaptainSystemPrompt` (`src/captain/prompts/captain-system.ts`).

## The 8 tools

M4-3 tags each tool with a **Primary** or **Optional** marker so the
captain sees the hierarchy both in the MCP tool list (adapters that
surface descriptions) and in the rendered captain-system prompt. The
prefixes live in the per-tool `<NAME>_DESCRIPTION` exports — a single
source of truth.

| Tool | Dispatch kind | Description |
|------|---------------|-------------|
| `run_agent` | dispatched | **Primary work primitive.** Delegate a bounded task to a named subagent. Allocates `~/.crew/runs/<runId>/worktree/`; the dispatcher's terminal-event listener cleans up. Write the agent's prompt inline — do NOT route through `plan_tasks` for single-task work. Input: `{agent_id, prompt, working_directory?, model?, effort?}`. `effort` (`low|medium|high`) overrides the per-machine default in `~/.crew/agents.json`. |
| `list_agents` | synchronous | Return the current agent inventory: `{name, strengths[], effort?, adapter, available, version?, authenticated?, error?, quota?, aliases?}`. `strengths` are soft routing hints; `effort` is the per-machine default for adapters with a native reasoning-effort knob (codex). |
| `ask_user` | dispatched | Block until the user answers. Use to clarify scope, resolve ambiguity, or align on approach — not only when blocked. Schedule via the ask-user coordinator; user_message events resolve in FIFO order. |
| `message_user` | synchronous | Append an assistant-visible message without ending the turn. |
| `plan_tasks` | synchronous | **Optional.** Wrapper over the `decompose` step helper. Useful for genuinely multi-step work; for single-task work dispatch directly through `run_agent`. Free-form `role` strings post-M3 (no hard enum). |
| `analyze_output` | synchronous | **Optional.** Wrapper over `ingest`. Skip for typical cases — reason about the raw `tool_result` inline. |
| `compress_context` | synchronous | **Optional.** Wrapper over `summarize`. Reach for this when the operating guardrails render the compression advisory (session > 15 messages since last compression AND > 100 KB of log). |
| `finish` | synchronous | Emit the final report and terminate the session. Call this when the user's request is addressed and (for planned work) the result is verified; do not wait for an unsolicited review. Implementation is `dispatchFinish(session, loop, input)` — appends summary as an assistant message and calls `SessionLoop.requestExit(summary)` so the loop exits on its next scheduleNextTurn check. |

## When to use wrappers

M4-1 + M4-3 reframe the three wrappers (`plan_tasks`, `analyze_output`,
`compress_context`) as opt-in optimizations rather than default
waypoints. Rules of thumb:

- **`plan_tasks`**: earn it when you genuinely need a structured plan —
  a multi-subagent flow with dependencies, or a request complex enough
  that writing one plan up-front saves multiple inline prompts. Skip it
  on single-task requests.
- **`analyze_output`**: earn it when you need structured findings
  (severity-tagged review findings, concerns with machine-readable
  shape) or when an agent's output is too long to reason about inline.
  Skip it for typical tool results — the captain reads them directly.
- **`compress_context`**: earn it when the session-loop advisory fires
  (the captain-system prompt grows a bullet pointing at the accumulation
  of history). Before then, the thresholds aren't crossed and the
  wrapper costs a turn without measurable benefit.

## Invariants

- Every captain turn sees exactly these 8 tools, prefixed with
  `mcp__crew__`. `ToolCatalog.toolNames()` is stable across runs.
- `ToolCatalog.getToolSchemaHash()` depends ONLY on (name, description,
  input schema) per tool. Preset hint edits and agent-inventory shifts do
  NOT bump the hash — the hash gates `providerSessionRef` invalidation,
  so preserving it across those deltas keeps native-resume sticky.
- `run_agent` mints a fresh `runId = randomUUID()` per call. Successful
  default-worktree executions with reported or git-detected edits merge via
  `WorktreeManager.mergeRunWorktree` before the dispatcher emits the
  terminal event; then the dispatcher's `run:complete` / `run:failed` /
  `run:cancelled` listeners fire
  `worktreeManager.cleanupByRunId(runId)` exactly once. No finally blocks
  inside the tool's `run()` to avoid double-cleanup.

## Adding a tool

1. Create the tool file under `src/captain/tools/`:
   - Zod input schema — exported as `<name>InputSchema`
   - Description string — exported as `<NAME>_DESCRIPTION`
   - Handler (for sync) or `plan*` helper (for dispatched)
2. Register the tool in `src/captain/tools/catalog.ts`:
   - Append to `M3_TOOL_NAMES`
   - Add an import-line for the schema + description and wire into
     `DESCRIPTIONS` + `INPUT_SCHEMAS`. `catalog.ts` is the router — do not
     re-declare the schema here (see `test/captain/tools/catalog.test.ts`
     "catalog schema + description parity" which locks this by identity).
3. Route it in `src/captain/judgment-runner.ts:handleM3ToolCallFromAdapter`
   (for sync) or `buildM3SessionLoopPair.scheduler` (for dispatched).
4. Write a test under `test/captain/tools/<name>.test.ts` and extend
   `test/captain/tools/catalog.test.ts` to assert it appears in
   `toActionCatalog()`.

Full walkthrough in `AGENTS.md` § "Adding a new captain tool".
