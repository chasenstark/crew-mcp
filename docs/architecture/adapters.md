# Adapter Tool-Loop Architecture

## Overview
Provider adapters now share a common prompt-loop implementation.

Shared modules:

- `src/adapters/tool-loop/decision.ts`
  - Canonical tool-loop decision schema/type (`tool_call | finish | fail`)
- `src/adapters/tool-loop/constants.ts`
  - Loop guardrail constants (turn limits, transcript limits)
- `src/adapters/tool-loop/transcript.ts`
  - Prompt/transcript rendering utilities
- `src/adapters/tool-loop/controller.ts`
  - Generic prompt-loop controller used by adapters

Adapters (`claude-code`, `codex`, `gemini-cli`) delegate fallback prompt-loop execution to this shared controller while preserving provider-specific stateful/resume transports.

## Extension Points

1. Add a new provider adapter
- Implement provider transport/session behavior locally
- Reuse `executePromptToolLoop()` for schema-driven fallback loop
- Reuse `ToolLoopDecisionSchema` for compatible decision parsing

2. Adjust shared controller policy
- Update `tool-loop/controller.ts` once
- All fallback loop users inherit behavior

3. Provider-specific telemetry/session logic
- Keep in adapter module (do not move to shared controller)
- Shared layer should remain transport-agnostic
