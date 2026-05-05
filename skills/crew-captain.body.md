<!--
  Canonical skill body. Per-host templates wrap this in the appropriate
  frontmatter (Claude Code skill, Codex prompt, Gemini extension). Single
  source of truth for the orchestration playbook — edit here, re-run
  `crew-mcp install` to propagate.

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
local model to triage", or any "have _another_ agent do X" framing.
It teaches you how to use the `mcp__crew__*` tools to dispatch work
into worktree-isolated runs and merge them back when the user is
ready. Crew is an MCP server: it provides the verbs; you stay the
orchestrator.

## Escape hatch — verify the tools are actually available

The `mcp__crew__*` tools live in an external MCP server the user has
to install. If you call one and it returns "tool not found" (or you
don't see them in the tool list at all), **stop and tell the user
that crew may be misconfigured**. Suggest `crew-mcp install --target
<host>` followed by a session restart. Do not invent a result; do
not pretend the dispatch happened. If the user prefers, continue
inline yourself instead.

Always reach for the `mcp__crew__*` tools — never shell out to a
local `crew-mcp` binary on PATH (or a `dist/index.js` you spot in
the repo). The MCP path is the contract; shelling out bypasses
worktree allocation and run-state tracking, leaving the user in a
state where
`merge_run` / `discard_run` can't find the run.

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

## Decision order — the spine

Run this in your head before reaching for any tool. Each step has its
own section below; this list is the ordering glue.

1. **Inline or dispatch?** No signal in the list above → inline; stop here.
2. **Ask first?** If any rubric item below fires, ask one question and wait.
3. **Dispatch.** `list_agents` → `run_agent` (or `continue_run` to resume an existing run).
4. **Iterate or surface.** Read the result; iterate inline (`continue_run` / second opinion) or summarize for the user.
5. **Merge / discard.** Only on explicit user approval. Never call `merge_run` or `discard_run` unprompted.

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
   `read_only: true` and `working_directory` pointed at the
   implementer's worktree so the reviewer sees the changes without
   allocating its own worktree. The reviewer is structurally
   prevented from leaving stranded edits in a phantom worktree —
   it just reads the implementer's tree. (Restate "review only, do
   not edit" in the reviewer's prompt anyway; the flag skips
   allocation but doesn't constrain the agent's tools.) Apply
   reviewer findings via `continue_run` on the implementer's run.
4. **Surface to the user.** Once you're satisfied (or once you have
   a question only the user can answer), summarize. For an
   implementer run, ask: merge, continue iterating, or discard?
   For a **review-only run** (no edits expected), there's nothing to
   merge — surface the findings and ask whether to discard the
   worktree (cleanup) or keep it around for follow-up.
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
not attempt automated resolution. The host repo may now be in a
mid-merge state — let the user resolve by hand or run
`git merge --abort`. Don't run `merge --abort` yourself without
asking; it discards their position in the merge.

## When to ask the user — rubric, not vibes

Before dispatching, **ask one clarifying question** if any of the
following hold. The check is mandatory; skip it only when none of
them hold.

1. **Scope is open-ended.** The ask uses verbs like "improve",
   "rework", "redesign", or "make X better" without naming a target
   file, success criterion, or stop condition. Ask: _"What does
   done look like for this?"_
2. **More than one plausible approach exists.** Name two and let
   the user pick. Don't dispatch on the assumption your read is
   right when a different interpretation is equally defensible.
3. **The work touches a sensitive area** — auth, money, data
   migrations, public APIs, deletion, anything irreversible. Confirm
   in-scope with the specific paths or symbols before dispatching.
4. **You don't know which agent fits.** Ask the user rather than
   guessing. Picking the wrong agent costs the user a 30–60s
   round-trip and a discard.
5. **The agent you'd dispatch to is the same product as the host
   CLI.** E.g. dispatching to `claude-code` from inside Claude
   Code — both consume the same subscription quota. Warn the user
   and offer a different agent before dispatching.

The rubric only fires **after** you've decided to dispatch. If a
dispatch signal already applies and the four items above are clean —
**just dispatch**, no clarifying question needed. Trivial,
well-specified asks should not be ceremonious; over-asking on an
obvious "fix this typo via the reviewer" defeats the point of the
crew. The escape hatch matters as much as the gate.

