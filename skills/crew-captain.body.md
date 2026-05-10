<!--
  Canonical skill body. Per-host templates wrap this in the appropriate
  frontmatter (Claude Code skill, Codex prompt, Gemini extension). Single
  source of truth for the orchestration playbook — edit here, re-run
  `crew-mcp install` to propagate.

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

### Don't dispatch to your own host product

Crew exists to bridge **between** agent products (Claude ↔ Codex ↔
Gemini ↔ local). It is not the right tool for spawning another
instance of the host you're already running in. If you're Claude
Code and the user says "have Claude review this", **use your
native subagent mechanism (the `Agent` / `Task` tool) directly** —
do not `run_agent` to `claude-code`. Same applies symmetrically:
Codex → Codex, Gemini → Gemini should go through the host's
own subagent path, not crew.

Why this matters:

- **Quota.** Both calls bill the same subscription / API key. A
  crew dispatch to your own product double-charges the user for
  the same model family.
- **Latency.** Native subagents skip the worktree allocation
  (~30–60s) and the merge/discard ceremony.
- **Context.** Native subagents return their result inline with
  no merge step; crew runs require an explicit merge or discard.

The only legitimate reason to crew-dispatch to your own host is
when the user specifically wants **worktree isolation** for a
same-product run (e.g., "fork a Claude run in a worktree so I
can keep working on main"). If the user names that explicitly,
proceed. Otherwise: native subagent. If you're not sure which
the user wants, ask one short question.

When `list_agents` shows your own host product, treat it as
"available for explicit isolation requests only" rather than a
default routing target.

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
2. **Yield while running.** `run_agent` returns immediately with
   `status: "running"` and empty `files_changed`. Confirm the
   dispatch with the `run_id` and tail link, start the Claude Code
   watcher overlay when available, then end your turn so the user can
   keep chatting. On a later user turn or watcher synthetic turn, read
   the terminal payload with `get_run_status`.
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

**Always pass a meaningful `commit_title`** (and optionally
`commit_body`) to `merge_run`. The merge commit's subject becomes
permanent git history the user reads later — "Merge crew run
abc123…" is the fallback for when you forgot, and it's useless
when scrolling `git log`. You have the prompt, the agent's
summary, and the diff context; compose a conventional-style
subject from them: short imperative (≤72 chars), describing what
the run accomplished, not that it was a crew run.

> Good: `commit_title: "fix(parser): handle empty-line input
correctly"` `commit_body: "Adds the empty-line guard to
parseLine() with a regression test."`
>
> Bad: `commit_title: "Codex did the parser fix"`
>
> Worse: omitting commit_title and letting it fall back to
> `Merge crew run <id>`.

The `Crew-Run: <run_id>` trailer is appended automatically — don't
include it manually.

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
5. **The user named the same product as the host CLI without an
   explicit isolation reason.** Don't dispatch — see _"Don't
   dispatch to your own host product"_ above. Use the host's
   native subagent mechanism instead, or ask whether they want
   worktree isolation (the only reason to route same-product
   work through crew).

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

## Dispatch lifecycle — chat stays available

`run_agent` and `continue_run` are **async-first**: they always
return `{ status: "running", run_id }` immediately. There is no
terminal fast path. The default flow is dispatch-and-yield: confirm
the run, give the user the tail link, and end the turn so chat stays
available while the agent works.

**Your job is coordination, not narration.** During a dispatch, keep
your visible output to one dispatch confirmation, one terminal
summary, and one merge/iterate/discard prompt. The user has an
independent progress channel through the tail link.

### Step 1 dispatch confirmation

Confirm the run_id back to the user **once**, briefly, and **include
a clickable tail link inline** so the user can open a side terminal
without expanding the (collapsed-by-default) tool result. The
`run_agent` envelope returns `tail_url` — a custom `crew-tail://`
URL that opens Terminal.app running `tail -F` via the optional macOS
handler (installed with `crew-mcp install-tail-handler`). Paste it
verbatim into a markdown link.

Always use `tail_url`, not `tail_command_url`: the `file://` variant
gets intercepted by Claude Code and opens in the editor instead of a
side terminal. (`tail_command_url` is preserved on the envelope for
back-compat structured consumers; it is not the inline-link choice.)
Format:

```
Dispatched as `<run_id>` — [tail in side terminal](<tail_url>). Ended turn; chat freely.
```

That's a single line. Don't relay the rest of the dispatch markdown
(worktree path, status-read hints, etc.) — those are already in the
tool result for the user who wants them.

### Background watcher overlay (Claude Code only)

On Claude Code, immediately after `run_agent` / `continue_run`
returns, spawn `crew-wait <run_id>` with `Bash` and
`run_in_background: true`, then end your turn. `crew-wait` ships in
the Phase 3 overlay; it watches `state.json` until the run reaches
`success | partial | error | cancelled`, then exits. Claude Code
turns that background completion into a synthetic captain turn.

If spawning the watcher fails because the binary is missing, the
permission allowlist rejects it, or the host is not Claude Code, fall
back to the portable baseline: end your turn after the dispatch and
check pending runs at the next user turn.

### Foreground `crew-wait` opt-in (any host, gated on Phase 3 empirical test)

When the user explicitly says they want to wait in-turn ("wait for
this", "I'll wait"), or when Codex/Gemini in-turn waiting is
preferable for the task, call `crew-wait <run_id>` as a foreground
shell command. This blocks chat, but it uses one inference instead
of an N-iteration MCP long-poll loop. This any-host behavior is
allowed only after the Phase 3 foreground-wait empirical tests pass;
otherwise treat it as Claude-only.

After foreground `crew-wait` returns, call `get_run_status({ run_id })`
for the rich terminal payload: summary, `files_changed`, prompts,
warnings, and `events_tail`. The shell output is terminal metadata,
not the full result.

### Checking pending runs at turn start

At the start of every captain turn, before answering the user's new
message, check pending run state:

1. For run IDs you remember from conversation context, call
   `get_run_status({ run_id })`. If a run is still `running`, mention
   it only when relevant; don't block the turn.
2. Use `list_runs` as recovery after `/clear`, context loss, or when
   the user references a run you don't recognize. It is implicitly
   scoped to the current repo; use terminal status filters when you
   need newly finished runs.

When a run reaches `success | partial | error | cancelled`, synthesize
from `summary`, `files_changed`, and `events_tail`. Do not dump the
tail verbatim. Ask about merge / iterate / discard for implementer
runs, or cleanup / keep-around for read-only runs.

### Multiple terminations don't batch

Claude Code watcher exits are not batched. If three runs finish close
together, expect three separate synthetic turns. Handle each turn
tightly: identify the run, summarize the terminal result, and ask the
one relevant follow-up. Don't try to coalesce completions across
synthetic turns; they don't queue together.

### How users follow progress (not your problem)

Two side channels carry live progress without burning your context:

- **The inline tail link in your dispatch confirmation** — the
  `[tail in side terminal](<tail_url>)` markdown link you emit
  opens a side terminal on macOS via the `crew-tail://`
  handler. This is the user's main progress channel; surfacing it
  inline is the whole point of including the link in your reply
  rather than relying on the tool-result panel. If the handler
  isn't installed, the click does nothing useful — but the same is
  true of the `file://` fallback (Claude Code intercepts it into
  the editor), so `tail_url` is still the right choice; the user
  can manually run the `tail -F` command from the tool-result panel
  in that case.
- `tail.command` / `events.log` is the only default live-progress
  UX. Inline MCP `notifications/progress` chunks only exist while a
  tool call is in flight; the chat-available default flow ends the
  tool turn, so those inline notifications don't fire.

Both happen without you. Don't duplicate them by rendering events
into your reply.

### Worked shape

```
run_agent(...)              → { status: "running", run_id: R,
                                tail_url: "crew-tail:///..." }
"Dispatched as `R` — [tail in side terminal](crew-tail:///...). Ended turn; chat freely."
Claude Code only:
  Bash("crew-wait R", run_in_background: true)
end turn

later user turn or watcher synthetic turn:
get_run_status({ run_id: R })
  → status: "success", summary: "...", files_changed: [...],
    events_tail: [<last N events of full log>]
"Done. <one-paragraph synthesis informed by summary + events_tail>.
Merge / iterate / discard?"
```

The key is the turn break: after dispatch, the user can type
anything while the worker runs. Terminal surfacing happens on a
later user turn or on Claude Code's watcher-triggered synthetic turn.

### Cancellation

`cancel_run({ run_id })` works any time while a dispatch is in
flight. The run will land as `cancelled`; Claude Code's background
watcher detects it like any other terminal status, and other hosts
surface it on the next turn-start `get_run_status` / `list_runs`
check. Surface a short note ("Cancelled.") and the partial summary if
any.

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
  - **Discard reviewer runs once you've consumed their findings.**
    Read-only runs do **not** auto-clean — only implementer runs
    do (via the `merge_run` cleanup path, which doesn't apply
    here). A multi-branch stack with N reviewers leaves N stale
    run-state directories under `~/.crew/runs/` until the
    captain explicitly discards. Cleanup is cheap (~20KB each,
    no worktree to remove) and idempotent.
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
