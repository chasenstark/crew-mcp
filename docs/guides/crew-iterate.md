# crew-iterate

`crew-iterate` is Crew's criteria-gated implementation and review workflow.
Use it when work should continue until an agreed standard passes, not merely
until an implementer finishes one turn.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/crew-iterate-dark.png">
  <img alt="A request becomes confirmed acceptance criteria, then implementation and independent review repeat until every criterion passes and the user decides whether to merge." src="../assets/crew-iterate.png" width="980">
</picture>

## Start an iteration

Ask naturally:

> Keep working on the rate limiter until the tests pass and independent
> reviewers approve it.

Or invoke the installed skill directly:

```text
/crew-iterate Implement the rate limiter and iterate until it is ready to ship.
```

The exact slash-command presentation depends on the host, but the installed
skill name is `crew-iterate` in Claude Code, Codex, and agy.

Use the umbrella `crew` workflow instead for a one-shot implementation,
review-only work, or an explicit "no review" request.

## What the user controls

Before implementation starts, the captain asks the user to confirm two parts
of the loop contract:

1. Three to seven acceptance criteria:
   - `[M]` mechanical checks such as tests, lint, build, or a file assertion.
   - `[B]` behavioral properties reviewers can verify from the diff.
   - `[N]` negative requirements protecting behavior the change touches.
2. The implementer, Crew reviewers, and host-native reviewer.

The user can edit either proposal before approving it. Criteria changes during
the loop start a new criteria epoch and require confirmation again. Roster
changes also pause dispatch until the user confirms the new roster.

The user retains three additional decisions:

- Whether an eligible Claude implementer may use a native `/goal` inner loop.
- How to proceed if the loop reaches a configured round limit or a reviewer
  returns `BLOCKING`.
- Whether the converged implementation is merged. Convergence never implies
  merge permission.

## The outer Crew loop

Crew owns the delivery lifecycle:

1. Persist the confirmed criteria.
2. Dispatch one write implementer in an isolated worktree.
3. Wait for the implementer to become terminal.
4. Dispatch the confirmed Crew reviewers and host-native reviewer.
5. Re-run every `[M]` command in the implementer's worktree and consolidate
   every reviewer's complete criteria score.
6. If anything fails, send the findings back through `continue_run` and review
   the full criteria set again.
7. Once every criterion passes and every reviewer approves, ask the user
   whether to merge.

Watchers wake the captain when asynchronous work becomes terminal. Crew does
not hold the conversation open by polling, and a watcher wake does not itself
authorize continuation, cleanup, or merge.

## Optional Claude `/goal` inner loop

Claude Code's native `/goal` can reduce outer-loop round trips for mechanical
fix-and-check work. It is a bounded execution primitive inside one implementer
dispatch, not another orchestrator.

These are two different slash commands:

- `/crew-iterate` is the user-facing skill invocation that starts Crew's
  criteria, implementation, review, and merge-decision workflow.
- Claude `/goal` is a provider control message that Crew may send inside the
  selected implementer's dispatch after the user separately opts in.

### The user opts in

Native goals are never inferred from a normal `crew-iterate` request. Choosing
Claude as the implementer or confirming an `[M]` criterion is not consent.

When the change is eligible, the captain can propose a concrete choice such
as:

> Let Claude use a bounded `/goal` loop for `npm run test:run` — up to six
> turns or five minutes — or use a normal single-shot dispatch?

Only an explicit affirmative selection permits the captain to attach `goal`
to `run_agent`. The user does not need to type the provider slash command;
Crew invokes it through the Claude adapter.

### Eligibility

All of these conditions must hold:

- The user explicitly opted in.
- The confirmed implementer is Claude Code.
- The run is a write implementation, not a review or ephemeral run.
- One `[M]` criterion provides one single-line validation command.
- The command is safe to execute repeatedly.
- The goal is bounded to 1--20 turns and 1,000--600,000 milliseconds, below
  Crew's outer watchdog.

The worker is told to stop on infrastructure, permission, or dependency
failure instead of grinding on a condition it cannot establish.

### Invocation

The captain passes a structured goal with the ordinary Crew dispatch:

```text
run_agent({
  agent_id: "claude-code",
  criteria_set_id: "criteria-...",
  goal: {
    validation_command: "npm run test:run",
    repeat_safe: true,
    max_turns: 6,
    max_wall_clock_ms: 300000
  },
  prompt: "Implement the change, run every [M] check, and report results."
})
```

