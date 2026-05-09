> **Current as of 2026-05-09.**

## Load-bearing source anchors

- Binary and command surface: `package.json:6`, `package.json:7`, `src/index.ts:11`, `src/index.ts:17`, `src/index.ts:28`, `src/index.ts:36`, `src/index.ts:44`, `src/index.ts:68`, `src/index.ts:90`, `src/index.ts:101`, `src/index.ts:114`.
- Server runtime: `buildCrewMcpServer()` entry at `src/cli/commands/serve.ts:214`; constructors for `WorktreeManager`, `ToolDispatcher`, `RunStateStore`, and `McpServer` at `src/cli/commands/serve.ts:219`, `src/cli/commands/serve.ts:220`, `src/cli/commands/serve.ts:221`, and `src/cli/commands/serve.ts:236`.
- Live MCP tools: `src/cli/commands/serve.ts:241`, `src/cli/commands/serve.ts:260`, `src/cli/commands/serve.ts:303`, `src/cli/commands/serve.ts:391`, `src/cli/commands/serve.ts:489`, `src/cli/commands/serve.ts:521`, `src/cli/commands/serve.ts:594`, `src/install/tool-catalog.ts:26`.
- Async dispatch envelope and polling contract: `src/cli/commands/serve.ts:711`, `src/cli/commands/serve.ts:729`, `src/cli/commands/serve.ts:747`, `src/cli/commands/serve.ts:749`, `src/cli/commands/serve.ts:757`, `src/cli/commands/serve.ts:1082`, `src/cli/commands/serve.ts:1088`, `src/cli/commands/serve.ts:1141`.
- Adapter dispatch and constraints: `src/orchestrator/tools/run-agent.ts:322`, `src/orchestrator/tools/run-agent.ts:327`, `src/orchestrator/tools/run-agent.ts:331`, `src/orchestrator/tools/run-agent.ts:341`, `src/adapters/types.ts:191`, `src/adapters/types.ts:240`.
- Run state and worktrees: `src/orchestrator/run-state.ts:55`, `src/orchestrator/run-state.ts:148`, `src/orchestrator/run-state.ts:185`, `src/orchestrator/run-state.ts:294`, `src/orchestrator/run-state.ts:444`, `src/git/worktree.ts:297`, `src/git/worktree.ts:369`, `src/git/worktree.ts:440`, `src/git/worktree.ts:529`.
- Install-time host wiring: `src/install/hosts/types.ts:21`, `src/install/hosts/claude-code.ts:45`, `src/install/hosts/codex.ts:80`, `src/install/hosts/gemini.ts:35`, `src/cli/commands/install.ts:177`, `src/install/skill-renderer.ts:121`.
- Built-in agent registry: `src/adapters/registry.ts:190`, `src/adapters/registry.ts:192`, `src/adapters/registry.ts:193`, `src/adapters/registry.ts:194`.

# Crew Architecture

## What Crew Is

`crew-mcp` is the only published binary; the package exposes it at `package.json:6` and `package.json:7`, and Commander names the program `crew-mcp` at `src/index.ts:11`. The v0.2 CLI entry points are `serve`, `status`, `install`, `install-tail-handler`, `verify`, `agents edit`, and `uninstall` at `src/index.ts:28`, `src/index.ts:36`, `src/index.ts:44`, `src/index.ts:68`, `src/index.ts:90`, `src/index.ts:101`, and `src/index.ts:114`; `src/index.ts:17` documents that the v0.1 `run`, `init`, `config`, `profile`, `state reset`, and `resume` commands were removed.

The production runtime is `crew-mcp serve`. `buildCrewMcpServer()` at `src/cli/commands/serve.ts:214` constructs a `WorktreeManager` at `src/cli/commands/serve.ts:219`, a `ToolDispatcher` at `src/cli/commands/serve.ts:220`, a `RunStateStore` at `src/cli/commands/serve.ts:221`, and an `McpServer` at `src/cli/commands/serve.ts:236`.

The host CLI is wired at install time, not by a v0.1 captain session loop. Host adapters implement the install/uninstall interface at `src/install/hosts/types.ts:21`; `crew-mcp install` calls `installSingleTarget()` at `src/cli/commands/install.ts:177`, and skill rendering is handled by `renderSkill()` at `src/install/skill-renderer.ts:121`.

## Current Runtime

The live runtime has three code-side layers:

