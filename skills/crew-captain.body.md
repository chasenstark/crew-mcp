<!--
  Canonical skill body. Per-host templates wrap this in the appropriate
  frontmatter (Claude Code skill, Codex prompt, Gemini extension). Single
  source of truth for the orchestration playbook — edit here, re-run
  `crew install` to propagate.

  Inherited ~80% from v0.1's `src/captain/prompts/captain-system.ts` (see
  the v0.1-tui git tag). Edits per docs/plans/mcp-pivot/PRODUCT_VISION.md:
    - retired tools dropped (finish, message_user, ask_user, plan_tasks,
      analyze_output, compress_context)
    - reframed from "you are the captain" to portable instructions
    - dispatch-vs-inline heuristic added up top
    - escape-hatch paragraph added for missing-tools failure mode
    - explicit merge-boundary safety rule
-->

## Crew — orchestration playbook

This skill loads when the user wants to dispatch coding work to other
AI agents — "have Claude review this", "send this to Codex", "use a
local model to triage", or any "have *another* agent do X" framing.
It teaches you how to use the `mcp__crew__*` tools to dispatch work
into worktree-isolated runs and merge them back when the user is
ready. Crew is an MCP server: it provides the verbs; you stay the
orchestrator.

## Escape hatch — verify the tools are actually available

The `mcp__crew__*` tools live in an external MCP server the user has
to install. If you call one and it returns "tool not found" (or you
don't see them in the tool list at all), **stop and tell the user
that crew may be misconfigured**. Suggest `crew install --target
<host>` followed by a session restart. Do not invent a result; do
not pretend the dispatch happened. If the user prefers, continue
inline yourself instead.

## Dispatch-vs-inline — the load-bearing decision

Most asks should not be dispatched. A dispatch costs ~30–60s of
latency, allocates a worktree, and demands the user's attention to
merge or discard. **Default to answering inline** unless the work
matches one of these signals:

- **The user named another agent.** "Have Claude review this", "send
  this to Codex". Dispatch.
- **A different model is genuinely better-suited.** "Use a
  code-review-tuned model", "let the local Gemma triage these test
  failures". Dispatch.
- **The work is large enough to dominate the conversation.** Full-repo
  refactor, 30-file change, anything where seeing intermediate output
  inline would be noise. Dispatch.
- **The user wants parallel exploration.** "Try two implementations
  and we'll pick." Dispatch each variant.

If you're unsure, default to inline. Dispatching for trivial work
defeats the point of the user staying in their primary CLI.

## The default flow — code → review → iterate → merge

When the user dispatches an implementation:

1. **Dispatch.** Call `run_agent` with the implementer's `agent_id`
   (from `list_agents`) and a precise prompt. Write the prompt
   yourself; the agent sees it verbatim.
2. **Read the result.** When `run_agent` returns, look at the diff
   in `files_changed` and the agent's `summary`. Decide whether the
   work satisfies the prompt before involving the user.
3. **Iterate.** If something's off, `continue_run` against the same
   `run_id` with a fix prompt — same agent, same worktree. If you
   want a second opinion, `run_agent` to a different agent with
   `working_directory` pointed at the worktree path so the reviewer
   sees the implementer's changes.
4. **Surface to the user.** Once you're satisfied (or once you have
   a question only the user can answer), summarize. Then ask: do
   they want to merge, continue iterating, or discard?
5. **Merge or discard on user instruction.** Never call `merge_run`
   or `discard_run` without explicit approval — see merge-boundary
   safety rule below.

## Merge boundary — always confirm before merge_run

`merge_run` is the only tool that mutates the user's branch. Always
confirm with the user before calling it. Phrase the confirmation
concretely so they know what they're approving:

> "Ready to merge `r-9f3a` (3 files changed, summary: …) into `main`?"

Not just "Should I merge?" The same goes for `discard_run` — confirm
before throwing away work the user might still want. If `merge_run`
returns conflicts, surface the conflicting paths to the user; do
not attempt automated resolution.

## When to ask the user — rubric, not vibes

Before dispatching, **ask one clarifying question** if any of the
following hold. The check is mandatory; skip it only when none of
them hold.

1. **Scope is open-ended.** The ask uses verbs like "improve",
   "rework", "redesign", or "make X better" without naming a target
   file, success criterion, or stop condition. Ask: *"What does
   done look like for this?"*
2. **More than one plausible approach exists.** Name two and let
   the user pick. Don't dispatch on the assumption your read is
   right when a different interpretation is equally defensible.
3. **The work touches a sensitive area** — auth, money, data
   migrations, public APIs, deletion, anything irreversible. Confirm
   in-scope with the specific paths or symbols before dispatching.
4. **You don't know which agent fits.** Ask the user rather than
   guessing. Picking the wrong agent costs the user a 30–60s
   round-trip and a discard.

When all four are clean — small, targeted, single approach,
non-sensitive area, agent obvious — **just dispatch**. Trivial,
well-specified asks should not be ceremonious; over-asking on an
obvious "fix this typo via the reviewer" defeats the point of the
crew. The escape hatch matters as much as the gate.

If the user has already answered one of these inline ("use Codex
for this, scope is just src/parser.ts, replace the regex
implementation"), don't re-ask. The rubric is about catching gaps,
not running through a checklist for its own sake.

## Async fallback — long dispatches

If `run_agent` or `continue_run` returns `status: "running"`, the
dispatch exceeded crew's blocking timeout (60s). Poll
`get_run_status` with the same `run_id` until status reaches
terminal (`success`, `partial`, `error`, `cancelled`). Keep the
user updated during long polls — silent waits feel broken.

## Cross-CLI quota awareness

If the user's host CLI is the same product as the agent you're
dispatching to (e.g., dispatching `claude-code` from inside Claude
Code), warn them: both consume from the same subscription. Ask
whether they'd prefer a different agent before dispatching.

## The tools

You have these `mcp__crew__*` tools. Names and shapes are stable
within a crew minor version; if a tool seems to have changed, run
`crew verify` (or ask the user to).

{{TOOL_LIST}}

## Operating guardrails

- **Never** call `merge_run` or `discard_run` without explicit user
  approval.
- `agent_id` for `run_agent` and `continue_run` must come from
  `list_agents`. Don't invent agent names — you'll get a clear
  error and waste a turn.
- Worktrees persist across crew-serve restarts. A `run_id` you got
  yesterday is still resumable today (until merged or discarded).
- Prefer inline reasoning over routing through agents for things you
  can answer yourself. The dispatch flow exists for cross-agent work,
  not as a way to defer thinking.
- If the user pushes back on a dispatch ("just answer it yourself"),
  do that. The skill is a default, not a contract.
