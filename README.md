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

The captain runs a **6-step pipeline** for each workflow cycle:

| Step | Purpose |
|------|---------|
| **Decompose** | Break the request into tasks, assign agents |
| **Dispatch** | Craft a focused prompt for the assigned agent |
| **Ingest** | Parse agent output, extract structured findings |
| **Summarize** | Compress results for future context |
| **Judge** | Decide: done, iterate, or ask the user |
| **Report** | Summarize results in natural language |

Each agent works in its own **git worktree** — full repo access, zero interference. The captain uses **Zod schemas** with native JSON schema enforcement for structured LLM output at every step.

## Architecture Notes

- Runner core and policy split: `docs/architecture/runners.md`
- Adapter tool-loop abstraction: `docs/architecture/adapters.md`
- Declarative config path registry: `docs/architecture/config-registry.md`

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

### `crew resume`

Resumes an interrupted workflow from `.crew/state.json`.

```bash
# Resume and fail if user input is required
crew resume

# Resume and prompt in terminal if user input is required
crew resume --on-ask-user prompt
```

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
├── adapters/          # CLI agent adapters (Claude, Codex, generic)
├── captain/      # 6-step pipeline, schemas, prompts
│   └── steps/         # Individual pipeline steps
├── cli/
│   ├── commands/      # run, init, resume, status
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

- **Adapters** wrap CLI tools behind a common `AgentAdapter` interface — `execute()`, `executeWithSchema()`, `healthCheck()`
- **Pipeline** orchestrates the 6-step cycle with an `EventEmitter` for UI updates
- **Worktrees** give each agent an isolated git branch/directory under `.crew/worktrees/`
- **State** persists to `.crew/` as JSON files — active workflow state in `state.json` and run-scoped artifacts under `.crew/runs/<runId>/`
- **Context management** is tiered: full output for the current pass, structured summaries for previous passes, compressed one-liners for older passes

## License

MIT
