> **Current as of 2026-05-14.**

## Load-bearing source anchors

- Live server registration: `src/cli/commands/serve.ts:398`, `src/cli/commands/serve.ts:414`, `src/cli/commands/serve.ts:427`, `src/cli/commands/serve.ts:483`, `src/cli/commands/serve.ts:511`, `src/cli/commands/serve.ts:528`, `src/cli/commands/serve.ts:545`, `src/cli/commands/serve.ts:666`, `src/cli/commands/serve.ts:774`, `src/cli/commands/serve.ts:809`, `src/cli/commands/serve.ts:895`.
- Install-time catalog parity: `src/install/tool-catalog.ts:1`, `src/install/tool-catalog.ts:30`, `test/install/tool-catalog.test.ts:21`, `test/install/tool-catalog.test.ts:31`.
- Tool schemas: `src/orchestrator/tools/list-runs.ts:35`, `src/orchestrator/tools/run-agent.ts:48`, `src/orchestrator/tools/run-panel.ts:24`, `src/orchestrator/tools/get-panel-status.ts:8`, `src/orchestrator/tools/aggregate-panel.ts:10`, `src/orchestrator/tools/continue-run.ts:17`, `src/orchestrator/tools/merge-run.ts:33`, `src/orchestrator/tools/get-run-status.ts:34`, `src/orchestrator/tools/get-run-status.ts:42`, `src/orchestrator/tools/get-run-status.ts:44`, `src/orchestrator/tools/cancel-run.ts:24`.
- Async dispatch and status envelope: `src/cli/commands/serve.ts:1069`, `src/cli/commands/serve.ts:1082`, `src/cli/commands/serve.ts:1089`, `src/cli/commands/serve.ts:1536`, `src/cli/commands/serve.ts:1562`, `src/cli/commands/serve.ts:1566`.
- Retired v0.1 surface: `src/orchestrator/tools/index.ts:7`, `src/orchestrator/tools/index.ts:8`.

# MCP Tool Surface

## Current Catalog

The live catalog has eleven MCP tools. `crew-mcp serve` registers those tools directly in `src/cli/commands/serve.ts`, and `crew-mcp install` mirrors the same names through `CATALOG_TOOLS` at `src/install/tool-catalog.ts:30`.

| Tool | Input source | Runtime path | Anchor |
| --- | --- | --- | --- |
| `list_agents` | Empty passthrough schema. | Direct server handler. | `src/cli/commands/serve.ts:398`, `src/orchestrator/tools/list-agents.ts:36` |
| `list_runs` | `{status?, include_unknown_repo?, completedAfter?, limit?}`. | Direct server handler that lists repo-scoped persisted run records. | `src/cli/commands/serve.ts:414`, `src/orchestrator/tools/list-runs.ts:35` |
| `run_agent` | `{agent_id, prompt, working_directory?, model?, effort?, read_only?, peer_messages?}`. | Starts dispatcher work for a fresh run. | `src/cli/commands/serve.ts:427`, `src/orchestrator/tools/run-agent.ts:48`, `src/cli/commands/serve.ts:438` |
| `run_panel` | `{implementer_run_id?, reviewers}`. | Dispatches parallel reviewer runs and records durable panel state. | `src/cli/commands/serve.ts:483`, `src/orchestrator/tools/run-panel.ts:24` |
| `get_panel_status` | `{panel_id}`. | Direct server handler that reads panel reviewer state and counts. | `src/cli/commands/serve.ts:511`, `src/orchestrator/tools/get-panel-status.ts:8` |
| `aggregate_panel` | `{panel_id}`. | Direct server handler that builds reviewer `peer_messages` for `continue_run`. | `src/cli/commands/serve.ts:528`, `src/orchestrator/tools/aggregate-panel.ts:10` |
| `continue_run` | `{run_id, prompt?, model?, effort?, peer_messages?}`. | Starts dispatcher work for an existing run. | `src/cli/commands/serve.ts:545`, `src/orchestrator/tools/continue-run.ts:17`, `src/cli/commands/serve.ts:650` |
| `merge_run` | `{run_id, target_branch?, force?, commit_title?, commit_body?, confirmed?}`. | Direct server handler. | `src/cli/commands/serve.ts:666`, `src/orchestrator/tools/merge-run.ts:33` |
| `discard_run` | `{run_id}`. | Direct server handler. | `src/cli/commands/serve.ts:774`, `src/orchestrator/tools/discard-run.ts:13` |
| `get_run_status` | `{run_id, since_event_line?, wait_for_change_ms?, wait_for_terminal_only?, log_lines?, max_events_tail?}`. | Direct server handler, with snapshot and opt-in long-poll modes. | `src/cli/commands/serve.ts:809`, `src/orchestrator/tools/get-run-status.ts:44` |
| `cancel_run` | `{run_id}`. | Direct server handler that aborts an in-flight dispatcher task. | `src/cli/commands/serve.ts:895`, `src/orchestrator/tools/cancel-run.ts:24` |

`src/install/tool-catalog.ts:1` documents that the static install catalog is used by `crew-mcp install` and `crew-mcp verify`. The parity test builds a fresh server at `test/install/tool-catalog.test.ts:21`, calls `listTools()` at `test/install/tool-catalog.test.ts:41`, and compares those names with `CATALOG_TOOLS` at `test/install/tool-catalog.test.ts:43`. It also explicitly checks that `run_panel`, `get_panel_status`, and `aggregate_panel` are exported from `src/orchestrator/tools/index.ts`.

## Retired v0.1 Tools