Crew converts that into separate Claude stream messages. Conceptually:

```text
/goal A fresh execution of this explicitly repeat-safe validation command
exits 0: "npm run test:run". Stop immediately and report blocked if
infrastructure, permissions, or dependencies prevent validation.

<ordinary implementation prompt>
```

The validation command is provider prompt data. Crew does not execute it as
part of setting `/goal`; Claude performs the inner-loop work. After the run is
terminal, the captain independently reruns the corresponding `[M]` command.
Native goal success alone never proves Crew convergence.

### Continuations

`continue_run` deliberately defaults `goal_policy` to `clear` so new review
findings cannot accidentally resume a stale provider objective.

| Policy | Behavior | Required intent |
| --- | --- | --- |
| `clear` | Sends `/goal clear` before the new work prompt. This is the default. | No additional opt-in. |
| `inherit` | Retains the same nonterminal native objective. | The user explicitly wants it retained. |
| `replace` | Clears the old objective and sets a newly supplied goal. | The user confirms the replacement. |

Inherited and replacement goals consume the original run's cumulative turn
and wall-clock budget. A continuation cannot reset or increase that ceiling.
If Claude does not authoritatively confirm a clear, the next default-clear
continuation retries it rather than silently resuming the stale goal.

### Outcomes

The captain reads the structured `goal.outcome` from Crew status, never a
worker's prose claim. Possible outcomes are:

```text
not_requested  unsupported  achieved  impossible  turn_capped
watchdog_timeout  cancelled  provider_error  evaluator_error
```

Provider goal outcomes must come from trusted provider control or status
events. If Crew cannot establish an authoritative outcome, it fails closed as
`evaluator_error`; the captain investigates instead of treating the goal as
successful.

## Why `/goal` stays inside one dispatch

Crew must remain the single continuation owner. A captain-level goal such as
"continue until all criteria pass and all reviewers approve" would compete
with Crew's watcher and durable run state. That creates several failure modes:

- duplicate or conflicting continuations;
- provider work continuing with stale instructions after review findings;
- disagreement between provider goal state, Crew watchdogs, and iteration
  caps;
- repeated wakes that rediscover nonterminal runs without an actionable event;
- a weak transcript evaluator making review, terminal, or merge decisions.

The inner boundary preserves the useful behavior — retrying mechanical work
without a captain round trip — while Crew retains criteria, review cadence,
watchers, cumulative budgets, terminal decisions, and the merge gate.

## Codex goals are unsupported

Do not offer a native goal when Codex is the Crew implementer, and do not use
the Codex captain's `/goal` to drive the outer `crew-iterate` loop.

The isolated Codex lifecycle spike found both required gates missing:

1. `codex exec --json` ended after the first public turn instead of keeping an
   autonomous multi-turn goal process alive.
2. Its public JSONL exposed no stable machine-readable terminal goal event.

Without both properties, Crew cannot place the provider loop beneath its
watchdog or distinguish achieved, impossible, interrupted, and still-active
states authoritatively. If a goal is nevertheless sent to an unsupported
provider, Crew records `unsupported` and performs one ordinary dispatch.

Codex workers therefore use Crew's explicit `continue_run` outer loop. Native
Codex support should be reconsidered only after a new isolated spike proves
both lifecycle gates.

## Convergence and merge

The loop converges only when:

- every captain-owned `[M]` command passes;
- every `[B]` and `[N]` criterion is `PASS`, except an `N-A` the user
  explicitly accepted;
- every reviewer returns a well-formed `APPROVE`; and
- no unresolved critical or major finding remains.

At that point the captain presents the proposed commit title and body and asks
whether to merge. Silence is not consent. The default merge strategy after
approval is squash because iteration naturally produces implementation and
fixup commits.

## Related references

- [Canonical skill body](../../skills/crew-iterate.body.md) — the installed
  captain playbook and safety invariants.
- [Configuration](configuration.md) — implementer/reviewer defaults and
  iteration limits.
- [MCP tool surface](../architecture/tools.md) — criteria, dispatch, status,
  bounded goal, and continuation contracts.
- [Adapter contracts](../architecture/adapters.md) — Claude `/goal` encoding,
  trusted outcome parsing, and the Codex lifecycle decision.
- [Run-state contract](../architecture/run-state-contract.md) — durable
  criteria, prompt, goal, and budget records.
