# Per-adapter event parsing taxonomy

Phase 0 capture date: 2026-05-06.

This document is the gating fixture taxonomy for
`docs/plans/active/per-adapter-event-parsing.md`. It intentionally documents
raw adapter subprocess event shapes only. Adapter implementation changes belong
to later phases.

## Fixture corpus

| Adapter | Version | Fixture | Capture status |
|---|---:|---|---|
| codex | 0.121.0 | `test/adapters/fixtures/codex-live-0.121.jsonl` | Existing baseline fixture. |
| codex | 0.128.0 | `test/adapters/fixtures/codex-live-0.128.0.jsonl` | Captured with `codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "Read README.md and summarize what this project does in 3 bullet points."`. A temporary writable `CODEX_HOME` reused auth/config because the sandbox cannot write `~/.codex/sessions`. The Codex sandbox was disabled for the capture after the first read-only attempt produced only agent messages due `sandbox_apply: Operation not permitted`. |
| claude-code | 2.1.131 | `test/adapters/fixtures/claude-stream-2.1.131.jsonl` | Captured with `claude --print --output-format stream-json --verbose --dangerously-skip-permissions -p "Read README.md and summarize what this project does in 3 bullet points."`. |
| gemini-cli | 0.40.1 | None | Optional capture attempted with `gemini --skip-trust --yolo --output-format json --prompt "Read README.md and summarize what this project does in 3 bullet points."`; it produced no stdout/stderr and did not terminate in the sandbox. No empty fixture was kept. |

## Shared semantic line contract

All later adapter phases should render bounded semantic lines as:

```text
[<agent>] <kind>: <summary>
```

The summary should be short enough that the full progress line stays within the
runtime progress cap. Unrecognized events should still produce a bounded line
so long-poll wakeups are not empty:

```text
[<agent>] event: <top-level-type>
```

For envelope events with a known top-level type but unknown inner content, use:

```text
[<agent>] event: <top-level-type>/<inner-type>
```

If the event is malformed enough that no type can be recovered:

```text
[<agent>] event: unknown
```

## Codex

### Observed event inventory

| Fixture | Top-level event | Inner item type | Observed shape notes |
|---|---|---|---|
| 0.121.0, 0.128.0 | `thread.started` | n/a | Has `thread_id`. |
| 0.121.0, 0.128.0 | `turn.started` | n/a | 0.121.0 has `turn_id`; 0.128.0 omitted it in this capture. |
| 0.128.0 | `item.started` | `command_execution` | New live-start envelope. Item has `id`, `command`, `aggregated_output`, `exit_code: null`, `status: "in_progress"`. |
| 0.121.0, 0.128.0 | `item.completed` | `command_execution` | 0.121.0 has `command`, `exit_code`; 0.128.0 also has `id`, `aggregated_output`, `status: "completed"`. |
| 0.121.0 | `item.completed` | `reasoning` | Has `text`. Not observed in the 0.128.0 README capture, but still covered by existing fixture. |
| 0.121.0 | `item.completed` | `file_change` | Has `path`, `action`; observed actions include `modified`, `created`, `none`. Not observed in the 0.128.0 README capture. |
| 0.121.0, 0.128.0 | `item.completed` | `agent_message` | Has `text`; 0.128.0 also has `id`. |
| 0.121.0, 0.128.0 | `turn.completed` | n/a | Has `usage`; 0.121.0 has `turn_id`, 0.128.0 omitted it in this capture. |
| Synthetic/current parser coverage | `turn.failed` | n/a | Existing parser handles `reason`; not observed in the live success fixtures. |
| Synthetic/current parser coverage | `error` | n/a | Existing parser handles `message`; not observed in the live success fixtures. |

### Proposed semantic mapping

| Raw event | Semantic line |
|---|---|
| `thread.started` | `[codex] turn: thread started` |
| `turn.started` | `[codex] turn: started` |
| `turn.completed` | `[codex] turn: completed` |
| `turn.failed` | `[codex] turn: failed (<reason preview>)` |
| `error` | `[codex] error: <message preview>` |
| `item.started` / `command_execution` | `[codex] command: started <command preview>` |
| `item.completed` / `command_execution` | `[codex] command: <command preview> (exit <code>)` |
| `item.completed` / `reasoning` | `[codex] reasoning: <text preview>` |
| `item.completed` / `file_change` | `[codex] file: <action> <path>`; suppress or de-emphasize `action: "none"` if Phase 1 chooses to avoid noise. |
| `item.completed` / `agent_message` | `[codex] message: <text preview>` |
| Unknown top-level | `[codex] event: <type>` |
| Unknown item envelope | `[codex] event: <type>/<item.type>` |
| Malformed/typeless | `[codex] event: unknown` |

## Claude Code

### Observed event inventory