`ask_user`, `message_user`, `finish`, `plan_tasks`, `analyze_output`, and `compress_context` are not live MCP tools in v0.2. The barrel comment records those retired names at `src/orchestrator/tools/index.ts:7` through `src/orchestrator/tools/index.ts:8`; the live registrations in `src/cli/commands/serve.ts` contain only the eleven tools listed above.

## Dispatch Tools

`run_agent`, `continue_run`, and `run_panel` are the tools that start dispatcher work. `run_agent` calls `dispatchRunAgentInternal()` at `src/cli/commands/serve.ts:438`; `continue_run` calls `runDispatchAndRespond()` at `src/cli/commands/serve.ts:650`; `run_panel` delegates reviewer dispatch through `runPanelHandler()` at `src/cli/commands/serve.ts:492`.

The async dispatch paths return immediately. `runDispatchAndRespond()` documents the async-first model at `src/cli/commands/serve.ts:1069`, starts the dispatcher at `src/cli/commands/serve.ts:1082`, and returns the structured `RunEnvelope` at `src/cli/commands/serve.ts:1103`; `run_agent` uses the extracted `dispatchRunAgentInternal()` helper for the same lifecycle contract.

The full dispatch envelope includes `agent_id`, `events_log_path`, `tail_command_path`, and `tail_command_url` at `src/cli/commands/serve.ts:1089` through `src/cli/commands/serve.ts:1094`. It also includes `status: "running"` at `src/cli/commands/serve.ts:1095`; the default structured envelope is trimmed unless `CREW_FULL_ENVELOPE=1`.

`continue_run` supports per-call `model` and `effort` overrides; the schema declares those fields at `src/orchestrator/tools/continue-run.ts:20` and `src/orchestrator/tools/continue-run.ts:26`. The server resolves those overrides before building the dispatch task at `src/cli/commands/serve.ts:357` through `src/cli/commands/serve.ts:366`.

## Status Tool

`get_run_status` has snapshot behavior when `wait_for_change_ms` is absent or zero, and long-poll behavior when it is positive; the handler branches on `useLongPoll` at `src/cli/commands/serve.ts:557` through `src/cli/commands/serve.ts:562`.

While the run is `running`, the response is intentionally lean: `status`, `events_tail`, and `next_event_line` are the only always-present fields according to `src/cli/commands/serve.ts:1116` through `src/cli/commands/serve.ts:1120`, and running poll returns suppress `events_tail` content at `src/cli/commands/serve.ts:1231` through `src/cli/commands/serve.ts:1242`.

Terminal responses add `filesChanged`, `prompts`, `summary`, conditional `lastError`, `mergeStatus`, `warnings`, `readOnly`, and capped `events_tail`; those terminal-only fields are documented at `src/cli/commands/serve.ts:1125` through `src/cli/commands/serve.ts:1133` and built at `src/cli/commands/serve.ts:1257` through `src/cli/commands/serve.ts:1270`.

`max_events_tail` defaults to `10` and caps at `500`; the constants are `DEFAULT_MAX_EVENTS_TAIL` at `src/orchestrator/tools/get-run-status.ts:36` and `MAX_EVENTS_TAIL_CAP` at `src/orchestrator/tools/get-run-status.ts:44`. The input schema exposes `max_events_tail` at `src/orchestrator/tools/get-run-status.ts:86`.

## Merge, Discard, Cancel

`merge_run` is the explicit branch-mutation boundary. Its schema includes `force`, `commit_title`, and `commit_body` at `src/orchestrator/tools/merge-run.ts:36`, `src/orchestrator/tools/merge-run.ts:45`, and `src/orchestrator/tools/merge-run.ts:51`; the server passes those values into `mergeRunWorktree()` at `src/cli/commands/serve.ts:451` through `src/cli/commands/serve.ts:456`.

On successful merge, the server marks the run merged at `src/cli/commands/serve.ts:459` and performs best-effort worktree cleanup at `src/cli/commands/serve.ts:469`. On discard, the server marks state discarded at `src/cli/commands/serve.ts:531`; write-mode runs clean the worktree first at `src/cli/commands/serve.ts:528`.

`cancel_run` finds an in-flight dispatcher task by `run_id` at `src/cli/commands/serve.ts:638` through `src/cli/commands/serve.ts:640`; the underlying schema is only `run_id` at `src/orchestrator/tools/cancel-run.ts:24` through `src/orchestrator/tools/cancel-run.ts:26`.

## Adding A Tool

1. Add or update the tool implementation under `src/orchestrator/tools/`; export its schema, description, handler/helper types, and any runtime helpers needed by tests from `src/orchestrator/tools/index.ts`.
2. Register the live MCP tool in `src/cli/commands/serve.ts`; the existing eleven registration blocks start at `src/cli/commands/serve.ts:398`, `src/cli/commands/serve.ts:414`, `src/cli/commands/serve.ts:427`, `src/cli/commands/serve.ts:483`, `src/cli/commands/serve.ts:511`, `src/cli/commands/serve.ts:528`, `src/cli/commands/serve.ts:545`, `src/cli/commands/serve.ts:666`, `src/cli/commands/serve.ts:774`, `src/cli/commands/serve.ts:809`, and `src/cli/commands/serve.ts:895`.
3. Add the install-time parity entry to `CATALOG_TOOLS` at `src/install/tool-catalog.ts:30`; the comment at `src/install/tool-catalog.ts:11` states that new tools must be added to both `serve.ts` and the static catalog.
4. Extend parity coverage in `test/install/tool-catalog.test.ts`; the current test asserts `listTools()` and `CATALOG_TOOLS` stay aligned at `test/install/tool-catalog.test.ts:41` through `test/install/tool-catalog.test.ts:44`, and targeted tests can also assert the `src/orchestrator/tools/index.ts` exports.
