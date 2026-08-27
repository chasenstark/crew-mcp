# PR-watch action and recovery reference

Treat the watch ledger as authoritative. Start with `get_pr_watch_status`; never infer a current batch, generation, blocker cause, surface, or waiter identity from conversation history.

## Actionable batch

1. Read `action_batch.actionBatchId`, `generation`, its event IDs, and the inclusive ledger watermark.
2. Default to monitor-only investigation. If a remote effect is needed, show the user the exact effect kinds, maximum action rounds, maximum actionable wakes, and optional grant expiry. Only an explicit confirmation authorizes a call to `authorize_pr_watch_actions`; a wake or prior Crew consent does not.
3. The authorization call must repeat the current generation, policy hash, and topology hash from status. It attaches a dedicated clean worktree lease and returns a bounded grant but performs no effect. Do not proceed if the remote heads, policy, topology, lease, expiry, or budget changed.
4. Execute a granted effect only through `{{CREW_PR_WATCH_COMMAND}} effect <watch_id> --generation <n> --action-batch <id> --event <id> --kind <kind> --target-base64 <base64url-json> [--body-base64 <base64url>] [--disposition <value>]`. Supported kinds are `post_pr_comment`, `reply_review_comment`, `resolve_review_thread`, and single-PR-only `push_single_branch`. The effect journal observes before retrying and settles its disposition atomically.
5. For monitor-only handling, record every handed-off event as `acknowledged`, `resolved`, `deferred`, or `superseded` using `{{CREW_PR_WATCH_COMMAND}} ack`; then call `rearm_pr_watch` with reason `disposed_batch`, exact generation, and action batch ID. An effect that settles the full batch returns the next state itself; do not acknowledge or rearm it again.

## Waiter recovery

For `TIMEOUT`, pass the exited waiter action ID with reason `timeout`. For a provably expired execution lease, pass that same ID with reason `stale_waiter`. Do not replace a healthy waiter.

## Blocked

Use the persisted `blocking_cause_id`, version, class, evidence, and allowed consuming reasons. Retryable provider/evidence blockers use `blocked_resolved`; Crew performs fresh bounded revalidation before the final compare-and-set. Budget blockers accept only `budget_exhausted` and preserve their server-owned handoff proof. Never construct or substitute proof fields.

## Expired

Extension requires explicit user confirmation and 1–30 days. The receipt restores the exact suspended state. Active gets one mode-preserving waiter; actionable keeps its batch and gets no waiter; blocked keeps its cause and gets a fresh remedy surface but no waiter.

## Safety boundary

Neither watcher completion nor this reference authorizes a remote effect. A durable grant is still limited to its named kinds, batch, budgets, heads, policy, topology, lease, and expiry. Revoke unused authority with `authorize_pr_watch_actions(action: "revoke", ...)`. Never merge, auto-merge, enter a merge queue, force/lease-push, delete/mirror a ref, close/create a PR, or approve. Multi-PR branch mutation is always forbidden.
