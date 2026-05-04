# Crew v2 — Product Vision

> An MCP server + portable captain skill that turns any AI coding CLI
> into the orchestrator of a worktree-isolated multi-agent crew.

---

## The Thesis

The right place for an agent captain is **inside the user's existing CLI**,
loaded as a skill, with orchestration verbs exposed via MCP. Captain logic
should be **portable instructions**, not a separate LLM process with its
own UI.

Crew v2 inverts the v0.1 architecture. v0.1 hosted its own captain LLM
in a Terminal UI and dispatched to Claude Code / Codex as workers. v2
keeps the captain *thinking* — preserved as a skill artifact — but
lets the host CLI's LLM be the captain. Crew becomes the dispatch
layer the host CLI calls into.

See [HISTORICAL_CONTEXT.md](./HISTORICAL_CONTEXT.md) for the v0.1
retrospective and what triggered the pivot.

---

## The Insight That Drove The Pivot

The host CLI is already a captain. It already has the user's trust,
the user's UI, the user's IDE integrations, the user's prompt history.
Putting another captain LLM in front of it adds latency, a worse UI,
and a redundant inference call.

What was missing was not a captain — it was the **verbs** (orchestration
primitives) and the **playbook** (when to dispatch, how to decompose,
how to iterate after review).

Crew v2 is the verbs (an MCP server with 6 tools) + the playbook (a
skill that ships with it and renders per-host).

---

## Who It's For

Solo developers who:

- Have multiple AI coding CLI subscriptions (Claude Max + ChatGPT Plus
  is the canonical case)
- Already trust one CLI as their primary driver
- Want to reach the other CLIs without leaving their primary
- Want isolated, reviewable, mergeable work units rather than direct
  HEAD modifications

Same target user as v0.1, but met where they already work instead of
asking them to adopt a new TUI.

---

## Core Principles

1. **The host CLI is the captain.** Crew adds tools; it does not add
   another LLM. No persistent captain process, no separate session
   loop, no second context window competing for tokens.

2. **Skill ships with the server.** Captain reasoning is preserved
   as a markdown skill artifact installed alongside the MCP config.
   One install command writes both. Updating crew updates both.

3. **Worktree isolation is non-negotiable.** Every dispatched run
   gets its own `~/.crew/runs/<runId>/worktree/` (out-of-tree from
   the host repo, M3.5). The host CLI's working directory never
   moves and `git status` in the host repo stays clean. Merges
   happen only via explicit tool calls.

4. **Provider-agnostic everywhere.** Host CLI swappable. Worker
   subagents swappable. The captain skill is host-templated but
   semantically identical across hosts.

5. **No API keys.** All inference flows through CLI subscription
   auth. Crew itself does no inference.

6. **Auto-invoked by design.** MCP servers are spawned by the host
   CLI at session start. The user never runs `crew` manually after
   install.

---

## How It Works

### Install

```
$ npm install -g crew-mcp
$ crew install --target codex

✓ Detected codex 0.121.0
✓ Detected claude-code 1.0.23 (will register as a subagent)
→ Writing MCP server   → ~/.codex/config.toml [mcp_servers.crew]
→ Writing captain skill → ~/.codex/prompts/crew.md
→ Writing agent registry → ~/.crew/agents.yaml
✓ Verifying via `codex mcp list`...
✓ crew is installed.

To use: in any codex session, type /crew or say "use crew to..."
Restart any open codex sessions to pick this up.
```

A single command writes both artifacts (MCP config block + skill
file), resolves the absolute crew binary path, and verifies the
host CLI sees the server. Same shape for `--target claude-code`,
`--target gemini`, and `--target all` (auto-detects installed
hosts).

### Usage from inside the host CLI

```
codex> have claude review the changelog parser i just wrote

[skill auto-loads — codex now has the playbook]
[codex → mcp__crew__list_agents()]
[codex → mcp__crew__run_agent(agent_id: "claude-code",
                               prompt: "Review src/changelog.ts...")]

  crew: dispatching → claude-code
  crew: worktree ~/.crew/runs/r-9f3a/worktree/
  crew: complete · 31s

codex: Claude flagged 3 issues:
       1. Off-by-one in version range parsing
       2. Empty release notes throw instead of returning ""
       3. Header regex doesn't match conventional commits markers

       Want me to dispatch a fix back to claude, or address them myself?

codex> have claude fix them

[codex → mcp__crew__continue_run(run_id: "r-9f3a", prompt: "fix...")]
  crew: resuming r-9f3a → claude-code
  crew: complete · 18s

codex: Fixed. Should I merge the worktree?

codex> yes

[codex → mcp__crew__merge_run(run_id: "r-9f3a")]
  crew: merged → 1 commit
```

