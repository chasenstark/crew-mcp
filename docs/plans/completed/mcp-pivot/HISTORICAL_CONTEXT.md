# Crew v0.1 — Historical Context

> **Status:** Historical. v0.1 was retired by the v0.2 MCP-server
> pivot; this doc is preserved as the retrospective that informed
> that decision. The v0.1 architecture docs themselves live under
> `docs/architecture/v0.1-archive/`.

> Retrospective on the original Terminal-UI version of crew, what
> worked, what didn't, and what the v0.1 → v2 inversion taught us.
> See [PRODUCT_VISION.md](./PRODUCT_VISION.md) for v2; see the
> `v0.1-tui` git tag for the frozen v0.1 codebase.

---

## What v0.1 Was

A standalone CLI tool, `crew`, that opened a Terminal UI (built with
Ink/React for terminals). Inside that UI, a "captain" LLM had a
conversation with the user. The captain was spawned as a subprocess
of crew via `claude -p` or `codex exec` with subscription auth — no
API keys. The captain had access to an 8-tool MCP-shaped surface:

- `run_agent` — dispatch a bounded task to a named subagent
- `list_agents` — discover available agents
- `ask_user` — pause and prompt the user
- `message_user` — narrate without ending the turn
- `plan_tasks` — structured decomposition (optional wrapper)
- `analyze_output` — structured output assessment (optional wrapper)
- `compress_context` — summarize older context (optional wrapper)
- `finish` — terminate the captain's turn

Each `run_agent` call spawned the worker subagent (Claude Code, Codex,
Gemini, or any CLI) in its own per-run git worktree at
`.crew/runs/<runId>/worktree/`. The captain's session was durable —
messages persisted across crew restarts, and provider-session refs
let the captain CLI resume natively when the environment hadn't
drifted.

Five milestones (M0 through M5) shipped over ~3 weeks of solo
development. The last milestone (M5) added a preset system letting
users switch the captain's behavior template mid-conversation
(`default`, `thorough-review`, `read-only`).

---

## Why It Was Built That Way

The original product-vision document
(`docs/plans/v0.1-archive/product-vision.md`) framed it like this:

- "The right interface for orchestrating agents is a conversation."
- "The right architecture is an abstraction layer."
- "Provider-agnostic everywhere."
- "Zero API keys."

Those principles are still right. The mistake was in the
*implementation* of "conversation": v0.1 implemented it by building
its own conversational UI with its own captain LLM, rather than
recognizing that the user already had a perfectly good conversational
UI in the host CLIs they were already using.

---

## What Worked

### The captain prompt iteration

The system prompt for the captain went through ~20 iterations across
M3, M4, and M5. The final version embedded:

- A clear dispatch-vs-inline heuristic
- "Run agent is non-blocking" semantics
- Explicit "finish is terminal" rules
- Preset hint injection
- Agent inventory rendered into the system prompt

This prompt is the **single most valuable artifact** v0.1 produced.
It transfers directly to v2 as the body of the captain skill. ~80%
of the content survives unchanged.

### Worktree-per-run isolation

`.crew/runs/<runId>/worktree/` per dispatch was the right call from
day one. It let multiple dispatches run in parallel, kept the user's
HEAD clean, and gave a natural unit for "abandon this attempt." The
implementation in `src/git/` survives v2 unchanged.

### The 8-tool to 6-tool migration insight

