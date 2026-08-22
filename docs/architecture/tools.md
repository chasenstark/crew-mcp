> **Current as of 2026-08-20.**

# MCP Tool Surface

## Source of truth

Crew defines each tool schema and handler under `src/orchestrator/tools/`,
registers the live captain surface in `src/cli/commands/serve.ts`, and mirrors
the install-time surface in `CATALOG_TOOLS` in
`src/install/tool-catalog.ts`. `test/install/tool-catalog.test.ts` connects an
in-memory MCP client to a fresh server and requires the live registrations and
static catalog to stay identical.

The complete catalog contains twenty tools. Nineteen are captain-facing;
`send_message` is installed only for workers.

## Current catalog

| Tool | Role | Contract |
| --- | --- | --- |
| `list_agents` | Captain | Lists configured agents, aliases, health/quota, preferences, routing guidance, and `model_selection_support`. |
| `list_models` | Captain | Discovers one agent's provider-native model catalog. Accepts `{agent_id, refresh?}` and returns exact arguments, catalog provenance, authority, and warnings. |
| `get_crew_preferences` | Captain | Reads effective per-machine crew preferences. |
| `list_runs` | Captain | Lists repo-scoped persisted runs, including each run's latest `model_selection`. |
| `check_captain_inbox` | Captain | Reads durable worker-to-captain messages. |
| `acknowledge_messages` | Captain | Acknowledges captain inbox messages. |
| `run_agent` | Captain | Starts an asynchronous write, read-only, or ephemeral-review run. |
| `continue_run` | Captain | Adds a turn to an existing run while preserving its lifecycle and model-selection history. |
| `merge_run` | Captain | Merges an authorized write run into a target branch. |
| `discard_run` | Captain | Discards an authorized run and performs lifecycle cleanup. |
| `get_run_status` | Captain | Reads immediate or explicitly authorized long-poll run status, with latest and per-turn model identity. |
| `cancel_run` | Captain | Cancels in-flight dispatcher work. |
| `run_panel` | Captain | Dispatches parallel reviewers and persists their independent agent/model identities. |
| `get_panel_status` | Captain | Reads reviewer lifecycle, files, summaries, failures, and model selections. |
| `aggregate_panel` | Captain | Converts terminal panel results into independently labeled peer messages. |
| `create_criteria` | Captain | Creates an acceptance-criteria set. |
| `confirm_criteria` | Captain | Confirms criteria before implementation dispatch. |
| `get_criteria` | Captain | Reads criteria and review-round state. |
| `revise_criteria` | Captain | Revises an unconfirmed criteria set or advances its epoch. |
| `send_message` | Worker | Sends a durable authenticated message to another run or the captain. |

## Model discovery and exact selection

`list_agents` is intentionally compact: it advertises whether an adapter uses
`catalog`, `catalog-and-provider-id`, `provider-validated`, or `unsupported`
model selection. Call `list_models` only when choices are needed. Provider
catalogs are cached in-process; `refresh:true` bypasses the cache.

`run_agent`, `continue_run`, and every `run_panel` reviewer accept an optional
`model`. A supplied model is resolved before run allocation or continuation
mutation. Resolution either produces the exact provider argument (including a
documented alias mapping) or returns a typed `model_selection.*` error. Crew
never drops a pin and continues on the provider default. Omitting `model`
records an intentional `cli_default` decision and performs no catalog lookup.

Dispatch and status envelopes use this additive wire record:

```text
model_selection: {
  source: per_call | agent_default | inherited | cli_default,
  requested_model?: string,
  model_argument?: string,
  display_name?: string,
  validation: catalog | syntax | configured | cli_default,
  inherited_from_turn?: number,
  observed_model?: string
}
```

`requested_model` is caller intent, `model_argument` is what Crew passed, and
`observed_model` is present only when provider output reports the primary
model. Continuations without a new pin inherit the prior explicit argument or
the prior CLI-default decision. Panel records preserve the same information so
same-provider reviewers such as Claude `opus`, `fable`, and `sonnet` remain
distinguishable through dispatch, status, and aggregation.

## Dispatch and watcher lifecycle

`run_agent`, `continue_run`, and `run_panel` return immediately after dispatch.
Their structured envelopes include the run or panel identity, warnings, model
selection, and `required_next_action` when the host supports a `crew-wait`
watcher. Captains launch that command without blocking the conversation. On a
completion wake they read status once; they do not hold the original tool turn
open with `get_run_status` long polling.

`get_run_status` returns a lean running payload and a richer terminal payload.
Both include the latest recorded `model_selection`; terminal `prompts` include
the selection for every turn. A terminal-only wait is accepted only with
`user_requested_wait:true`, which represents an explicit user request to
block.

`run_panel` routes adapters according to `reviewDispatchMode`. In-place
reviewers use read-only binding. Ephemeral-worktree reviewers such as agy get a
disposable snapshot of the source HEAD plus dirty state. `aggregate_panel`
refuses while any reviewer is running and labels every terminal result with
its agent and model.

## Adding a tool

1. Add the implementation under `src/orchestrator/tools/` and export it from
   `src/orchestrator/tools/index.ts`.
2. Register the live MCP handler in `src/cli/commands/serve.ts`.
3. Add the install-time entry to `CATALOG_TOOLS` in
   `src/install/tool-catalog.ts`.
4. Extend `test/install/tool-catalog.test.ts` and focused tool tests.
5. If the captain workflow or envelope changed, update
   `skills/crew-captain.body.md` in the same change.