The user never leaves Codex. The skill teaches Codex how to think
about orchestration. The MCP server gives Codex the verbs to act
on it. Worktree isolation keeps the user's HEAD clean until merge.

### What gets written where

| File | Purpose | Updated by |
|---|---|---|
| `~/.codex/config.toml` `[mcp_servers.crew]` | MCP server registration | `crew install` |
| `~/.codex/prompts/crew.md` | Skill (captain playbook) | `crew install` |
| `~/.claude.json` `mcpServers.crew` | MCP server registration | `crew install` |
| `~/.claude/skills/crew/SKILL.md` | Skill (captain playbook) | `crew install` |
| `~/.gemini/settings.json` | MCP server registration | `crew install` |
| `~/.gemini/extensions/crew/` | Skill (captain playbook) | `crew install` |
| `~/.crew/agents.yaml` | Agent registry (which CLIs to dispatch to) | user; `crew install` seeds it |
| `~/.crew/install.json` | Tracks which hosts have crew installed | `crew install` / `uninstall` |
| `~/.crew/runs/<runId>/` | Per-run state, worktree, artifacts (state.json, events.log, worktree/) | `crew serve` (per dispatch) |

---

## The Tool Surface

Six tools, exposed by `crew serve`:

| Tool | Returns | Purpose |
|------|---------|---------|
| `list_agents` | `[{id, status, capabilities, model}]` | What can be dispatched to |
| `run_agent` | `{run_id, status, diff, summary, files_changed}` | Dispatch a fresh run in a new worktree |
| `continue_run` | same | Add instructions to an existing worktree run |
| `merge_run` | `{commit_sha, conflicts}` | Merge worktree → host's HEAD |
| `discard_run` | `{ok}` | Delete worktree without merging |
| `get_run_status` | `{run_id, status, log_tail}` | Poll long-running dispatches |

Down from v0.1's 8. Retired:

- `finish` — host CLI ends its own turns
- `message_user` — host CLI streams its own responses
- `compress_context` — host CLI manages its own context
- `analyze_output` — host CLI reasons inline
- `plan_tasks` — host CLI plans inline (or asks the user)

Added (lifecycle):

- `continue_run` — resume a worktree without spawning a new one
- `merge_run` — explicit merge boundary; the only state-mutating tool
- `discard_run` — abandon a worktree cleanly
- `get_run_status` — poll fallback for hosts whose tool-call
  timeouts are shorter than long dispatches

`merge_run` is the single safety boundary. crew never auto-merges.
The host CLI must ask the user before calling it. The captain skill
encodes this rule explicitly.

---

## The Captain Skill

The skill is a markdown playbook that loads into the host CLI's
context when user intent matches. It contains:

- The dispatch-vs-inline heuristic (when to call `run_agent` vs.
  answer directly)
