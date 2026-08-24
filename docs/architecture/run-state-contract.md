> **Current as of 2026-08-23.**

# Run State Contract

`state.json` is the durable producer-side contract for a crew run. Each run
directory under `<crewHome>/runs/<runId>/` contains one `state.json` record,
one append-only `events.log`, and any helper files such as `tail.command`.
The TypeScript source of truth is `RunStateV1` and `RunStatus` in
`src/orchestrator/run-state.ts`.

## Atomic Writes

`RunStateStore` writes `state.json` with `writeAtomic()` in
`src/orchestrator/run-state.ts:456`: it writes the full JSON payload to a
temporary sibling path (`state.json.tmp`) and then renames that file over
`state.json`.

Readers can assume they either see the previous complete record or the next
complete record. They should not need to handle a half-written JSON document
from normal crew writes. Parse failures still remain possible if a user or
external process edits the file manually.

## Status Values

`RunStatus` is a top-level string field on every `RunStateV1` record:

```ts
type RunStatus =
  | 'running'
  | 'success'
  | 'partial'
  | 'error'
  | 'cancelled'
  | 'merged'
  | 'merge_conflict'
  | 'discarded';
```

`success`, `partial`, `error`, and `cancelled` are the terminal dispatch
statuses written through `markTerminal()`. They mean the agent turn has ended
and no dispatcher work remains in flight for that turn.

`merged`, `merge_conflict`, and `discarded` are post-terminal user actions.
They are written after the run has already left active dispatch: merge success,
merge conflict recording, or explicit discard.

`crew-wait` distinguishes these sets. It waits for the four `markTerminal()`
statuses (`success`, `partial`, `error`, `cancelled`) because those indicate
the agent turn itself has completed. It does not treat post-terminal actions as
the primary wait target.

As of the 2026-07-20 F1-3 change, `crew-wait` no longer hangs when a watched run
has already reached a post-terminal status. It surfaces a distinct
`CREW_WAIT_POST_TERMINAL run_id=<id> status=<merged|merge_conflict|discarded>`
liveness-exit line and exits 0 (on both the single-run and multi-run paths), and
excludes those runs from the hosted Codex wake — the wake fires only for the
genuinely-terminal subset of the batch. This is a watcher-liveness exit, not a
dispatch termination; post-terminal statuses are still never reported as
`CREW_WAIT_TERMINAL`.

## Schema Stability

`schemaVersion` versions the record shape, but the top-level `status` string is
load-bearing and must not move. Future schema bumps must preserve a top-level
`status` field with the same role so simple readers, shell waiters, and recovery
tools can keep detecting run lifecycle state without understanding every newer
field.

Additional fields may be added in later schemas, but changes must preserve:

- `status` as a top-level string lifecycle field.
- `runId`, `agentId`, `startedAt`, and `worktreePath` as the core identity and
  location fields.
- `completedAt` as the completion timestamp when a run is terminal or
  post-terminal.
- `prompts[].summary` as the latest agent-turn summary, with `lastError` as the
  fallback error text for records that become terminal without a prompt summary.

`list_runs` relies on that stable subset when recovering runs after context
loss.

## Goal audit records

Modern writers add a `goal` object to every prompt turn. Unrequested turns are
explicitly `not_requested`; unsupported requests retain the requested
configuration and terminal `unsupported` outcome. A supported in-flight turn
has no outcome until terminal persistence updates it from provider or Crew
watchdog output. Dispatcher cancellation events retain a typed origin so both
streaming-idle and buffered-absolute watchdog aborts persist as
`watchdog_timeout`; user cancellation remains `cancelled`. The terminal set is:

```text
not_requested | unsupported | achieved | impossible | turn_capped |
watchdog_timeout | cancelled | provider_error | evaluator_error
```

`goalBudget` is run-level state containing the original maximum native turns
and wall-clock milliseconds plus cumulative use. `continue_run` computes
remaining allowances from this record before provider resume; it never trusts
provider-local counters to reset or expand the aggregate bound. The fields are
additive to schema version 1, so legacy records without goal data remain valid.

## Server-Owner PID

`serverPid` (optional) records the PID of the `crew-mcp serve` process that
owns the run while it is `running`. The stale-run sweeper at server startup
uses this to distinguish "abandoned by a crashed prior server" from "currently
being managed by another live server" — which is the normal case, since every
host MCP connection (Claude Code, Codex, Gemini) spawns its own crew-mcp
process. Without this check, a sibling server's startup sweep would mark
in-flight runs as `error: "abandoned (server restart)"` mid-execution.

The sweeper skips records whose `serverPid` resolves to a live OS process
(`process.kill(pid, 0)` succeeds, or fails with `EPERM` — which means the
process exists but we lack signal permission). It only marks records as
abandoned when the PID is set AND `process.kill(pid, 0)` reports `ESRCH`.

Records without `serverPid` (legacy, written before the field existed) are
also skipped. The sweeper has no way to know whether they're still owned
by an active server, so it leaves them alone rather than risk killing
in-flight work. Users can `discard_run` such records manually if they
turn out to be truly stale. Writers always populate the field going forward;
the legacy-record exception is a one-time transition cost.

## Run garbage collection

Worktrees and run-dirs accumulate under `<crewHome>/runs/` — a run that
ends `success`/`merge_conflict`/`error`/`cancelled` and is never merged or
discarded keeps its full working-tree checkout (often hundreds of MB)
indefinitely. The run GC (`src/orchestrator/run-gc.ts`, scheduled by
`scheduleRunGc` alongside the stale-run sweeper at server startup) reclaims
them on two independent age windows, both measured from when the run
reached a terminal state (`completedAt`, falling back to the last prompt's
`completedAt` then `startedAt`):

- **Worktree TTL** (`CREW_WORKTREE_TTL_DAYS`, default 7) — remove the
  worktree directory. The `crew-run/*` branch is KEPT so any unmerged
  commits survive as a recoverable ref, EXCEPT for `merged` runs (their
  commits already live in the merge target, so the branch is deleted too).
  After this, `merge_run` / `continue_run` on the run can no longer find a
  worktree — the user merges the surviving branch directly if needed.
- **Run-dir TTL** (`CREW_RUNDIR_TTL_DAYS`, default 30) — delete the entire
  run-dir (`state.json` + `events.log` + any residual worktree). Branches
  are never touched here; they live in the host repo's git, not the
  run-dir, so history survives.

Resolution precedence for each window is env > `config.json` > built-in
default: the env vars above (which also accept `off`/`never`), then
`cleanup.worktreeTtlDays` / `cleanup.runDirTtlDays` in `config.json` (where
`-1` disables), then the 7/30-day defaults. Like the stale-run sweeper, the
GC is repo-scoped: it only touches runs whose `repoRoot` matches the
current server's project root, skips `running` runs and legacy records
without a `repoRoot`, and takes the per-run lock for each worktree removal
so it's safe to run concurrently across the per-dispatch sub-servers.

The same pass is exposed manually as `crew-mcp cleanup`
(`src/cli/commands/cleanup.ts`) — `--dry-run` previews, `--all-repos`
sweeps every repo represented in `<crewHome>/runs/`, and
`--worktree-ttl-days` / `--rundir-ttl-days` override the windows for one
invocation. The interactive `crew-mcp config` TUI surfaces the same under a
**Cleanup & retention** submenu: it edits the two TTLs and can trigger a
cleanup (or dry-run preview) on the spot.