| Layer | Current implementation | Anchor |
| --- | --- | --- |
| Host install layer | Host adapters know where each host config and skill file live. | `src/install/hosts/types.ts:21`, `src/install/hosts/claude-code.ts:45`, `src/install/hosts/codex.ts:80`, `src/install/hosts/gemini.ts:35` |
| MCP server layer | `buildCrewMcpServer()` owns the server, dispatcher, worktree manager, and state store. | Entry: `src/cli/commands/serve.ts:214`; worktree manager: `src/cli/commands/serve.ts:219`; dispatcher: `src/cli/commands/serve.ts:220`; state store: `src/cli/commands/serve.ts:221`; MCP server: `src/cli/commands/serve.ts:236` |
| Agent dispatch layer | `run_agent` dispatches by calling `adapter.execute()`. | `src/orchestrator/tools/run-agent.ts:322` |

The production built-in agent registry registers Claude Code, Codex, and Gemini CLI at `src/adapters/registry.ts:192`, `src/adapters/registry.ts:193`, and `src/adapters/registry.ts:194`. Generic and OpenAI-compatible adapters exist in `src/adapters/`, but they are not registered by `createBuiltinRegistry()` at `src/adapters/registry.ts:190`.

The archived v0.1 runner, session, and preset docs live under `docs/plans/v0.1-archive/`; they are historical reference, not current architecture.

## Tool Surface

The live MCP surface has seven tools. The server registers them in `serve.ts`, and the install-time catalog mirrors them through `CATALOG_TOOLS` at `src/install/tool-catalog.ts:26`.

| Tool | Runtime behavior | Anchor |
| --- | --- | --- |
| `list_agents` | Direct server handler that reads prefs and returns inventory. | `src/cli/commands/serve.ts:241`, `src/cli/commands/serve.ts:250`, `src/cli/commands/serve.ts:251` |
| `run_agent` | Starts dispatcher work for a fresh run. | `src/cli/commands/serve.ts:260`, `src/cli/commands/serve.ts:269`, `src/cli/commands/serve.ts:290` |
| `continue_run` | Starts dispatcher work for an existing run. | `src/cli/commands/serve.ts:303`, `src/cli/commands/serve.ts:344`, `src/cli/commands/serve.ts:378` |
| `merge_run` | Direct server handler that merges and may clean up the worktree. | `src/cli/commands/serve.ts:391`, `src/cli/commands/serve.ts:429`, `src/cli/commands/serve.ts:447` |
| `discard_run` | Direct server handler that marks discarded and cleans write-mode worktrees. | `src/cli/commands/serve.ts:489`, `src/cli/commands/serve.ts:501`, `src/cli/commands/serve.ts:507` |
| `get_run_status` | Direct server handler for snapshot and long-poll status reads. | `src/cli/commands/serve.ts:521`, `src/cli/commands/serve.ts:534`, `src/cli/commands/serve.ts:571` |
| `cancel_run` | Direct server handler that aborts an in-flight dispatcher task. | `src/cli/commands/serve.ts:594`, `src/cli/commands/serve.ts:604` |

Only `run_agent` and `continue_run` start dispatcher work; both call `runDispatchAndRespond()` at `src/cli/commands/serve.ts:290` and `src/cli/commands/serve.ts:378`. `merge_run`, `discard_run`, `get_run_status`, and `cancel_run` are direct server handlers at `src/cli/commands/serve.ts:391`, `src/cli/commands/serve.ts:489`, `src/cli/commands/serve.ts:521`, and `src/cli/commands/serve.ts:594`.

## Dispatch Lifecycle

`run_agent` validates and plans with `planRunAgent()` at `src/cli/commands/serve.ts:269`, creates initial run state at `src/cli/commands/serve.ts:282`, and then enters the async-first dispatch path at `src/cli/commands/serve.ts:290`.

`runDispatchAndRespond()` is explicitly async-first at `src/cli/commands/serve.ts:711`; it installs lifecycle listeners at `src/cli/commands/serve.ts:734`, starts the dispatcher at `src/cli/commands/serve.ts:742`, and immediately returns a structured envelope at `src/cli/commands/serve.ts:749`. That envelope includes `run_id`, `agent_id`, `worktree_path`, `events_log_path`, `tail_command_path`, `tail_command_url`, `tail_url`, `status: "running"`, `summary`, and `files_changed` at `src/cli/commands/serve.ts:750` through `src/cli/commands/serve.ts:759`.

The adapter dispatch path calls `adapter.execute()` at `src/orchestrator/tools/run-agent.ts:322`. The constraints object passed to adapters includes `model`, `effort`, `sandbox`, `writablePaths`, and `networkAccess` at `src/orchestrator/tools/run-agent.ts:327` through `src/orchestrator/tools/run-agent.ts:341`; the shared type defines `sandbox`, `networkAccess`, and `writablePaths` at `src/adapters/types.ts:191` through `src/adapters/types.ts:234`.

