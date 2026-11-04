> **Current as of 2026-08-31.**

# MCP Tool Surface

## Source of truth

Crew defines each tool schema and handler under `src/orchestrator/tools/`,
registers the live captain surface in `src/cli/commands/serve.ts`, and mirrors
the install-time surface in `CATALOG_TOOLS` in
`src/install/tool-catalog.ts`. `test/install/tool-catalog.test.ts` connects an
in-memory MCP client to a fresh server and requires the live registrations and
static catalog to stay identical.

The complete catalog contains twenty-seven tools. Twenty-six are captain-facing;
`send_message` is installed only for workers.

## Current catalog

| Tool | Role | Contract |
| --- | --- | --- |
| `list_agents` | Captain | Lists configured agents, aliases, health/quota, preferences, routing guidance, `model_selection_support`, `goal_support`, `repo_context_mode`, and `accepts_context_files`. |
| `list_models` | Captain | Discovers one agent's provider-native model catalog. Accepts `{agent_id, refresh?}` and returns exact arguments, catalog provenance, authority, and warnings. |
| `get_crew_preferences` | Captain | Reads effective per-machine crew preferences, including crew-iterate round limits. |
| `list_runs` | Captain | Lists repo-scoped persisted runs, including each run's latest model and goal state. |
| `check_captain_inbox` | Captain | Reads durable worker-to-captain messages. |
| `acknowledge_messages` | Captain | Acknowledges captain inbox messages. |
| `run_agent` | Captain | Starts an asynchronous write, read-only, or ephemeral-review run. |
| `continue_run` | Captain | Adds a turn while preserving lifecycle/model history and applying explicit goal continuation policy. |
| `merge_run` | Captain | Merges an authorized write run into a target branch. |
| `discard_run` | Captain | Discards an authorized run and performs lifecycle cleanup. |
| `get_run_status` | Captain | Reads status with latest/per-turn model and goal identity plus cumulative goal budgets. |
| `cancel_run` | Captain | Cancels in-flight dispatcher work. |
| `run_panel` | Captain | Dispatches parallel reviewers and persists their independent agent/model identities. |
| `get_panel_status` | Captain | Reads reviewer lifecycle, files, summaries, failures, and model selections. |
| `aggregate_panel` | Captain | Converts terminal panel results into independently labeled peer messages. |
| `manage_native_reviewer` | Captain | Registers, reads, and resolves a Codex host-native reviewer wake claim using trusted parent-thread request metadata. |
| `create_criteria` | Captain | Creates an acceptance-criteria set. |
| `confirm_criteria` | Captain | Confirms criteria before implementation dispatch. |
| `get_criteria` | Captain | Reads criteria and review-round state. |
| `revise_criteria` | Captain | Revises an unconfirmed criteria set or advances its epoch. |
| `start_pr_watch` | Captain | Starts or resumes one durable PR or linear-stack watch after bounded provider and policy preflight. |
| `list_pr_watches` | Captain | Pure repo-scoped or all-repo authoritative watch listing. |
| `get_pr_watch_status` | Captain | Pure snapshot of lifecycle, evidence, batch, budgets, remedies, grant, lease, and derived waiter health/recovery hints. |
| `rearm_pr_watch` | Captain | Explicit compare-and-set transition after disposition, waiter recovery, budget handoff, expiry extension, or blocker revalidation. |
| `cancel_pr_watch` | Captain | Stops observation without deleting history or changing GitHub/git state. |
| `authorize_pr_watch_actions` | Captain | Grants or revokes bounded effect authority and a dedicated worktree lease; grant performs no remote effect. |
| `send_message` | Worker | Sends a durable authenticated message to another run or the captain. |

## PR-watch lifecycle

The five monitor tools are safe by default. Status and list are byte-pure;
start owns bounded provider readiness; rearm is the only public observation
generation transition. `authorize_pr_watch_actions` requires an explicit
`confirmed:true` grant bound to generation, policy/topology hashes, remote
heads, named effect kinds, budgets, and optional expiry. It prepares or recovers
the dedicated worktree but does not comment, reply, resolve, or push.

Effects run through the packaged typed CLI against the persisted grant and
action batch. The controller journals prepare/observe/apply/verify/settle and
observes before retrying. Only top-level PR comments, review-comment replies,
review-thread resolution, and a single-PR fast-forward SHA push exist. There is
no MCP merge, auto-merge, close, approve, force/lease push, or multi-PR branch
mutation surface.

## Model discovery and exact selection

`list_agents` is intentionally compact: it advertises whether an adapter uses
`catalog`, `catalog-and-provider-id`, `provider-validated`, or `unsupported`
model selection. Call `list_models` only when choices are needed. Provider
catalogs are cached in-process; `refresh:true` bypasses the cache.

