> **Current as of 2026-08-27.**

# Crew Architecture

Crew is a TypeScript MCP server that lets a host CLI act as captain over
Claude Code, Codex, agy/Antigravity, and configured custom agents. The package
publishes `crew-mcp`, the `crew-wait` terminal watcher, and the
`crew-pr-watch` / `crew-pr-watch-wait` durable PR-watch pair.

## Runtime shape

| Layer | Owner | Responsibility |
| --- | --- | --- |
| CLI | `src/index.ts`, `src/cli/commands/` | `serve`, host installation, verification, preferences, agent editing, cleanup, and uninstall. |
| Install | `src/install/` | Host config/skill rendering, manifests, binary resolution, and static tool-catalog parity. |
| Orchestrator | `src/orchestrator/` | MCP tools, run state, criteria, panels, progress, inbox messages, and dispatch lifecycle. |
| PR watch | `src/pr-watch/` | Separate durable GitHub observation, evidence, deadlines, wake ownership, authorization, action leases, and remote-effect recovery. |
| Adapters | `src/adapters/` | Provider-native execution, health, model discovery/resolution, stream parsing, and failure classification. |
| Git isolation | `src/git/` | Per-run write worktrees and ephemeral review snapshots. |

`crew-mcp serve` constructs the adapter registry, worktree manager, dispatcher,
run-state store, and MCP server. Dispatch tools call `AgentAdapter.execute()`;
the old v0.1 runner/session loop and shared adapter tool-loop are retired.

## Command and tool surfaces

The current CLI commands are `serve`, `codex`, `status`, `cleanup`, `config`,
`install`, `install-tail-handler`, `verify`, `agents`, and `uninstall`.
Historical `run`, `init`, `profile`, `state reset`, and `resume` commands live
only in `docs/architecture/v0.1-archive/`.

The catalog contains twenty-five MCP tools: twenty-four captain tools and the
worker-only `send_message`. `src/cli/commands/serve.ts` owns the live
registrations and `src/install/tool-catalog.ts` owns install-time parity. See
`docs/architecture/tools.md` for the catalog and envelope contracts.

## Dispatch lifecycle

Fresh write runs get isolated worktrees under
`~/.crew/runs/<runId>/worktree/` (or the configured `CREW_HOME`).
Read-only runs bind to an existing directory. Adapters that cannot honestly
enforce read-only, currently agy, use `ephemeral_review` snapshots when routed
through panels. Uncommitted source state is synchronized into Crew-owned
worktrees without mutating the host checkout.

Dispatch returns asynchronously with a structured envelope and a launch-only
`crew-wait` action when the host supports it. Claude Code uses a background
shell watcher. Codex uses the authenticated App Server bridge when launched by
`crew-mcp codex`; otherwise Codex 0.149+ can receive queue-backed wake messages
using the active thread id carried in MCP request metadata. `CODEX_THREAD_ID`
remains a compatibility fallback. Other hosts recover terminal state on the
next user turn.

Run state is persisted under the Crew home and contains prompt turns,
lifecycle mode, criteria linkage, model-selection audit records, provider
session identity, files, failures, and merge state. Terminal lifecycle
listeners persist adapter results; only explicit `merge_run` or `discard_run`
crosses the mutation/cleanup boundary.

PR watches are not agent runs. Their digest-chained ledgers and monotonic state
caches live under `~/.crew/pr-watches/`. A background waiter polls typed GitHub
and optional CircleCI evidence outside model turns, then wakes the originating
Claude Code or Codex conversation for an actionable batch, remedy, expiry, or
terminal result. This release is monitor-only: actionable events are handed to
ordinary, separately authorized workflows, and the watch records dispositions
before rearming. The PR-watch controller cannot mutate GitHub or git. See
`docs/architecture/pr-watch.md`.

## Provider and model identity

The adapter ID names the provider integration; model is an orthogonal per-turn
selection. `list_agents` advertises model-selection support and `list_models`
performs provider-native discovery. A supplied pin is exact-or-refuse before
run allocation or continuation mutation. Fresh-turn precedence is per-call
pin, saved provider default, then provider CLI default. The last case does not
trigger discovery.

Every new turn stores requested, passed, and optional provider-observed model
identity. Panel records retain that identity independently, including when the
same provider reviews with multiple models. See
`docs/architecture/adapters.md` for provider-specific discovery and validation.

## Install contract

Host adapters under `src/install/hosts/` know each host's config and skill
paths. The canonical captain prose lives in `skills/crew-captain.body.md` and
`skills/crew-iterate.body.md`; rendering injects host-specific watcher text and
version metadata. Any dispatch envelope, tool surface, or polling-contract
change must update the runtime, catalog, skill prose, and parity tests together.

## Related documents

- `docs/architecture/tools.md` — current MCP catalog and dispatch/status fields.
- `docs/architecture/adapters.md` — adapter execution and model-selection contracts.
- `docs/architecture/captain-portability.md` — install-time host wiring.
- `docs/architecture/config-registry.md` — workflow configuration paths.
- `docs/architecture/run-state-contract.md` — durable run-state behavior.
- `docs/architecture/pr-watch.md` — durable PR-watch lifecycle and action boundary.
- `docs/architecture/v0.1-archive/` — historical runner/session design only.
