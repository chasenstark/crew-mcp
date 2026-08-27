> **Current as of 2026-08-27.**

# Durable PR watch

Crew PR watch observes a GitHub pull request or GitHub-defined linear stack
without keeping a model turn open. It is a separate durable lifecycle, not a
synthetic Crew run. The frozen behavior and provenance input is in
[the behavioral contract](pr-watch-behavioral-contract.md).

## Runtime and state

`src/pr-watch/` owns provider capability checks, discovery, policy resolution,
evidence reduction, deadlines, waiters, recovery surfaces, and retention. Each
watch lives at:

```text
<crewHome>/pr-watches/<pw-id>/
  events.jsonl       digest-chained authoritative state transitions
  state.json         monotonic cache, replayed from the ledger on pure reads
```

Watch IDs are server-issued `pw-` plus 32 lowercase hex characters and are
validated before every path or lock use. Fresh-call idempotency uses a separate
hashed index with `prepared`, `committed`, and `reclaimed` states.

Lifecycle states are `active`, `actionable`, `blocked`, `expired`, `terminal`,
and `cancelled`. An actionable handoff freezes an event batch and inclusive
ledger watermark. Events arriving later remain pending for the next batch.
Status and list replay the authoritative ledger without writing; explicit
rearm performs the generation compare-and-set.

## Observation and terminal evidence

GitHub access is a typed read-only CLI command union. CircleCI is optional and
admits only typed run/workflow reads. Start and blocker revalidation own bounded
capability/provider work; ordinary `crew-mcp verify` never probes the network.

Missing, incomplete, paginated, stale, progressively registered, or unavailable
evidence fails closed. Green/approved requires two identical complete terminal
fingerprints at least one poll cadence apart and after the last head watermark.
Heads, checks and attempt identities, approval evaluation, provider policy, and
PR state are part of that fingerprint.

`start_pr_watch` may receive bounded `verdict_sources` entries with an exact
GitHub author and body marker. Ordinary comments remain noise. A matching
comment becomes actionable, and each later matching edit uses its GitHub
`updatedAt` value as a distinct stable attempt identity so the edit wakes once
without reviving an already disposed version.

Every nonterminal watch has a snapshotted age deadline unless disabled. Expiry
pauses the exact active, actionable, or blocked state. A confirmed extension
restores that state: only active observation returns a waiter. Blocker and
expiry remedies use distinct durable surfaces. Waiter and JIT delivery claim
one surface attempt; expired unaudited claims are recovered with attempt
history and stale audits cannot win.

## Wake and recovery

`crew-pr-watch-wait` polls outside model turns and wakes supported Claude Code
or Codex conversations through Crew's existing transports. One persisted
waiter action and execution lease own polling; a separate thread/watch/
generation claim owns synthetic-turn delivery. A wake is information, never
mutation authority. Unsupported host survival fails before watch allocation.

The captain tools are `start_pr_watch`, `list_pr_watches`,
`get_pr_watch_status`, `rearm_pr_watch`, and `cancel_pr_watch`.

The installed `crew:pr-watch` skill launches exactly the returned trusted
waiter command and reads `ACTION.md` only for an actionable batch or remedy.

## Action handling

This release is monitor-only. PR watch does not own a GitHub or git mutation
path. A captain may investigate an actionable event through an ordinary,
separately authorized workflow, record each disposition with the packaged
`crew-pr-watch ack` command, and explicitly rearm the disposed batch. A watcher
wake is information only and never grants mutation authority.

## Retention and verification

`crew-mcp status` summarizes repo-scoped watches and pending remedies.
`crew-mcp cleanup` supports PR-watch TTL, dry run, and all-repo scope, but may
delete only terminal/cancelled histories. Default global verify remains offline
and repo-independent while checking PR-watch state writability. Project verify
requires a non-empty project install, exact companion/waiter paths, and a
writable contained git-common-dir host lock.
