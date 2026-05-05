# Crew — architectural guide

This document is the entry point for understanding how `crew-mcp` works.
It covers the mental model, the runtime flow, the data shapes, and the
codebase layout. Subsequent docs in this directory go deeper on specific
concerns (`tools.md`, `adapters.md`, `presets.md`, `runners.md`,
`session.md`, `captain-portability.md`, `config-registry.md`).

Read this top-to-bottom on a first encounter; later, jump to the section
that matches what you're changing.

---

## What crew is

Crew is a **portable multi-agent orchestration layer** that turns any
modern AI coding CLI (Claude Code, Codex, Gemini CLI) into a "captain"
that can dispatch sub-tasks to *other* coding agents — and then merge
the results back into the host repo when the user approves.

It ships as one binary (`crew-mcp`) that exposes itself as an **MCP
server** (`crew-mcp serve`) and provides an installer (`crew-mcp
install`) that wires the server + a portable orchestration skill into
each host CLI's config.

The user stays in their primary CLI; crew gives that CLI six verbs for
delegating work to other agents in worktree-isolated runs.

---

## Mental model

```
                     ┌────────────────────────────┐
                     │   user, in their CLI       │
                     │ "have codex review this"   │
                     └──────────────┬─────────────┘
                                    │
                                    ▼
                     ┌────────────────────────────┐
                     │  HOST CLI  (the captain)   │
                     │  Claude Code / Codex /     │
                     │  Gemini CLI                │
                     │                            │
                     │  Reads `crew` skill;       │
                     │  decides inline vs         │
                     │  dispatch; calls           │
                     │  `mcp__crew__*` tools      │
                     └──────────────┬─────────────┘
                                    │  MCP (stdio)
                                    ▼
                     ┌────────────────────────────┐
                     │ crew-mcp serve (this code) │
                     │                            │
                     │  - tool registry           │
                     │  - dispatcher (in-flight)  │
                     │  - worktree manager        │
                     │  - run-state store         │
                     │  - agent-prefs reader      │
                     └──────────────┬─────────────┘
                                    │  spawns
                                    ▼
                     ┌────────────────────────────┐
                     │ SUBAGENT  (the worker)     │
                     │ codex / claude-code /      │
                     │ gemini-cli / generic /     │
                     │ openai-compatible          │
                     │                            │
                     │ Runs in an isolated git    │
                     │ worktree; output streamed  │
                     │ back as MCP progress       │
                     │ notifications.             │
                     └────────────────────────────┘
```

Three roles, three layers:

- **User**: gives the original ask.
- **Captain (host CLI)**: decides whether to answer inline or dispatch;
  writes the prompt for the subagent; surfaces results; asks before
  merging.
- **Subagent**: receives a bounded task in a worktree; produces a diff
  + a summary. Has no awareness of the wider conversation — receives
  exactly what the captain wrote.

Crew owns the **glue between captain and subagent**: the MCP tool
surface, the worktree allocator, the run-state store, the per-machine
agent preferences. It deliberately does NOT own:

- The captain's reasoning (that's the host CLI's job, guided by the
  skill body).
- The subagent's reasoning (that's the subagent CLI's job).
- Any UI (host CLIs render their own).

---

## Why MCP?

