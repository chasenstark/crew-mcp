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

# 2. Initialize config in your project
cd /path/to/your/project
orchestrator init

# 3. Run a workflow
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
```

### `orchestrator init`

Creates `.orchestra/workflow.yaml` in the current project with the default workflow configuration.

### `orchestrator status`

Health-checks all registered agents and shows which are installed and authenticated.

```
  ✓ claude-code (1.0.23): ready
  ✗ codex: not installed
```

### `orchestrator resume`

Checks for an interrupted workflow (saved in `.orchestra/state.json`) and displays its status.

## Configuration

After running `orchestrator init`, edit `.orchestra/workflow.yaml` to customize the workflow:

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
    strengths: [implementation, refactoring, TypeScript, React]

  codex:
    adapter: codex
    strengths: [review, testing, Python, security]

orchestrator:
  cli: claude-code

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
    strengths: [analysis]
```

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
- **State** persists to `.orchestra/` as JSON files — workflow state, pass summaries, and conversation history
- **Context management** is tiered: full output for the current pass, structured summaries for previous passes, compressed one-liners for older passes

## License

MIT
