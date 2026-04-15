# Runner Architecture

## Overview
The orchestration runtime now has a shared base/core split:

- `src/captain/runner-base.ts`
  - Owns event-driven user input lifecycle (`ask_user` / `provideUserInput`)
  - Owns cancellation and interruption behavior
  - Provides common `AbortController` management
- `src/captain/task-execution-core.ts`
  - Shared decision helpers for both engines:
    - task model resolution
    - captain model resolution
    - safe working-directory resolution
    - max-pass policy lookup
    - run-id generation
    - fallback report rendering

Concrete runners remain policy-specific:

- `Pipeline` (`src/captain/pipeline.ts`): deterministic linear step loop.
- `JudgmentRunner` (`src/captain/judgment-runner.ts`): tool/action-loop controller.

## Extension Points

1. Add a new runner policy
- Extend `RunnerBase`
- Reuse `task-execution-core` helpers for common semantics
- Implement `run()` and `resume()` with policy-specific control flow

2. Tune model-routing behavior
- Update `resolveTaskModel` / `resolveCaptainModel` in `task-execution-core.ts`
- Keep both runners behavior-aligned automatically

3. Adjust interruption semantics
- Update `RunnerBase.cancel()` / `RunnerBase.markInterrupted()` once
- Both runners inherit behavior