- The default flow (code → review → iterate)
- The merge boundary (always ask the user before `merge_run`)
- An escape hatch ("if these tools aren't found, tell the user to
  run `crew install` and answer inline")
- The agent inventory (rendered from `~/.crew/agents.yaml`)

The captain prompt content from v0.1 survives ~80%. Edits required
for the inverted model:

- Drop references to retired tools (`finish`, `message_user`,
  `compress_context`, `analyze_output`, `plan_tasks`)
- Reframe "you are the captain" → just instructions; the host is
  already itself
- Add explicit "ask the user before merge_run" — the safety boundary
- Add the dispatch-vs-inline heuristic up top — most load-bearing
  decision and was implicit in v0.1

The skill body is canonical (one source file in the repo at
`skills/crew-captain.body.md`). Per-host templates render frontmatter,
opening framing, and trigger metadata. Three host targets at v0.2:

| Host | Skill file | Trigger |
|---|---|---|
| Claude Code | `~/.claude/skills/crew/SKILL.md` | auto-match on description |
| Codex | `~/.codex/prompts/crew.md` | `/crew` or "@crew" |
| Gemini | `~/.gemini/extensions/crew/` | extension invocation |

---

## Verification + Escape Hatch

Two layers of defense against drift:

1. **Install-time verification.** `crew install` writes both the MCP
   block and the skill, then runs `host_cli mcp list` to confirm the
   server is reachable. `crew verify` re-runs the checks anytime: it
   reads the installed skill, extracts every `mcp__crew__*` tool
   reference, and compares against `ToolCatalog.listTools()`. Drift
   produces a clear message with `crew install` as the suggested fix.

2. **Skill-level escape hatch.** A paragraph at the top of every
   rendered skill instructs the host CLI: if the tools aren't
   available at the moment of attempted use, don't pretend they are
   — tell the user crew may be misconfigured and answer inline as
   yourself. This makes the failure mode user-visible and recoverable
   without a host-CLI restart.

Verification is the load-bearing piece. The escape hatch is one
paragraph; nearly free.

---

## Differentiation

| | Crew v2 | Claude Code subagents | Codex agent loop | Cursor multi-agent |
|---|---|---|---|---|
| Host-CLI agnostic | Yes | No (Claude only) | No (Codex only) | No (Cursor only) |
| Portable captain logic | Yes (skill) | No (in-product) | No (in-product) | No (in-product) |
| Worktree isolation | Yes | Partial | No | No |
| Cross-CLI dispatch | Yes (Claude→Codex etc.) | No | No | No |
| Install location | User's existing CLI | n/a | n/a | n/a |
| Provider-agnostic | Yes | No | No | No |

The pitch:

> "Crew is an MCP server that gives any AI coding CLI access to all
> the others. Install it once, then from inside Claude Code or Codex,
> ask things like 'have the other one review this' or 'have a local
> model triage the test failures.' Each subagent runs in its own git
> worktree. Bring your own subscriptions."

That slots into a workflow the user already has rather than asking
them to adopt a new one.

---

## What's In / What's Out

**In:**

- MCP stdio server (`crew serve`)
- Three host targets at v0.2: Claude Code, Codex, Gemini
- 6-tool surface with worktree lifecycle
- Skill rendering + install + verify
- Existing adapter substrate (Claude Code, Codex, Gemini, generic,
  openai-compatible)
- Worktree isolation (`~/.crew/runs/`, M3.5 — out of host repo)
- Agent registry config (`~/.crew/agents.yaml`)
- Eval harness + field report (portfolio artifact)

**Out:**

- Terminal UI (deleted)
- Persistent captain session (host CLI owns the session)
- Captain LLM as a separate process (host CLI is the captain)
- Presets-as-runtime (skill body is the only "preset")
- `workflow.yaml` (collapsed into agents.yaml)
- Profile system (host CLIs have their own)
- Slash commands inside crew (host CLIs have their own)
- API keys / paid inference

---

## Configuration Surface

> **Status as of v0.2-dev:** the user-facing `~/.crew/agents.yaml`
> below is the planned shape. It is **not yet implemented**. The
> v0.2-dev adapter registry is built-in only (`claude-code`, `codex`,
> `gemini-cli`, `generic`, `openai-compatible`) — there is no YAML
> loader, no `defaults` section honored at runtime, and no
> `max_concurrent_runs` enforcement. The shape below is the target
> for whichever post-M3 milestone tackles user-facing config; M4
> dogfooding will inform that decision.

```yaml
# ~/.crew/agents.yaml — the entire user-facing config (planned)
agents:
  claude-code:
    adapter: claude-code
    model: claude-opus-4-7
  codex:
    adapter: codex
    model: gpt-5.4
  local-gemma:
    adapter: generic
    command: ollama
    args: [run, gemma4:latest, "{{prompt}}"]

defaults:
  worktree_root: ~/.crew/runs   # post-M3.5: out of host repo, per-user
  cleanup_on_merge: true
  max_concurrent_runs: 2
```

That is the entire config. No `workflow.yaml`, no captain section,
no presets, no completion strategy. The skill is the runtime; the
agents.yaml is the registry.

---

## Architecture Sketch

```
┌─────────────────────────────────────────────────────────┐
│ User's host CLI (Claude Code / Codex / Gemini)          │
│                                                          │
│   ┌─────────────────────────────┐                       │
│   │ Captain skill loaded        │  ← markdown playbook  │
│   │ (instructions + heuristics) │     written by         │
│   └─────────────────────────────┘     `crew install`   │
│                ↕                                         │
│   ┌─────────────────────────────┐                       │
│   │ MCP client                  │  ← spawned at session  │
│   └──────────────┬──────────────┘     start by host CLI │
│                  │ stdio                                │
└──────────────────┼──────────────────────────────────────┘
                   │
┌──────────────────┴──────────────────────────────────────┐
│ crew serve (MCP server)                                 │
│                                                          │
│   ToolCatalog → 6 tools (list_agents, run_agent, ...)   │
│   ToolDispatcher → spawns worker subprocesses           │
│   Worktree manager → ~/.crew/runs/<id>/worktree/        │
│   Adapter registry → claude-code, codex, gemini, ...    │
└────────┬───────────────┬───────────────┬────────────────┘
         │               │               │
         ▼               ▼               ▼
   [worker A]       [worker B]      [worker C]
   claude-code       codex           ollama:gemma
   in worktree A     in worktree B   in worktree C
```

---

## Lifecycle / Process Model

### Per-host-session

- One `crew serve` process spawned by the host CLI on session start
  (auto, via the MCP block in host config)
- Lives in memory; no persistence except per-run state (below)
- Idle cost: ~80–120 MB RAM, ~300 ms additional host startup
- Dies with the host CLI session

### Per-dispatch

- `run_agent` spawns a worker subprocess (claude / codex / etc.) in
  a fresh worktree
- Blocks-but-streams for ≤ 60 s; if exceeded, returns
  `{status: 'running', run_id}` and the host polls via
  `get_run_status`
- Worker runs to completion regardless of host poll cadence
- State + artifacts persist in `~/.crew/runs/<runId>/` (M3.5: out of
  the host repo so `git status` stays clean)

### Permission model

- One-time MCP server approval prompt on first host session post-install
  (standard MCP UX, single click)
- One-time per-tool approval on first call (standard MCP UX, with
  remember option)
- No `--dangerously-skip-permissions` or bypass flags required
- Worker subprocesses spawned by crew are crew's children — outside
  the host CLI's permission tree

---

## Open Design Questions

Originally listed as open at v2 planning. Resolutions inline below;
items that remain open are flagged.

1. **Run lifecycle: blocking vs. async by default.** **RESOLVED in
   M2.** Implemented as originally sketched: blocks ≤ 60 s, then
   returns `{status: 'running', run_id}` and the host polls via
   `get_run_status`. The 60 s value is configurable via
   `asyncFallbackMs` in `ServeOptions` for tests. State.json is the
   source of truth regardless of when the host polls. Real-use
   validation lands in M4.

2. **Cost/quota interaction when host = worker.** **STILL OPEN.** The
   captain skill at `skills/crew-captain.body.md` includes a
   "Cross-CLI quota awareness" paragraph instructing the host CLI to
   warn the user before dispatching to its own product — the
   simplest first version, no server-side enforcement. M4 dogfooding
   will surface whether this is enough or whether `run_agent` should
   refuse self-dispatch by default.

3. **`ask_user` semantics.** **RESOLVED in M3.** The tool was removed
   from the v2 surface. The captain skill instructs the host CLI to
   ask the user inline before destructive operations (notably
   `merge_run` and `discard_run`); the host's own chat is the asking
   surface.

4. **Auto-load vs. explicit invoke for skills.** **RESOLVED in M3.**
   Auto-load by default. Claude Code uses `description`-frontmatter
   matching (the `SKILL_DESCRIPTION` constant in `src/install/skill-renderer.ts`
   is tuned for the orchestration intent); Codex uses `/crew` or
   `@crew`; Gemini uses extension-descriptor invocation. No
   `--manual-only` install flag at v0.2 — can be added if M4
   dogfooding finds users want it.

5. **Skill drift across host CLI updates.** **STILL OPEN / monitor.**
   `crew verify` covers `mcp__crew__*` tool-name drift between the
   rendered skill and the live MCP catalog. Semantic drift in the
   host CLI's skill semantics requires release-notes vigilance —
   not a v0.2 blocker.

6. **Multi-host concurrent runs.** **STILL OPEN / post-v0.2.** If
   the user has Codex AND Claude Code open simultaneously, each
   spawns its own crew server. Post-M3.5 they share a single global
   `~/.crew/runs/` (across host repos, not just sessions). Run IDs
   are UUIDs so directory collision is impossible; lock keying is
   per-runId. The remaining open question is `merge_run` semantics
   (two hosts trying to merge two different runs into the same
   branch) — needs smoke before declaring resolved.

---

## Success Criteria

This is for personal use + portfolio. Success looks like:

1. Installable in 30 seconds: `npm i -g crew-mcp && crew install --target all`
2. Workable from inside Claude Code or Codex with zero TUI
3. The captain skill can be A/B'd against an empty skill in eval
4. The author can dogfood it on real work for 2 weeks without
   reverting to v0.1's TUI
5. A field report exists explaining what the v0.1 → v2 inversion
   taught us
6. The repo on GitHub is legible to a hiring reviewer in 10 minutes

---

## Naming

> **Resolved at fork time:** `crew-mcp`. Lives at
> `https://github.com/chasenstark/crew-mcp` as a fresh GitHub repo
> alongside the original `crew` (frozen at the `v0.1-tui` tag). The
> npm package name follows: `crew-mcp`, binary still `crew`.

Candidates considered:

- `quartermaster` — continues the nautical metaphor; literal
  "dispatcher and provisioner"; longer to type
- `bosun` / `signalman` — nautical; thematic continuity
- `relay` — neutral; signals the "between two CLIs" framing
- `dispatch` — neutral; conflicts with common word
- `captain-mcp` — most explicit; less branded

`crew-mcp` was picked: keeps continuity with the `crew` brand
identity from v0.1, with `-mcp` making the architecture inversion
explicit. The product vision works under any name.