[MCP (Model Context Protocol)](https://modelcontextprotocol.io) is the
standard way for an AI CLI to expose tools to a model. By implementing
crew as an MCP server, we get:

- **Universal compatibility**: any MCP-compliant host (Claude Code,
  Codex, Gemini CLI, future ones) can use crew without code changes.
- **No fork/maintain a CLI**: we don't have to be a captain ourselves.
- **Process isolation**: `crew-mcp serve` runs as a separate stdio
  subprocess of the host. The host's process boundary cleanly separates
  captain reasoning from crew's tool implementation.
- **Streaming**: MCP supports `notifications/progress`, which we use
  to stream subagent output back to the user in real time.

The trade-off: the captain's behavior comes from the **skill body** we
install (`skills/crew-captain.body.md`), not from code. That's a feature
— it means a determined user can edit the skill — but it means we can't
*enforce* anything captain-side. We can only nudge.

---

## The seven tools

Registered in `src/cli/commands/serve.ts`; described in `tools.md`.

| Tool | Returns | Purpose |
|------|---------|---------|
| `list_agents` | `[{name, strengths[], effort?, model?, available, …}]` | Inventory + soft routing hints |
| `run_agent` | `{run_id, worktree_path, status, summary, files_changed}` | Dispatch a fresh run in a new worktree |
| `continue_run` | same | Add instructions to an existing worktree run |
| `merge_run` | `{commit_sha?, conflicts?}` | Merge worktree → host's HEAD (safety boundary) |
| `discard_run` | `{ok: true}` | Delete worktree without merging |
| `get_run_status` | `{status, prompts, log_tail, …}` | Poll a long-running dispatch |
| `cancel_run` | `{ok, reason?}` | Abort an in-flight run; preserves worktree |

Six of seven are dispatched into the run lifecycle. `list_agents` is the
only purely synchronous one (and it consults health of every adapter
concurrently before returning).

---

## Dispatch lifecycle, end-to-end

This is the load-bearing flow. Walk through it once and the rest of the
codebase makes sense.

```
USER:   "Have codex review my parser refactor"
         │
         ▼
HOST CLI (captain):
   1. reads `crew` skill body → decides this is a dispatch
   2. calls mcp__crew__list_agents → finds codex available
   3. writes a prompt for codex (review only, don't edit, etc.)
   4. calls mcp__crew__run_agent({agent_id: "codex", prompt: "..."})
         │
         ▼  (MCP request, stdio)
CREW SERVE:
   serve.ts: run_agent handler
     │
     ├─ planRunAgent() (orchestrator/tools/run-agent.ts)
     │     ├─ resolves adapter from registry
     │     ├─ resolves effective model + effort (per-call >
     │     │      agents.json > adapter default)
     │     ├─ allocates worktree:
     │     │      ~/.crew/runs/<runId>/worktree/  (a git worktree)
     │     └─ returns a dispatch plan
     │
     ├─ runStateStore.create() writes initial state.json
     │
     ├─ runDispatchAndRespond:
     │     ├─ installs lifecycle listeners on the dispatcher
     │     ├─ dispatcher.start(task)  ← spawns the subagent
     │     ├─ races: terminal-event-promise vs 60s timeout
     │     │
     │     │   subagent runs in its worktree:
     │     │     codex execute() → spawns `codex exec ...`
     │     │     stdout streams chunks → onOutput(chunk)
     │     │       ├─ append to events.log (run-state)
     │     │       └─ send notifications/progress to host CLI
     │     │              (host renders inline as the user watches)
     │     │
     │     │   adapter.execute() resolves with TaskResult
     │     │   dispatcher emits 'run:complete'
     │     │   lifecycle listener writes terminal state.json
     │     │
     │     ├─ terminal-event-promise resolves with the result
     │     └─ returns RunEnvelope { status, summary, files_changed }
         │
         ▼  (MCP response)
HOST CLI (captain):
   5. reads result; decides if work is good
   6. summarizes for user; asks: merge / iterate / discard?
         │
         ▼
USER:   "Looks good, merge it"
         │
         ▼
HOST CLI:  mcp__crew__merge_run({run_id, target_branch?: "main"})
         │
         ▼
CREW SERVE:
   merge_run handler:
     ├─ worktreeManager.mergeRunWorktree() runs `git merge`
     ├─ on conflict: returns conflicts; host repo is now mid-merge
     │   (captain MUST surface this; user resolves)
     └─ on success: returns commit_sha; runStateStore.markMerged
```

Two key races:

- **60s block vs terminal**: if the subagent finishes within 60s, the
  captain receives the full result in a single tool-call return. If it
  takes longer, `run_agent` returns `status: "running"` and the captain
  polls `get_run_status` until terminal. The block was 5min through
  2026-05-04; field testing against codex (which doesn't surface MCP
  `notifications/progress`) turned long blocks into UX dead-zones, so
  the default was shortened. Hosts that DO surface progress (Claude
  Code) still get live streaming inside the shorter block; the only
  trade-off is that medium-length runs (60s–5min) now return
  `running` and force a poll.

- **Terminal vs cancel**: the dispatcher tracks an `AbortController`
  per in-flight run. `cancel_run` finds the run by `run_id` and aborts;
  the same lifecycle listener that handles `run:complete` handles
  `run:cancelled` with `status: "cancelled"`.

---

## Adapter pattern

Two distinct adapter interfaces, one for each side of the boundary:

### Host adapters (`src/install/hosts/`)

For `crew-mcp install` only — they know how to wire the MCP block + skill
file into each host CLI's config:

```
HostAdapter
├── id: "claude-code" | "codex" | "gemini"
├── displayName: string
├── configPath(home): string         (~/.claude.json, ~/.codex/config.toml, …)
├── skillPath(home): string          (where to drop the skill body)
├── mergeMcpBlock(existing, …)       (config-format-aware merge)
├── detectInstalled() / detectRunning()
└── writeAutoApproval / clearAutoApproval  (per-host pre-approval mechanism)
```

Per-host implementations live in `src/install/hosts/{claude-code,codex,gemini}.ts`
and are registered in `src/install/hosts/index.ts`.

### Agent adapters (`src/adapters/`)

For dispatch — they spawn the subagent CLI and return a `TaskResult`:

```
AgentAdapter
├── name: "claude-code" | "codex" | "gemini-cli" | <user-defined>
├── aliases?: ["claude", …]
├── strengths: AgentStrength[]       (defaults; user overrides via agents.json)
├── defaultEffort?: EffortLevel      (omitted when no native knob)
├── supportsJsonSchema: boolean
├── execute(task) → Promise<TaskResult>
├── healthCheck() → { available, authenticated, version, error? }
└── (optional) executeWithTools, executeWithSchema, getCliVersionTag, recognizesModel
```

First-party implementations: `claude-code.ts`, `codex.ts`,
`gemini-cli.ts`. Two adapters for arbitrary tools:
- `generic.ts` — wraps any CLI behind `command` + `argsTemplate`.
- `openai-compatible.ts` — talks to any OpenAI-compatible HTTP endpoint.

The dichotomy matters: a host adapter answers "where do I install?", an
agent adapter answers "how do I dispatch?". They don't share an
interface — they don't need to.

---

## Run state + worktrees

Every dispatch gets a fresh **git worktree** under `~/.crew/runs/`:

```
~/.crew/
├── install.json              ← which hosts crew is installed into
├── agents.json               ← per-machine agent preferences
└── runs/
    └── <runId>/
        ├── state.json        ← persisted run metadata
        ├── events.log        ← per-line streaming output buffer
        └── worktree/         ← the git worktree (a real on-disk checkout)
            ├── .git          ← (gitfile pointing back at the host repo)
            ├── README.md
            └── … (the rest of the host repo's HEAD)
```

The worktree is a real `git worktree add ~/.crew/runs/<id>/worktree`.
That means:

- The subagent operates on a real on-disk checkout — no virtual FS,
  no in-memory tricks. Whatever tools it uses (`grep`, `cat`, language
  servers, build tools) just work.
- The host repo is **not modified** until the captain calls `merge_run`.
  A botched dispatch costs nothing — the user discards the worktree
  and the host repo is untouched.
- Worktrees persist across `crew-mcp serve` restarts. A `run_id` from
  yesterday is still resumable today (until merged or discarded).

`state.json` schema (v1) carries: `runId`, `agentId`, `worktreePath`,
`status`, `prompts[]` (turns + summaries), `filesChanged`, optional
`readOnly`, optional `mergeStatus`. Defined in
`src/orchestrator/run-state.ts`. No migrations until v3 — additive
changes only.

`events.log` is per-line streaming output appended as the adapter's
`onOutput` callback fires. Used by `get_run_status` to surface a
`log_tail` for the captain to summarize during long polls.

### Read-only runs (skip the worktree)

`run_agent` accepts `read_only: true` for review/triage/Q&A
dispatches that aren't expected to write. The branch:

- **No allocation.** `worktreeManager.createRunWorktree(runId)` is
  not called. The agent's CWD is `working_directory` (caller's
  choice — typically another run's worktree for the
  reviewer-on-implementer pattern) or the host repo root.