By M5 the captain mostly used 4 of the 8 tools (`run_agent`,
`list_agents`, `ask_user`, `finish`). The optional helpers
(`plan_tasks`, `analyze_output`, `compress_context`) were rarely
called — the captain reasoned inline more often than not. v2's 6-tool
surface (which drops 5 of v0.1's tools and adds 3 lifecycle tools)
is informed directly by this observation.

### MCP wiring portability

`src/captain/mcp-registration.ts` was built to project the 8-tool
catalog into Claude / Codex / Gemini's per-CLI MCP shapes. The
discovery that "one source catalog, three pure-function converters"
was the right design held up across M3, M4, and M5. The same
abstraction is what makes v2's `crew install` cheap: the same
converters now write into the user's host config files at install
time instead of building per-invocation argv.

### Adapter abstraction

`src/adapters/{claude-code,codex,gemini-cli,openai-compatible,generic}.ts`
each implementing a common `AgentAdapter` interface (`execute`,
`executeWithTools`, `executeWithSchema`, `healthCheck`) survived
every refactor and survives v2 unchanged. The investment in adapter
quality paid off both in v0.1 and into v2.

### Captain-portability research

`docs/architecture/captain-portability.md` captured a non-obvious
finding: every captain CLI (Claude / Codex / Gemini) handles MCP
registration, native resume, and tool-schema invalidation
differently, and a small set of pure converters could project a
single catalog into all of them. This research transfers directly
to v2: in the inverted model, the same converters write
install-time host configs.

### Milestone discipline

The M0–M5 cadence — execution plans + exit smoke logs + release
notes + status reviews — was over-formal for solo development. But
the rhythm of "ship a milestone cleanly before starting the next"
was right. v2 keeps the structure with lighter ceremony.

---

## What Didn't Work

### The Terminal UI

Ink/React for terminals was the wrong investment. Reasons:

1. **The host CLIs already had better UIs.** Claude Code's terminal
   UI, Codex's, Cursor's — all are better than what we could build
   in Ink. We were rebuilding a worse version of what users already
   had.

2. **Discoverability was bad.** A user had to type `crew run` to
   even start the conversation. They had to learn a new tool. They
   had to leave the CLI they were already using.

3. **Conversational state was duplicated.** Both the captain (a
   process inside crew) and the user (in the TUI) maintained
   conversational state. The captain's session was durable across
   restarts; the user's mental state of "what's going on" was not.
   A second LLM in the loop is a second source of drift.

4. **Maintenance overhead.** ~30% of v0.1's LoC was UI code
   (`src/cli/ui/` plus the runtime that drove it). All of it was
   undifferentiated terminal-UI plumbing — testing keystrokes,
   handling Ink lifecycle, managing focus. None of it was the
   actual product value.

### A second captain LLM

Running our own captain LLM made sense in the abstract — it gave us
a control layer for orchestration. In practice it was a redundant
inference call. The host CLI's LLM (which the user was eventually
going to talk to anyway, to ask "did that work?") could have done
the orchestration directly.

The captain's tool surface and prompt were genuinely useful. The
captain *as a process* was not.

### Presets-as-runtime

M5 introduced a preset system: named bundles of system-prompt nudges
(`default`, `thorough-review`, `read-only`) switchable mid-conversation
via `/preset`. This was over-engineered:

- The 3 shipping presets were thin enough that they could have been
  inline branches in one prompt.
- The `/preset` slash command was a UI affordance for a problem
  almost nobody had (mid-conversation behavior switching).
- The preset-state-as-conversation-state added a SessionSnapshot
  schema bump (v1 → v2) and persistence logic.

In v2, the entire concept retires. The captain skill IS the preset;
if the user wants different behavior, they install a different skill
(or edit the body in `~/.claude/skills/crew/`).

### `compress_context` / `analyze_output` / `plan_tasks`

These were the "optional helpers" — wrapper tools the captain could
call when a task warranted structured intermediate output. By M5 they
were rarely used. The captain preferred inline reasoning, and when
it did need to compress, it could just say so in its response and
the host CLI's own context management took over.

In v2 these are deleted. The host CLI handles its own context
management; planning is the user's job (or an inline reasoning step);
analysis is what the captain skill teaches.

### Profiles + scope management

`crew config profile`, `crew config scope project|global`, named
profile YAMLs at `.crew/profiles/<profile>/workflow.yaml` — this
was a feature in search of a use case. Solo devs don't need named
profiles; they need one config that works.

In v2, config collapses to `~/.crew/agents.yaml`. The host CLIs
have their own profile/scope mechanisms; we don't compete.

### Interactive config wizard

`crew config` opened an interactive Ink wizard for editing the
workflow YAML. ~600 lines of UI code for a problem that
`vim ~/.crew/agents.yaml` solves better. Retired in v2.

---

## What Triggered The Pivot

A specific question in conversation: "I'm wondering if there's a way
to preserve the captain training, and when we invoke captain, the
LLM is passed that prompt. Maybe this is a combination thing where
it's a skill and an MCP server."

That question made it obvious: the captain is *content*, not a
*process*. The valuable artifact (the captain prompt) is portable.
The expensive artifact (the captain process) is replaceable — in
fact, the host CLI replaces it for free.

Once you see "captain as skill," everything follows:

- The TUI is unnecessary (host CLI is the UI)
- The captain LLM is unnecessary (host CLI is the captain)
- The persistent session is unnecessary (host CLI owns sessions)
- The presets are unnecessary (the skill is the preset)
- The `/preset` slash command is unnecessary (host CLIs have their own)
- The interactive config wizard is unnecessary (host CLIs have their own)

The pivot's elegance is that **almost everything load-bearing in
v0.1 — the captain prompt, the tool dispatcher, the worktree
isolation, the adapter layer, the MCP wiring converters — survives
into v2 unchanged or near-unchanged.** What gets deleted is
exclusively the stuff that competed with the host CLI for the user's
attention.

---

## Engineering Artifacts

### Surviving v2 unchanged or near-unchanged

- `src/adapters/*` — every adapter
- `src/git/*` — worktree management
- `src/captain/action-server.ts` — the MCP-shaped tool registry
- `src/captain/tools/catalog.ts` — single-source-of-truth catalog
- `src/captain/tools/{run-agent,list-agents}.ts` — tool definitions
- `src/captain/tool-dispatcher.ts` — non-blocking dispatch
- `src/captain/mcp-registration.ts` — converters (refactored from
  per-invocation to install-time, but the converter logic itself is
  unchanged)
