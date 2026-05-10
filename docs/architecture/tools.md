> **Current as of 2026-05-10.**

## Load-bearing source anchors

- Live server registration: `src/cli/commands/serve.ts:247`, `src/cli/commands/serve.ts:265`, `src/cli/commands/serve.ts:281`, `src/cli/commands/serve.ts:326`, `src/cli/commands/serve.ts:414`, `src/cli/commands/serve.ts:512`, `src/cli/commands/serve.ts:544`, `src/cli/commands/serve.ts:617`.
- Install-time catalog parity: `src/install/tool-catalog.ts:1`, `src/install/tool-catalog.ts:27`, `test/install/tool-catalog.test.ts:20`, `test/install/tool-catalog.test.ts:29`.
- Tool schemas: `src/orchestrator/tools/list-runs.ts:35`, `src/orchestrator/tools/run-agent.ts:48`, `src/orchestrator/tools/continue-run.ts:17`, `src/orchestrator/tools/merge-run.ts:33`, `src/orchestrator/tools/get-run-status.ts:34`, `src/orchestrator/tools/get-run-status.ts:42`, `src/orchestrator/tools/get-run-status.ts:44`, `src/orchestrator/tools/cancel-run.ts:24`.
- Async dispatch and status envelope: `src/cli/commands/serve.ts:763`, `src/cli/commands/serve.ts:776`, `src/cli/commands/serve.ts:783`, `src/cli/commands/serve.ts:1231`, `src/cli/commands/serve.ts:1257`, `src/cli/commands/serve.ts:1261`.
- Retired v0.1 surface: `src/orchestrator/tools/index.ts:7`, `src/orchestrator/tools/index.ts:8`.

# MCP Tool Surface

## Current Catalog

The live catalog has eight MCP tools. `crew-mcp serve` registers those tools directly in `src/cli/commands/serve.ts`, and `crew-mcp install` mirrors the same names through `CATALOG_TOOLS` at `src/install/tool-catalog.ts:27`.

| Tool | Input source | Runtime path | Anchor |
| --- | --- | --- | --- |
| `list_agents` | Empty passthrough schema. | Direct server handler. | `src/cli/commands/serve.ts:247`, `src/orchestrator/tools/list-agents.ts:35` |
| `list_runs` | `{status?, include_unknown_repo?, completedAfter?, limit?}`. | Direct server handler that lists repo-scoped persisted run records. | `src/cli/commands/serve.ts:265`, `src/orchestrator/tools/list-runs.ts:35` |
| `run_agent` | `{agent_id, prompt, working_directory?, model?, effort?, read_only?}`. | Starts dispatcher work for a fresh run. | `src/cli/commands/serve.ts:281`, `src/orchestrator/tools/run-agent.ts:48`, `src/cli/commands/serve.ts:312` |
| `continue_run` | `{run_id, prompt, model?, effort?}`. | Starts dispatcher work for an existing run. | `src/cli/commands/serve.ts:326`, `src/orchestrator/tools/continue-run.ts:17`, `src/cli/commands/serve.ts:401` |
| `merge_run` | `{run_id, target_branch?, force?, commit_title?, commit_body?}`. | Direct server handler. | `src/cli/commands/serve.ts:414`, `src/orchestrator/tools/merge-run.ts:33` |
| `discard_run` | `{run_id}`. | Direct server handler. | `src/cli/commands/serve.ts:512`, `src/orchestrator/tools/discard-run.ts:13` |
| `get_run_status` | `{run_id, since_event_line?, wait_for_change_ms?, log_lines?, max_events_tail?}`. | Direct server handler, with snapshot and long-poll modes. | `src/cli/commands/serve.ts:544`, `src/orchestrator/tools/get-run-status.ts:44` |
| `cancel_run` | `{run_id}`. | Direct server handler that aborts an in-flight dispatcher task. | `src/cli/commands/serve.ts:617`, `src/orchestrator/tools/cancel-run.ts:24` |

`src/install/tool-catalog.ts:1` documents that the static install catalog is used by `crew-mcp install` and `crew-mcp verify`. The parity test builds a fresh server at `test/install/tool-catalog.test.ts:20`, calls `listTools()` at `test/install/tool-catalog.test.ts:29`, and compares those names with `CATALOG_TOOLS` at `test/install/tool-catalog.test.ts:31`.

## Retired v0.1 Tools

`ask_user`, `message_user`, `finish`, `plan_tasks`, `analyze_output`, and `compress_context` are not live MCP tools in v0.2. The barrel comment records those retired names at `src/orchestrator/tools/index.ts:7` through `src/orchestrator/tools/index.ts:8`; the live registrations in `src/cli/commands/serve.ts` contain only the eight tools listed above.

## Dispatch Tools

`run_agent` and `continue_run` are the only tools that start dispatcher work. `run_agent` calls `runDispatchAndRespond()` at `src/cli/commands/serve.ts:312`; `continue_run` calls it at `src/cli/commands/serve.ts:400`.

Both dispatch tools return immediately through the async-first helper. `runDispatchAndRespond()` documents the async-first model at `src/cli/commands/serve.ts:763`, starts the dispatcher at `src/cli/commands/serve.ts:776`, and returns the structured `RunEnvelope` at `src/cli/commands/serve.ts:783`.

The dispatch envelope includes `agent_id`, `events_log_path`, `tail_command_path`, and `tail_command_url` at `src/cli/commands/serve.ts:785` through `src/cli/commands/serve.ts:789`. It also includes `status: "running"` at `src/cli/commands/serve.ts:791`.

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

1. Add or update the tool implementation under `src/orchestrator/tools/`; the current tool barrel exports schemas and descriptions from that directory at `src/orchestrator/tools/index.ts:10` through `src/orchestrator/tools/index.ts:65`.
2. Register the live MCP tool in `src/cli/commands/serve.ts`; the existing eight registration blocks start at `src/cli/commands/serve.ts:247`, `src/cli/commands/serve.ts:265`, `src/cli/commands/serve.ts:281`, `src/cli/commands/serve.ts:326`, `src/cli/commands/serve.ts:414`, `src/cli/commands/serve.ts:512`, `src/cli/commands/serve.ts:544`, and `src/cli/commands/serve.ts:617`.
3. Add the install-time parity entry to `CATALOG_TOOLS` at `src/install/tool-catalog.ts:27`; the comment at `src/install/tool-catalog.ts:11` states that new tools must be added to both `serve.ts` and the static catalog.
4. Extend parity coverage in `test/install/tool-catalog.test.ts`; the current test asserts `listTools()` and `CATALOG_TOOLS` stay aligned at `test/install/tool-catalog.test.ts:29` through `test/install/tool-catalog.test.ts:32`.
