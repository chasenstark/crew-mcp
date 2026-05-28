# crew-mcp

An MCP server that turns your AI coding CLI into the orchestrator of a
multi-agent crew. Dispatch work to Claude Code, Codex, Gemini CLI, or
local models — each run gets its own git worktree, so your working
directory stays clean and merges happen only when you say so.

```
you ── Claude Code (captain) ──┬── run_agent → Codex (worktree A)
                                ├── run_agent → Gemini (worktree B)
                                └── run_panel → Claude + Codex (parallel review)
```

## How it works

Crew installs two things into your host CLI:

1. **An MCP server** exposing orchestration tools (`run_agent`,
   `run_panel`, `merge_run`, etc.)
2. **Captain skills** — markdown playbooks that teach the host LLM how
   to orchestrate. The umbrella `crew` skill covers dispatch, review
   panels, and merge; the `crew-iterate` skill drives a criteria-gated
   implement → review → iterate loop ([see below](#the-crew-iterate-skill)).

Your host CLI's LLM becomes the captain. You stay in one conversation.
When work needs another agent, the captain dispatches it into an
isolated worktree and reports back.

## What you can do

- **Dispatch work** — "have Codex implement this feature", "send this
  to Claude for review". The captain picks the right agent, allocates a
  worktree, and dispatches.
- **Run review panels** — multiple models review the same diff in
  parallel. Each model does a full independent review; the captain
  cross-checks agreement and disagreement across models.
- **Iterate to acceptance** — define acceptance criteria, then loop
  between an implementer and one or more reviewers until every criterion
  passes. The captain drives the loop; you watch or intervene. See
  [the crew-iterate skill](#the-crew-iterate-skill).
- **Use local models** — add Ollama, LM Studio, or any
  OpenAI-compatible endpoint as a crew agent alongside the cloud CLIs.
- **Merge when ready** — review the diff, then `merge_run` applies it
  to your branch. Or `discard_run` to throw it away. Nothing touches
  your working tree until you decide.

## The crew-iterate skill

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

## Install

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

### Add local models

```sh
crew-mcp agents add --provider ollama
crew-mcp agents add --provider lm-studio
crew-mcp agents add --provider openai-compatible --api-base http://localhost:8080/v1
```

The interactive wizard discovers available models and registers them as
crew agents.

### Optional: live tail handler (macOS)

Dispatched runs log to `~/.crew/runs/<id>/`. Install the `crew-tail://`
URL handler to open a side Terminal window with live logs automatically:

```sh
crew-mcp install-tail-handler
```

Without it, the captain prints a `tail -F` command you can run manually.

## MCP tools

| Tool | Purpose |
|------|---------|
| `run_agent` | Dispatch work to a specific agent in an isolated worktree |
| `run_panel` | Dispatch parallel reviewers (full-review-per-model) |
| `aggregate_panel` | Collect panel reviewer findings |
| `get_panel_status` | Check panel progress |
| `get_run_status` | Check a single run's status |
| `list_runs` | List all runs, optionally filtered by status |
| `list_agents` | List available agents and their capabilities |
| `merge_run` | Apply a completed run's changes to your branch |
| `continue_run` | Send follow-up instructions to a running agent |
| `discard_run` | Discard a run's worktree and changes |
| `cancel_run` | Cancel a running agent |
| `get_crew_preferences` | Read crew configuration |

## Configure

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

## Supported hosts

| Host | Adapter | Install target |
|------|---------|----------------|
| Claude Code | `claude-code` | `--target claude-code` |
| Codex CLI | `codex` | `--target codex` |
| Gemini CLI | `gemini-cli` | `--target gemini` |
| Ollama / LM Studio / vLLM | `openai-compatible` | `crew-mcp agents add` |
| Any CLI with a command interface | `generic` | `crew-mcp agents add` |

## Architecture

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