# Operations and troubleshooting

Crew runs asynchronously. The captain starts work, returns control to the
conversation, and recovers terminal state through a watcher or the next user
turn.

## Observe active work

Ask the captain for status, or use the CLI:

```sh
crew-mcp status
```

Each run persists state and logs under `~/.crew/runs/<run-id>/`. Dispatch
messages include a `crew-tail://` link and a manual `tail -F` command.

On macOS, install the optional URL handler:

```sh
crew-mcp install-tail-handler
```

## Completion wake

```text
dispatch -> crew-wait starts in background -> run reaches terminal state
                                             |
                    +------------------------+----------------------+
                    |                                               |
              supported wake                                 no wake transport
                    |                                               |
          conversation starts a turn                    next user turn recovers it
```

Claude Code uses its supported background watcher path. Codex prefers the
authenticated direct bridge from `crew-mcp codex` and otherwise uses a durable
thread queue in ordinary Codex 0.149+ sessions. Watcher generation tokens and
one-shot claims suppress stale or duplicate completion turns.

Do not foreground or repeatedly poll `crew-wait`. If the watcher cannot start,
the run still continues; ask for status on the next turn.

## Watch a pull request

Ask the captain to start a PR watch. It performs bounded `gh` capability,
discovery, policy, and evidence checks, persists the watch, then launches the
exact returned `crew-pr-watch-wait` command once. Unchanged polls use no model
turns. On a wake, read `get_pr_watch_status` once; do not poll the status tool.

`blocked` and `expired` include typed remedies. Status/list are pure, so use
`rearm_pr_watch` for an explicit compare-and-set recovery or confirmed 1–30 day
extension. An extension restores the exact suspended state and returns a waiter
only for active observation. `get_pr_watch_status` derives waiter health from
the persisted lease without writing: an expired running lease reports
`waiter_health.state: "stale"`, while an exited timeout reports `"timed_out"`.
In either case, pass the exact reported `waiter_health.rearm_arguments` to
`rearm_pr_watch`, then launch its returned waiter action once.

Codex launches the exact server-returned waiter command with narrowly scoped
filesystem escalation because the server-pinned Crew home can sit outside the
project sandbox. An `EPERM` under the Crew-home `pr-watches` path means the
watch was created but polling did not start; do not change its home, generation,
or waiter identity. Retry only that trusted launch, or recover it on a later
turn from the status snapshot.

Monitoring is default deny for remote effects. A comment, reply, thread
resolution, or single-PR fast-forward push requires a separately confirmed
`authorize_pr_watch_actions` grant bound to current hashes, heads, named kinds,
budgets, and expiry. Authorization creates a dedicated branch worktree but
performs no effect. A wake never authorizes an action, and PR watch never merges,
auto-merges, closes, approves, force-pushes, or mutates a multi-PR stack branch.

If start reports capability trouble, fix `gh auth status`; when CircleCI is
configured, verify its CLI authentication too. Ordinary `crew-mcp verify` is
intentionally offline. Use `crew-mcp verify --scope project` to validate the
project waiter/companion and shared git lock after a project install.

## A run is stuck or no longer wanted

Ask the captain to:

- call `get_run_status` for a rich snapshot
- call `cancel_run` to stop an in-flight provider process
- call `discard_run` to remove an unwanted terminal run
- call `continue_run` with corrected instructions after a recoverable result

Cancellation preserves the run worktree for inspection. Discarding a write run
with changes requires explicit confirmation because it deletes that owned
worktree.

## Merge completed work promptly

Write-run changes may remain uncommitted inside the Crew worktree until merge.
Inspect and merge valuable results before the worktree retention window. Crew
keeps unmerged branches when possible during cleanup, but uncommitted worktree
state is not a durable archive.

If `merge_run` reports a conflict, stop and inspect the named paths. Crew
preserves the materialized conflict; do not reset or discard it unless that is
the deliberate resolution.

## Tools do not appear

1. Reinstall the current skill and MCP block:

   ```sh
   crew-mcp install --target <host>
   ```

2. Restart the host CLI.
3. Run:

   ```sh
   crew-mcp verify
   ```

`verify` checks on-disk installation and catalog parity. A successful result
does not prove that an already-running host reloaded the config or that a
provider dispatch will authenticate.

For project scope, run `npx crew-mcp verify --scope project` and confirm Codex
trusts the repository.

## Crew reports a missing built module

A source-linked install may point at a partially rebuilt `dist/` directory.
From the source checkout:

```sh
npm run build
crew-mcp install --target <host>
crew-mcp verify
```

Then restart the host so its MCP process loads one consistent build.

## Provider failures

Call `list_agents({ refresh: true })` after fixing authentication or quota so
Crew re-probes the provider. Do not blindly retry `rate_limited`,
`quota_exhausted`, or `auth` failures; follow the typed recommendation and
preserve any partial write run.

Antigravity review runs are disposable snapshots because agy cannot enforce
read-only access. They are never merge candidates. A provider tool failure may
still leave a useful partial textual result; inspect the terminal summary before
rerouting.

## Cleanup

```sh
crew-mcp cleanup --dry-run
crew-mcp cleanup
crew-mcp cleanup --all-repos
```

The server also runs garbage collection at startup and periodically. Configure
retention through `crew-mcp config`; see the
[configuration guide](configuration.md).
