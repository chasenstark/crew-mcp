# PR-watch action and recovery reference

Treat the watch ledger as authoritative. Start with `get_pr_watch_status`; never infer a current batch, generation, blocker cause, surface, or waiter identity from conversation history.

## Actionable batch

1. Read `action_batch.actionBatchId`, `generation`, its event IDs, and the inclusive ledger watermark.
2. Investigate through ordinary user-authorized workflows; PR-watch itself has no GitHub or git mutation path in this release.
3. Record every handed-off event as `acknowledged`, `resolved`, `deferred`, or `superseded` using `{{CREW_PR_WATCH_COMMAND}} ack`; then call `rearm_pr_watch` with reason `disposed_batch`, exact generation, and action batch ID.

## Waiter recovery

For `TIMEOUT`, pass the exited waiter action ID with reason `timeout`. For a provably expired execution lease, pass that same ID with reason `stale_waiter`. Do not replace a healthy waiter.

## Blocked

Use the persisted `blocking_cause_id`, version, class, evidence, and allowed consuming reasons. Retryable provider/evidence blockers use `blocked_resolved`; Crew performs fresh bounded revalidation before the final compare-and-set. Budget blockers accept only `budget_exhausted` and preserve their server-owned handoff proof. Never construct or substitute proof fields.

## Expired

Extension requires explicit user confirmation and 1–30 days. The receipt restores the exact suspended state. Active gets one mode-preserving waiter; actionable keeps its batch and gets no waiter; blocked keeps its cause and gets a fresh remedy surface but no waiter.

## Safety boundary

Neither watcher completion nor this reference authorizes a remote effect. This release cannot perform one: never use PR-watch to comment, reply, resolve, push, merge, auto-merge, enter a merge queue, force/lease-push, delete/mirror a ref, close/create a PR, or approve.
