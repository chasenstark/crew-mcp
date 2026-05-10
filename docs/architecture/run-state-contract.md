> **Current as of 2026-05-10.**

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