- **`worktreePath` is informational.** Stored in `state.json` for
  consistency, but it's not a worktree we own.
- **No FS isolation.** If the agent ignores the prompt contract and
  edits, the changes land in `working_directory`. The dispatch runs
  a best-effort `git status --porcelain` after the agent terminates;
  any uncommitted changes surface as a `warnings` field on the
  result.
- **`merge_run` refuses** — there's no branch to merge. The handler
  returns a clear error ("dispatched read-only; nothing to merge").
- **`discard_run` is metadata-only.** The state record is marked
  `discarded`; no FS cleanup happens because there's no worktree to
  remove.
- **Sticky on `continue_run`.** The follow-up turn reads
  `state.readOnly` and threads it back into the dispatch task so the
  same contract applies. To switch modes, dispatch a fresh
  `run_agent` instead of continuing.

Trade-off: read-only runs trade structural isolation for cheaper
dispatches. The 5 worktrees a fan-out review used to allocate
(implementer + 4 reviewers) collapse to 1 (just the implementer's),
and the reviewers point at it directly. The risk — a misbehaving
agent dirties the host repo — is the same risk model the user
already accepts when running an agent inline.

---

## Per-machine configuration

### `~/.crew/agents.json`

User-tunable preferences per agent. Read every dispatch (cheap) so an
edit between dispatches takes effect without restarting `crew-mcp serve`.

```json
{
  "_readme": ["docstring lives here"],
  "claude-code": {
    "strengths": ["careful-reasoning", "code-review", "documentation"],
    "model": "claude-opus-4-7"
  },
  "codex": {
    "strengths": ["fast-iteration", "autonomous-loops"],
    "effort": "high",
    "model": "gpt-5.5-codex"
  }
}
```

Three fields per agent, all optional:

- **`strengths`**: free-form kebab-case routing hints. Surfaced via
  `list_agents` so the captain can use them when picking between
  adapters. Adapters ship sensible defaults; users override per machine.
- **`effort`**: `"low" | "medium" | "high" | "xhigh" | "max"`. Mirrors
  codex's `model_reasoning_effort` set. Codex translates natively;
  other adapters log + ignore (the captain restates effort in the
  prompt for portability).
- **`model`**: free-form string passed to the adapter's `--model` flag.
  When absent, the adapter's CLI picks (its own `~/.claude.json` /
  `~/.codex/config.toml` etc.) — we deliberately don't override the
  user's per-CLI config when no per-machine preference is set.

