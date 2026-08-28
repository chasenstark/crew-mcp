# PR-watch behavioral contract

**Frozen:** 2026-08-27. **Author:** Crew maintainers. **Provenance:** this is
an independently written, public behavior and incident contract distilled from
the approved local plan. Planning inspected Assembled's private PR-watch
implementation; implementation must not copy that source or its fixtures.

This contract is the only Assembled-derived implementation input for Crew's
PR-watch subsystem. It describes externally important behavior, not source
structure.

## Product boundary

PR-watch observes one GitHub pull request or one linear GitHub-defined stack,
persists observations outside model turns, and wakes the originating captain
only for an actionable batch, a blocker/remedy, expiry, or a terminal outcome.
Unchanged polling consumes no model turns.

Milestone A is monitor-only. It cannot push, comment, reply, resolve a thread,
close or create a pull request, merge, enable auto-merge, enter a merge queue,
or run an arbitrary repository command. Milestone B adds only explicitly
granted GitHub effects and a single-PR fast-forward push. Multi-PR branch
mutation and every force form remain forbidden.

## Stable observation behavior

- A watch owns a server-issued `pw-<32 lowercase hex>` ID. Every public entry
  point validates that exact single-segment form before filesystem or lock use.
- Fresh-call idempotency is keyed separately by a SHA-256 request digest with a
  durable `prepared -> committed -> reclaimed` lifecycle. A prepared retry
  finishes the reserved ID; retained committed state returns the old receipt;
  only reclaim proof permits a new ID.
- Event identity is `(PR number, head SHA, kind, provider source ID, attempt)`.
  Kinds are check failure, review thread, comment, review, and PR closure.
  Same-name CI reruns and allowlisted comment edits therefore remain distinct.
- A new head supersedes old-head events without deleting history. Dispositions,
  notes, prior judgments, fix-attempt counts, heads, deferred work, rounds, and
  budgets survive process death and context compaction.
- GitHub checks are always observed. Optional CircleCI evidence is a typed,
  read-only provider. Missing, incomplete, paginated, stale, transiently
  unavailable, or progressively registering evidence never means green.
- Terminal green/approval requires two identical complete observations at
  least one nominal cadence apart and after the last observed head update.
  Required-check identity, attempt identity, exact heads, approval evaluation,
  provider policy, pagination completeness, and PR state are fingerprinted.
- At the default 50-PR limit, an unchanged steady-state snapshot uses at most
  three GitHub requests and respects the persisted projected point budget.

## Durable state and crash behavior

Watch state lives under `<crewHome>/pr-watches/<watchId>/`, separate from Crew
run state. `events.jsonl` is the append-only digest-chained commit log;
`state.json` is only a monotonic cache with a sequence, byte offset, and digest
checkpoint. Pure reads validate and replay a committed cache tail in memory.
Only controller startup may repair the cache. Unknown, corrupt, or truncated
records fail closed and are never skipped.

An actionable handoff freezes a batch ID and inclusive ledger watermark.
Disposition and explicit rearm are idempotent. Events observed after the
watermark survive into the next batch. `get_pr_watch_status` is byte-pure and
may derive stale waiter health from persisted lease timestamps, but it never
mutates lifecycle. `rearm_pr_watch` is the only public Milestone A
generation/replacement writer.

The standalone waiter keeps its polling timer referenced. While a provider
poll is in flight, a bounded independent heartbeat renews the execution lease;
renewal at or after the persisted deadline fails closed so an expired waiter
cannot become healthy again without compare-and-set rearm.

Every nonterminal watch has a snapshotted age deadline unless age is disabled.
One internal deadline controller owns active, terminal-only, actionable, and
blocked expiry. Expiry is a pause over a digest-bound suspended lifecycle:

- extending active restores exactly full or terminal-only mode and one waiter;
- extending actionable restores the same handoff and no waiter;
- extending blocked restores the same cause, evidence, consuming reasons,
  authority/corruption constraints, and no waiter;
- extending a budget blocker preserves its complete server-owned handoff proof
  and rebinds only the expected generation.

