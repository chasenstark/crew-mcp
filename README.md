# crew

A CLI tool that lets you talk to one AI agent that manages others. You describe what you want built — the captain decomposes the work, dispatches it to coding agents (Claude Code, Codex, or any CLI-based agent), reviews the output, iterates, and reports back.

No API keys required. Uses CLI subscription auth for everything.

```
User: "Build a DatePicker component. Claude builds, Codex reviews."

  → Captain decomposes into tasks
  → Claude Code implements the component (in an isolated git worktree)
  → Codex reviews the code
  → Captain evaluates findings
  → Claude Code fixes issues
  → Codex re-reviews → clean
  → "Done. 2 passes, all issues resolved. Want a PR?"
```

## How It Works

The captain is a CLI-backed LLM that drives the crew through **8 tools**:

| Tool | Purpose |
|------|---------|
| **run_agent** | Delegate a bounded task to a named subagent |
| **list_agents** | Discover available agents + capabilities + health |
| **ask_user** | Block until the user answers |
| **message_user** | Narrate without ending the turn |
| **plan_tasks** | Decompose into structured tasks (optional wrapper) |
| **analyze_output** | Structured assessment of agent output (optional) |
| **compress_context** | Terse summary for the next pass (optional) |
| **finish** | Emit final report and terminate |

Each `run_agent` call spawns the subagent in its own **per-run git worktree** at `.crew/runs/<runId>/worktree/` — full repo access, zero interference. The captain's session is durable: messages persist across invocations, and the `providerSessionRef` lets Claude / Codex / Gemini resume natively without replay when the environment hasn't drifted.

See `docs/architecture/tools.md` for the tool surface, `docs/architecture/session.md` for how the session + dispatcher + ToolCatalog fit together, and `docs/architecture/captain-portability.md` for the captain support matrix.

## Presets

A preset is a named bundle of soft-policy nudges rendered into the captain's system prompt. Three ship out of the box:

- **`default`** — balanced captain behavior (the shipping default).
- **`thorough-review`** — fans out to a second reviewer before `finish`.
- **`read-only`** — refuses write dispatches; replies with diffs + asks confirmation.

Switch mid-conversation with `/preset <name>`; persist with `crew config set captain.preset <name>`. See `docs/architecture/presets.md` for details.

```bash
/preset thorough-review     # next turn: captain fans out to multiple reviewers
/preset read-only           # next turn: captain refuses to modify files
/preset clear               # next turn: revert to captain.preset default
/preset list                # list declared presets
```

## Architecture Notes

- Runner core and policy split: `docs/architecture/runners.md`
- Adapter tool-loop abstraction: `docs/architecture/adapters.md`
- Declarative config path registry: `docs/architecture/config-registry.md`
- Preset system: `docs/architecture/presets.md`

## Requirements

