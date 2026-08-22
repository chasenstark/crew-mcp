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