Blocker and expiry remedies have distinct durable surface IDs. Waiter and JIT
delivery compete by exact CAS. Claimed surfaces have attempt-scoped leases;
live timers, selector preflight, and startup recover an expired unaudited claim
to pending without changing lifecycle or generation. Delayed audits cannot win.
Status/list reads never perform this recovery.

Actionable-wake and action-round exhaustion are non-retryable budget blockers.
Their sole consuming transition validates the preserved cause, generation,
batch, disposition map, counter, and grant identity when applicable, then
enters terminal-only observation once. `blocked_resolved` cannot consume a
budget blocker. Every non-expiry rearm checks the age deadline again at its
final CAS.

GC never deletes active, actionable, blocked, or expired watches. It may delete
only retained terminal/cancelled watches, coordinating the reverse start-key
mapping under start-key-then-watch lock order.

## Wake compatibility

PR-watch reuses Crew's Claude and Codex transports through a target-aware wake
request. Existing run/panel behavior is immutable: canonical multi-run pair
sorting, serialized digest input, claim filename, lock path, terminal predicate,
reason strings, exit codes, and ambiguous-failure claim retention remain
byte-compatible. Mixed run/watch batches are invalid.

Polling ownership is separate from synthetic-turn delivery. A watch waiter
claims one generation/action under an execution lease and heartbeat. Duplicate
or stale waiters cannot wake twice. A waiter exits after handing off an
actionable or terminal surface; it never holds a model turn open.

## Provider and policy boundary

Provider access uses authenticated CLIs, never an API-key-only path. GitHub is
a typed read-command union; CircleCI, when configured, admits only structured
run/workflow reads. Arbitrary URLs, methods, request bodies, GraphQL mutations,
and generic shell hooks are rejected before spawn. Provider subprocesses obey
the MCP request abort signal, a 20-second per-process deadline, and a 60-second
total transition deadline. Timeout/cancellation returns a typed retryable
blocker without partial state mutation.

Repository policy is only `.crew/pr-watch.yaml`, validated without following a
symlink outside the repository. GitHub rules are resolved even for an explicit
check list. Omitting a protected context, choosing no checks, or being unable
to compare policy requires explicit confirmation bound to the comparison hash.
Policy is immutable for a watch; drift blocks instead of silently weakening it.

## Authorized action boundary

Milestone B persists an expiring, revocable grant scoped to one watch,
repository, heads, effect kinds, and bounded rounds. Default is deny. Actions
use a dedicated Crew-owned worktree and the existing git-common-dir-keyed host
reader/writer lock. Lock order is host lock, run/watch worktree lock, then
state lock. Network calls and effect settlement never hold the host writer. A
single-PR push binds the remote URL and validates the local lease, head, and
fast-forward ancestry in the first writer section, performs the exact
non-force SHA refspec push after releasing it, then verifies remotely before a
second local revalidation section.

Every effect is journaled through prepare, observe, apply, verify, and settle.
Recovery may produce exactly one observable remote effect and one durable next
action, never a duplicate. A push is permitted only for exactly one PR, with an
explicit non-force SHA refspec and proved fast-forward ancestry. Lost lease,
head, topology, policy, expiry, budget, or authority stops in place.

Supported remote effects are single-branch fast-forward push, review-comment
reply, top-level comment, and review-thread resolution. Merge, auto-merge,
merge queue, force/lease push, delete/mirror refspec, PR creation/closure, and
multi-PR branch mutation are rejected structurally and in fake-CLI transcript
tests.

## Distribution and verification

The live server, static catalog, installed captain contract, and tool tests stay
in parity: five monitor tools in Milestone A and one authorization tool added in
Milestone B. The package includes separate `crew-pr-watch` and safe
`crew-pr-watch-wait` binaries plus a small `crew:pr-watch` skill and canonical
`ACTION.md` companion. Only the waiter receives automatic host approval or the
exact Codex watcher escalation.

Default `crew-mcp verify` remains offline and repository-agnostic while
retaining the state-lock, panel, and peer-message probes and adding PR-watch
state writability. `verify --scope project` separately requires a non-empty
project install and validates exact targets, companion bytes, commands,
permissions, state roots, and the Milestone B shared host lock. Neither scope
probes GitHub or CI.