Lifecycle listeners mark terminal state at `src/cli/commands/serve.ts:856` and `src/cli/commands/serve.ts:859`; they do not own worktree cleanup. Cleanup is owned by `merge_run` on successful merge at `src/cli/commands/serve.ts:447` and by `discard_run` at `src/cli/commands/serve.ts:507`.

## Status Contract

While a run is still `running`, `get_run_status` returns only `status`, `events_tail`, and `next_event_line`; the comment and response type declare that at `src/cli/commands/serve.ts:1082` through `src/cli/commands/serve.ts:1086`. The running branch intentionally returns an empty `events_tail` while advancing the cursor at `src/cli/commands/serve.ts:1141` through `src/cli/commands/serve.ts:1147`.

Terminal status responses add terminal-only fields such as `filesChanged`, `prompts`, `summary`, `lastError`, `mergeStatus`, `warnings`, and `readOnly`; those are documented at `src/cli/commands/serve.ts:1088` through `src/cli/commands/serve.ts:1097`.

`get_run_status.max_events_tail` defaults to `10` and caps at `500`; those constants are declared at `src/orchestrator/tools/get-run-status.ts:34` and `src/orchestrator/tools/get-run-status.ts:42`.

## Merge Contract

`merge_run` accepts `run_id`, `target_branch`, `force`, `commit_title`, and `commit_body`; the schema is `src/orchestrator/tools/merge-run.ts:33` through `src/orchestrator/tools/merge-run.ts:51`. The server passes `force`, `commitTitle`, and `commitBody` into `mergeRunWorktree()` at `src/cli/commands/serve.ts:429` through `src/cli/commands/serve.ts:434`.

`WorktreeManager.mergeRunWorktree()` auto-commits dirty run worktrees at `src/git/worktree.ts:460` through `src/git/worktree.ts:469`, refuses dirty host working trees unless `force` is set at `src/git/worktree.ts:472` through `src/git/worktree.ts:480`, creates a no-fast-forward merge at `src/git/worktree.ts:496` through `src/git/worktree.ts:502`, returns conflicts at `src/git/worktree.ts:507` through `src/git/worktree.ts:510`, and returns the merge commit SHA at `src/git/worktree.ts:513`.

## Run State

`RunStateV1` is defined at `src/orchestrator/run-state.ts:55`. It includes `repoRoot`, `readOnly`, `prompts`, `filesChanged`, `mergeStatus`, and `warnings` at `src/orchestrator/run-state.ts:70` through `src/orchestrator/run-state.ts:92`.

`RunStateStore.create()` writes initial `state.json` at `src/orchestrator/run-state.ts:148` and writes a `tail.command` helper at `src/orchestrator/run-state.ts:169`. `events.log` lives at the path returned by `eventsLogPath()` at `src/orchestrator/run-state.ts:444`; `tail.command` lives at the path returned by `tailCommandPath()` at `src/orchestrator/run-state.ts:185`.

Write-mode runs allocate a worktree with `createRunWorktree()` at `src/git/worktree.ts:297`; fresh worktrees sync uncommitted host state at `src/git/worktree.ts:311` through `src/git/worktree.ts:318`. `continue_run` re-syncs uncommitted state for non-read-only runs at `src/cli/commands/serve.ts:368` through `src/cli/commands/serve.ts:370`.

Read-only runs skip worktree allocation because `planRunAgent()` uses `working_directory` or the project root in the read-only branch at `src/orchestrator/tools/run-agent.ts:177` through `src/orchestrator/tools/run-agent.ts:183`, and only calls `createRunWorktree()` in the write-mode branch at `src/orchestrator/tools/run-agent.ts:184` through `src/orchestrator/tools/run-agent.ts:187`; read-only dirty-tree warnings are attached at `src/orchestrator/tools/run-agent.ts:348` through `src/orchestrator/tools/run-agent.ts:360`, and `TaskResult.warnings` is defined at `src/adapters/types.ts:240`.

## Related Docs

- `docs/architecture/tools.md` documents the seven-tool surface and add-a-tool workflow.
- `docs/architecture/adapters.md` documents production adapter dispatch and the legacy optional tool-loop APIs.
- `docs/architecture/captain-portability.md` documents install-time host wiring and legacy converter helpers.
- `docs/architecture/config-registry.md` documents the workflow config path registry.
