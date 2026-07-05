# 🚢 crew-mcp

An MCP server that turns your AI coding CLI into the **orchestrator of a
multi-agent crew**. Dispatch work to Claude Code, Codex, Gemini CLI, or
local models — each run gets its own git worktree, so your working
directory stays clean and merges happen only when you say so.

## 💡 The vision — no API keys, just the CLIs you already have

Crew drives the AI coding CLIs you've **already installed and logged in**.
Every dispatched run goes through Claude Code, Codex, or Gemini on **your
existing subscription** — 🔑 no API keys to wrangle, 💸 no per-token
billing, no second bill for the same models. Want it fully private? 🏠 Add
local models (Ollama, LM Studio) and those runs never leave your machine.

That's the whole idea: a multi-agent crew built on the plans you're
already paying for. 🤝

```
you ── Claude Code (captain) ──┬── run_agent → Codex (worktree A)
                                ├── run_agent → Gemini (worktree B)
                                └── run_panel → Claude + Codex (parallel review)
```

## ⚡ Quickstart

Once installed (see **📦 Install** below), just talk to your host CLI:

> have Codex implement the rate limiter and review it until the tests pass

The captain derives acceptance criteria, dispatches Codex into an
isolated worktree, runs review, folds the findings back, and asks before
merging — all while you stay in one conversation.

Prefer to drive explicitly? Name the agent ("send this to Gemini"), ask
for a panel ("have Claude and Codex both review this"), or kick off the
ship-quality loop directly with `/crew-iterate`.

## 🧭 How it works

Crew installs two things into your host CLI:

1. **An MCP server** exposing orchestration tools (`run_agent`,
   `run_panel`, `merge_run`, etc.)
2. **Captain skills** — markdown playbooks that teach the host LLM how
   to orchestrate. The umbrella `crew` skill covers dispatch, review
   panels, and merge; the `crew-iterate` skill drives a criteria-gated
   implement → review → iterate loop (see **🔁 The crew-iterate skill**
   below).

Your host CLI's LLM becomes the captain. You stay in one conversation.
When work needs another agent, the captain dispatches it into an
isolated worktree and reports back.

## ✨ What you can do

- **Dispatch work** — "have Codex implement this feature", "send this
  to Claude for review". The captain picks the right agent, allocates a
  worktree, and dispatches.
- **Run review panels** — multiple models review the same diff in
  parallel. Each model does a full independent review; the captain
  cross-checks agreement and disagreement across models.
- **Iterate to acceptance** — define acceptance criteria, then loop
  between an implementer and one or more reviewers until every criterion
  passes. The captain drives the loop; you watch or intervene. See
  **🔁 The crew-iterate skill** below.
- **Use local models** — add Ollama, LM Studio, or any
  OpenAI-compatible endpoint as a crew agent alongside the cloud CLIs.
- **Merge when ready** — review the diff, then `merge_run` applies it
  to your branch. Or `discard_run` to throw it away. Nothing touches
  your working tree until you decide.

## 🔁 The crew-iterate skill

For work you want pushed to ship-quality, `crew-iterate` runs a
criteria-gated loop instead of a one-shot dispatch.

Trigger it by intent — "keep working on X with review", "iterate until
it's good", "ship-quality loop" — or invoke it directly: `/crew-iterate`
on Claude Code (`crew-iterate` on Codex / Gemini).

The loop:

1. **Derive acceptance criteria** from your request and confirm them
   with you. They become the contract for every downstream step.
2. **Confirm agents** — the captain proposes an implementer and a
   reviewer count scaled to the change's complexity (one reviewer for a
   narrow change, up to three distinct models for large or high-risk
   ones), honoring your configured defaults and bans. You OK or adjust.
3. **Dispatch the implementer** with the criteria embedded in the prompt.
4. **Dual review** — a free inline review by the captain plus one or more
   dispatched reviewers, each scoring every criterion PASS/FAIL and
   giving an overall verdict. Multiple reviewers run as a parallel panel.
5. **Iterate** — failing criteria and findings fold back via
   `continue_run` until every criterion passes and every reviewer
   approves (bounded by a safety cap).
6. **Merge** — on your explicit go, the run is squash-merged into a
   single clean commit.