`repo_context_mode` separately reports `workspace`, `supplied-text`, or
`unknown`. Supplied-text agents receive the composed prompt and any explicitly
selected attachments they support. Capable read-only agents also receive a
bounded automatic diff, but cannot explore the checkout. Capability warnings persist with terminal and panel reviewer
results. Unknown capabilities are not guessed from the agent's name or endpoint.

`accepts_context_files` reports explicit file-attachment support. `run_agent`,
`continue_run`, and each `run_panel` reviewer accept an optional `context_files`
array of up to 50 relative paths, each 1–4096 characters. Unsupported agents
reject nonempty selections before dispatch. Files are read from the effective
run working directory with containment and resource limits. Selections are per
call and are not inherited on continuation.
A files-only continuation is accepted, but callers should restate their task
because supplied-text adapters do not resume the preceding conversation.

Automatic diffs require `supplied-text`, positive attachment support and
`read_only` mode. A host root uses current `HEAD`; an existing Crew run uses its
recorded branch point, including committed work. The baseline persists across
continuation while contents refresh. Named files take budget priority. Diff
omissions and scan limits are visible; write and disposable-review modes do not
auto-collect. A clean host feature branch is not compared to another branch.

Remote repository context reads require `CREW_OPENAI_ALLOW_REMOTE_CONTEXT=1`; loopback
endpoints are allowed by default. Omission/egress warnings reach terminal
results, and the model receives an omission list. Original panel-dispatch
snapshots retain these warnings after reviewer runs are removed; while a run
exists, panel reads also include its current warnings after continuation.
`aggregate_panel` exposes optional
reviewer-labelled `warnings` for attachment and supplied-text limitations;
captains must consider them when consolidating votes. See the
[agent guide](../guides/agents-and-models.md) for limits and backend caveats.

`run_agent`, `continue_run`, and every `run_panel` reviewer accept an optional
`model`. A supplied model is resolved before run allocation or continuation
mutation. Resolution either produces the exact provider argument (including a
documented alias mapping) or returns a typed `model_selection.*` error. Crew
never drops a pin and continues on the provider default. For a fresh turn, the
precedence is per-call `model`, then the canonical provider entry's saved
`model` in `~/.crew/agents.json`, then the provider CLI default. The config UI
and `config set providerModels.<provider>` validate saved defaults through the
same resolver. With no per-call or saved value, Crew records an intentional
`cli_default` decision and performs no dispatch-time catalog lookup.

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
model. The wire value `agent_default` denotes the saved model on the canonical
provider-adapter entry, even though the configuration UI calls it a provider
default. Continuations without a new pin inherit the prior explicit argument or
the prior CLI-default decision. Panel records preserve the same information so
same-provider reviewers such as Claude `opus`, `fable`, and `sonnet` remain
distinguishable through dispatch, status, and aggregation.

## Bounded worker goals

`run_agent.goal` is an opt-in object with `validation_command`, the required
literal `repeat_safe:true`, `max_turns`, and `max_wall_clock_ms`. The command is
provider prompt data; Crew does not execute it itself. Native execution is
restricted to Claude Code write implementers. Codex, agy, custom providers,
read-only runs, and reviewers record `unsupported` and dispatch exactly once.

Every prompt record uses the complete outcome vocabulary:
`not_requested`, `unsupported`, `achieved`, `impossible`, `turn_capped`,
`watchdog_timeout`, `cancelled`, `provider_error`, and `evaluator_error`.
Supported in-flight turns omit the outcome until terminal persistence. Provider
outcomes must come from structured provider output; Crew's own timeout and
cancellation signals are authoritative only for their respective outcomes.

`continue_run.goal_policy` is `inherit`, `clear`, or `replace` and defaults to
`clear`. Inherit requires a nonterminal prior goal. Replace requires a new goal
and cannot increase the run's original aggregate limits. Crew subtracts prior
native turns and wall time before dispatching a resumed provider process.
Clear and replacement require provider control echoes when Claude supports the
prior goal. A failed or unconfirmed clear remains pending intent, so the next
default-clear continuation retries `/goal clear` in the retained provider
session instead of silently resuming a stale objective. Crew remains the only
owner of outer continuation and review.

Panel terminal snapshots retain the reviewer's latest goal audit record beside
summary, files, failure, and model selection. `get_panel_status` therefore
preserves goal data even after the underlying reviewer run state is unavailable.

## Dispatch and watcher lifecycle

