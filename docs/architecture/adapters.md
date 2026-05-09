> **Current as of 2026-05-09.**

## Load-bearing source anchors

- Production registry: `src/adapters/registry.ts:190`, `src/adapters/registry.ts:192`, `src/adapters/registry.ts:193`, `src/adapters/registry.ts:194`.
- Agent adapter interface and optional tool-loop method: `src/adapters/types.ts:133`, `src/adapters/types.ts:139`.
- Production dispatch call: `src/orchestrator/tools/run-agent.ts:322`.
- Dispatch constraints: `src/orchestrator/tools/run-agent.ts:327`, `src/orchestrator/tools/run-agent.ts:331`, `src/orchestrator/tools/run-agent.ts:341`, `src/adapters/types.ts:191`, `src/adapters/types.ts:208`, `src/adapters/types.ts:218`, `src/adapters/types.ts:234`.
- Result warnings: `src/adapters/types.ts:240`, `src/adapters/types.ts:252`, `src/orchestrator/tools/run-agent.ts:348`, `src/orchestrator/tools/run-agent.ts:360`.
- Shared legacy tool-loop modules: `src/adapters/tool-loop/decision.ts:47`, `src/adapters/tool-loop/constants.ts:1`, `src/adapters/tool-loop/transcript.ts:1`, `src/adapters/tool-loop/controller.ts:1`.

# Adapter Architecture

## Production Path

The v0.2 MCP-server production path invokes `AgentAdapter.execute()`. The interface declares `execute(task)` at `src/adapters/types.ts:133`, and `run_agent` calls `args.adapter.execute()` at `src/orchestrator/tools/run-agent.ts:322`.

`executeWithTools()` still exists as an optional interface method at `src/adapters/types.ts:139`, but the live `crew-mcp serve` dispatch path does not call it. The optional tool-loop modules remain in `src/adapters/tool-loop/`, and `ToolLoopDecisionSchema` still accepts `tool_call`, `finish`, and `fail` at `src/adapters/tool-loop/decision.ts:47`.

The built-in production registry contains Claude Code, Codex, and Gemini CLI. `createBuiltinRegistry()` is defined at `src/adapters/registry.ts:190`, and it registers those three adapters at `src/adapters/registry.ts:192`, `src/adapters/registry.ts:193`, and `src/adapters/registry.ts:194`.

## Dispatch Constraints

`run_agent` builds a `constraints` object at `src/orchestrator/tools/run-agent.ts:327`. That object threads the effective model at `src/orchestrator/tools/run-agent.ts:329`, effective effort at `src/orchestrator/tools/run-agent.ts:330`, sandbox mode at `src/orchestrator/tools/run-agent.ts:331`, writable paths at `src/orchestrator/tools/run-agent.ts:332`, and network access at `src/orchestrator/tools/run-agent.ts:341`.

The shared `Task` type declares the constraints block at `src/adapters/types.ts:191`. It defines `sandbox` values at `src/adapters/types.ts:208`, `networkAccess` at `src/adapters/types.ts:218`, and `writablePaths` at `src/adapters/types.ts:234`.

Write-mode runs use `sandbox: "workspace-write"` and read-only runs use `sandbox: "read-only"`; that branch is in `src/orchestrator/tools/run-agent.ts:331`. Write-mode runs derive extra Git writable paths before dispatch at `src/orchestrator/tools/run-agent.ts:305` through `src/orchestrator/tools/run-agent.ts:308`.

## Result Contract

Adapters return `TaskResult`; the interface starts at `src/adapters/types.ts:240`. `TaskResult.status` is `success`, `error`, or `partial` at `src/adapters/types.ts:243`, and `TaskResult.warnings` is an optional advisory field at `src/adapters/types.ts:252`.

The dispatch layer, not adapters, owns `warnings`. The type comment states that the current producer is the read-only dirty-tree probe at `src/adapters/types.ts:246` through `src/adapters/types.ts:250`. The implementation performs that probe after read-only dispatches at `src/orchestrator/tools/run-agent.ts:348` and appends the warning at `src/orchestrator/tools/run-agent.ts:360`.

## Optional Tool-Loop Surface

The shared tool-loop code is still present for adapter-local fallback paths. The decision schema is in `src/adapters/tool-loop/decision.ts`, constants are in `src/adapters/tool-loop/constants.ts`, transcript helpers are in `src/adapters/tool-loop/transcript.ts`, and the generic controller is in `src/adapters/tool-loop/controller.ts`.

Do not describe this optional surface as the `crew-mcp serve` production path. The production path is `execute()` at `src/adapters/types.ts:133` and the live call site is `src/orchestrator/tools/run-agent.ts:322`.