- `src/state/runs/*` — per-run state
- `src/utils/*` — JSON parsing, validation, logging
- The captain system prompt content (becomes the skill body)

### Retiring in v2

- `src/cli/ui/*` — all of the Ink TUI
- `src/captain/judgment-runner.ts` — the captain's session loop
- `src/captain/session.ts`, `session-loop.ts`, `session-store.ts` —
  durable session machinery
- `src/captain/prompts/captain-system.ts` — the prompt as code
  (preserved as content in the skill markdown file)
- `src/captain/tools/{ask-user,message-user,finish,compress-context,
  analyze-output,plan-tasks}.ts` — retired tools
- The preset system (`docs/architecture/presets.md`,
  `defaults/presets/`, `src/workflow/presets.ts`,
  `src/cli/commands/preset.ts`)
- The interactive config wizard (`src/cli/commands/config.ts` and
  associated UI)
- Profile management (`src/cli/commands/config-profile.ts`)
- `state/session*` — captain-session persistence

---

## Lessons Preserved Into v2

1. **The captain prompt is the product.** Everything else is plumbing.
   v2 makes this explicit by shipping the prompt as a first-class
   skill artifact.

2. **Worktree-per-run isolation is non-negotiable.** v2 retains it;
   in fact, exposes it more directly via `merge_run` / `discard_run`
   lifecycle tools.

3. **Tool surface stability beats tool surface size.** v0.1's 8 tools
   were 50% rarely used. v2 ships 6 (3 of v0.1's, plus 3 new
   lifecycle tools), with no optional helpers.

4. **One source catalog, three pure converters.** The MCP wiring
   pattern from v0.1 survives. v2 reuses the same converters at
   install time.

5. **Subscription auth is a real product constraint, not a transient
   one.** v0.1 made subscription auth load-bearing; v2 continues
   this. The TOS gray-zone risk did not materialize during v0.1's
   lifetime but remains a watch item.

6. **Don't compete with the host CLI.** v0.1 competed (TUI, slash
   commands, config wizard, profiles). v2 augments (skill, MCP
   verbs, install command). This is the single biggest lesson.

7. **Milestone discipline is real engineering.** v0.1's M0–M5
   structure was over-formal for solo development, but the rhythm
   of "ship a milestone cleanly before starting the next" was right.
   v2 keeps the structure with lighter ceremony.

8. **The unused tool is the wrong tool.** When `plan_tasks`,
   `analyze_output`, and `compress_context` were rarely called, the
   right read was "delete them," not "tune the prompt to use them
   more." v2 acts on this.

9. **Eval data is the missing portfolio artifact.** v0.1 had no A/B
   data on whether the captain prompt actually helped. v2 makes the
   eval harness an explicit M4 deliverable. This is the single biggest
   gap from a portfolio lens that the v2 plan closes.

---

## What v0.1 Is Now

The repo is tagged `v0.1-tui` and frozen. The README has a header
linking to v2. It is not under active development. It exists as:

1. A portfolio artifact showing the original thesis and how it was
   shipped to working code.
2. A reference for v2 — the cherry-pick source for surviving code.
3. A teaching artifact — the field report on what didn't work
   (this document) is itself the senior-thinking signal.

The git history is more interesting than the running product. The
shape of the milestone exits, the vision-alignment plans, the
review-2 critique cycles — these show how the project actually
evolved, including the moments where the architecture changed
materially. That's the part worth pointing reviewers at.

---

## How To Read v0.1's Code If You're Coming From v2

If you've read [PRODUCT_VISION.md](./PRODUCT_VISION.md) and want to
understand what came before, the load-bearing v0.1 files are:

- `src/captain/prompts/captain-system.ts` — the original captain
  prompt (the source material for v2's skill body)
- `src/captain/judgment-runner.ts` + `session-loop.ts` — the
  captain's session loop (gone in v2; host CLI replaces it)
- `src/captain/tools/catalog.ts` — the 8-tool catalog (v2 ships 6)
- `src/captain/mcp-registration.ts` — per-CLI MCP wiring (v2 reuses
  for install)
- `src/captain/tool-dispatcher.ts` — non-blocking dispatch (survives)
- `src/git/worktree-manager.ts` — worktree isolation (survives)

The `docs/plans/completed/redesign/` directory has the full M0–M5
execution-plan history. `docs/plans/completed/redesign/m5-execution-plan.md`
is the most recent and shows the architecture at the moment v0.1
froze.

`docs/architecture/captain-portability.md` is the most senior-feeling
artifact in the repo — it documents the empirical research into
how each captain CLI handles MCP registration and resume
differently. Worth reading even if you're never going to touch v0.1
code.