Set persistent defaults so you don't re-pick every run — a default
implementer, default reviewers, and a per-scope ban list (e.g. "never
use Gemini"):

```sh
crew-mcp config   # → "Agent defaults…"
```

## 📋 Requirements

- **Node.js ≥ 20**
- **git** (worktrees are how runs stay isolated)
- **At least one host CLI** — [Claude Code](https://claude.com/claude-code),
  [Codex CLI](https://github.com/openai/codex), or
  [Gemini CLI](https://github.com/google-gemini/gemini-cli) — installed
  and authenticated. Local models (Ollama, LM Studio, …) work too.

## 📦 Install

```sh
npm install -g crew-mcp
```

Or from source:

```sh
git clone https://github.com/chasenstark/crew-mcp.git
cd crew-mcp
npm install && npm run build && npm link
```

Install into your host CLI:

```sh
crew-mcp install --target claude-code   # Claude Code
crew-mcp install --target codex         # OpenAI Codex CLI
crew-mcp install --target gemini        # Gemini CLI
crew-mcp install --target all           # auto-detect installed hosts
```

Verify the install:

```sh
crew-mcp verify
```

Restart your host CLI session. The `mcp__crew__*` tools and the captain
skill are now available.

### Project-scoped install

For a shared repo, commit portable host config and skills once:

```sh
npm install --save-dev crew-mcp
npx crew-mcp install --scope project --target claude-code,codex
git add .mcp.json .claude .codex .crew/install.project.json package.json package-lock.json
```

Antigravity CLI (`agy`) is **project-scope only** — it loads MCP servers
solely from `<repo>/.agents/mcp_config.json`, so there is no global
`--target agy`. Install it per repo:

```sh
npx crew-mcp install --scope project --target agy
git add .agents .crew/install.project.json package.json package-lock.json
```

agy has no config-level tool-approval flag; launch it with
`--dangerously-skip-permissions` so crew tool calls don't prompt.

As a crew *worker*, agy is write-mode only — it can't be trusted to
keep a read-only promise, so when agy is asked to review, crew hands it
a disposable snapshot worktree of the diff and discards it afterward
(review panels do this automatically).

Project scope writes `./node_modules/.bin/crew-mcp serve` into the
host config, not a machine-specific `dist/index.js` or home-directory
path. It also writes `.crew/install.project.json` with repo-relative
paths, does not write `~/.crew/install.json`, and does not seed
`~/.crew/agents.json`.

After pulling the repo, each developer runs:

```sh
npm install
```

Claude Code reads `.mcp.json` and `.claude/skills` from the project.
Codex developers must trust the repo once before `.codex/config.toml`
is loaded:

```toml
[projects."/absolute/path/to/repo"]
trust_level = "trusted"
```

Then restart the host and run:

```sh
npx crew-mcp verify --scope project
```

Per-machine agent overrides still use `crew-mcp agents add` or
`crew-mcp agents edit`.

### 🤖 Add local models

```sh
crew-mcp agents add --provider ollama
crew-mcp agents add --provider lm-studio
crew-mcp agents add --provider openai-compatible --api-base http://localhost:8080/v1
```

The interactive wizard discovers available models and registers them as
crew agents.

### 🖥️ Optional: live tail handler (macOS)

Dispatched runs log to `~/.crew/runs/<id>/`. Install the `crew-tail://`
URL handler to open a side Terminal window with live logs automatically:

```sh
crew-mcp install-tail-handler
```

Without it, the captain prints a `tail -F` command you can run manually.

### 🧹 Uninstall

Removes the crew MCP block and skills from a host CLI (your runs and
config under `~/.crew/` are left untouched):

```sh
crew-mcp uninstall --target claude-code
crew-mcp uninstall --target all
```

## 🧰 MCP tools

| Tool | Purpose |
|------|---------|
| `run_agent` | Dispatch work to a specific agent in an isolated worktree |
| `run_panel` | Dispatch parallel reviewers (full-review-per-model) |
| `aggregate_panel` | Collect panel reviewer findings |
| `get_panel_status` | Check panel progress |
| `get_run_status` | Check a single run's status |
| `list_runs` | List all runs, optionally filtered by status |
| `list_agents` | List available agents with `useWhen`, strengths, defaults, health, and quota — the captain routes away from rate-limited agents |
| `merge_run` | Apply a completed run's changes to your branch |
| `continue_run` | Send follow-up instructions to a running agent |
| `discard_run` | Discard a run's worktree and changes |
| `cancel_run` | Cancel a running agent |
| `get_crew_preferences` | Read crew configuration |
| `create_criteria` | Draft an acceptance-criteria set for a piece of work |
| `confirm_criteria` | Lock a criteria set after you approve it |
| `get_criteria` | Read a criteria set (drives reviewer scoring) |
| `revise_criteria` | Amend a criteria set mid-loop |

The criteria tools back the `crew-iterate` loop: criteria are stored
server-side, embedded into implementer prompts, and scored PASS/FAIL by
every reviewer.

## ⚙️ Configure

```sh
crew-mcp config
```

Interactive TUI for per-machine settings:

- **notifications.success / error** — OS notifications when dispatched
  runs finish (on by default)
- **confirmBeforeMerge** — require explicit confirmation before
  `merge_run` mutates your branch (on by default)
- **Agent defaults** — default implementer and reviewers for
  `crew-iterate`, default reviewers for `run_panel`, and per-scope ban
  lists. Stored globally in `~/.crew/workflow.yaml`; the toggles above
  live in `~/.crew/config.json`.

Env overrides: `CREW_OS_NOTIFICATIONS=off`, `CREW_CONFIRM_BEFORE_MERGE=off`.

Crew garbage-collects terminal runs under `~/.crew/runs/` so worktree
checkouts don't pile up: a terminal run's worktree is reclaimed after the
worktree window (default 7d, branch kept unless the run was merged) and its
run-dir deleted after the run-dir window (default 30d). The GC runs at
server startup; run it on demand with `crew-mcp cleanup` (`--dry-run` to
preview, `--all-repos` to sweep every repo). Tune the windows in
`crew-mcp config` → **Cleanup & retention** (stored in `config.json` as
`cleanup.worktreeTtlDays` / `cleanup.runDirTtlDays`; `-1` = off). Env vars
`CREW_WORKTREE_TTL_DAYS` / `CREW_RUNDIR_TTL_DAYS` (accept `off`) override
config for a given process.

## 👥 Managing agents

Agents live in `~/.crew/agents.json`. Each entry can carry `useWhen`
primary routing prose, `strengths` secondary tags, a default `effort`,
and a `model` — the captain reads these to route work when you don't
name an agent explicitly.

```sh
crew-mcp agents add      # register a model (interactive wizard, --use-when supported)
crew-mcp agents edit     # tune useWhen / strengths / effort / model
crew-mcp agents remove   # drop an agent
```

The `add` wizard also discovers local models — see **🤖 Add local
models** above.

Built-in strength tags come from a curated vocabulary:
`deep-reasoning`, `code-review`, `refactoring`, `technical-writing`,
`fast-iteration`, `autonomous-loops`, `bulk-implementation`,
`long-context`, `codebase-triage`, and `multimodal`. Custom tags remain
valid; the curated list is only the default picker and seed set.

## 🔌 Supported hosts

| Host | Adapter | Install target |
|------|---------|----------------|
| Claude Code | `claude-code` | `--target claude-code` |
| Codex CLI | `codex` | `--target codex` |
| Gemini CLI | `gemini-cli` | `--target gemini` |
| Antigravity CLI (`agy`) | `agy` | `--scope project --target agy` |
| Ollama / LM Studio / vLLM | `openai-compatible` | `crew-mcp agents add` |
| Any CLI with a command interface | `generic` | `crew-mcp agents add` |

## 🩺 Troubleshooting

**`mcp__crew__*` tools don't show up.** Restart your host CLI session
after install — the MCP server is loaded at startup. Then run
`crew-mcp verify` to confirm the config block and skills are in place.

**The captain says crew may be misconfigured.** Re-run
`crew-mcp install --target <host>` and restart the session. `crew-mcp
verify` reports exactly which host is missing the MCP block or skill.

**Gemini warns about a skill conflict.** Harmless if it persists, but
re-running `crew-mcp install --target gemini` resolves duplicate skill
copies (Gemini also reads the shared `~/.agents/skills/` directory).

**A run is stuck or unwanted.** `crew-mcp` exposes `cancel_run` (stop a
running agent) and `discard_run` (throw away its worktree); ask the
captain, or inspect runs under `~/.crew/runs/`.

## 🏗️ Architecture

```
┌─────────────────────────────────────────────┐
│  Host CLI (Claude Code / Codex / Gemini)    │
│  ┌───────────────────────────────────────┐  │
│  │  Captain skill (markdown playbook)    │  │
│  └──────────────┬────────────────────────┘  │
│                 │ MCP tool calls             │
│  ┌──────────────▼────────────────────────┐  │
│  │  crew-mcp server (stdio transport)    │  │
│  │  ┌────────────┐  ┌────────────────┐   │  │
│  │  │ Dispatcher │  │ Run state      │   │  │
│  │  │ (worktree  │  │ (status, logs, │   │  │
│  │  │  + adapter │  │  peer messages │   │  │
│  │  │  + tool    │  │  panel state)  │   │  │
│  │  │  loop)     │  │                │   │  │
│  │  └─────┬──────┘  └────────────────┘   │  │
│  └────────┼──────────────────────────────┘  │
└───────────┼─────────────────────────────────┘
            │ spawns
  ┌─────────▼──────────┐
  │  Worker agent       │
  │  (own process,      │
  │   isolated worktree │
  │   under ~/.crew/)   │
  └─────────────────────┘
```

Each dispatched run gets a worktree at `~/.crew/runs/<runId>/worktree/`.
The host repo's working directory is never touched. `merge_run`
squash-merges the run's branch into the host branch as a single commit.

## 📄 License

[MIT](LICENSE)