Resolution precedence per dispatch:

```
per-call (run_agent({model, effort}))   ← captain's deliberate override
        │
        ▼  (if absent)
agents.json override
        │
        ▼  (if absent)
adapter default (e.g. codex defaultEffort = 'medium')
        │
        ▼  (if absent)
undefined  →  adapter doesn't pass --model / -c flag,
              CLI's own default wins
```

`crew-mcp install` seeds the file with adapter defaults on first install
(`seedAgentPrefsFile`); `crew agents edit` opens it in `$EDITOR`.

### `~/.crew/install.json`

Tracks which host CLIs `crew-mcp install` has wired into. Schema in
`src/install/install-manifest.ts`. Used by `crew-mcp verify` (parity
check) and `crew-mcp uninstall` (undo).

---

## Installation flow

`crew install [-t <host|all>]` per-target steps:

```
for each target in resolveTargets(args.target):
    1. render skill from skills/crew-captain.body.md +
       per-host template (skills/targets/<host>.md.tmpl)
    2. write skill file at adapter.skillPath(home)
    3. read host config; mergeMcpBlock; write back
    4. if --auto-approve (default): writeAutoApproval to
       host's permissions file
    5. record in ~/.crew/install.json

after at least one successful target:
    seed ~/.crew/agents.json with adapter defaults
    (only if file doesn't exist; never overwrites)
```

Target resolution:

- `--target <ids>` (comma-separated or `all`) — explicit, force-installs
  even if binary not on PATH (the user knows what they want).
- No `--target` flag — interactive mode: detect every host's binary
  concurrently; if TTY, prompt the user to pick; if non-TTY, install
  to all detected (CI-friendly).

The renderer (`src/install/skill-renderer.ts`) substitutes
`{{TOOL_LIST}}` with the catalog from `tool-catalog.ts` so the skill
the captain reads always matches the live tool surface (parity-checked
by `crew-mcp verify`).

Per-host quirks live in `src/install/hosts/<host>.ts`:

- **claude-code**: JSON config at `~/.claude.json`; permissions at
  `~/.claude/settings.json` (separate file).
- **codex**: TOML config at `~/.codex/config.toml`; pre-approval as
  per-tool `[mcp_servers.crew.tools.<X>]` blocks with
  `approval_mode = "always"`. Hand-rolled TOML section parser (no dep).
