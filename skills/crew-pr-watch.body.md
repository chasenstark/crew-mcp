# Crew PR watch

Use Crew's durable PR-watch lifecycle when the user asks to watch or babysit a pull request or linear stack. Confirm the target and any approval goal that is genuinely unclear, then call `start_pr_watch` once and launch exactly the returned `required_next_action.command` in the background before ending the turn.

The public surface is the five monitor tools—`start_pr_watch`, `list_pr_watches`, `get_pr_watch_status`, `rearm_pr_watch`, and `cancel_pr_watch`—plus `authorize_pr_watch_actions`. Authorization is captain-only and performs no remote effect.

The waiter polls outside model turns. Do not poll `get_pr_watch_status` in a loop. On a wake or the next user turn, read status once. Status is pure; only `rearm_pr_watch` advances or replaces observation.

If `get_pr_watch_status` reports `waiter_health.state: "stale"`, the persisted waiter is no longer healthy even if its raw waiter state still says `running`. Rearm with the reported waiter identity and `reason: "stale_waiter"` for an expired lease, or `reason: "timeout"` for a timed-out exited waiter.

<!-- host:codex -->
On Codex, launch the waiter with `functions.exec` by pasting
`required_next_action.spawn_recipe_json` verbatim — it is the complete
server-built `tools.exec_command` argument: command, working directory, and
the escalated sandbox permission (`sandbox_permissions: 'require_escalated'`)
with its justification. The trusted waiter must write its execution lease and
wake claim under the server-pinned Crew home, which may be outside the
project sandbox. Do not rebuild the command or strip any field from the
recipe.

```js
const recipe = <required_next_action.spawn_recipe_json>;
const result = await tools.exec_command(recipe);
if (result.exit_code !== undefined && result.exit_code !== 0) {
  throw new Error(`crew-pr-watch-wait failed to start: ${result.output}`);
}
text(JSON.stringify({ type: 'crew_pr_watch_waiter_started', session_id: result.session_id }));
```

The escalation inside the recipe applies only to the exact server-returned
waiter command, never to provider, worker, git, or repository commands. A
waiter launched without it cannot write its lease or wake claim: it exits
immediately with `CREW_PR_WATCH_WAKE_UNWRITABLE` (exit 4), which the
exit-code check surfaces — relaunch with the exact recipe. If escalation is
unavailable, report that the durable watch exists but is not polling;
recover it on a later turn through `get_pr_watch_status` and the exact
reported rearm arguments.
<!-- /host -->

For `actionable`, inspect the persisted batch. Default to monitor-only handling. Without a current grant, investigate through ordinary user-authorized workflows, record each disposition through the packaged `{{CREW_PR_WATCH_COMMAND}} ack` command, and call `rearm_pr_watch` with the exact batch and generation identities. For `blocked` or `expired`, explain the persisted remedy and obtain any required confirmation. An expiry extension can restore active, actionable, or blocked state: launch a waiter only when the returned receipt includes one.

Read [ACTION.md]({{ACTION_REFERENCE_PATH}}) only when a watch is actionable or a remedy must be consumed.

A wake is never authority to mutate GitHub, git, a review, or a branch. Before action automation, obtain explicit user confirmation for the exact effect kinds, maximum action rounds, maximum actionable wakes, and optional expiry; then call `authorize_pr_watch_actions` with the current generation, policy hash, and topology hash. The returned grant may be used only through the packaged typed `{{CREW_PR_WATCH_COMMAND}} effect` command and only for the current batch. Never infer or broaden a grant. Crew cannot merge, auto-merge, enter a merge queue, force/lease-push, delete a ref, close, create, or approve a PR.
