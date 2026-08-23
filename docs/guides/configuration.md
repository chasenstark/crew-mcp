# Configuration

`crew-mcp config` is the supported per-machine configuration surface. It
manages notifications, merge confirmation, cleanup retention, provider model
defaults, agent strengths, and default implementer/reviewer choices.

## Interactive configuration

```sh
crew-mcp config
```

The main screens are:

- notification success/error toggles
- `confirmBeforeMerge` server gate
- `Agent defaults...` for iterate and panel routing
- `Provider models...` for an exact default model per built-in provider
- agent strengths and `useWhen` guidance
- `Cleanup & retention...` for worktree, run-directory, and criteria lifetimes

The captain still asks before merging or discarding; `confirmBeforeMerge` adds
an independent server-side confirmation requirement.

## Scripted configuration

```sh
crew-mcp config show
crew-mcp config show notifications.success
crew-mcp config set notifications.success false
crew-mcp config set confirmBeforeMerge true
crew-mcp config unset notifications.success
```

Agent-default paths are also scriptable:

```sh
crew-mcp config set workflow.agentDefaults.iterate.implementer codex
crew-mcp config set workflow.agentDefaults.iterate.reviewers '["claude-code"]'
crew-mcp config set workflow.agentDefaults.iterate.banList '["agy"]'
crew-mcp config set workflow.agentDefaults.panel.reviewers '["codex","claude-code"]'
crew-mcp config set workflow.agentDefaults.panel.banList '["agy"]'
```

Provider model defaults are exact-or-refuse and use the same native validation
as dispatch. `unset` hands control back to that provider's CLI configuration:

```sh
crew-mcp config show providerModels
crew-mcp config set providerModels.claude-code opus
crew-mcp config set providerModels.codex gpt-5.6-sol
crew-mcp config set providerModels.agy '<exact label from list_models>'
crew-mcp config unset providerModels.codex
```

`unset` restores or removes the selected value. Run `config show` to inspect
the effective result.

## Where settings live

```text
~/.crew/config.json    notifications, merge gate, cleanup retention
~/.crew/agents.json    agents, useWhen, strengths, provider model defaults, effort
~/.crew/workflow.yaml  surviving agent-default compatibility surface
.crew/workflow.yaml    optional project-level agent defaults
```

Prefer the CLI over manual file edits. `CREW_HOME` relocates the global Crew
state root for diagnostics or isolated test environments.

## Cleanup and retention

Terminal run state lives under `~/.crew/runs/`. Default retention is:

| Artifact | Default | Behavior at expiry |
| --- | ---: | --- |
| Terminal worktree | 7 days | Worktree reclaimed; unmerged branch kept when possible |
| Run directory | 30 days | Persisted run record removed |
| Criteria set | 30 days | Expired criteria record removed |

Preview or run cleanup explicitly:

```sh
crew-mcp cleanup --dry-run
crew-mcp cleanup
crew-mcp cleanup --all-repos
```

Use the interactive cleanup screen to change retention. `-1` or `off` disables
the corresponding window.

## Common environment variables

Configuration files are preferred for ordinary use. These overrides are useful
for automation and diagnostics:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CREW_HOME` | `~/.crew` | Global Crew state and preferences |
| `CREW_LOG_LEVEL` / `CREW_FILE_LOG_LEVEL` | `info` / `debug` | Console and file thresholds |
| `CREW_LOG_FILE` | unset | Append server logs to a chosen file |
| `CREW_OS_NOTIFICATIONS` | on | Set `off` to disable completion notifications |
| `CREW_CONFIRM_BEFORE_MERGE` | on | Server-side merge confirmation gate |
| `CREW_WORKTREE_TTL_DAYS` | 7 | Terminal-worktree retention |
| `CREW_RUNDIR_TTL_DAYS` | 30 | Run-directory retention |
| `CREW_CRITERIA_SET_TTL_DAYS` | 30 | Criteria-set retention |
| `CREW_RUN_GC_INTERVAL_MS` | 24h | Periodic cleanup cadence |
| `CREW_STALE_RUN_GRACE_MS` | 30s | Dead-server stale-run grace |
| `CREW_SHUTDOWN_GRACE_MS` | 10s | Shutdown drain window |
| `CREW_DISPATCH_STALL_TIMEOUT_MS` | 12m | Streaming idle watchdog |
| `CREW_DISPATCH_ABSOLUTE_TIMEOUT_MS` | 60m | Buffered adapter watchdog |
| `CREW_CANCEL_ESCALATION_TIMEOUT_MS` | 30s | Abort force-release window |
| `CREW_PROCESS_GROUP_FORCE_KILL_AFTER_MS` | 5s | SIGTERM-to-SIGKILL delay |
| `CREW_OPENAI_BASE_URL` | unset | Default OpenAI-compatible endpoint |
| `CREW_OPENAI_COMPATIBLE_TIMEOUT_MS` | 10m | OpenAI-compatible request timeout |
| `CREW_HEALTHCHECK_TTL_MS` | 5m | Successful health-probe cache |
| `CREW_TAIL_INSTALL_DIR` | `~/Applications` | Direct tail-handler install location |

This is the commonly useful set, not every internal cap. Source-level limits
for inboxes, peer messages, prompts, locks, and authentication tokens remain
implementation controls rather than routine user configuration.
