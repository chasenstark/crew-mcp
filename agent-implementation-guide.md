# Agent Implementation Guide: Provider-Agnostic Agent Orchestration CLI

> **This document is a complete implementation specification.** It contains everything
> needed to build the MVP from scratch. Follow the phases in order — each phase builds
> on the previous one. Do not skip ahead.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Tech Stack & Dependencies](#3-tech-stack--dependencies)
4. [Project Structure](#4-project-structure)
5. [Phase 0: Scaffold](#5-phase-0-scaffold)
6. [Phase 1: CLI Adapters](#6-phase-1-cli-adapters)
7. [Phase 2: Orchestrator Core](#7-phase-2-orchestrator-core)
8. [Phase 3: Git Worktrees](#8-phase-3-git-worktrees)
9. [Phase 4: State Persistence](#9-phase-4-state-persistence)
10. [Phase 5: CLI & Conversation UI](#10-phase-5-cli--conversation-ui)
11. [Phase 6: Integration & Testing](#11-phase-6-integration--testing)
12. [Appendix A: Complete Zod Schemas](#appendix-a-complete-zod-schemas)
13. [Appendix B: Complete System Prompts](#appendix-b-complete-system-prompts)
14. [Appendix C: Default Workflow YAML](#appendix-c-default-workflow-yaml)
15. [Appendix D: Few-Shot Decomposition Examples](#appendix-d-few-shot-decomposition-examples)

---

## 1. Project Overview

### What We're Building

A CLI tool that lets a solo developer have a conversation with one LLM (the "orchestrator"),
which autonomously delegates coding and review tasks to other AI coding agents (Claude Code,
Codex CLI, Gemini CLI, or any CLI-based agent). The user talks to one agent; that agent
manages everything else.

### Core Concept

```
User: "Build a DatePicker component. Claude builds, Codex reviews."

  → Orchestrator LLM decomposes the request into tasks
  → Dispatches implementation task to Claude Code CLI (in a git worktree)
  → Claude Code writes the component
  → Dispatches review task to Codex CLI (reads same worktree)
  → Codex reviews the code, finds issues
  → Orchestrator evaluates review findings
  → Dispatches fix task back to Claude Code
  → Codex re-reviews → clean
  → Orchestrator reports back to user: "Done. Want a PR?"
```

### Key Design Decisions (Already Made)

| Decision | Resolution |
|----------|-----------|
| Primary interface | Conversational CLI (Ink/React for terminal) |
| Target user | Solo dev already using AI coding agents |
| Unit of work | Feature-level and task-level |
| Agent routing | Configurable defaults, user can override in conversation |
| Work sharing | Hybrid — filesystem (git worktrees) + orchestrator-curated context |
| Workflow enforcement | Opinionated defaults, fully configurable via YAML |
| Agent adapters | Built-in for Claude Code + Codex, plus generic escape hatch |
| Language | TypeScript/Node |
| Auth | CLI subscription auth everywhere — zero API keys required |
| Orchestrator output format | Native JSON schema enforcement via CLI flags (with prompted-JSON fallback) |
| Context management | Tiered — full output for current pass, summaries for older passes |
| Result passing | Orchestrator LLM decides what's relevant to forward |
| Error handling | Configurable retry/fallback per workflow step |
| State persistence | Yes — `.orchestra/` directory, resumable workflows |
| Packaging | CLI first (`npx` or global install) |

### Positioning

"Gas Town is Kubernetes for agents. This is Docker Compose."

---

## 2. Architecture

### System Diagram

```
┌─────────────────────────────────────────────────┐
│                  User (CLI)                      │
│         Ink-based conversational interface        │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│              Orchestrator LLM                    │
│    (any CLI: claude -p, codex exec, etc.)        │
│    Reasoning via subscription auth — no API keys │
│                                                  │
│  Runs a 6-step pipeline per workflow cycle:       │
│  DECOMPOSE → DISPATCH → INGEST →                 │
│  SUMMARIZE → JUDGE → REPORT                      │
└───────┬──────────┬──────────┬───────────────────┘
        │          │          │
        ▼          ▼          ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│ Adapter: │ │ Adapter: │ │ Adapter: │
│ Claude   │ │ Codex    │ │ Generic  │
│ Code CLI │ │ CLI      │ │ (any)    │
└──────────┘ └──────────┘ └──────────┘
        │          │          │
        ▼          ▼          ▼
   [git worktree] [git worktree] [git worktree]
         \         |         /
          \        |        /
           ▼       ▼       ▼
        Shared Repository (main)
```

### The 6-Step Orchestrator Pipeline

Every workflow cycle runs these steps as separate LLM calls:

1. **DECOMPOSE** — Break user request into tasks, assign agents
2. **DISPATCH** — Craft a focused prompt for the assigned agent
3. **INGEST** — Parse agent output, extract structured findings
4. **SUMMARIZE** — Compress current pass into summary for future context
5. **JUDGE** — Decide: done / iterate / ask user
6. **REPORT** — Summarize results for user in natural language

Each step (except REPORT) produces validated JSON output. The orchestrator uses
native `--json-schema` / `--output-schema` CLI flags when available, with a
prompted-JSON + Zod validation fallback for generic adapters.

### Context Management Strategy

| Pass | Context treatment |
|------|------------------|
| Current pass | Full agent output — orchestrator needs complete fidelity |
| Previous pass | Structured summary: what was attempted, found, decided |
| Older passes | Compressed to single paragraph of key decisions |

After each step, the orchestrator summarizes before moving on. This keeps the
context window bounded even over many review iterations.

---

## 3. Tech Stack & Dependencies

### Production Dependencies

```json
{
  "commander": "^12.0.0",
  "ink": "^5.0.0",
  "ink-text-input": "^6.0.0",
  "react": "^18.0.0",
  "zod": "^3.23.0",
  "zod-to-json-schema": "^3.23.0",
  "yaml": "^2.4.0",
  "cosmiconfig": "^9.0.0",
  "execa": "^9.0.0",
  "simple-git": "^3.25.0",
  "eventemitter3": "^5.0.0",
  "chalk": "^5.3.0"
}
```

### Dev Dependencies

```json
{
  "typescript": "^5.5.0",
  "tsup": "^8.0.0",
  "vitest": "^2.0.0",
  "@types/react": "^18.0.0",
  "@types/node": "^20.0.0",
  "ink-testing-library": "^4.0.0"
}
```

### System Requirements

- Node.js 20+
- Git 2.25+ (for worktree support)
- At least one of: Claude Code CLI (`@anthropic-ai/claude-code`), Codex CLI (`@openai/codex`)
- Authenticated CLI sessions (subscription auth via browser login)

---

## 4. Project Structure

Create this exact directory structure:

```
[project-name]/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── README.md
├── .gitignore
│
├── src/
│   ├── index.ts                        # CLI entry point
│   │
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── run.ts                  # Main command: start a workflow
│   │   │   ├── resume.ts              # Resume interrupted workflow
│   │   │   ├── init.ts                # Initialize config in a project
│   │   │   └── status.ts             # Check agent/workflow status
│   │   └── ui/
│   │       ├── App.tsx                 # Root Ink component
│   │       ├── ConversationView.tsx   # Chat message display
│   │       ├── AgentStatus.tsx        # Live agent status panel
│   │       └── PromptInput.tsx        # User text input
│   │
│   ├── orchestrator/
│   │   ├── index.ts                    # Orchestrator public API
│   │   ├── pipeline.ts                # 6-step pipeline runner
│   │   ├── steps/
│   │   │   ├── decompose.ts           # Step 1
│   │   │   ├── dispatch.ts            # Step 2
│   │   │   ├── ingest.ts              # Step 3
│   │   │   ├── summarize.ts          # Step 4
│   │   │   ├── judge.ts              # Step 5
│   │   │   └── report.ts             # Step 6
│   │   ├── schemas.ts                 # All Zod schemas in one file
│   │   └── prompts.ts                 # All system prompt templates
│   │
│   ├── adapters/
│   │   ├── types.ts                    # AgentAdapter interface
│   │   ├── registry.ts                # Adapter registry / factory
│   │   ├── claude-code.ts             # Claude Code CLI adapter
│   │   ├── codex.ts                   # Codex CLI adapter
│   │   └── generic.ts                 # Generic CLI adapter
│   │
│   ├── workflow/
│   │   ├── types.ts                    # WorkflowConfig types
│   │   ├── loader.ts                  # Load + validate workflow YAML
│   │   └── defaults.ts               # Default workflow definition
│   │
│   ├── state/
│   │   ├── types.ts                    # State types
│   │   ├── store.ts                   # Read/write .orchestra/ state
│   │   └── context.ts                 # Build orchestrator context from state
│   │
│   ├── git/
│   │   ├── worktree.ts                # Create/manage worktrees
│   │   └── merge.ts                   # Merge worktree changes
│   │
│   └── utils/
│       ├── json-parse.ts              # Robust JSON extraction
│       ├── validate.ts                # Zod validation with retry
│       └── logger.ts                  # Structured logging
│
├── defaults/
│   ├── workflow.yaml                   # Default workflow config
│   └── examples/                       # Few-shot decomposition examples
│       ├── feature.json
│       ├── bugfix.json
│       └── refactor.json
│
└── test/
    ├── adapters/
    │   ├── claude-code.test.ts
    │   ├── codex.test.ts
    │   └── fixtures/
    │       ├── claude-success.json     # Sample Claude Code JSON output
    │       ├── claude-error.json
    │       ├── claude-structured.json
    │       ├── codex-success.jsonl     # Sample Codex JSONL output
    │       ├── codex-error.jsonl
    │       └── codex-structured.json
    ├── orchestrator/
    │   ├── decompose.test.ts
    │   ├── judge.test.ts
    │   └── pipeline.test.ts
    ├── workflow/
    │   └── loader.test.ts
    └── state/
        └── store.test.ts
```

---

## 5. Phase 0: Scaffold

**Goal:** Empty CLI that runs, prints help, has build pipeline working.
**Time estimate:** ~2 hours

### Step 0.1: Initialize the project

```bash
mkdir [project-name] && cd [project-name]
pnpm init
```

### Step 0.2: Create package.json

```json
{
  "name": "[project-name]",
  "version": "0.1.0",
  "description": "Provider-agnostic agent orchestration through conversation",
  "type": "module",
  "bin": {
    "[project-name]": "./dist/index.js"
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest",
    "test:run": "vitest run",
    "lint": "tsc --noEmit",
    "prepublishOnly": "pnpm build"
  },
  "engines": {
    "node": ">=20"
  },
  "files": [
    "dist",
    "defaults"
  ],
  "keywords": [
    "ai", "agent", "orchestrator", "claude", "codex", "multi-agent", "cli"
  ]
}
```

### Step 0.3: Create tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "jsx": "react-jsx",
    "jsxImportSource": "react"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

### Step 0.4: Create tsup.config.ts

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
```

### Step 0.5: Create vitest.config.ts

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
```

### Step 0.6: Create .gitignore

```
node_modules/
dist/
*.tsbuildinfo

# Orchestrator state (project-specific, not committed)
.orchestra/worktrees/
.orchestra/state.json
.orchestra/passes/
.orchestra/summaries/
.orchestra/conversation.json

# Keep the workflow config
!.orchestra/workflow.yaml
```

### Step 0.7: Install dependencies

```bash
pnpm add commander ink ink-text-input react zod zod-to-json-schema yaml cosmiconfig execa simple-git eventemitter3 chalk
pnpm add -D typescript tsup vitest @types/react @types/node ink-testing-library
```

### Step 0.8: Create CLI entry point

```typescript
// src/index.ts
import { program } from 'commander';

program
  .name('[project-name]')
  .description('Provider-agnostic agent orchestration through conversation')
  .version('0.1.0');

program
  .command('run')
  .description('Start a new workflow or enter conversation mode')
  .argument('[prompt]', 'Initial prompt (or enter interactive mode)')
  .action(async (prompt?: string) => {
    if (prompt) {
      console.log(`Starting workflow: "${prompt}"`);
    } else {
      console.log('Entering interactive mode...');
    }
    console.log('(Not yet implemented — Phase 5)');
  });

program
  .command('init')
  .description('Initialize orchestrator config in the current project')
  .action(async () => {
    console.log('Initializing config...');
    console.log('(Not yet implemented — Phase 0 completion)');
  });

program
  .command('resume')
  .description('Resume an interrupted workflow')
  .action(async () => {
    console.log('Checking for interrupted workflows...');
    console.log('(Not yet implemented — Phase 4)');
  });

program
  .command('status')
  .description('Check status of available agents')
  .action(async () => {
    console.log('Checking agent status...');
    console.log('(Not yet implemented — Phase 1)');
  });

program.parse();
```

### Step 0.9: Verify the build

```bash
pnpm build
node dist/index.js --help
node dist/index.js run "test prompt"
node dist/index.js init
```

All commands should run without errors, printing placeholder messages.

### Step 0.10: Create initial test

```typescript
// test/smoke.test.ts
import { describe, it, expect } from 'vitest';

describe('smoke test', () => {
  it('passes', () => {
    expect(true).toBe(true);
  });
});
```

```bash
pnpm test:run
```

### Phase 0 Checklist

- [ ] Project initialized with pnpm
- [ ] All dependencies installed
- [ ] TypeScript compiles without errors
- [ ] `pnpm build` produces `dist/index.js`
- [ ] CLI runs: `node dist/index.js --help` shows commands
- [ ] `pnpm test:run` passes
- [ ] Git repo initialized with .gitignore

---

## 6. Phase 1: CLI Adapters

**Goal:** Can invoke Claude Code and Codex CLI headlessly and get structured output back.
**Time estimate:** ~3 hours
**This is the go/no-go gate for the entire project.**

### Important Context: CLI Output Formats

**Claude Code CLI** (`claude -p "prompt" --output-format json`) returns a **single JSON object**:

```json
{
  "type": "result",
  "subtype": "success",
  "result": "The model's text response...",
  "session_id": "uuid-here",
  "total_cost_usd": 0.042,
  "duration_ms": 3200,
  "num_turns": 1,
  "is_error": false
}
```

When `--json-schema` is used, structured data appears in `structured_output`:

```json
{
  "type": "result",
  "subtype": "success",
  "result": "...",
  "structured_output": { "your": "schema-validated data" },
  "session_id": "...",
  "total_cost_usd": 0.05
}
```

**Codex CLI** (`codex exec "prompt" --json`) returns **JSONL (newline-delimited JSON)**:

```jsonl
{"type":"thread.started","thread_id":"thread_abc123"}
{"type":"turn.started","turn_id":"turn_1"}
{"type":"item.agent_message","content":"I'll analyze the code..."}
{"type":"item.command_execution","command":"cat src/auth.ts","exit_code":0}
{"type":"item.file_change","path":"src/auth.ts","action":"modified"}
{"type":"turn.completed","turn_id":"turn_1"}
```

Codex also supports `--output-schema schema.json -o result.json` for structured output
written directly to a file.

### Step 1.1: Create the adapter interface

```typescript
// src/adapters/types.ts
import type { z } from 'zod';

export interface AgentAdapter {
  readonly name: string;
  readonly capabilities: AgentCapability[];
  readonly supportsJsonSchema: boolean;

  /**
   * Execute a task and return the result.
   * Used for worker agents performing coding/review tasks.
   */
  execute(task: Task): Promise<TaskResult>;

  /**
   * Execute with native JSON schema enforcement.
   * Used for orchestrator reasoning calls where we need structured output.
   * Only available when supportsJsonSchema is true.
   */
  executeWithSchema?<T extends z.ZodType>(
    prompt: string,
    schema: T,
    options?: ExecuteOptions,
  ): Promise<z.infer<T>>;

  /**
   * Check if the CLI is installed and authenticated.
   */
  healthCheck(): Promise<HealthCheckResult>;
}

export type AgentCapability =
  | 'implement'
  | 'review'
  | 'refactor'
  | 'test'
  | 'document'
  | 'analyze';

export interface Task {
  /** The prompt to send to the agent */
  prompt: string;

  context: {
    /** Working directory (git worktree path) for the agent */
    workingDirectory: string;
    /** Specific files the agent should focus on */
    files?: string[];
    /** Results from previous workflow steps */
    previousResults?: TaskResult[];
  };

  constraints?: {
    /** Timeout in milliseconds (default: 300000 = 5 min) */
    timeout?: number;
    /** Maximum tool-use turns (default: 50) */
    maxTurns?: number;
    /** Sandbox mode for the agent */
    sandbox?: 'read-only' | 'workspace-write' | 'full-access';
  };
}

export interface TaskResult {
  /** The agent's text response */
  output: string;
  /** Files created or modified by the agent */
  filesModified: string[];
  /** Whether the task completed successfully */
  status: 'success' | 'error' | 'partial';
  /** Session ID for potential resumption */
  sessionId?: string;
  /** Additional metadata */
  metadata: {
    costUsd?: number;
    durationMs?: number;
    numTurns?: number;
    /** Raw Codex JSONL events (for debugging) */
    rawEvents?: unknown[];
  };
}

export interface HealthCheckResult {
  available: boolean;
  version?: string;
  authenticated: boolean;
  error?: string;
}

export interface ExecuteOptions {
  workingDirectory?: string;
  timeout?: number;
  maxTurns?: number;
}
```

### Step 1.2: Build the Claude Code adapter

```typescript
// src/adapters/claude-code.ts
import { execa } from 'execa';
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  AgentAdapter,
  AgentCapability,
  Task,
  TaskResult,
  HealthCheckResult,
  ExecuteOptions,
} from './types.js';

/** Response shape from `claude -p --output-format json` */
interface ClaudeJsonResponse {
  type: string;
  subtype?: string;
  result: string;
  structured_output?: unknown;
  session_id: string;
  total_cost_usd?: number;
  cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  is_error?: boolean;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = 'claude-code';
  readonly capabilities: AgentCapability[] = [
    'implement', 'review', 'refactor', 'test', 'document', 'analyze',
  ];
  readonly supportsJsonSchema = true;

  async execute(task: Task): Promise<TaskResult> {
    const args = this.buildArgs(task);

    try {
      const result = await execa('claude', args, {
        cwd: task.context.workingDirectory,
        timeout: task.constraints?.timeout ?? 300_000,
        reject: false, // don't throw on non-zero exit
      });

      // Handle complete CLI failure (no output at all)
      if (result.exitCode !== 0 && !result.stdout.trim()) {
        return {
          output: result.stderr || `Claude Code exited with code ${result.exitCode}`,
          filesModified: [],
          status: 'error',
          metadata: {},
        };
      }

      const parsed = this.parseJsonOutput(result.stdout);

      return {
        output: parsed.result ?? '',
        filesModified: [], // Claude doesn't report this — detect via git diff
        status: parsed.is_error ? 'error' : 'success',
        sessionId: parsed.session_id,
        metadata: {
          costUsd: parsed.total_cost_usd ?? parsed.cost_usd,
          durationMs: parsed.duration_ms,
          numTurns: parsed.num_turns,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return {
        output: message,
        filesModified: [],
        status: 'error',
        metadata: {},
      };
    }
  }

  async executeWithSchema<T extends z.ZodType>(
    prompt: string,
    schema: T,
    options?: ExecuteOptions,
  ): Promise<z.infer<T>> {
    const jsonSchema = zodToJsonSchema(schema, { target: 'jsonSchema7' });

    const args: string[] = [
      '-p', prompt,
      '--output-format', 'json',
      '--json-schema', JSON.stringify(jsonSchema),
      '--dangerously-skip-permissions',
    ];

    if (options?.maxTurns) {
      args.push('--max-turns', String(options.maxTurns));
    }

    const result = await execa('claude', args, {
      cwd: options?.workingDirectory ?? process.cwd(),
      timeout: options?.timeout ?? 120_000,
    });

    const parsed = this.parseJsonOutput(result.stdout);

    if (parsed.is_error) {
      throw new Error(`Claude Code error: ${parsed.result}`);
    }

    // When --json-schema is used, validated output is in structured_output
    const data = parsed.structured_output ?? JSON.parse(parsed.result);
    return schema.parse(data);
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const versionResult = await execa('claude', ['--version'], {
        timeout: 5_000,
        reject: false,
      });

      if (versionResult.exitCode !== 0) {
        return { available: false, authenticated: false, error: 'CLI not found or errored' };
      }

      // Quick auth check with a minimal prompt
      const authCheck = await execa('claude', [
        '-p', 'Respond with the single word: ok',
        '--output-format', 'json',
        '--max-turns', '1',
        '--dangerously-skip-permissions',
      ], { timeout: 30_000, reject: false });

      const authenticated = authCheck.exitCode === 0;

      return {
        available: true,
        version: versionResult.stdout.trim(),
        authenticated,
      };
    } catch {
      return { available: false, authenticated: false, error: 'Claude Code CLI not found' };
    }
  }

  private buildArgs(task: Task): string[] {
    const args: string[] = [
      '-p', task.prompt,
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ];

    if (task.constraints?.maxTurns) {
      args.push('--max-turns', String(task.constraints.maxTurns));
    }

    return args;
  }

  private parseJsonOutput(stdout: string): ClaudeJsonResponse {
    const trimmed = stdout.trim();

    // Claude Code outputs a single JSON object
    try {
      return JSON.parse(trimmed);
    } catch {
      // Sometimes the output has extra text before/after the JSON
      const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      throw new Error(`Failed to parse Claude Code output as JSON: ${trimmed.slice(0, 200)}`);
    }
  }
}
```

### Step 1.3: Build the Codex adapter

```typescript
// src/adapters/codex.ts
import { execa } from 'execa';
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { writeFileSync, readFileSync, mkdtempSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type {
  AgentAdapter,
  AgentCapability,
  Task,
  TaskResult,
  HealthCheckResult,
  ExecuteOptions,
} from './types.js';

/** A single event from Codex's JSONL output */
interface CodexEvent {
  type: string;
  [key: string]: unknown;
}

export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex';
  readonly capabilities: AgentCapability[] = [
    'implement', 'review', 'test', 'analyze',
  ];
  readonly supportsJsonSchema = true;

  async execute(task: Task): Promise<TaskResult> {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orchestrator-codex-'));
    const outputFile = join(tmpDir, 'output.txt');

    const args = this.buildArgs(task, outputFile);

    try {
      const result = await execa('codex', args, {
        cwd: task.context.workingDirectory,
        timeout: task.constraints?.timeout ?? 300_000,
        reject: false,
      });

      // Parse JSONL events from stdout
      const events = this.parseJsonlOutput(result.stdout);

      // Extract file changes
      const fileChanges = events
        .filter(e => e.type === 'item.file_change')
        .map(e => String(e.path ?? e.file ?? ''))
        .filter(Boolean);

      // Detect errors
      const errors = events.filter(
        e => e.type === 'error' || e.type === 'turn.failed'
      );

      // Get final message: prefer output file, fall back to JSONL events
      let finalMessage = '';
      if (existsSync(outputFile)) {
        try {
          finalMessage = readFileSync(outputFile, 'utf-8').trim();
        } catch { /* fall through to JSONL extraction */ }
      }

      if (!finalMessage) {
        const agentMessages = events.filter(
          e => e.type === 'item.agent_message'
        );
        const lastMessage = agentMessages[agentMessages.length - 1];
        finalMessage = String(lastMessage?.content ?? lastMessage?.text ?? '');
      }

      return {
        output: finalMessage,
        filesModified: fileChanges,
        status: result.exitCode !== 0 || errors.length > 0 ? 'error' : 'success',
        metadata: {
          rawEvents: events,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return {
        output: message,
        filesModified: [],
        status: 'error',
        metadata: {},
      };
    }
  }

  async executeWithSchema<T extends z.ZodType>(
    prompt: string,
    schema: T,
    options?: ExecuteOptions,
  ): Promise<z.infer<T>> {
    const jsonSchema = zodToJsonSchema(schema, { target: 'jsonSchema7' });

    const tmpDir = mkdtempSync(join(tmpdir(), 'orchestrator-codex-'));
    const schemaFile = join(tmpDir, 'schema.json');
    const outputFile = join(tmpDir, 'result.json');

    writeFileSync(schemaFile, JSON.stringify(jsonSchema, null, 2));

    const args: string[] = [
      'exec', prompt,
      '--output-schema', schemaFile,
      '-o', outputFile,
      '--sandbox', 'read-only',
    ];

    await execa('codex', args, {
      cwd: options?.workingDirectory ?? process.cwd(),
      timeout: options?.timeout ?? 120_000,
    });

    if (!existsSync(outputFile)) {
      throw new Error('Codex did not produce output file');
    }

    const rawResult = readFileSync(outputFile, 'utf-8');
    const data = JSON.parse(rawResult);
    return schema.parse(data);
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const result = await execa('codex', ['--help'], {
        timeout: 5_000,
        reject: false,
      });

      return {
        available: result.exitCode === 0,
        authenticated: true, // Auth errors surface on exec, not on --help
      };
    } catch {
      return { available: false, authenticated: false, error: 'Codex CLI not found' };
    }
  }

  private buildArgs(task: Task, outputFile: string): string[] {
    const args: string[] = [
      'exec', task.prompt,
      '--json',
      '-o', outputFile,
    ];

    const sandbox = task.constraints?.sandbox ?? 'workspace-write';
    args.push('--sandbox', sandbox);

    return args;
  }

  private parseJsonlOutput(stdout: string): CodexEvent[] {
    return stdout
      .trim()
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line) as CodexEvent;
        } catch {
          return null;
        }
      })
      .filter((event): event is CodexEvent => event !== null);
  }
}
```

### Step 1.4: Build the generic adapter (fallback)

```typescript
// src/adapters/generic.ts
import { execa } from 'execa';
import type {
  AgentAdapter,
  AgentCapability,
  Task,
  TaskResult,
  HealthCheckResult,
} from './types.js';

/**
 * Generic adapter for any CLI tool that accepts a prompt and returns text.
 * Used as a fallback when no specific adapter exists.
 *
 * Configured via workflow YAML:
 *   agents:
 *     my-agent:
 *       adapter: generic
 *       command: "my-tool"
 *       args: ["--prompt", "{{prompt}}", "--output", "json"]
 */
export class GenericAdapter implements AgentAdapter {
  readonly supportsJsonSchema = false;

  constructor(
    readonly name: string,
    private command: string,
    private argsTemplate: string[] = [],
    readonly capabilities: AgentCapability[] = ['implement', 'review'],
  ) {}

  async execute(task: Task): Promise<TaskResult> {
    // Replace {{prompt}} placeholder in args template
    const args = this.argsTemplate.map(arg =>
      arg.replace('{{prompt}}', task.prompt)
    );

    // If no {{prompt}} in template, pass prompt as last arg
    if (!this.argsTemplate.some(a => a.includes('{{prompt}}'))) {
      args.push(task.prompt);
    }

    try {
      const result = await execa(this.command, args, {
        cwd: task.context.workingDirectory,
        timeout: task.constraints?.timeout ?? 300_000,
        reject: false,
      });

      return {
        output: result.stdout,
        filesModified: [],
        status: result.exitCode === 0 ? 'success' : 'error',
        metadata: {},
      };
    } catch (err: unknown) {
      return {
        output: err instanceof Error ? err.message : 'Unknown error',
        filesModified: [],
        status: 'error',
        metadata: {},
      };
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      await execa('which', [this.command], { timeout: 5_000 });
      return { available: true, authenticated: true };
    } catch {
      return { available: false, authenticated: false, error: `${this.command} not found` };
    }
  }
}
```

### Step 1.5: Build the adapter registry

```typescript
// src/adapters/registry.ts
import type { AgentAdapter } from './types.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexAdapter } from './codex.js';
import { GenericAdapter } from './generic.js';

export class AdapterRegistry {
  private adapters = new Map<string, AgentAdapter>();

  constructor() {
    // Register built-in adapters
    this.register(new ClaudeCodeAdapter());
    this.register(new CodexAdapter());
  }

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name);
  }

  getOrThrow(name: string): AgentAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new Error(
        `Unknown agent adapter: "${name}". Available: ${[...this.adapters.keys()].join(', ')}`
      );
    }
    return adapter;
  }

  async healthCheckAll(): Promise<Map<string, Awaited<ReturnType<AgentAdapter['healthCheck']>>>> {
    const results = new Map();
    for (const [name, adapter] of this.adapters) {
      results.set(name, await adapter.healthCheck());
    }
    return results;
  }

  listAvailable(): string[] {
    return [...this.adapters.keys()];
  }
}
```

### Step 1.6: Create test fixtures

Create sample CLI outputs that the tests will use. Capture these from real CLI
runs if possible, otherwise use these representative samples.

```json
// test/adapters/fixtures/claude-success.json
{
  "type": "result",
  "subtype": "success",
  "result": "I've created the DatePicker component at src/components/DatePicker/DatePicker.tsx with the following features:\n\n- Calendar grid with month navigation\n- Click-to-select date functionality\n- Keyboard navigation with arrow keys\n- Design system token integration\n\nFiles created:\n- src/components/DatePicker/DatePicker.tsx\n- src/components/DatePicker/DatePicker.test.tsx\n- src/components/DatePicker/index.ts",
  "session_id": "session-abc-123-def-456",
  "total_cost_usd": 0.087,
  "duration_ms": 45200,
  "num_turns": 8,
  "is_error": false
}
```

```json
// test/adapters/fixtures/claude-error.json
{
  "type": "result",
  "subtype": "error",
  "result": "I encountered an error: Unable to read the file src/nonexistent.ts",
  "session_id": "session-err-789",
  "total_cost_usd": 0.003,
  "duration_ms": 1200,
  "num_turns": 1,
  "is_error": true
}
```

```json
// test/adapters/fixtures/claude-structured.json
{
  "type": "result",
  "subtype": "success",
  "result": "",
  "structured_output": {
    "reasoning": "Single component with clear implementation and review phases.",
    "tasks": [
      {
        "id": "task-1",
        "description": "Implement DatePicker component",
        "agent": "claude-code",
        "role": "implement",
        "dependencies": [],
        "scope": {
          "files": ["src/components/DatePicker/"],
          "description": "New component in design system"
        },
        "estimatedComplexity": "high"
      }
    ],
    "suggestedOrder": ["task-1"]
  },
  "session_id": "session-struct-456",
  "total_cost_usd": 0.012,
  "duration_ms": 3400,
  "num_turns": 1,
  "is_error": false
}
```

```text
// test/adapters/fixtures/codex-success.jsonl
{"type":"thread.started","thread_id":"thread_abc123"}
{"type":"turn.started","turn_id":"turn_1"}
{"type":"item.agent_message","content":"I'll review the DatePicker component for accessibility and edge cases."}
{"type":"item.command_execution","command":"cat src/components/DatePicker/DatePicker.tsx","exit_code":0}
{"type":"item.agent_message","content":"## Review Findings\n\n### Major\n1. **Missing keyboard navigation**: No arrow key support for date selection\n\n### Minor\n1. No aria-label on calendar grid\n2. Feb 29 not handled for leap years"}
{"type":"item.file_change","path":"src/components/DatePicker/DatePicker.tsx","action":"none"}
{"type":"turn.completed","turn_id":"turn_1"}
```

### Step 1.7: Write adapter tests

```typescript
// test/adapters/claude-code.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { readFileSync } from 'fs';
import { join } from 'path';

// Mock execa
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

const loadFixture = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf-8');

describe('ClaudeCodeAdapter', () => {
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    adapter = new ClaudeCodeAdapter();
    vi.resetAllMocks();
  });

  describe('execute', () => {
    it('parses successful JSON output', async () => {
      const { execa } = await import('execa');
      (execa as any).mockResolvedValue({
        stdout: loadFixture('claude-success.json'),
        exitCode: 0,
      });

      const result = await adapter.execute({
        prompt: 'Build a DatePicker',
        context: { workingDirectory: '/tmp/test' },
      });

      expect(result.status).toBe('success');
      expect(result.output).toContain('DatePicker');
      expect(result.sessionId).toBe('session-abc-123-def-456');
      expect(result.metadata.costUsd).toBe(0.087);
      expect(result.metadata.numTurns).toBe(8);
    });

    it('handles error responses', async () => {
      const { execa } = await import('execa');
      (execa as any).mockResolvedValue({
        stdout: loadFixture('claude-error.json'),
        exitCode: 0,
      });

      const result = await adapter.execute({
        prompt: 'Read nonexistent file',
        context: { workingDirectory: '/tmp/test' },
      });

      expect(result.status).toBe('error');
      expect(result.output).toContain('Unable to read');
    });

    it('handles CLI crash (no stdout)', async () => {
      const { execa } = await import('execa');
      (execa as any).mockResolvedValue({
        stdout: '',
        stderr: 'Segmentation fault',
        exitCode: 139,
      });

      const result = await adapter.execute({
        prompt: 'Crash',
        context: { workingDirectory: '/tmp/test' },
      });

      expect(result.status).toBe('error');
      expect(result.output).toContain('Segmentation fault');
    });

    it('handles timeout', async () => {
      const { execa } = await import('execa');
      (execa as any).mockRejectedValue(new Error('Command timed out'));

      const result = await adapter.execute({
        prompt: 'Slow task',
        context: { workingDirectory: '/tmp/test' },
        constraints: { timeout: 1000 },
      });

      expect(result.status).toBe('error');
      expect(result.output).toContain('timed out');
    });

    it('passes correct CLI flags', async () => {
      const { execa } = await import('execa');
      (execa as any).mockResolvedValue({
        stdout: loadFixture('claude-success.json'),
        exitCode: 0,
      });

      await adapter.execute({
        prompt: 'Test prompt',
        context: { workingDirectory: '/tmp/test' },
        constraints: { maxTurns: 10 },
      });

      expect(execa).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining([
          '-p', 'Test prompt',
          '--output-format', 'json',
          '--dangerously-skip-permissions',
          '--max-turns', '10',
        ]),
        expect.objectContaining({ cwd: '/tmp/test' }),
      );
    });
  });

  describe('executeWithSchema', () => {
    it('returns validated structured output', async () => {
      const { execa } = await import('execa');
      (execa as any).mockResolvedValue({
        stdout: loadFixture('claude-structured.json'),
        exitCode: 0,
      });

      const { z } = await import('zod');
      const schema = z.object({
        reasoning: z.string(),
        tasks: z.array(z.object({
          id: z.string(),
          description: z.string(),
        })),
        suggestedOrder: z.array(z.string()),
      });

      const result = await adapter.executeWithSchema(
        'Decompose this task',
        schema,
      );

      expect(result.reasoning).toContain('Single component');
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].id).toBe('task-1');
    });
  });

  describe('healthCheck', () => {
    it('returns available when CLI exists', async () => {
      const { execa } = await import('execa');
      (execa as any)
        .mockResolvedValueOnce({ stdout: '1.0.0', exitCode: 0 })  // --version
        .mockResolvedValueOnce({ stdout: '{"result":"ok"}', exitCode: 0 }); // auth check

      const result = await adapter.healthCheck();

      expect(result.available).toBe(true);
      expect(result.version).toBe('1.0.0');
      expect(result.authenticated).toBe(true);
    });

    it('returns unavailable when CLI missing', async () => {
      const { execa } = await import('execa');
      (execa as any).mockRejectedValue(new Error('ENOENT'));

      const result = await adapter.healthCheck();

      expect(result.available).toBe(false);
    });
  });
});
```

Write equivalent tests for the Codex adapter covering JSONL parsing, output file
reading, structured output, error handling, and health check.

### Step 1.8: Wire up the `status` command

```typescript
// src/cli/commands/status.ts
import { AdapterRegistry } from '../../adapters/registry.js';
import chalk from 'chalk';

export async function statusCommand(): Promise<void> {
  const registry = new AdapterRegistry();
  const results = await registry.healthCheckAll();

  console.log('\nAgent Status:\n');

  for (const [name, health] of results) {
    const statusIcon = health.available && health.authenticated
      ? chalk.green('✓')
      : health.available
        ? chalk.yellow('⚠')
        : chalk.red('✗');

    const statusText = health.available && health.authenticated
      ? chalk.green('ready')
      : health.available
        ? chalk.yellow('not authenticated')
        : chalk.red('not installed');

    const version = health.version ? chalk.dim(` (${health.version})`) : '';
    const error = health.error ? chalk.dim(` — ${health.error}`) : '';

    console.log(`  ${statusIcon} ${name}${version}: ${statusText}${error}`);
  }

  console.log('');
}
```

Update `src/index.ts` to wire this command:

```typescript
program
  .command('status')
  .description('Check status of available agents')
  .action(statusCommand);
```

### Step 1.9: Implement the `init` command

```typescript
// src/cli/commands/init.ts
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

export async function initCommand(): Promise<void> {
  const configDir = join(process.cwd(), '.orchestra');
  const configFile = join(configDir, 'workflow.yaml');

  if (existsSync(configFile)) {
    console.log(chalk.yellow('\n  .orchestra/workflow.yaml already exists. Skipping.\n'));
    return;
  }

  mkdirSync(configDir, { recursive: true });

  // Copy default workflow from the package
  const defaultWorkflow = readFileSync(
    new URL('../../defaults/workflow.yaml', import.meta.url),
    'utf-8'
  );

  writeFileSync(configFile, defaultWorkflow);

  console.log(chalk.green('\n  ✓ Created .orchestra/workflow.yaml'));
  console.log(chalk.dim('    Edit this file to customize your workflow.\n'));
}
```

### Phase 1 Checklist

- [ ] `src/adapters/types.ts` — complete adapter interface
- [ ] `src/adapters/claude-code.ts` — working adapter with execute, executeWithSchema, healthCheck
- [ ] `src/adapters/codex.ts` — working adapter with JSONL parsing, execute, executeWithSchema, healthCheck
- [ ] `src/adapters/generic.ts` — fallback adapter for arbitrary CLIs
- [ ] `src/adapters/registry.ts` — adapter registration and lookup
- [ ] Test fixtures created with representative CLI outputs
- [ ] Unit tests pass for both adapters (mocked CLI calls)
- [ ] `[name] status` shows which CLIs are installed and authenticated
- [ ] `[name] init` creates default workflow config
- [ ] **GO/NO-GO: Both adapters can parse real CLI output reliably**

---

## 7. Phase 2: Orchestrator Core

**Goal:** The 6-step pipeline works end-to-end with mocked agents.
**Time estimate:** ~4 hours

This phase builds the orchestrator pipeline, Zod schemas for each step, system
prompt templates, and the validation/retry logic. The full schemas and prompts
are in Appendix A and Appendix B respectively.

### Step 2.1: Create utility functions

```typescript
// src/utils/json-parse.ts

/**
 * Extract JSON from LLM output that might contain markdown fences,
 * extra text, or other wrapping.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  // Try direct parse first
  try {
    return JSON.parse(trimmed);
  } catch { /* continue */ }

  // Try extracting from markdown code fence
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch { /* continue */ }
  }

  // Try finding a JSON object in the text
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch { /* continue */ }
  }

  // Try finding a JSON array in the text
  const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch { /* continue */ }
  }

  throw new Error(`Could not extract JSON from text: ${trimmed.slice(0, 200)}...`);
}
```

```typescript
// src/utils/validate.ts
import type { z, ZodError } from 'zod';
import type { AgentAdapter } from '../adapters/types.js';
import { extractJson } from './json-parse.js';

/**
 * Execute an orchestrator reasoning call with schema validation.
 *
 * Strategy:
 * 1. If the adapter supports native JSON schema enforcement, use it
 * 2. Otherwise, use prompted JSON with Zod validation + retry on failure
 */
export async function executeWithValidation<T extends z.ZodType>(
  adapter: AgentAdapter,
  prompt: string,
  schema: T,
  options?: {
    workingDirectory?: string;
    maxRetries?: number;
  },
): Promise<z.infer<T>> {
  // Strategy 1: Native JSON schema enforcement
  if (adapter.supportsJsonSchema && adapter.executeWithSchema) {
    return adapter.executeWithSchema(prompt, schema, {
      workingDirectory: options?.workingDirectory,
    });
  }

  // Strategy 2: Prompted JSON with validation + retry
  const maxRetries = options?.maxRetries ?? 1;

  let lastError: ZodError | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let fullPrompt = prompt;

    if (attempt > 0 && lastError) {
      fullPrompt += `\n\nYour previous response had validation errors:\n${lastError.message}\n\nPlease fix these issues and respond again with valid JSON.`;
    }

    const result = await adapter.execute({
      prompt: fullPrompt + '\n\nRespond with ONLY valid JSON matching the required schema. No markdown, no explanation, no preamble.',
      context: { workingDirectory: options?.workingDirectory ?? process.cwd() },
      constraints: { maxTurns: 1, timeout: 60_000 },
    });

    try {
      const parsed = extractJson(result.output);
      return schema.parse(parsed);
    } catch (err) {
      if (err instanceof Error && 'issues' in err) {
        lastError = err as ZodError;
      } else {
        throw err;
      }
    }
  }

  throw new Error(
    `Failed to get valid structured output after ${maxRetries + 1} attempts. Last error: ${lastError?.message}`
  );
}
```

```typescript
// src/utils/logger.ts
import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let currentLevel: LogLevel = 'info';

const levels: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export const logger = {
  debug: (msg: string, ...args: unknown[]) => {
    if (levels[currentLevel] <= levels.debug) {
      console.error(chalk.dim(`[debug] ${msg}`), ...args);
    }
  },
  info: (msg: string, ...args: unknown[]) => {
    if (levels[currentLevel] <= levels.info) {
      console.error(chalk.blue(`[info] ${msg}`), ...args);
    }
  },
  warn: (msg: string, ...args: unknown[]) => {
    if (levels[currentLevel] <= levels.warn) {
      console.error(chalk.yellow(`[warn] ${msg}`), ...args);
    }
  },
  error: (msg: string, ...args: unknown[]) => {
    if (levels[currentLevel] <= levels.error) {
      console.error(chalk.red(`[error] ${msg}`), ...args);
    }
  },
};
```

### Step 2.2: Create all Zod schemas

Create `src/orchestrator/schemas.ts` with the complete schemas from Appendix A.
This is a single file containing all 5 output schemas (DECOMPOSE, DISPATCH,
INGEST, SUMMARIZE, JUDGE). REPORT does not have a schema — it produces
natural language.

### Step 2.3: Create all system prompts

Create `src/orchestrator/prompts.ts` with the complete prompt templates from
Appendix B. Each prompt is a function that accepts context variables and returns
the formatted system prompt string.

### Step 2.4: Implement each pipeline step

Create one file per step in `src/orchestrator/steps/`. Each step:
1. Builds its system prompt from the template
2. Calls the orchestrator LLM via `executeWithValidation()`
3. Returns the validated, typed result

```typescript
// src/orchestrator/steps/decompose.ts
import type { AgentAdapter } from '../../adapters/types.js';
import type { z } from 'zod';
import { DecomposeOutputSchema } from '../schemas.js';
import { buildDecomposePrompt } from '../prompts.js';
import { executeWithValidation } from '../../utils/validate.js';
import type { WorkflowConfig } from '../../workflow/types.js';

export type DecomposeOutput = z.infer<typeof DecomposeOutputSchema>;

export async function decompose(
  orchestrator: AgentAdapter,
  userRequest: string,
  agents: { name: string; capabilities: string[] }[],
  workflow: WorkflowConfig,
): Promise<DecomposeOutput> {
  const prompt = buildDecomposePrompt(userRequest, agents, workflow);
  return executeWithValidation(orchestrator, prompt, DecomposeOutputSchema);
}
```

Follow the same pattern for dispatch, ingest, summarize, and judge.

The report step is different — it produces natural language:

```typescript
// src/orchestrator/steps/report.ts
import type { AgentAdapter } from '../../adapters/types.js';
import { buildReportPrompt } from '../prompts.js';
import type { PassSummary } from '../../state/types.js';

export async function report(
  orchestrator: AgentAdapter,
  summaries: PassSummary[],
  userRequest: string,
): Promise<string> {
  const prompt = buildReportPrompt(summaries, userRequest);

  const result = await orchestrator.execute({
    prompt,
    context: { workingDirectory: process.cwd() },
    constraints: { maxTurns: 1, timeout: 30_000 },
  });

  return result.output;
}
```

### Step 2.5: Build the pipeline runner

```typescript
// src/orchestrator/pipeline.ts
import { EventEmitter } from 'eventemitter3';
import type { AgentAdapter } from '../adapters/types.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { WorkflowConfig } from '../workflow/types.js';
import type { StateStore } from '../state/store.js';
import type { WorktreeManager } from '../git/worktree.js';
import { decompose, type DecomposeOutput } from './steps/decompose.js';
import { dispatch } from './steps/dispatch.js';
import { ingest } from './steps/ingest.js';
import { summarize } from './steps/summarize.js';
import { judge } from './steps/judge.js';
import { report } from './steps/report.js';
import { logger } from '../utils/logger.js';

interface PipelineEvents {
  'agent:start': (agentName: string, taskDescription: string) => void;
  'agent:complete': (agentName: string, status: string) => void;
  'step:start': (stepName: string) => void;
  'step:complete': (stepName: string) => void;
  'report': (message: string) => void;
  'ask_user': (question: string) => void;
  'error': (error: Error) => void;
}

export class Pipeline extends EventEmitter<PipelineEvents> {
  constructor(
    private orchestratorAdapter: AgentAdapter,
    private registry: AdapterRegistry,
    private workflow: WorkflowConfig,
    private state: StateStore,
    private worktreeManager: WorktreeManager,
  ) {
    super();
  }

  async run(userRequest: string): Promise<void> {
    try {
      // Step 1: Decompose
      this.emit('step:start', 'decompose');
      logger.info('Decomposing request...');

      const agents = this.registry.listAvailable().map(name => {
        const adapter = this.registry.getOrThrow(name);
        return { name, capabilities: [...adapter.capabilities] };
      });

      const decomposition = await decompose(
        this.orchestratorAdapter,
        userRequest,
        agents,
        this.workflow,
      );

      this.emit('step:complete', 'decompose');
      logger.info(`Decomposed into ${decomposition.tasks.length} tasks`);

      // Save initial state
      this.state.saveState({
        status: 'running',
        userRequest,
        decomposition,
        currentTaskIndex: 0,
        passes: [],
      });

      // Execute tasks in order
      for (const taskId of decomposition.suggestedOrder) {
        const task = decomposition.tasks.find(t => t.id === taskId);
        if (!task) continue;

        await this.executeTaskWithReviewLoop(task, decomposition, userRequest);
      }

      // Step 6: Report
      this.emit('step:start', 'report');
      const summaries = this.state.loadPassSummaries();
      const finalReport = await report(
        this.orchestratorAdapter,
        summaries,
        userRequest,
      );
      this.emit('report', finalReport);
      this.emit('step:complete', 'report');

      // Mark workflow complete
      this.state.saveState({
        ...this.state.loadState()!,
        status: 'completed',
      });

    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', error);
      logger.error(`Pipeline error: ${error.message}`);
      throw error;
    }
  }

  private async executeTaskWithReviewLoop(
    task: DecomposeOutput['tasks'][0],
    decomposition: DecomposeOutput,
    userRequest: string,
  ): Promise<void> {
    const maxPasses = this.workflow.steps
      .find(s => s.role === 'reviewer')?.maxPasses ?? 3;

    let passNumber = 0;
    let isDone = false;

    while (!isDone && passNumber < maxPasses) {
      passNumber++;

      // Get the agent adapter for this task
      const agentAdapter = this.registry.getOrThrow(task.agent);

      // Create worktree if first pass
      let worktreePath: string;
      if (passNumber === 1) {
        worktreePath = await this.worktreeManager.createWorktree(task.id);
      } else {
        worktreePath = this.worktreeManager.getWorktreePath(task.id);
      }

      // Step 2: Dispatch
      this.emit('step:start', 'dispatch');
      const previousSummaries = this.state.loadPassSummaries();
      const dispatched = await dispatch(
        this.orchestratorAdapter,
        task,
        previousSummaries,
        passNumber,
      );
      this.emit('step:complete', 'dispatch');

      // Execute the agent
      this.emit('agent:start', task.agent, task.description);
      logger.info(`Running ${task.agent}: ${task.description}`);

      const agentResult = await agentAdapter.execute({
        prompt: dispatched.agentPrompt,
        context: {
          workingDirectory: worktreePath,
        },
        constraints: {
          timeout: 300_000,
          sandbox: task.role === 'review' ? 'read-only' : 'workspace-write',
        },
      });

      this.emit('agent:complete', task.agent, agentResult.status);

      // Detect modified files via git if adapter didn't report them
      if (agentResult.filesModified.length === 0 && agentResult.status === 'success') {
        agentResult.filesModified = await this.worktreeManager.getModifiedFiles(task.id);
      }

      // Step 3: Ingest
      this.emit('step:start', 'ingest');
      const ingested = await ingest(
        this.orchestratorAdapter,
        task.description,
        agentResult,
      );
      this.emit('step:complete', 'ingest');

      // Step 4: Summarize
      this.emit('step:start', 'summarize');
      const summary = await summarize(
        this.orchestratorAdapter,
        ingested,
        passNumber,
      );
      this.state.addPassSummary(summary);
      this.state.addPassOutput(passNumber, agentResult);
      this.emit('step:complete', 'summarize');

      // Step 5: Judge (only after review passes or iteration)
      if (task.role === 'review' || passNumber > 1) {
        this.emit('step:start', 'judge');
        const judgment = await judge(
          this.orchestratorAdapter,
          ingested,
          previousSummaries,
          passNumber,
          maxPasses,
        );
        this.emit('step:complete', 'judge');

        if (judgment.decision === 'done') {
          isDone = true;
          logger.info('Judge: work is complete');
        } else if (judgment.decision === 'ask_user') {
          this.emit('ask_user', judgment.questionForUser ?? 'Need your input');
          isDone = true; // For MVP, stop and wait
        } else {
          // Iterate: update task for next pass
          logger.info(`Judge: iterating (${judgment.issuesRequiringFixes?.length ?? 0} issues)`);
          task = {
            ...task,
            description: `Fix review issues: ${judgment.issuesRequiringFixes?.map(i => i.description).join('; ')}`,
            role: 'implement',
          };
        }
      } else {
        // After first implementation pass, find the review task
        const reviewTask = decomposition.tasks.find(
          t => t.role === 'review' && t.dependencies.includes(task.id)
        );
        if (reviewTask) {
          // Continue with review
          task = reviewTask;
          isDone = false;
        } else {
          isDone = true; // No review task configured
        }
      }
    }

    if (!isDone) {
      logger.warn(`Max passes (${maxPasses}) reached for task ${task.id}`);
    }
  }
}
```

### Phase 2 Checklist

- [ ] `src/utils/json-parse.ts` — JSON extraction from messy LLM output
- [ ] `src/utils/validate.ts` — schema validation with native + fallback strategies
- [ ] `src/utils/logger.ts` — structured logging
- [ ] `src/orchestrator/schemas.ts` — all 5 Zod schemas (see Appendix A)
- [ ] `src/orchestrator/prompts.ts` — all 6 system prompt templates (see Appendix B)
- [ ] `src/orchestrator/steps/decompose.ts`
- [ ] `src/orchestrator/steps/dispatch.ts`
- [ ] `src/orchestrator/steps/ingest.ts`
- [ ] `src/orchestrator/steps/summarize.ts`
- [ ] `src/orchestrator/steps/judge.ts`
- [ ] `src/orchestrator/steps/report.ts`
- [ ] `src/orchestrator/pipeline.ts` — full pipeline runner with event emission
- [ ] Unit tests for each step with mocked adapters
- [ ] Pipeline integration test with fully mocked adapters

---

## 8. Phase 3: Git Worktrees

**Goal:** Agents work in isolated git worktrees.
**Time estimate:** ~2 hours

### Step 3.1: Implement WorktreeManager

```typescript
// src/git/worktree.ts
import simpleGit, { type SimpleGit } from 'simple-git';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export class WorktreeManager {
  private git: SimpleGit;
  private basePath: string;

  constructor(projectRoot: string) {
    this.git = simpleGit(projectRoot);
    this.basePath = join(projectRoot, '.orchestra', 'worktrees');
    mkdirSync(this.basePath, { recursive: true });
  }

  async createWorktree(taskId: string): Promise<string> {
    const branchName = `orchestra/${taskId}`;
    const worktreePath = join(this.basePath, taskId);

    if (existsSync(worktreePath)) {
      // Worktree already exists (e.g., resumed workflow)
      return worktreePath;
    }

    // Create worktree with a new branch from current HEAD
    await this.git.raw(['worktree', 'add', '-b', branchName, worktreePath]);

    return worktreePath;
  }

  getWorktreePath(taskId: string): string {
    return join(this.basePath, taskId);
  }

  async getModifiedFiles(taskId: string): Promise<string[]> {
    const worktreePath = this.getWorktreePath(taskId);
    const worktreeGit = simpleGit(worktreePath);
    const status = await worktreeGit.status();
    return [
      ...status.modified,
      ...status.created,
      ...status.not_added,
      ...status.renamed.map(r => r.to),
    ];
  }

  async mergeWorktree(taskId: string, targetBranch?: string): Promise<void> {
    const branchName = `orchestra/${taskId}`;

    if (targetBranch) {
      await this.git.checkout(targetBranch);
    }

    await this.git.merge([branchName, '--no-ff', '-m', `Merge orchestra/${taskId}`]);
  }

  async cleanupWorktree(taskId: string): Promise<void> {
    const worktreePath = this.getWorktreePath(taskId);
    const branchName = `orchestra/${taskId}`;

    try {
      await this.git.raw(['worktree', 'remove', worktreePath, '--force']);
    } catch { /* worktree might not exist */ }

    try {
      await this.git.deleteLocalBranch(branchName, true);
    } catch { /* branch might not exist */ }
  }

  async cleanupAll(): Promise<void> {
    // List all orchestra worktrees
    const raw = await this.git.raw(['worktree', 'list', '--porcelain']);
    const worktrees = raw.split('\n\n')
      .filter(block => block.includes('.orchestra/worktrees/'))
      .map(block => {
        const match = block.match(/worktree (.+)/);
        return match?.[1];
      })
      .filter(Boolean);

    for (const path of worktrees) {
      try {
        await this.git.raw(['worktree', 'remove', path!, '--force']);
      } catch { /* ignore cleanup errors */ }
    }
  }
}
```

### Step 3.2: Implement merge utility

```typescript
// src/git/merge.ts
import simpleGit from 'simple-git';
import type { WorktreeManager } from './worktree.js';

/**
 * Merge all completed task worktrees back to the base branch.
 * Called when the workflow completes successfully.
 */
export async function mergeAllWorktrees(
  worktreeManager: WorktreeManager,
  taskIds: string[],
  targetBranch: string = 'main',
): Promise<{ merged: string[]; failed: string[] }> {
  const merged: string[] = [];
  const failed: string[] = [];

  for (const taskId of taskIds) {
    try {
      await worktreeManager.mergeWorktree(taskId, targetBranch);
      merged.push(taskId);
    } catch (err) {
      failed.push(taskId);
    }
  }

  return { merged, failed };
}
```

### Phase 3 Checklist

- [ ] `src/git/worktree.ts` — create, get, list modified files, merge, cleanup
- [ ] `src/git/merge.ts` — merge all worktrees on completion
- [ ] Tests for worktree creation and cleanup
- [ ] Handles edge cases: dirty working directory, existing worktrees, missing branches

---

## 9. Phase 4: State Persistence

**Goal:** Save workflow state to `.orchestra/` for resume capability.
**Time estimate:** ~1 hour

### Step 4.1: Define state types

```typescript
// src/state/types.ts
import type { DecomposeOutput } from '../orchestrator/steps/decompose.js';

export interface WorkflowState {
  status: 'running' | 'paused' | 'completed' | 'failed';
  userRequest: string;
  decomposition: DecomposeOutput;
  currentTaskIndex: number;
  passes: PassRecord[];
  startedAt?: string;
  completedAt?: string;
}

export interface PassRecord {
  passNumber: number;
  taskId: string;
  agentName: string;
  timestamp: string;
}

export interface PassSummary {
  passNumber: number;
  summary: string;
  unresolvedIssues: string[];
  contextForNextPass: string;
  filesInScope: string[];
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}
```

### Step 4.2: Implement the state store

```typescript
// src/state/store.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { WorkflowState, PassSummary, Message } from './types.js';

export class StateStore {
  private basePath: string;

  constructor(projectRoot: string) {
    this.basePath = join(projectRoot, '.orchestra');
    mkdirSync(join(this.basePath, 'passes'), { recursive: true });
    mkdirSync(join(this.basePath, 'summaries'), { recursive: true });
  }

  // ── Workflow State ──────────────────────────────────────────

  saveState(state: WorkflowState): void {
    writeFileSync(
      join(this.basePath, 'state.json'),
      JSON.stringify(state, null, 2),
    );
  }

  loadState(): WorkflowState | null {
    const path = join(this.basePath, 'state.json');
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  }

  hasInterruptedWorkflow(): boolean {
    const state = this.loadState();
    return state !== null && state.status === 'running';
  }

  // ── Pass Summaries ──────────────────────────────────────────

  addPassSummary(summary: PassSummary): void {
    writeFileSync(
      join(this.basePath, 'summaries', `pass-${String(summary.passNumber).padStart(3, '0')}.json`),
      JSON.stringify(summary, null, 2),
    );
  }

  loadPassSummaries(): PassSummary[] {
    const dir = join(this.basePath, 'summaries');
    if (!existsSync(dir)) return [];

    const { readdirSync } = require('fs');
    return readdirSync(dir)
      .filter((f: string) => f.endsWith('.json'))
      .sort()
      .map((f: string) => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
  }

  // ── Raw Pass Output ─────────────────────────────────────────

  addPassOutput(passNumber: number, output: unknown): void {
    writeFileSync(
      join(this.basePath, 'passes', `pass-${String(passNumber).padStart(3, '0')}.json`),
      JSON.stringify(output, null, 2),
    );
  }

  // ── Conversation ────────────────────────────────────────────

  saveConversation(messages: Message[]): void {
    writeFileSync(
      join(this.basePath, 'conversation.json'),
      JSON.stringify(messages, null, 2),
    );
  }

  loadConversation(): Message[] {
    const path = join(this.basePath, 'conversation.json');
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, 'utf-8'));
  }

  // ── Cleanup ─────────────────────────────────────────────────

  clear(): void {
    const { rmSync } = require('fs');
    for (const sub of ['state.json', 'conversation.json', 'passes', 'summaries']) {
      const path = join(this.basePath, sub);
      if (existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
      }
    }
    // Recreate directories
    mkdirSync(join(this.basePath, 'passes'), { recursive: true });
    mkdirSync(join(this.basePath, 'summaries'), { recursive: true });
  }
}
```

### Step 4.3: Build context builder

```typescript
// src/state/context.ts
import type { StateStore } from './store.js';
import type { PassSummary } from './types.js';

/**
 * Build the tiered context object for orchestrator reasoning calls.
 *
 * Tiered strategy:
 * - Current pass: included as full data (passed separately)
 * - Previous pass: full summary
 * - Older passes: compressed to single paragraph
 */
export function buildTieredContext(summaries: PassSummary[]): string {
  if (summaries.length === 0) return 'No previous passes.';

  const parts: string[] = [];

  for (let i = 0; i < summaries.length; i++) {
    const summary = summaries[i];
    const isOldest = i < summaries.length - 2;

    if (isOldest) {
      // Oldest passes: single line
      parts.push(`Pass ${summary.passNumber}: ${summary.summary.split('.')[0]}.`);
    } else {
      // Recent passes: full summary
      parts.push(`Pass ${summary.passNumber}: ${summary.summary}`);
      if (summary.unresolvedIssues.length > 0) {
        parts.push(`  Unresolved: ${summary.unresolvedIssues.join('; ')}`);
      }
    }
  }

  return parts.join('\n');
}
```

### Phase 4 Checklist

- [ ] `src/state/types.ts` — all state type definitions
- [ ] `src/state/store.ts` — save/load state, summaries, conversation
- [ ] `src/state/context.ts` — tiered context builder
- [ ] Tests for state persistence (save, load, clear, interrupted detection)

---

## 10. Phase 5: CLI & Conversation UI

**Goal:** Interactive CLI with conversation loop and agent status.
**Time estimate:** ~3 hours

### Step 5.1: Build the Ink UI components

Build the following React/Ink components for the terminal interface:

**ConversationView** — renders chat messages in a scrollable list. User messages
are prefixed with `→`, assistant messages are plain text. Use chalk colors to
distinguish roles.

**AgentStatus** — a bordered panel showing active agents, their current task,
and elapsed time. Only visible when agents are running. Format:

```
┌ Agents ─────────────────────────────────────────┐
│ ● claude-code  implementing DatePicker...  2m13s │
│ ○ codex        waiting (review)                  │
└──────────────────────────────────────────────────┘
```

**PromptInput** — text input at the bottom of the screen using `ink-text-input`.

**App** — root component that composes the above, manages conversation state,
and connects to the Pipeline's event emitter.

### Step 5.2: Wire up the `run` command

The `run` command should:
1. Load workflow config from `.orchestra/workflow.yaml` (or defaults)
2. Initialize adapter registry and health-check agents
3. Create state store and worktree manager
4. If a prompt is provided as an argument, run it immediately
5. If no prompt, enter interactive mode (render Ink app)
6. On Ctrl+C, save state and exit gracefully

### Step 5.3: Wire up the `resume` command

The `resume` command should:
1. Check for `.orchestra/state.json`
2. If interrupted workflow found, display summary and ask to resume or start fresh
3. If resumed, rebuild pipeline state from summaries and continue from last step

### Phase 5 Checklist

- [ ] Ink components: ConversationView, AgentStatus, PromptInput, App
- [ ] `run` command: interactive and single-prompt modes
- [ ] `resume` command: detect and resume interrupted workflows
- [ ] Graceful shutdown: Ctrl+C saves state
- [ ] Agent status updates in real-time via pipeline events

---

## 11. Phase 6: Integration & Testing

**Goal:** Full end-to-end workflow with real CLIs.
**Time estimate:** ~3 hours

### Test Matrix

| Test | Description | Expected |
|------|-------------|----------|
| Single file task | "Create a function that validates emails" | Claude implements → Codex reviews → 1-2 passes → done |
| Multi-file task | "Build a React component with tests" | Claude implements 3+ files → Codex reviews → iterate → done |
| Explicit assignment | "Use Codex to write tests, Claude to review" | Agents swapped from defaults |
| Resume after interrupt | Start workflow → Ctrl+C mid-review → resume | Picks up from last completed step |
| Error recovery | Task that causes agent failure | Retry per config → fallback → ask user |
| Max passes cap | Intentionally bad code → review loop | Stops at max_passes with "accepted minor issues" |

### What to Fix During Integration

Expect these issues and budget time to fix:

1. **CLI output format mismatches** — the exact JSON/JSONL shape may differ from docs
2. **Prompt engineering** — orchestrator decomposition/judge quality needs iteration
3. **Timing** — agent execution takes 30s-5min, UI needs to show progress
4. **Worktree edge cases** — uncommitted changes, merge conflicts
5. **Context size** — large agent outputs may need truncation before ingesting

### Phase 6 Checklist

- [ ] End-to-end workflow completes with real Claude Code + Codex
- [ ] Adapters handle real CLI output (not just fixtures)
- [ ] Prompts refined based on actual orchestrator output quality
- [ ] State persistence works across interrupt/resume
- [ ] Error handling works for: timeout, bad JSON, agent crash
- [ ] README written with install, setup, and usage instructions

---

## Appendix A: Complete Zod Schemas

```typescript
// src/orchestrator/schemas.ts
import { z } from 'zod';

// ── Step 1: DECOMPOSE ─────────────────────────────────────────

export const DecomposeOutputSchema = z.object({
  reasoning: z.string().describe(
    'Brief explanation of how the request was broken down (2-3 sentences)'
  ),
  tasks: z.array(z.object({
    id: z.string().describe("Short identifier, e.g. 'task-1'"),
    description: z.string().describe('What this task accomplishes'),
    agent: z.string().describe('Which agent should handle this'),
    role: z.enum(['implement', 'review', 'test', 'refactor', 'document']),
    dependencies: z.array(z.string()).describe('IDs of tasks that must complete first'),
    scope: z.object({
      files: z.array(z.string()).optional().describe('Specific files/directories involved'),
      description: z.string().describe('What area of the codebase this touches'),
    }),
    estimatedComplexity: z.enum(['low', 'medium', 'high']),
  })),
  suggestedOrder: z.array(z.string()).describe(
    'Task IDs in recommended execution order'
  ),
});

// ── Step 2: DISPATCH ──────────────────────────────────────────

export const DispatchOutputSchema = z.object({
  agentPrompt: z.string().describe(
    'The complete prompt to send to the agent. This is the ONLY thing the agent sees.'
  ),
  workingDirectory: z.string().optional().describe(
    'Specific subdirectory to focus the agent on'
  ),
  expectedOutputs: z.array(z.string()).describe(
    'What files or artifacts the agent should produce'
  ),
  successCriteria: z.string().describe(
    'How to determine if the agent completed the task successfully'
  ),
});

// ── Step 3: INGEST ────────────────────────────────────────────

export const IngestOutputSchema = z.object({
  status: z.enum(['success', 'partial', 'failure']),
  summary: z.string().describe('2-3 sentence summary of what the agent did'),
  filesModified: z.array(z.object({
    path: z.string(),
    action: z.enum(['created', 'modified', 'deleted']),
  })),
  decisions: z.array(z.string()).describe('Key technical decisions the agent made'),
  concerns: z.array(z.object({
    severity: z.enum(['info', 'warning', 'error']),
    description: z.string(),
  })).describe('Issues or concerns found in the output'),
  needsHumanAttention: z.boolean(),
  humanAttentionReason: z.string().optional(),
  reviewFindings: z.array(z.object({
    severity: z.enum(['critical', 'major', 'minor', 'suggestion']),
    description: z.string(),
    file: z.string().optional(),
    actionable: z.boolean(),
  })).optional().describe('For review tasks: specific findings'),
});

// ── Step 4: SUMMARIZE ─────────────────────────────────────────

export const SummarizeOutputSchema = z.object({
  passNumber: z.number(),
  summary: z.string().describe('3-8 sentence summary of what happened in this pass'),
  unresolvedIssues: z.array(z.string()).describe('Issues still needing attention'),
  contextForNextPass: z.string().describe('Specific context the next agent needs'),
  filesInScope: z.array(z.string()).describe('Files that were touched'),
});

// ── Step 5: JUDGE ─────────────────────────────────────────────

export const JudgeOutputSchema = z.object({
  decision: z.enum(['done', 'iterate', 'ask_user']),
  reasoning: z.string().describe('Why this decision was made (2-3 sentences)'),
  issuesRequiringFixes: z.array(z.object({
    description: z.string(),
    severity: z.enum(['critical', 'major']),
    originalFinding: z.string(),
  })).optional().describe('Only for iterate: critical/major issues worth fixing'),
  acceptedMinorIssues: z.array(z.string()).optional().describe(
    'Only for done: minor issues accepted as-is'
  ),
  questionForUser: z.string().optional().describe(
    'Only for ask_user: what to ask the user'
  ),
  isLooping: z.boolean().describe('Are the same issues repeating across passes?'),
  loopDescription: z.string().optional(),
});
```

---

## Appendix B: Complete System Prompts

```typescript
// src/orchestrator/prompts.ts
import type { WorkflowConfig } from '../workflow/types.js';
import type { PassSummary } from '../state/types.js';
import type { TaskResult } from '../adapters/types.js';
import { buildTieredContext } from '../state/context.js';

// ── Shared helpers ────────────────────────────────────────────

function formatAgents(agents: { name: string; capabilities: string[] }[]): string {
  return agents
    .map(a => `- ${a.name}: capabilities=[${a.capabilities.join(', ')}]`)
    .join('\n');
}

function formatSummaries(summaries: PassSummary[]): string {
  if (summaries.length === 0) return 'No previous passes.';
  return buildTieredContext(summaries);
}

// ── Step 1: DECOMPOSE ─────────────────────────────────────────

export function buildDecomposePrompt(
  userRequest: string,
  agents: { name: string; capabilities: string[] }[],
  workflow: WorkflowConfig,
): string {
  return `You are a task decomposition engine for a multi-agent coding workflow.

Given a user request and a list of available agents with their capabilities,
break the request into discrete, actionable tasks. Each task should be:
- Small enough for a single agent to complete in one session
- Clear about what files/areas of the codebase are involved
- Ordered by dependency (tasks that block others come first)

Assign each task to the most appropriate agent based on their configured
strengths. If the user has specified agent assignments in their request,
honor those explicitly.

Available agents:
${formatAgents(agents)}

Default workflow: ${workflow.steps.map(s => s.role).join(' → ')}

User request:
${userRequest}

Respond with ONLY a JSON object matching the required schema. No markdown fences, no explanation, no preamble.`;
}

// ── Step 2: DISPATCH ──────────────────────────────────────────

export function buildDispatchPrompt(
  taskDescription: string,
  taskRole: string,
  previousSummaries: PassSummary[],
  passNumber: number,
): string {
  return `You are a prompt engineer for a multi-agent coding system. Your job is to
craft a clear, focused prompt for a specific coding agent.

The agent will receive your prompt and work in a git worktree with full access
to the codebase. It does NOT have access to the conversation history or previous
agent outputs — you must include all relevant context in the prompt itself.

Write a prompt that:
- States exactly what the agent should build/review/fix
- Includes specific requirements and constraints
- References specific files or directories if known
- Includes relevant feedback from previous review passes (if any)
- Does NOT include unnecessary context that would distract the agent
- Is written as direct instructions, not a conversation

Task: ${taskDescription}
Task role: ${taskRole}
Pass number: ${passNumber}

Context from previous passes:
${formatSummaries(previousSummaries)}

Respond with ONLY a JSON object matching the required schema. No markdown fences, no explanation, no preamble.`;
}

// ── Step 3: INGEST ────────────────────────────────────────────

export function buildIngestPrompt(
  taskDescription: string,
  agentOutput: string,
): string {
  return `You are analyzing the output of a coding agent that just completed a task.
Read the agent's full response and extract structured findings.

Your job is to determine:
1. Did the agent complete the task successfully?
2. What files were created or modified?
3. What decisions did the agent make?
4. Are there any issues, warnings, or concerns?
5. Is there anything the agent flagged for human attention?
6. If this was a review task, what specific findings were reported?

Task that was assigned:
${taskDescription}

Agent output:
${agentOutput}

Respond with ONLY a JSON object matching the required schema. No markdown fences, no explanation, no preamble.`;
}

// ── Step 4: SUMMARIZE ─────────────────────────────────────────

export function buildSummarizePrompt(
  ingestOutput: string,
  passNumber: number,
): string {
  return `You are compressing the results of a workflow pass into a concise summary
that will be used as context for future passes. The raw output will be
discarded after this summary is created.

Include:
- What was attempted and what was accomplished
- Key technical decisions made
- Unresolved issues that need to be addressed in future passes
- Any constraints or context that future agents need to know

Be concise — this summary will be injected into future prompts and needs
to be information-dense without being verbose. Target 3-8 sentences.

Pass number: ${passNumber}

Pass results:
${ingestOutput}

Respond with ONLY a JSON object matching the required schema. No markdown fences, no explanation, no preamble.`;
}

// ── Step 5: JUDGE ─────────────────────────────────────────────

export function buildJudgePrompt(
  ingestOutput: string,
  previousSummaries: PassSummary[],
  currentPass: number,
  maxPasses: number,
): string {
  return `You are the quality gate for a multi-agent coding workflow. A coding agent
built something, and a review agent reviewed it. You need to decide:
is the work done, or does it need another pass?

Guidelines for your decision:

DONE when:
- No critical or major issues remain
- Only minor/suggestion-level findings left
- The implementation meets the original requirements
- We've hit max passes and remaining issues are non-critical

ITERATE when:
- Critical or major issues exist that are clearly actionable
- The fix is likely to succeed (not a fundamental design problem)
- We haven't hit max passes
- We're NOT seeing the same issues repeated (that's looping)

ASK_USER when:
- There's a design decision that requires human judgment
- The review raised a concern about requirements ambiguity
- We're looping (same issues appearing across passes)
- The agent flagged something for human attention

Be decisive. Shipping with minor issues is better than infinite iteration.

Current pass: ${currentPass} of ${maxPasses}

Review findings from this pass:
${ingestOutput}

Summary of previous passes:
${formatSummaries(previousSummaries)}

Respond with ONLY a JSON object matching the required schema. No markdown fences, no explanation, no preamble.`;
}

// ── Step 6: REPORT ────────────────────────────────────────────

export function buildReportPrompt(
  summaries: PassSummary[],
  userRequest: string,
): string {
  return `You are reporting the results of a multi-agent coding workflow to the user.
Write a clear, conversational summary of what happened.

Include:
- What was built/changed
- How many passes it took
- Key decisions that were made
- Any remaining minor issues that were accepted
- What the user should do next (review code, create PR, etc.)

Keep it concise — the user can look at the code themselves. Focus on
what they need to KNOW, not what they can SEE.

Do NOT output JSON for this step. Write naturally, as if you're a
colleague giving a quick update.

Original request: ${userRequest}

Workflow summary:
${formatSummaries(summaries)}`;
}
```

---

## Appendix C: Default Workflow YAML

```yaml
# defaults/workflow.yaml
# Default workflow configuration for the orchestrator.
# Copy to .orchestra/workflow.yaml and customize.

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

    - role: judge
      agent: orchestrator
      action: evaluate_review
      criteria:
        - "Are the review findings actionable?"
        - "Is the fix complete and correct?"

    - role: coder
      agent: claude-code
      action: fix_review_issues
      condition: "judge says fixes needed"

  completion:
    strategy: judge_approval
    fallback: max_passes

agents:
  claude-code:
    adapter: claude-code
    auth: subscription
    strengths:
      - implementation
      - refactoring
      - TypeScript
      - React

  codex:
    adapter: codex
    auth: subscription
    strengths:
      - review
      - testing
      - Python
      - security

orchestrator:
  cli: claude-code

error_handling:
  default:
    retry: 1
    fallback: null
    on_exhausted: ask_user
```

---

## Appendix D: Few-Shot Decomposition Examples

```json
// defaults/examples/feature.json
{
  "userRequest": "Add user profile editing with avatar upload",
  "decomposition": {
    "reasoning": "This feature has backend (API + storage) and frontend (form + cropper) components with a natural dependency chain. Review should cover security (upload validation) and UX.",
    "tasks": [
      {
        "id": "task-1",
        "description": "Backend: API endpoint for profile update with avatar upload to cloud storage",
        "agent": "claude-code",
        "role": "implement",
        "dependencies": [],
        "scope": { "files": ["src/api/profile/"], "description": "New API endpoint" },
        "estimatedComplexity": "medium"
      },
      {
        "id": "task-2",
        "description": "Frontend: Profile edit form with avatar cropper and preview",
        "agent": "claude-code",
        "role": "implement",
        "dependencies": ["task-1"],
        "scope": { "files": ["src/components/Profile/"], "description": "New React component" },
        "estimatedComplexity": "high"
      },
      {
        "id": "task-3",
        "description": "Review for security (upload validation, file type/size limits, auth) and UX (error states, loading, responsiveness)",
        "agent": "codex",
        "role": "review",
        "dependencies": ["task-2"],
        "scope": { "files": ["src/api/profile/", "src/components/Profile/"], "description": "Full feature review" },
        "estimatedComplexity": "medium"
      }
    ],
    "suggestedOrder": ["task-1", "task-2", "task-3"]
  }
}
```

```json
// defaults/examples/bugfix.json
{
  "userRequest": "Fix the login timeout issue where users get logged out after 5 minutes",
  "decomposition": {
    "reasoning": "This is a targeted bug fix in session management. Single implementation task with a review for security implications.",
    "tasks": [
      {
        "id": "task-1",
        "description": "Investigate and fix session timeout configuration — check token expiry, refresh logic, and cookie settings",
        "agent": "claude-code",
        "role": "implement",
        "dependencies": [],
        "scope": { "files": ["src/auth/", "src/middleware/"], "description": "Session management" },
        "estimatedComplexity": "medium"
      },
      {
        "id": "task-2",
        "description": "Review fix for security implications: token lifetime, refresh token rotation, session fixation",
        "agent": "codex",
        "role": "review",
        "dependencies": ["task-1"],
        "scope": { "files": ["src/auth/"], "description": "Security review of auth changes" },
        "estimatedComplexity": "low"
      }
    ],
    "suggestedOrder": ["task-1", "task-2"]
  }
}
```

```json
// defaults/examples/refactor.json
{
  "userRequest": "Extract the authentication logic from the monolithic auth.ts into separate modules",
  "decomposition": {
    "reasoning": "Refactoring requires planning module boundaries first, then executing the split. Review should verify no behavior changes.",
    "tasks": [
      {
        "id": "task-1",
        "description": "Plan module boundaries: identify logical groupings in auth.ts, define interfaces between modules, map imports/exports",
        "agent": "claude-code",
        "role": "implement",
        "dependencies": [],
        "scope": { "files": ["src/auth/auth.ts"], "description": "Analysis and planning" },
        "estimatedComplexity": "medium"
      },
      {
        "id": "task-2",
        "description": "Execute refactor: split auth.ts into token.ts, session.ts, oauth.ts, and middleware.ts. Update all imports across the codebase.",
        "agent": "claude-code",
        "role": "refactor",
        "dependencies": ["task-1"],
        "scope": { "files": ["src/auth/"], "description": "Module extraction" },
        "estimatedComplexity": "high"
      },
      {
        "id": "task-3",
        "description": "Review: verify no behavior changes, check all import paths updated, ensure tests still pass, look for circular dependencies",
        "agent": "codex",
        "role": "review",
        "dependencies": ["task-2"],
        "scope": { "files": ["src/auth/", "src/"], "description": "Refactor correctness review" },
        "estimatedComplexity": "medium"
      }
    ],
    "suggestedOrder": ["task-1", "task-2", "task-3"]
  }
}
```

---

## Implementation Order Summary

| Phase | What | Est. Time | Key Deliverable |
|-------|------|-----------|----------------|
| 0 | Scaffold | 2h | CLI runs, build works, tests pass |
| 1 | Adapters | 3h | Can invoke Claude Code + Codex programmatically |
| 2 | Orchestrator | 4h | 6-step pipeline with schemas and prompts |
| 3 | Git worktrees | 2h | Agent isolation working |
| 4 | State persistence | 1h | Resume interrupted workflows |
| 5 | CLI & UI | 3h | Interactive conversation with agent status |
| 6 | Integration | 3h | End-to-end workflow with real CLIs |
| **Total** | | **~18h** | **Working MVP** |

**Start with Phase 0 and Phase 1. Phase 1 is the go/no-go gate.** If the adapters
can reliably invoke both CLIs and parse their output, everything else is engineering.
If they can't, the architecture needs to change before investing more time.