- **Node.js 20+**
- **Git 2.25+** (worktree support)
- At least one of:
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — `claude`
  - [Codex CLI](https://github.com/openai/codex) — `codex`
- Authenticated CLI sessions (browser login, no API keys)

## Installation

```bash
# Clone and install
git clone <repo-url> && cd crew
npm install

# Build
npm run build

# Link globally (optional)
npm link
```

## Quick Start

```bash
# 1. Check which agents are available
crew status

# 2. Select project-local config scope (recommended)
cd /path/to/your/project
crew config scope project

# 3. (Optional) choose a named profile
crew config profile claude-captain

# 4. Configure via interactive wizard (or use config set commands)
crew config

# 4. Run a workflow
crew run "Build a DatePicker component with tests"

# Or enter interactive mode
crew run
```

## Commands

### `crew run [prompt]`

Start a workflow. With a prompt, runs non-interactively and prints progress to the terminal. Without a prompt, opens an interactive conversation UI.

```bash
# Non-interactive
crew run "Add email validation to the signup form"

# Interactive mode
crew run

# Non-interactive input policy when the workflow needs clarification
crew run "Add email validation to the signup form" --on-ask-user prompt

# Verbose debugging logs
crew --debug run "Add email validation to the signup form"
```

Each run writes a log file to `.crew/logs/run-<timestamp>.log`.
Use `--debug` (or `CREW_LOG_LEVEL=debug`) to include detailed adapter/process diagnostics.

### `crew init [--project]`

Creates `workflow.yaml` with the default workflow configuration.

- Default: global config at `~/.crew/workflow.yaml`
- With `--project`: project config at `./.crew/workflow.yaml`
- Compatibility command. Preferred setup/edit flow is `crew config`.

### `crew config`

Interactive and command-based configuration management.
The wizard is keyboard-driven: use `↑` / `↓` to highlight options and press `Enter` to select.
For each field, you can also choose `[Custom value...]` or `[Keep current value]`.
If your workflow has no review step, reviewer-pass settings are skipped automatically.

```bash
# Interactive wizard
crew config

# Show effective config + active scope
crew config show

# Set values
crew config set captain.cli codex
crew config set captain.model claude-sonnet-4-6
crew config set captain.model next
crew config set captain.preset thorough-review
crew config set workflow.execution.mode judgment
crew config set workflow.roleModels.reviewer gpt-5.4
crew config set workflow.roleModels.fix_review_issues claude-opus-4-6
crew config set workflow.roleModels.reviewer next
crew config set agents.codex.adapter codex
crew config set agents.codex.model gpt-5.4
crew config set agents.codex.model prev
crew config set agents.local-gemma.command ollama
crew config set agents.local-gemma.args run,gemma4:latest,{{prompt}}
crew config set agents.local-gemma.capabilities implement,review
crew config set workflow.reviewer.maxPasses 3
crew config set errorHandling.default.retry 1

# Add/remove agents
crew config add-agent local-gemma --adapter generic --command ollama --args run,gemma4:latest,{{prompt}} --capabilities implement,review
crew config remove-agent local-gemma

# Scope management
crew config scope
crew config scope project
crew config scope global

# Profile management
crew config profile
crew config profile claude-captain
crew config profile codex-captain

# Reset a scope to defaults
crew config reset --scope project
```

In interactive `crew run` mode, `/config` slash commands are also available:

```text
/config
/config show
/config scope
/config scope project
/config profile
/config profile codex-captain
/config add-agent local-gemma generic ollama
/config set agents.local-gemma.args run,gemma4:latest,{{prompt}}
/config set agents.local-gemma.capabilities implement,review
/config set captain.cli codex
/config set workflow.execution.mode judgment
/config set workflow.roleModels.reviewer gpt-5.4
/config remove-agent local-gemma
/config reset
```

### `crew status`

Health-checks all registered agents and shows which are installed and authenticated.

```
  ✓ claude-code (1.0.23): ready
  ✗ codex: not installed
```

### Session continuity (post-M3)

`crew resume` was removed in M3. `crew run` auto-continues any durable
session under `.crew/` without an explicit resume step — the captain
picks up where the prior invocation left off. If the captain environment
drifted (new CLI version, tool-schema bump), one automatic full-message-log
replay reconciles state on the next turn; subsequent turns use native
resume again.

To discard a session entirely, use `crew state reset`.

## Configuration

Primary path: use `crew config` and `/config` commands.

Profiles let you keep separate config variants (for example, `claude-captain` and `codex-captain`) and switch between them quickly.
Profile files are stored under:
- Project scope: `.crew/profiles/<profile>/workflow.yaml`
- Global scope: `~/.crew/profiles/<profile>/workflow.yaml`
- Default profile (when no named profile is set) continues using `.crew/workflow.yaml` and `~/.crew/workflow.yaml`.

Advanced/legacy path: edit `.crew/workflow.yaml` manually if needed:

```yaml
workflow:
  name: default
  steps:
    - role: coder
      agent: codex
      action: implement

    - role: reviewer
      agent: claude-code
      action: review
      max_passes: 3

  role_models:
    reviewer: gpt-5.4
    fix_review_issues: claude-opus-4-6
    judge: claude-opus-4-6

  completion:
    strategy: judge_approval
    fallback: max_passes

agents:
  claude-code:
    adapter: claude-code
    model: claude-opus-4-6
    strengths: [implementation, refactoring, TypeScript, React]

  codex:
    adapter: codex
    model: gpt-5.3-codex
    strengths: [implementation, review, testing, Python, TypeScript, React, security]

captain:
  cli: claude-code
  model: claude-sonnet-4-6

error_handling:
  default:
    retry: 1
    on_exhausted: ask_user
```

Model selection precedence:
1. `workflow.role_models.<task role>`.
2. If a task role matches a workflow step `action`, then `workflow.role_models.<step role>`.
3. `agents.<agent>.model`.
4. For captain judge decisions, `workflow.role_models.judge` overrides `captain.model`.

### Custom Agents

Add any CLI tool as an agent using the `generic` adapter:

```yaml
agents:
  my-tool:
    adapter: generic
    command: "my-tool"
    args: ["--prompt", "{{prompt}}", "--output", "json"]
    capabilities: [analyze]
```

Example for a local Gemma model via `ollama`:

```bash
crew config add-agent local-gemma --adapter generic --command ollama --args run,gemma4:latest,{{prompt}} --capabilities implement,review
crew config set captain.cli local-gemma
```

**Structured output caveat.** The `generic` adapter does not natively enforce
JSON schemas (generic CLIs have no universal mechanism for this). When an
captain step requires structured output, the framework falls back to
prompted JSON: the schema is appended to the prompt, stdout is parsed, and
validated with Zod — retrying once with validation errors if the first
attempt is malformed. Reliability depends on the underlying tool's ability
to follow JSON instructions precisely; tools that wrap output in markdown
fences, prepend prose, or truncate will retry until the retry budget is
exhausted. For the captain role itself, prefer `codex` or
`claude-code`, which support native JSON-schema enforcement.

## Project Structure

```
src/
├── adapters/          # CLI agent adapters (Claude, Codex, Gemini, generic)
├── captain/           # Session-loop runner + 8-tool surface
│   ├── tools/         # run_agent, list_agents, ask_user, message_user,
│   │                  # plan_tasks, analyze_output, compress_context, finish
│   └── steps/         # decompose / ingest / summarize (wrapped by the
│                      # optional plan_tasks / analyze_output / compress_context
│                      # tools — the captain reasons inline for typical cases)
├── cli/
│   ├── commands/      # run, init, status
│   └── ui/            # Ink/React terminal components
├── git/               # Worktree isolation and merge
├── state/             # File-based persistence (.crew/)
├── workflow/          # YAML config loading
└── utils/             # JSON parsing, validation, logging
```

## Development

```bash
# Watch mode (rebuilds on changes)
npm run dev

# Run tests
npm test

# Run tests once
npm run test:run

# Type-check
npm run lint

# Build
npm run build
```

## Architecture

- **Adapters** wrap CLI tools behind a common `AgentAdapter` interface — `execute()`, `executeWithSchema()`, `executeWithTools()`, `healthCheck()`.
- **JudgmentRunner** drives the captain via a `SessionLoop` over an 8-tool MCP surface. The captain writes subagent prompts inline via `run_agent` and reasons about tool results inline; three wrapper tools (`plan_tasks`, `analyze_output`, `compress_context`) are opt-in when a request genuinely benefits from structured intermediate output.
- **Worktrees** give each dispatched `run_agent` its own `.crew/runs/<runId>/worktree/`; the dispatcher's terminal-event listener cleans up on success, failure, or cancellation.
- **State** persists to `.crew/` as JSON files — active workflow state in `state.json` and the durable captain-session message log in `session.json`.
- **Context management** is tiered: session-log message history for the current run, with an opt-in `compress_context` tool when the operating guardrails render the compression advisory (≥ 15 messages since last compression AND ≥ 100 KB of log).

## License

MIT