- **gemini**: JSON config; pre-approval via server-wide `"trust": true`.

---

## Streaming + cancellation

Two mechanisms layered on top of MCP's normal request/response model:

### Progress notifications

When the host CLI includes a `progressToken` in the MCP request `_meta`,
crew sends `notifications/progress` for each adapter onOutput chunk.
The host renders them as live activity (Claude Code shows them under
the tool call; Codex/Gemini handle similarly).

```
Adapter.execute(task):
  spawn subagent
  while running:
    chunk = read line from stdout
    task.onOutput(chunk)
              │
              ▼
  Dispatcher.run:stream event
              │
              ▼
  serve.ts lifecycle listener:
    ├── runStateStore.appendEvent(runId, chunk)   (always)
    └── progressNotifier.send(chunk)              (if progressToken supplied)
              │
              ▼
        sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: counter++, message: chunk }
        })
              │
              ▼  (MCP, stdio)
        host CLI renders inline
```

Counter is monotonically increasing per the MCP spec. `total` is
omitted (we don't know chunk count up-front; renderers handle that
as indeterminate progress).

### Cancellation

The dispatcher tracks an `AbortController` per in-flight tool-call.
`cancel_run({ run_id })` looks up the matching tool-call by runId and
fires `controller.abort()`. The adapter's subprocess receives the
abort via execa's `cancelSignal` (SIGTERM → SIGKILL after grace).

```
cancel_run handler:
  inFlight = dispatcher.listInFlight().find(t => t.runId === runId)
  if !inFlight: return { ok: false, reason: "not in-flight" }
  dispatcher.cancel(inFlight.toolCallId)
              │
              ▼
  controller.abort()
              │
              ▼
  adapter subprocess receives SIGTERM
  task promise rejects with abort
              │
              ▼
  dispatcher emits run:cancelled
              │
              ▼
  lifecycle listener: runStateStore.markTerminal({ status: 'cancelled' })
```

The worktree is preserved on cancel — call `discard_run` after for
cleanup. Rationale: cancellation is "stop work," not "throw away
everything"; the user might still want to inspect partial output.

---

## Codebase layout

```
src/
├── index.ts                 ← CLI entry: serve, install, verify, uninstall, status, agents
├── cli/commands/
│   ├── serve.ts             ← MCP server (the bulk of runtime logic)
│   ├── install.ts           ← `crew-mcp install` orchestration
│   ├── uninstall.ts         ← reverse of install
│   ├── verify.ts            ← parity check (skill ↔ tool catalog)
│   ├── status.ts            ← health check across registered adapters
│   └── agents.ts            ← `crew agents edit` ($EDITOR on agents.json)
│
├── adapters/                ← agent-side adapters (the workers)
│   ├── types.ts             ← AgentAdapter interface, EffortLevel, AgentStrength
│   ├── registry.ts          ← AdapterRegistry; alias resolution; collision checks
│   ├── claude-code.ts       ← `claude` CLI
│   ├── codex.ts             ← `codex exec` CLI
│   ├── gemini-cli.ts        ← `gemini` CLI
│   ├── generic.ts           ← arbitrary command + args
│   ├── openai-compatible.ts ← any OpenAI-compatible HTTP endpoint
│   └── tool-loop/           ← shared tool-loop primitives for captain mode
│
├── install/                 ← host-side adapters + install plumbing
│   ├── hosts/
│   │   ├── types.ts         ← HostAdapter interface
│   │   ├── claude-code.ts   ← JSON config + ~/.claude/settings.json
│   │   ├── codex.ts         ← TOML config + per-tool approval blocks
│   │   ├── gemini.ts        ← JSON config + trust:true
│   │   └── index.ts         ← registry of HOST_ADAPTERS
│   ├── crew-binary.ts       ← resolves the `crew` binary path at install time
│   ├── install-manifest.ts  ← ~/.crew/install.json schema
│   ├── interactive-target.ts← TTY prompt for "no --target" install
│   ├── skill-renderer.ts    ← templates skill body with tool list
│   └── tool-catalog.ts      ← canonical list for skill rendering
│
├── orchestrator/            ← dispatch + tool implementations
│   ├── tools/               ← one file per MCP tool
│   │   ├── run-agent.ts     ← planRunAgent + buildAdapterDispatchTask
│   │   ├── continue-run.ts
│   │   ├── merge-run.ts
│   │   ├── discard-run.ts
│   │   ├── get-run-status.ts
│   │   ├── cancel-run.ts
│   │   ├── list-agents.ts
│   │   └── index.ts         ← barrel export
│   ├── tool-dispatcher.ts   ← AbortController-per-task; run:start/stream/complete events
│   ├── run-state.ts         ← state.json + events.log persistence
│   ├── events.ts            ← shared event types
│   └── mcp-registration.ts  ← per-host MCP wiring helpers
│
├── agent-prefs/
│   └── store.ts             ← ~/.crew/agents.json read/write/seed/merge
│
├── git/
│   ├── worktree.ts          ← WorktreeManager: createRunWorktree, mergeRunWorktree, …
│   └── (legacy v0.1 helpers; lazily initialized)
│
├── workflow/                ← v1 captain config (kept for openai-compatible/generic)
│   ├── types.ts             ← AgentConfig, WorkflowConfig (legacy)
│   ├── config-codec.ts      ← YAML/JSON config parsing
│   ├── config-validation.ts
│   ├── config-service.ts
│   ├── config-path-registry.ts
│   ├── models.ts            ← ModelId enum + alias resolution
│   └── …
│
└── utils/
    ├── crew-home.ts         ← resolves $CREW_HOME or ~/.crew
    ├── logger.ts
    └── …

skills/
├── crew-captain.body.md     ← canonical orchestration playbook (the captain's brain)
└── targets/
    ├── claude-code.md.tmpl  ← per-host frontmatter wrappers
    ├── codex.md.tmpl
    └── gemini.md.tmpl
```

