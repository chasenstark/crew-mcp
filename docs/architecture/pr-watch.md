> **Current as of 2026-09-02.**

# Durable PR watch

Crew PR watch observes a GitHub pull request or GitHub-defined linear stack
without keeping a model turn open. It is a separate durable lifecycle, not a
synthetic Crew run. The frozen behavior and provenance input is in
[the behavioral contract](pr-watch-behavioral-contract.md).

## Runtime and state

`src/pr-watch/` owns provider capability checks, discovery, policy resolution,
evidence reduction, deadlines, waiters, recovery surfaces, retention, action
leases, and effect settlement. Each watch lives at:

```text
<crewHome>/pr-watches/<pw-id>/
  events.jsonl       digest-chained authoritative state transitions
  state.json         monotonic cache, replayed from the ledger on pure reads
  effects.jsonl      digest-chained remote-effect phases when authorized
  observation-cache.json  delta-polling sidecar: last detail per PR + change signal
  observation-poll.json   delta-polling per-poll costs and diagnostics
  worktree/          dedicated attached action worktree when authorized
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

Polling is delta-based. GitHub prices GraphQL by requested connection nodes,
so the full per-PR detail query (100 threads, each with a nested last comment,
plus reviews, comments, and check contexts) costs about 105 node-units per PR:
53 points for a 50-PR stack, which the 25% projection gate rejects outright.
Each poll therefore starts with a scalar change probe over every watched PR
(state, `updatedAt`, head, base, review decision, draft flag, and the head
commit's check rollup state; about 1 point for 50 PRs), compares each signal
with the one stored beside that PR's cached detail in `observation-cache.json`,
and fetches the full query only for PRs whose signal moved. A full refresh
runs anyway once the cache is older than `PR_WATCH_FULL_REFRESH_INTERVAL_MS`
(15 minutes) or is missing, foreign, or corrupt, so the design never depends
on the probe seeing every kind of change. The merged result is shaped exactly
like a full snapshot; evaluation and the reducer never learn which PRs came
from cache, and the sidecar is never authoritative.

Two guards keep the cache from weakening evidence. A terminal verdict is never
certified from cached detail: when a probe-served evaluation is still a green
or all-closed candidate after every provider (including CircleCI) has been
folded in, the controller re-reads every PR in full before that observation
can start or complete the terminal dwell, because a thread can be unresolved,
or a review dismissed, without moving any probe field. A pending required
CircleCI workflow vetoes the candidate first, so it never pays for that
re-read on every poll. The re-read is charged to the same poll (its cost and
call count accumulate in `lastObservation` and fold into the detail-cost
window) rather than counting as the periodic refresh. And the ledger's
projected point spend uses the amortized steady-state poll cost (probe,
refresh spread over the polls between refreshes, and the detail-cost window
averaged over at least five polls) only when the sidecar was actually
persisted; a failed write projects the poll's real cost, so an unwritable
cache directory trips the 25% gate instead of silently bypassing it.

The detail file is rewritten only when a detail fetch happened and stores
only comment bodies from the watch's immutable verdict sources, since no other
comment can produce an event; the small per-poll record is rewritten every
poll. `get_pr_watch_status` reports both read-only as `delta_polling`.

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

The standalone polling sleep stays referenced so Node cannot exit between
polls. During provider work, an independent lease heartbeat runs at most every
60 seconds and is stopped before the polling sleep; the polling sleep then owns
process lifetime. A heartbeat at or after its lease deadline is rejected, so a
stale process cannot resurrect after recovery becomes eligible. Status remains
pure but derives `waiter_health` and exact compare-and-set rearm arguments from
that deadline; JIT diagnostics use the same derivation.

The captain tools are:

- `start_pr_watch`, `list_pr_watches`, `get_pr_watch_status`,
  `rearm_pr_watch`, and `cancel_pr_watch` for monitoring;
- `authorize_pr_watch_actions` for a separately confirmed bounded grant.

The installed `crew:pr-watch` skill launches exactly the returned trusted
waiter command and reads `ACTION.md` only for an actionable batch or remedy.

## Authorized actions

Default is deny. A grant is durably bound to watch generation, exact policy and
topology hashes, observed heads, named effect kinds, maximum action rounds,
maximum actionable wakes, and optional expiry. Authorization performs a fresh
bounded head snapshot and creates or crash-recovers a prepared dedicated
worktree lease under the existing git-common-dir host writer. It performs no
remote effect.

The worktree is clean, attached to the watched head branch, and unavailable if
another worktree owns that branch. Host writer sections have a 10-second
aggregate budget and never contain provider/network calls or settlement. A
single-PR push uses two short writer/revalidation sections. The first binds the
remote URL and proves local lease, head, and fast-forward ancestry; one explicit
`<sha>:refs/heads/<branch>` push runs after releasing it, and remote
verification remains outside before the second local revalidation.

Effects are serialized by deterministic ID and journaled through
`prepared`, `observed_absent`, `applied` or `ambiguous`, `verified`, and
`settled`. Recovery observes the marker or remote head before retrying. Settle
records the event disposition, increments the action budget, rolls forward
heads/lease when needed, and rearms a fully disposed batch in one watch-ledger
transaction.

Supported effects are top-level PR comment, review-comment reply,
review-thread resolution, and single-PR fast-forward push. Merge, auto-merge,
merge queue, PR close/create/approve, force/lease/delete/mirror push, and every
multi-PR branch mutation are structurally unavailable.

## Retention and verification

`crew-mcp status` summarizes repo-scoped watches and pending remedies.
`crew-mcp cleanup` supports PR-watch TTL, dry run, and all-repo scope, but may
delete only terminal/cancelled histories. Default global verify remains offline
and repo-independent while checking PR-watch state writability. Project verify
requires a non-empty project install, exact companion/waiter paths, and a
writable contained git-common-dir host lock.
