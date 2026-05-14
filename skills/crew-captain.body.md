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

**Default to inline whenever zero of the four signals applies
cleanly.** Maybe-fits should not dispatch — they should ask. A
30–60s dispatch followed by a discard is worse than a 5-second
clarifying question; dispatching for trivial work defeats the
point of the user staying in their primary CLI.

### Don't dispatch to your own host product

Crew bridges **between** agent products (Claude ↔ Codex ↔ Gemini ↔
local). It's not the right tool for spawning another instance of the
host you're already running in. If you're Claude Code and the user
says "have Claude review this", **use your native subagent
mechanism (the `Agent` / `Task` tool) directly** — don't `run_agent`
to `claude-code`. Symmetric for Codex → Codex, Gemini → Gemini.

The one legitimate exception is **explicit worktree isolation** for
a same-product run ("fork a Claude run in a worktree so I can keep
working on main"). If the user names that, proceed. Otherwise:
native subagent. If unsure, ask. When `list_agents` shows your own
host product, treat it as "available for explicit isolation
requests only" rather than a default routing target.

## The default flow — code → review → iterate → merge

When the user dispatches an implementation:

1. **Dispatch.** Call `run_agent` with the implementer's `agent_id`
   (from `list_agents`) and a precise prompt. Write the prompt
   yourself; the agent sees it verbatim.
2. **Yield while running.** `run_agent` returns immediately with the
   `run_id` and `tail_url`. Confirm the dispatch with the `run_id`
   and tail link, then end your turn so the user can keep chatting.
   On Claude Code, before ending the turn, spawn the watcher overlay:
   `Bash({{CREW_WAIT_COMMAND}} <run_id>, run_in_background: true)`.
   On Codex / Gemini, just end the turn — no watcher. Read the
   terminal payload with `get_run_status` on the watcher's synthetic
   turn (Claude Code) or on the next user turn (Codex / Gemini).
   **Never** call `get_run_status` with `wait_for_terminal_only` or
   a long `wait_for_change_ms` to block the turn open — see the
   Dispatch lifecycle section.
3. **Iterate.** `continue_run` for fix-up turns (same agent, same
   worktree). For a second opinion, `run_agent` to a different
   agent with `read_only: true` + `working_directory` pointed at
   the implementer's worktree — the reviewer reads the changes
   without allocating its own worktree. (Restate "review only, do
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
   safety rule below. When merging, pass `confirmed: true` only after
   that approval.

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

By default the server enforces this boundary too:
`merge_run` requires `{ confirmed: true }` when
`confirmBeforeMerge=true` in the user's crew config. You may pass
`confirmed: true` only after the user gives explicit affirmative
consent in the immediately preceding turn. Never add it
pre-emptively, never infer it from a stale approval, and never pass it
just to get past the gate.

If `merge_run` rejects with
`requires explicit user confirmation`, re-ask the user with a concrete
merge prompt, wait for an affirmative answer, then retry
`merge_run` with `confirmed: true`. Do not retry automatically.

**Always pass a meaningful `commit_title`** (and optionally
`commit_body`) to `merge_run`. The merge commit's subject becomes
permanent git history the user reads later — "Merge crew run
abc123…" is the useless fallback. Compose a conventional-style
subject from the prompt, summary, and diff: short imperative
(≤72 chars) describing what the run accomplished, not that it was
a crew run. The `Crew-Run: <run_id>` trailer is appended
automatically — don't include it manually.

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
dispatch signal already applies and the five items above are clean —
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
return immediately with `run_id` and `tail_url`. There is no
terminal fast path. The default flow is dispatch-and-yield: confirm
the run, give the user the tail link, and end the turn so chat stays
available while the agent works.

**Your job is coordination, not narration.** During a dispatch, keep
your visible output to one dispatch confirmation, one terminal
summary, and one merge/iterate/discard prompt. The user has an
independent progress channel through the tail link.

**Don't block the turn with `get_run_status`.** Setting
`wait_for_terminal_only: true` (or a long `wait_for_change_ms`)
holds the turn open until the run lands — the user can't chat,
can't interrupt, can't redirect. Async-first dispatch exists so
the captain stays available; the watcher overlay (Step 2 below)
is how Claude Code captains surface a terminal result without
blocking. The only legitimate in-turn wait is the explicit
foreground opt-in described further down, and it only applies
when the user said "wait for this" out loud. On Codex / Gemini,
default to a snapshot `get_run_status` at the next user turn —
never a long-poll inside the dispatch turn.

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
side terminal. (`tail_command_url` is available only to full-envelope
legacy structured consumers; it is not the inline-link choice.)
Format:

```
Dispatched as `<run_id>` — [tail in side terminal](<tail_url>). Ended turn; chat freely.
```

That's a single line. Don't relay the rest of the dispatch markdown
(worktree path, status-read hints, etc.) — those are already in the
tool result for the user who wants them.

### Step 2 — background watcher overlay (Claude Code, mandatory)

On Claude Code, immediately after `run_agent` / `continue_run`
returns, spawn `{{CREW_WAIT_COMMAND}} <run_id>` with `Bash` and
`run_in_background: true`, then end your turn. The watcher polls
`state.json` until the run reaches `success | partial | error |
cancelled`, then exits. Claude Code turns that background
completion into a synthetic captain turn.

**Use `{{CREW_WAIT_COMMAND}}` exactly as rendered above** — the
install picks the literal form your `Bash(...)` allowlist accepts
(bare `crew-wait` when it's on PATH, or an absolute path like
`/usr/local/bin/crew-wait` when the install fell back). Either form
is correct in its own install; the wrong form for this install will
miss the allowlist entry, the `Bash` call will be denied, and the
watcher won't spawn. If you have to type it from memory, copy it
from this section rather than guessing.

**Synthetic-turn handling.** When the watcher exits, Claude Code
fires a synthetic turn whose tool-result body includes a single
line of stdout:

```
CREW_WAIT_TERMINAL run_id=<id> agent=<agent> status=<status> worktree=<path>
```

Parse `run_id` from that line and call
`get_run_status({ run_id })` for the rich terminal payload
(summary, `files_changed`, `events_tail`). Surface a tight
synthesis to the user and ask the relevant follow-up
(merge / iterate / discard for implementer runs;
keep / cleanup for read-only).

If the synthetic turn arrives without the `CREW_WAIT_TERMINAL`
line (host stdout-surfacing degrades, watcher killed by signal,
etc.), fall back to discovery via `list_runs`:

```
list_runs({
  status: ["success", "partial", "error", "cancelled"],
  completedAfter: <ISO timestamp of your last terminal surfacing>,
})
```

That returns every newly-terminal run in the current repo,
newest-first. Dedupe against run IDs you already surfaced earlier
in the conversation, then process each remaining one as if its
`CREW_WAIT_TERMINAL` line had arrived normally.

**Spawn failure / non-Claude host.** If spawning the watcher
fails (binary missing, allowlist rejects, host is not Claude
Code), fall back to the portable baseline: end your turn after
the dispatch and check pending runs at the next user turn.

### Foreground `{{CREW_WAIT_COMMAND}}` opt-in (Claude Code only — Codex / Gemini blocked until empirical gates pass)

When the user explicitly says they want to wait in-turn ("wait
for this", "I'll wait"), call `{{CREW_WAIT_COMMAND}} <run_id>`
as a foreground shell command. This blocks chat, but it uses one
inference instead of an N-iteration MCP long-poll loop.

**Hard gate: Claude Code only for now.** Phase 3 empirical tests
#3 (Codex foreground ≥5min) and #4 (Gemini foreground ≥5min) are
documented as deferred in
`docs/status/captain-flow-review-2026-04-29.md`. Until that file
records dated passing evidence for those gates, do NOT use
foreground `{{CREW_WAIT_COMMAND}}` on Codex or Gemini — those
hosts may silently kill long shell commands or behave
inconsistently with ESC. Default to the portable baseline (end
turn, check at next user turn) on Codex/Gemini.

After foreground `{{CREW_WAIT_COMMAND}}` returns, call
`get_run_status({ run_id })` for the rich terminal payload:
summary, `files_changed`, prompts, warnings, and `events_tail`.
The shell output is terminal metadata, not the full result.

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

The inline `[tail in side terminal](<tail_url>)` link in your
dispatch confirmation is the user's main live-progress channel.
Don't duplicate it by rendering events into your reply. Inline
MCP `notifications/progress` only fire while a tool call is in
flight; the chat-available default flow ends the turn, so those
don't apply here.

### Worked shape

```
run_agent(...)              → { run_id: R, tail_url: "crew-tail:///..." }
"Dispatched as `R` — [tail in side terminal](crew-tail:///...). Ended turn; chat freely."
Claude Code only:
  Bash("{{CREW_WAIT_COMMAND}} R", run_in_background: true)
end turn

later — Claude Code synthetic turn from watcher exit:
  tool result contains: "CREW_WAIT_TERMINAL run_id=R agent=... status=success worktree=..."
  get_run_status({ run_id: R })
    → status: "success", summary: "...", files_changed: [...],
      events_tail: [<last N events of full log>]
  "Done. <one-paragraph synthesis informed by summary + events_tail>.
  Merge / iterate / discard?"

OR — later user turn (Codex/Gemini default; or Claude Code if synthetic-turn payload was empty):
  list_runs({ status: ["success","partial","error","cancelled"],
              completedAfter: <last surfaced timestamp> })
    → runs: [{ run_id: R, agent_id, status, summary, ... }]
  get_run_status({ run_id: R }) for the rich payload
  surface as above; dedupe against already-surfaced run IDs.
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
  approval. For `merge_run`, include `confirmed: true` only after the
  user's explicit "yes" in the immediate prior turn.
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
- **Read-only dispatches.** Pass `read_only: true` for review/triage/Q&A
  work. Skips worktree allocation (~100ms–1s saved); the
  reviewer-on-implementer pattern is `read_only: true` +
  `working_directory: <implementer-worktree>`. Caveats:
  - **No FS isolation.** If the agent ignores the prompt and
    writes, edits land in `working_directory`. The dispatch
    surfaces a `warnings` field if it detects post-run uncommitted
    changes — relay those.
  - `merge_run` refuses on read-only with a clear reason;
    `discard_run` works (metadata-only).
  - **Discard reviewer runs once you've consumed their findings.**
    Read-only runs don't auto-clean (only `merge_run` triggers
    cleanup). A stack of N reviewers leaves N stale run-state
    directories under `~/.crew/runs/` until explicit discard.
    Cleanup is cheap (~20KB each) and idempotent.
  - `continue_run` is sticky on read-only; to switch modes,
    dispatch a fresh `run_agent`.
  - Without the flag, dispatching a reviewer at another worktree
    still works but allocates a wasted worktree — prefer the flag.

- **Effort.** `run_agent` / `continue_run` accept the canonical
  `effort: "low" | "medium" | "high" | "xhigh" | "max"` scale. `list_agents` surfaces the per-machine default; accept it by passing nothing. **When you override**, do BOTH: (a) pass
  `effort: "<level>"` (b) restate it in the prompt in one short line.
  Mapping:
  - `low` / `medium`: typo fixes through ordinary implementation or review.
  - `high`: cross-file reasoning, non-trivial refactors, root-cause triage.
  - `xhigh` / `max`: correctness-critical work (auth, money, migrations), architectural changes, or "exhaustive pass" requests.

- Worktrees persist across crew-serve restarts. A `run_id` you got
  yesterday is still resumable today (until merged or discarded).
- Prefer inline reasoning over routing through agents for things you
  can answer yourself. The dispatch flow exists for cross-agent work,
  not as a way to defer thinking.
- If the user pushes back on a dispatch ("just answer it yourself"),
  do that. The skill is a default, not a contract.

## Forwarding peer context

You can pass structured peer context to a worker at dispatch time via
the `peer_messages` parameter on `run_agent` and `continue_run`. Use
it instead of pasting freeform strings into the prompt.

### `peer_messages`: captain → worker context

Both `run_agent` and `continue_run` accept an optional `peer_messages`
array. Each item is `{body, kind, from_label, files, excerpts}`. The
dispatcher prepends a typed block to the worker's prompt.

Use cases:

- Forward run A's output to run B's review prompt.
- Forward synthesized feedback from multiple reviewers back to the
  implementer.
- Provide structured "here's context you'll need" alongside a normal
  prompt.

### Pattern: implement-then-review

1. `run_agent(implementer, "implement X")` → run A. Dispatch and yield
   per the §Dispatch lifecycle default flow.
2. When A reaches terminal (via the watcher overlay on Claude Code, or
   the next user-turn snapshot on Codex/Gemini), read `A.summary` and
   `A.files_changed` via `get_run_status`.
3. `run_agent(reviewer, "review this implementation", read_only: true,
working_directory: <A.worktree_path>, peer_messages: [{body:
A.summary, kind: 'review', from_label: "A (implementer)", files:
A.files_changed}])` → run B. The `read_only` + `working_directory`
   pair lets the reviewer read A's edits without allocating its own
   worktree; the `peer_messages` array forwards A's synthesis as
   typed context.
4. When B reaches terminal, read `B.summary`.
5. If revisions needed: `continue_run(A, peer_messages: [{body:
B.summary, from_label: "B (reviewer)", kind: 'review'}],
prompt: "revise per these findings")`.

Worker findings flow back via the existing `terminal.summary` path.
There is no `send_message` / inbox return path in this plan.

### When NOT to use peer_messages

- Single freeform string of context: just put it in the prompt.
- One-shot forwarding where structure adds noise: prompt is fine.

`peer_messages` is for STRUCTURED forwarding where typed labels,
fenced excerpts, and audit records aid orchestration.

### `kind` is advisory

`note | review | question | answer | status`. Crew-mcp does NOT
branch on `kind`. Use it as a hint to the worker.

### Caps

Default per-item body: 16 KB; per-excerpt: 4 KB; excerpts per item:
8; items per call: 50; aggregate rendered: 64 KB; hard ceiling: 128
KB; composed prompt total: 256 KB.

Errors all use `peer_messages.<code>:` prefix. See plan for full
list. Truncation and drops emit `warnings` on the envelope (non-fatal).