If the user has already answered one of these inline ("use Codex
for this, scope is just src/parser.ts, replace the regex
implementation"), don't re-ask. The rubric is about catching gaps,
not running through a checklist for its own sake.

## Async fallback — long dispatches

`run_agent` / `continue_run` block synchronously for up to 60s. If
the agent finishes inside that window, the tool call returns the
final envelope and you're done. If it doesn't, the call returns
`{ status: "running", run_id }` and the dispatch keeps running in
the background — its terminal state is persisted to state.json.

**Whenever you receive `status: "running"`, immediately call
`get_run_status({ run_id })` and surface the `log_tail` to the user.
Then poll every 10–20s** until status reaches terminal (`success`,
`partial`, `error`, `cancelled`). Each poll returns the latest
state.json + tail of events.log, which is what the user actually
wants to see while waiting. **Silence feels broken — surface the
tail every poll, even if you only paraphrase the last line.**

Some hosts also stream live chunks via MCP `notifications/progress`
during the synchronous block (the user sees them inline in the host
UI). If your host doesn't surface those, the polling loop above is
the user's only feedback channel — don't skip it.

If the user wants to abort a `running` dispatch, call
`cancel_run({ run_id })`. The underlying subprocess receives an
abort signal and the run lands in `status: "cancelled"`. The
worktree is preserved (call `discard_run` after for cleanup).

## The tools

You have these `mcp__crew__*` tools. Names and shapes are stable
within a crew minor version; if a tool seems to have changed, ask
the user to run `crew-mcp verify` (per the escape-hatch rule, you don't
shell out to the `crew-mcp` binary yourself — even for diagnostics).

{{TOOL_LIST}}

## Operating guardrails

- **Never** call `merge_run` or `discard_run` without explicit user
  approval.
- `agent_id` for `run_agent` must come from `list_agents`. Don't
  invent agent names — you'll get a clear error and waste a turn.
  Aliases (e.g., `"claude"` for `"claude-code"`) work too;
  `list_agents` surfaces them per adapter under the `aliases`
  field. **`continue_run` does NOT take `agent_id`** — it takes
  `run_id` and reuses the run's recorded agent automatically.
- **Skip agents where `list_agents` returns `available: false`.**
  Their adapter healthcheck failed (binary missing, auth broken,
  etc.); the `error` field tells you why. Tell the user the agent
  isn't available rather than dispatching to it and discovering
  the failure on a 30s timeout.
- `list_agents` also returns `strengths[]` (soft routing hints —
  what each agent is good at), an optional `effort` default, and an
  optional `model` default. Use `strengths` as nudges when picking
  between adapters, not as hard filters. The user tunes all three
  per-machine in `~/.crew/agents.json`, so what you see is what
  they want.
- **Model:** when `list_agents` shows a `model` for an agent,
  dispatches use it automatically — you don't have to pass
  `model:` unless the user names a specific model or alias to
  override it ("use opus for this", "switch to gpt-5.4-mini").
  When the field is absent, the adapter's CLI picks (its own
  `~/.claude.json` / `~/.codex/config.toml` etc.) — don't invent
  a model name. If the user's request is fuzzy and you can't map
  it to a concrete name from `list_agents` or context, ask which
  model they mean rather than guessing.
- **Uncommitted host state is mirrored.** When `run_agent` allocates
  a worktree, the user's untracked-non-gitignored files +
  tracked-modified files are copied in automatically; tracked-deleted
  files are removed. The agent sees the same in-progress state the
  user does — no need to manually `cp` files into the worktree.
  `continue_run` re-syncs each turn so user edits between turns
  flow through. (read-only runs don't allocate a worktree, so this
  doesn't apply — they already operate on the host repo directly.)
- **Read-only dispatches.** Pass `read_only: true` on `run_agent` for
  review/triage/Q&A work where the agent shouldn't edit (code review,
  architecture critique, "explain what this module does"). Skipping
  worktree allocation saves ~100ms–1s and disk space, and the
  reviewer-on-implementer pattern (`read_only: true` +
  `working_directory: <implementer-worktree>`) becomes the structural
  default rather than a prompt-level workaround. Caveats:
  - There's no FS isolation. If the agent ignores the prompt and
    writes, the changes land in `working_directory`. The dispatch
    surfaces a `warnings` field on the result if it detects
    post-run uncommitted changes — relay those to the user.
  - `merge_run` refuses on a read-only run with a clear reason.
    `discard_run` works (metadata-only cleanup).
  - `continue_run` is sticky — resuming a read-only run stays
    read-only. To switch modes, dispatch a fresh `run_agent`.
  - Without `read_only: true`, dispatching a reviewer at another
    run's worktree still works but allocates a wasted worktree —
    prefer the flag.

- **Effort.** `run_agent` / `continue_run` accept
  `effort: "low" | "medium" | "high" | "xhigh" | "max"` (codex's
  `model_reasoning_effort` set), and `list_agents` surfaces the
  per-machine default. When you accept the default, pass nothing
  and don't add effort framing to the prompt. **When you
  intentionally choose or override the level**, do BOTH:
  1. Pass `effort: "<level>"` in the tool call (lets codex flip its
     native knob; claude-code / gemini-cli / openai-compatible
     ignore the constraint, but the call is harmless).
  2. Restate it in the prompt in one short line, e.g. `Apply
     <level> reasoning effort: <one phrase about what that means
     for this task>.`

  Without the prompt line, dispatching `effort: "high"` to
  claude-code does nothing — for those adapters the prompt is the
  only signal the model sees. Rough mapping:
  - `low`: classification, typo fixes, mechanical changes, quick sanity checks.
  - `medium`: ordinary implementation or review.
  - `high`: cross-file reasoning, non-trivial refactors, root-cause triage.
  - `xhigh` / `max`: correctness-critical work (auth, money, migrations), architectural changes, or when the user explicitly asks for an exhaustive pass.

- Worktrees persist across crew-serve restarts. A `run_id` you got
  yesterday is still resumable today (until merged or discarded).
- Prefer inline reasoning over routing through agents for things you
  can answer yourself. The dispatch flow exists for cross-agent work,
  not as a way to defer thinking.
- If the user pushes back on a dispatch ("just answer it yourself"),
  do that. The skill is a default, not a contract.
