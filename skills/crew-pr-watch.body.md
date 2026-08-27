# Crew PR watch

Use Crew's durable PR-watch lifecycle when the user asks to watch or babysit a pull request or linear stack. Confirm the target and any approval goal that is genuinely unclear, then call `start_pr_watch` once and launch exactly the returned `required_next_action.command` in the background before ending the turn.

The public surface is the five monitor tools—`start_pr_watch`, `list_pr_watches`, `get_pr_watch_status`, `rearm_pr_watch`, and `cancel_pr_watch`. This release has no controller-owned GitHub or git mutation path.

The waiter polls outside model turns. Do not poll `get_pr_watch_status` in a loop. On a wake or the next user turn, read status once. Status is pure; only `rearm_pr_watch` advances or replaces observation.

For `actionable`, inspect the persisted batch. Default to monitor-only handling. Without a current grant, investigate through ordinary user-authorized workflows, record each disposition through the packaged `{{CREW_PR_WATCH_COMMAND}} ack` command, and call `rearm_pr_watch` with the exact batch and generation identities. For `blocked` or `expired`, explain the persisted remedy and obtain any required confirmation. An expiry extension can restore active, actionable, or blocked state: launch a waiter only when the returned receipt includes one.

Read [ACTION.md]({{ACTION_REFERENCE_PATH}}) only when a watch is actionable or a remedy must be consumed.

A wake is never authority to mutate GitHub, git, a review, or a branch. PR-watch only observes, reports, records dispositions, and rearms; any external change remains an ordinary separately authorized user workflow. Crew PR-watch cannot comment, reply, resolve, push, merge, auto-merge, enter a merge queue, force/lease-push, delete a ref, close, create, or approve a PR.