`run_agent`, `continue_run`, and `run_panel` return immediately after dispatch.
Their structured envelopes include the run or panel identity, warnings, model
selection, and `required_next_action` when the host supports a `crew-wait`
watcher. Captains launch that command without blocking the conversation. On a
completion wake they read status once; they do not hold the original tool turn
open with `get_run_status` long polling.

Criteria-linked write runs and `run_panel` panel-level watchers use a
one-shot terminal-or-check-in watcher. Their `required_next_action` includes
`check_in_interval_ms` (default 600000, from `iterate.checkInMinutes` in the
per-machine config; `-1` disables check-ins and the watchers become
terminal-only); when the deadline wins, `crew-wait`
emits `CREW_WAIT_CHECK_IN` and wakes the captain. A running `get_run_status`
snapshot — or `get_panel_status` while `running_count > 0` — returns a fresh
watcher action so the captain can report status and re-arm the next interval
(`get_panel_status` omits it when any dispatched reviewer's live state is
unreadable without a terminal snapshot, since generations feed the durable
wake claim). Per-reviewer selective watchers remain terminal-only.

`get_run_status` returns a lean running payload and a richer terminal payload.
For a running criteria-linked write run on a watcher-capable host, the lean
payload also carries the fresh `required_next_action` used to re-arm periodic
check-ins.
Both include the latest recorded `model_selection`; terminal `prompts` include
the selection and goal outcome for every turn, plus `goal_budget` when used. A
terminal-only wait is accepted only with
`user_requested_wait:true`, which represents an explicit user request to
block.

`run_panel` routes adapters according to `reviewDispatchMode`. In-place
reviewers use read-only binding. Ephemeral-worktree reviewers such as agy get a
disposable snapshot of the source HEAD plus dirty state. `aggregate_panel`
refuses while any reviewer is running and labels every terminal result with
its agent and model.

### Codex host-native reviewer wake

A Codex native reviewer is not a Crew run and has no `run_id`.
`manage_native_reviewer` accepts `register`, `status`, and `resolve`.
Registration requires exactly one host-returned `agent_id` UUID or canonical
`task_name` such as `/root/reviewer`. Callers cannot provide a parent thread
id: the server derives it from trusted Codex MCP request metadata and refuses
missing or conflicting values. `status` and `resolve` require the UUID
returned by successful registration; task names are never durable wake keys.

For task names, a short-lived Codex App Server connection reads public thread
metadata scoped to the trusted parent, exact repository and subagent source.
The connection opts into the public experimental relationship API and supplies
`parentThreadId` on every list page; ordinary history lists can omit active
children. Rejected API requests fail registration safely. It checks both
active and archived inventories, requires complete bounded pagination and one
unique child UUID with matching source parent/path, then verifies the child's
metadata again. Missing visibility, unsupported metadata, conflicting identity,
ambiguity, or a lookup bound prevents registration. The lookup never starts or
resumes a model turn, reads transcript turns, infers identity from names or
previews, or saves a task-path cache. The UUID route and wake storage contract
remain unchanged.

If registration fails, retain the native task handle and collect that reviewer
through the host's wait/status/result tools. A wait notification for another
agent does not complete this review. Keep the turn open unless a valid Crew
watcher guarantees a later collection turn; call lifecycle `status`/`resolve`
only after successful registration.

Codex install merges a selective `SubagentStop` command into `hooks.json`.
The callback resolves the event's git root, records only session/agent/repo
identity, and queues a turn only when an unexpired registration matches. It
does not persist the prompt, transcript, or reviewer output. A ten-minute
tombstone closes completion-before-registration races; registered claims expire
after 24 hours, and each lifecycle operation opportunistically prunes expired
records under their per-record locks. Durable delivery claims suppress
duplicates; a queue timeout is retained as ambiguous instead of being retried.
`resolve` makes a late queued turn a silent no-op after another user or Crew
turn has already collected the vote.

Hook trust remains explicit in Codex. Install tells the user to inspect and
trust the exact command with `/hooks`; `verify` can prove the definition and
command are present but reports that session trust is not statically
observable. Until trusted, the rendered skill keeps the turn open and joins
the native reviewer directly once no Crew watcher can guarantee a later turn.
Completion events never grant merge, discard, or other mutation authority.

## Adding a tool

1. Add the implementation under `src/orchestrator/tools/` and export it from
   `src/orchestrator/tools/index.ts`.
2. Register the live MCP handler in `src/cli/commands/serve.ts`.
3. Add the install-time entry to `CATALOG_TOOLS` in
   `src/install/tool-catalog.ts`.
4. Extend `test/install/tool-catalog.test.ts` and focused tool tests.
5. If the captain workflow or envelope changed, update
   `skills/crew-captain.body.md` in the same change.
