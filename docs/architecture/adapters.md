> **Current as of 2026-08-23.**

# Adapter Architecture

## Production path

Production dispatch calls `AgentAdapter.execute(task)` through
`src/orchestrator/dispatch-run-agent-internal.ts`. The retired shared tool-loop
path is not part of the live server. Built-in adapters are Claude Code, Codex,
and agy/Antigravity; custom generic and OpenAI-compatible adapters are loaded
from per-machine agent preferences.

`Task.constraints` carries the selected model argument, effort, sandbox,
network, and writable-path decisions. Each concrete provider converts those
constraints to its native CLI or API request. The run lifecycle owns state,
worktrees, progress, warnings, and terminal persistence.

## Model-selection capability

`AgentAdapter` exposes `modelSelectionSupport` and, when supported,
`listModels({refresh?})` plus `resolveModel(requested,
{refreshOnMiss:true})`. The support levels are:

| Support | Meaning |
| --- | --- |
| `catalog` | Exact values come from a provider catalog. |
| `catalog-and-provider-id` | The provider distinguishes exact human labels from provider IDs. |
| `provider-validated` | Crew can enumerate documented choices and recognize provider-shaped IDs, but the provider confirms entitlement at dispatch. |
| `unsupported` | Crew refuses explicit model selection. |

Successful provider catalogs are cached per adapter instance. Discovery and
resolution share the same parser/catalog helpers, so there is no separate
checked-in allowlist that can drift. A cache miss during exact resolution may
trigger one refreshed provider lookup. The absence of a pin skips discovery
and omits the provider model argument.

## Provider implementations

### Claude Code

`ClaudeCodeAdapter` advertises `provider-validated`. It discovers the
documented aliases `sonnet`, `opus`, and `haiku`, and includes `fable` when the
installed `claude --help` advertises it. Provider-shaped full `claude-*` IDs
are accepted syntactically; account entitlement remains Claude's decision.
Execution passes the resolved value through `--model` unchanged. Claude stream
`system/init` or assistant events populate `TaskResult.metadata.observedModel`
when available.

Claude also advertises `goalSupport: 'claude-native'`. Crew sends `/goal` and
the work prompt as separate stream-JSON user messages, requires an explicitly
repeat-safe validation command, and applies both `--max-turns` and a wall-clock
timeout below Crew's dispatcher watchdog. Only write implementers receive this
constraint. Reviews and read-only runs record the request as `unsupported` and
remain ordinary single-shot dispatches.

Goal outcomes come from provider events, never final prose. Crew recognizes a
top-level `goal_status` event or the exact `system/hook_response` attachment
shape when Claude exposes one, and separately verifies `Goal set:` / `Goal
cleared:` only from assistant envelopes whose provider-set model is
`<synthetic>`. Goal-shaped objects in worker tool input and goal-like text from
the real worker model are ignored. Claude 2.1.241 currently filters
`goal_status` from its public stream even with hook events enabled; a generic
`terminal_reason=completed` cannot distinguish achievement from impossibility,
so Crew reports `evaluator_error` rather than claiming success in that case.

### Codex

`CodexAdapter` advertises `provider-validated`. Discovery uses a bounded
`codex app-server --listen stdio://` JSON-RPC session and paginated
`model/list` requests. The client bounds request time, pages, catalog size,
stdout/stderr capture, and closes the child process on success or failure.
Account-catalog IDs resolve exactly. Provider-shaped Codex/OpenAI model IDs can
be passed through for provider validation when discovery is unavailable.

Codex advertises `goalSupport: 'unsupported'`. The 2026-08-23 isolated 0.149.0
spike showed that an active native goal schedules another private task but
`codex exec --json` immediately interrupts it and exits after the first public
turn. Explicit resume preserves native accounting, but the public JSONL has no
goal terminal event. Until both autonomous execution and a stable public event
are proven together, Crew records requests as unsupported and allocates no
Codex inner loop.

### agy / Antigravity

`AgyAdapter` advertises `catalog-and-provider-id`. Discovery runs the live
`agy models` command and parses its tab-separated label/provider-id output.
Callers pin the exact human label that agy accepts; an unknown label is refused
before dispatch because agy may otherwise choose its default. The old static
model-label list is gone.

agy may finish with an `ERROR` envelope for an earlier built-in tool failure
even after the model self-corrects and emits a later final response. For a
bounded set of local tool errors, the adapter inspects that conversation's
private transcript and returns the later final planner response as `partial`.
Recovery is limited to the latest explicit user turn and accepts only a
non-empty `MODEL` / `PLANNER_RESPONSE` event with no tool calls after the
failing tool step. Tool output, prior-turn responses, and missing transcripts
remain errors. Conversation IDs must also be one safe path segment before the
adapter reads provider state. The original failure is preserved with
`tool_schema_error` or `provider_tool_error_recovered` metadata; recovery never
upgrades the run to success.

This is a compatibility boundary around agy's current private transcript at
`~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/`.
A future agy transport should prefer a provider-supported structured event
stream when one can preserve the same evidence and turn-boundary checks.

### OpenAI-compatible

`OpenAICompatibleAdapter` advertises `catalog`. It uses the shared `/models`
parser in `src/adapters/openai-models.ts`, merges the configured default into
the catalog, and resolves exact IDs. Chat-completions responses populate
`observedModel` from the provider's response `model` field.

### Generic

`GenericAdapter` advertises `unsupported`. Its command template has no model
placeholder, so accepting a pin would falsely imply it reached the provider.
An explicit model is refused; an unpinned dispatch retains current behavior.

## Audit boundary

Crew persists a `ModelSelectionRecord` on every prompt turn. Its fields
separate intent (`requestedModel`), Crew's provider argument (`modelArgument`),
validation evidence, inheritance, and provider observation
(`observedModel`). `continue_run` inherits the preceding decision unless the
caller explicitly changes it. Legacy prompts without a record use current
preference resolution once, then become sticky.

The record is additive to schema-version-1 state. Existing run and panel files
remain readable without a migration. The run lifecycle enriches only the
terminal turn with an observed model; it never rewrites prior turns or claims
an observation that the provider did not report.

Goal capability follows the same lazy-proxy/loaded-instance parity rule. Goal
requests and outcomes live on each prompt record; aggregate turn and wall-clock
usage lives at run level so a provider resume cannot reset Crew's bound.

## Adding or changing an adapter

1. Implement `AgentAdapter` under `src/adapters/` and register it in
   `src/adapters/registry.ts` or the custom-agent loader.
2. Declare honest model-selection and review-dispatch capabilities in both
   lazy metadata and the loaded adapter; parity tests require them not to
   change after load.
3. Reuse one provider parser for discovery and resolution, add bounded failure
   behavior, and prove an unpinned dispatch performs no discovery.
4. Test native argument translation, unknown-pin refusal, discovery caching,
   and any observed-model extraction.
5. Update `list_models`, captain prose, and architecture docs if the public
   capability or envelope changes.
