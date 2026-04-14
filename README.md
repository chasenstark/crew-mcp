# orchestrator

A CLI tool that lets you talk to one AI agent that manages others. You describe what you want built — the orchestrator decomposes the work, dispatches it to coding agents (Claude Code, Codex, or any CLI-based agent), reviews the output, iterates, and reports back.

No API keys required. Uses CLI subscription auth for everything.

```
User: "Build a DatePicker component. Claude builds, Codex reviews."

  → Orchestrator decomposes into tasks
  → Claude Code implements the component (in an isolated git worktree)
  → Codex reviews the code
  → Orchestrator evaluates findings
  → Claude Code fixes issues
  → Codex re-reviews → clean
  → "Done. 2 passes, all issues resolved. Want a PR?"
```

## How It Works

The orchestrator runs a **6-step pipeline** for each workflow cycle:

| Step | Purpose |
|------|---------|
| **Decompose** | Break the request into tasks, assign agents |
| **Dispatch** | Craft a focused prompt for the assigned agent |
| **Ingest** | Parse agent output, extract structured findings |
| **Summarize** | Compress results for future context |
| **Judge** | Decide: done, iterate, or ask the user |
| **Report** | Summarize results in natural language |

Each agent works in its own **git worktree** — full repo access, zero interference. The orchestrator uses **Zod schemas** with native JSON schema enforcement for structured LLM output at every step.

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
git clone <repo-url> && cd orchestrator
npm install

# Build
npm run build

# Link globally (optional)
npm link
```

## Quick Start

```bash
# 1. Check which agents are available
orchestrator status

# 2. Select project-local config scope (recommended)
cd /path/to/your/project
orchestrator config scope project

# 3. Configure via interactive wizard (or use config set commands)
orchestrator config

# 4. Run a workflow
orchestrator run "Build a DatePicker component with tests"

# Or enter interactive mode
orchestrator run
```

## Commands

### `orchestrator run [prompt]`

Start a workflow. With a prompt, runs non-interactively and prints progress to the terminal. Without a prompt, opens an interactive conversation UI.

```bash
# Non-interactive
orchestrator run "Add email validation to the signup form"

# Interactive mode
orchestrator run

# Non-interactive input policy when the workflow needs clarification
orchestrator run "Add email validation to the signup form" --on-ask-user prompt

# Verbose debugging logs
orchestrator --debug run "Add email validation to the signup form"
```

Each run writes a log file to `.orchestra/logs/run-<timestamp>.log`.
Use `--debug` (or `ORCHESTRATOR_LOG_LEVEL=debug`) to include detailed adapter/process diagnostics.

### `orchestrator init [--project]`

Creates `workflow.yaml` with the default workflow configuration.

- Default: global config at `~/.orchestra/workflow.yaml`
- With `--project`: project config at `./.orchestra/workflow.yaml`
- Compatibility command. Preferred setup/edit flow is `orchestrator config`.

### `orchestrator config`

Interactive and command-based configuration management.
The wizard is keyboard-driven: use `↑` / `↓` to highlight options and press `Enter` to select.
For each field, you can also choose `[Custom value...]` or `[Keep current value]`.
If your workflow has no review step, reviewer-pass settings are skipped automatically.

```bash
# Interactive wizard
orchestrator config

# Show effective config + active scope
orchestrator config show

# Set values
orchestrator config set orchestrator.cli codex
orchestrator config set orchestrator.model claude-sonnet-4-5
orchestrator config set orchestrator.model next
orchestrator config set agents.codex.model gpt-5.4
orchestrator config set agents.codex.model prev
orchestrator config set workflow.reviewer.maxPasses 3
orchestrator config set errorHandling.default.retry 1

# Scope management
orchestrator config scope
orchestrator config scope project
orchestrator config scope global

# Reset a scope to defaults
orchestrator config reset --scope project
```

In interactive `orchestrator run` mode, `/config` slash commands are also available:

```text
/config
/config show
/config scope
/config scope project
/config set orchestrator.cli codex
/config reset
```

### `orchestrator status`

Health-checks all registered agents and shows which are installed and authenticated.

```
  ✓ claude-code (1.0.23): ready
  ✗ codex: not installed
```

### `orchestrator resume`

Resumes an interrupted workflow from `.orchestra/state.json`.

```bash
# Resume and fail if user input is required
orchestrator resume

# Resume and prompt in terminal if user input is required
orchestrator resume --on-ask-user prompt
```

## Configuration

Primary path: use `orchestrator config` and `/config` commands.

Advanced/legacy path: edit `.orchestra/workflow.yaml` manually if needed:

```yaml
workflow:
  name: default
  steps:
    - role: coder
      agent: claude-code
      action: implement

    - role: reviewer
      agent: codex
      action: review
      max_passes: 3

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
    strengths: [review, testing, Python, security]

orchestrator:
  cli: claude-code
  model: claude-sonnet-4-5

error_handling:
  default:
    retry: 1
    on_exhausted: ask_user
```

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

**Structured output caveat.** The `generic` adapter does not natively enforce
JSON schemas (generic CLIs have no universal mechanism for this). When an
orchestrator step requires structured output, the framework falls back to
prompted JSON: the schema is appended to the prompt, stdout is parsed, and
validated with Zod — retrying once with validation errors if the first
attempt is malformed. Reliability depends on the underlying tool's ability
to follow JSON instructions precisely; tools that wrap output in markdown
fences, prepend prose, or truncate will retry until the retry budget is
exhausted. For the orchestrator role itself, prefer `codex` or
`claude-code`, which support native JSON-schema enforcement.

## Project Structure

```
src/
├── adapters/          # CLI agent adapters (Claude, Codex, generic)
├── orchestrator/      # 6-step pipeline, schemas, prompts
│   └── steps/         # Individual pipeline steps
├── cli/
│   ├── commands/      # run, init, resume, status
│   └── ui/            # Ink/React terminal components
├── git/               # Worktree isolation and merge
├── state/             # File-based persistence (.orchestra/)
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
- **Worktrees** give each agent an isolated git branch/directory under `.orchestra/worktrees/`
- **State** persists to `.orchestra/` as JSON files — active workflow state in `state.json` and run-scoped artifacts under `.orchestra/runs/<runId>/`
- **Context management** is tiered: full output for the current pass, structured summaries for previous passes, compressed one-liners for older passes

## License

MIT