| Top-level event | Inner content type | Observed shape notes |
|---|---|---|
| `system` | n/a | `subtype: "init"` with `cwd`, `session_id`, tool inventory, MCP server statuses, model, permission mode, Claude Code version, agents, skills, plugins, and memory paths. Very verbose. |
| `rate_limit_event` | n/a | Has `rate_limit_info.status`, reset timestamps, overage fields, `uuid`, and `session_id`. |
| `assistant` | `thinking` | Assistant message content block with `thinking` and `signature`. The captured `thinking` text was empty. |
| `assistant` | `tool_use` | Tool call content block. Captured `name: "Read"` with `input.file_path` pointing at `README.md`. |
| `user` | `tool_result` | Tool result is not top-level. It appears as a `user` event whose `message.content[]` contains a `tool_result` block, plus a top-level `tool_use_result` object. |
| `assistant` | `text` | Final assistant message text. |
| `result` | n/a | Terminal result event with `subtype: "success"`, `is_error`, durations, `num_turns`, `result`, `stop_reason`, `total_cost_usd`, usage, model usage, permission denials, and `terminal_reason`. |

### Proposed semantic mapping

| Raw event | Semantic line |
|---|---|
| `system` / `subtype: "init"` | `[claude-code] system: init <model> tools=<count> mcp=<connected>/<total>` |
| `rate_limit_event` | `[claude-code] rate: <status> <rateLimitType>` |
| `assistant` / `thinking` | `[claude-code] reasoning: <thinking preview>` when non-empty; `[claude-code] reasoning: thinking` if the block is structurally important but empty. |
| `assistant` / `tool_use` | `[claude-code] tool: <name>(<args preview>)` |
| `user` / `tool_result` | `[claude-code] result: <tool name or id> <ok|error> <summary preview>`; infer error from block fields when present, otherwise treat captured text result as `ok`. |
| `assistant` / `text` | `[claude-code] message: <text preview>` |
| `result` / success | `[claude-code] turn: completed` |
| `result` / error | `[claude-code] turn: failed <terminal_reason or error preview>` |
| Unknown top-level | `[claude-code] event: <type>` |
| Unknown content block | `[claude-code] event: <type>/<content.type>` |
| Malformed/typeless | `[claude-code] event: unknown` |

Important Phase 2 correction: the plan's sketch listed `tool_result` as a
possible top-level stream-json event. In the 2.1.131 fixture, tool results are
inside top-level `user` events.

## Gemini CLI

Gemini is still optional Phase 3 scope. The current adapter uses
`--output-format json` and only calls `onOutput` after the process returns, so
there is no live taxonomy to implement in Phase 1 or Phase 2.

The 0.40.1 CLI advertises `--output-format` choices `text`, `json`, and
`stream-json`, but the optional JSON capture did not complete in this sandbox
and emitted no baseline JSON. Phase 3 should start by recapturing Gemini in a
controlled process with a hard timeout before changing adapter behavior.

Provisional fallback if Phase 3 keeps JSON mode:

| Raw event | Semantic line |
|---|---|
| Successful final JSON response | `[gemini] message: <response preview>` |
| Failed final JSON response | `[gemini] error: <error preview>` |
| Unknown JSON shape | `[gemini] event: json` |
| Malformed/typeless | `[gemini] event: unknown` |

## Codex 0.121.0 to 0.128.0 drift report

### New in 0.128.0

| Event/field | Impact |
|---|---|
| `item.started` envelope for `command_execution` | Phase 1 should emit a command-start line or otherwise handle it with a non-empty bounded fallback. The v2 plan only listed `item.completed`, so this is material taxonomy drift. |
| `item.id` on observed `item.completed` payloads | Useful for correlating `item.started` and `item.completed`, but semantic emission does not need to expose the id. |
| `command_execution.aggregated_output` | Gives command output preview opportunity. To keep progress concise, Phase 1 should probably prefer command text and exit status over raw output. |
| `command_execution.status` | Distinguishes `in_progress` from `completed`; useful for start/finish wording. |

### Gone or omitted in the 0.128.0 README capture

| Event/field | Impact |
|---|---|
| `turn_id` on `turn.started` and `turn.completed` | Do not require `turn_id` in parser logic. |
| `item.completed` / `reasoning` | Not observed in this 0.128.0 capture. Keep support because the 0.121.0 fixture has it and reasoning may depend on model/run behavior. |
| `item.completed` / `file_change` | Not expected for the read-only README task. Keep support because it is present in the 0.121.0 fixture and matters for implementation tasks. |

### Changed shape

| Item type | 0.121.0 shape | 0.128.0 shape | Phase 1 note |
|---|---|---|---|
| `command_execution` | Completed-only item with `command`, `exit_code`. | Started and completed items with `id`, `command`, `aggregated_output`, `exit_code`, `status`. | Handle both started and completed envelopes; tolerate missing `aggregated_output` and `status`. |
| `agent_message` | `type`, `text`. | `id`, `type`, `text`. | Keep using `text`; ignore `id` for display. |
| `turn.started` / `turn.completed` | Includes `turn_id` in fixture. | No `turn_id` in fixture. | Treat `turn_id` as optional metadata. |

No observed 0.128.0 event replaces or invalidates the 0.121.0 `reasoning`,
`file_change`, `turn.failed`, or `error` handling paths. The main Phase 1 scope
change is adding `item.started` support and making command parsing tolerant of
both command payload shapes.
