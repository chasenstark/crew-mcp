# Captain tool surface

M3 replaces the 11-verb controller with an 8-tool surface the captain
drives via each CLI's native tool-loop. The tool names + schemas are
declared in one place — `src/captain/tools/catalog.ts` — and projected
into three shapes:

1. `CaptainActionServer` (the `mcp__crew__<name>`-prefixed tool list the
   captain sees).
2. Per-CLI MCP wiring (Claude inline JSON, Gemini allowed-names, Codex
   argv overrides — see `docs/architecture/captain-portability.md`).
3. The prompt-side "agent inventory" block rendered into
   `buildCaptainSystemPrompt` (`src/captain/prompts/captain-system.ts`).

## The 8 tools

| Tool | Dispatch kind | Description |
|------|---------------|-------------|
| `run_agent` | dispatched | Delegate a bounded task to a named subagent. Allocates `.crew/runs/<runId>/worktree/`; the dispatcher's terminal-event listener cleans up. Input: `{agent_id, prompt, working_directory?, model?, capabilities_hint?}`. |
| `list_agents` | synchronous | Return the current agent inventory (name, capabilities, health, optional quota). |
| `ask_user` | dispatched | Block until the user answers. Schedule via the ask-user coordinator; user_message events resolve in FIFO order. |
| `message_user` | synchronous | Append an assistant-visible message without ending the turn. |
| `plan_tasks` | synchronous | Wrapper over the legacy `decompose` step helper. Free-form `role` strings post-M3 (no hard enum). |
| `analyze_output` | synchronous | Wrapper over `ingest`. Synthesizes a minimal `TaskResult` from `{task_description, agent_output, files_modified?}`. |
| `compress_context` | synchronous | Wrapper over `summarize`. Validates `analyzed_output` via `IngestOutputSchema` before calling through. |
| `finish` | synchronous | Emit the final report and terminate the session. Implementation is `dispatchFinish(session, loop, input)` (src/captain/tools/finish.ts) — appends summary as an assistant message and calls `SessionLoop.requestExit(summary)` so the loop exits on its next scheduleNextTurn check. |

## Invariants

- Every captain turn sees exactly these 8 tools, prefixed with
  `mcp__crew__`. `ToolCatalog.toolNames()` is stable across runs.
- `ToolCatalog.getToolSchemaHash()` depends ONLY on (name, description,
  input schema) per tool. Preset hint edits and agent-inventory shifts do
  NOT bump the hash — the hash gates `providerSessionRef` invalidation,
  so preserving it across those deltas keeps native-resume sticky.
- `run_agent` mints a fresh `runId = randomUUID()` per call. The
  dispatcher's `run:complete` / `run:failed` / `run:cancelled` events
  fire `worktreeManager.cleanupByRunId(runId)` exactly once. No finally
  blocks inside the tool's `run()` to avoid double-cleanup.

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