Read order if you're new:
1. `skills/crew-captain.body.md` — what the captain is told to do
2. `src/cli/commands/serve.ts` — how the MCP server is built
3. `src/orchestrator/tools/run-agent.ts` — the dispatch primitive
4. `src/orchestrator/tool-dispatcher.ts` — the AbortController-per-task model
5. `src/adapters/codex.ts` — a representative agent adapter
6. `src/install/hosts/claude-code.ts` — a representative host adapter

---

## Key invariants

These are load-bearing. Breaking them breaks the contract.

1. **Crew never modifies the host repo without an explicit `merge_run`.**
   Worktrees are isolated; failed dispatches are zero-cost.
2. **The captain decides; crew enables.** The skill body teaches the
   captain's behavior; the code provides the verbs. We do NOT enforce
   captain decisions in code (e.g., "ask before merging" is in the
   skill, not in `merge_run`).
3. **`run_agent` is the only primitive for fresh dispatches.** No
   workflow DSL, no captain-side step planner. The captain writes the
   prompt verbatim.
4. **Per-machine config is opt-in.** `agents.json` doesn't exist until
   first install; missing file = adapter defaults. The user's existing
   per-CLI configs (`~/.claude.json`, `~/.codex/config.toml`) are the
   source of truth unless the user has expressed a per-machine override.
5. **Run state is durable across `crew-mcp serve` restarts.** A `run_id`
   from yesterday is still resumable today.

---

## Where to go next

- **`tools.md`** — tool surface in detail, including edge cases and
  status semantics.
- **`adapters.md`** — agent-adapter contract; how to add a new adapter.
- **`presets.md`** — preset config (legacy v1 captain knobs, kept for
  openai-compatible/generic adapters).
- **`captain-portability.md`** — what makes the skill body work across
  Claude Code / Codex / Gemini, and the per-host quirks that almost
  broke that portability.
- **`runners.md`** / **`session.md`** — deeper notes on the v0.1 captain
  internals, kept as historical context for the workflow/ subtree.
- **`config-registry.md`** — the `/config set` path-registry pattern
  used by the legacy workflow config.
- **`docs/plans/active/`** — current in-flight plans (what's being
  built right now).
- **`docs/plans/mcp-pivot/PRODUCT_VISION.md`** — the pivot from v0.1's
  TUI-based captain to the v0.2 MCP-server-+-skill model.

For the historical context (why crew exists at all, what v0.1 looked
like, what we learned), see the v0.1-tui git tag and the
`docs/plans/mcp-pivot/` directory.
