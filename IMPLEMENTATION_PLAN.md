# Implementation Plan

This document translates the findings in `ANALYSIS.md` into a corrected, prioritized implementation plan.

## Corrections To The Analysis

- `--debug` is already implemented in `src/index.ts`; it should not be tracked as a missing feature.
- `resume` is still a stub in `src/cli/commands/resume.ts`.
- `cosmiconfig` appears to be unused; there are no direct imports under `src/` or `test/`.

## Prioritized Plan

### 1. Add the missing safety net first

Target files:

- `src/captain/pipeline.ts`
- `src/utils/json-parse.ts`
- `src/utils/validate.ts`
- `test/captain/pipeline.test.ts` (new)
- `test/utils/json-parse.test.ts` (new)
- `test/smoke.test.ts`

Scope:

- Cover `done`, `iterate`, `ask_user`, and loop-detected paths in the pipeline.
- Test dependency-skip behavior.
- Test fallback report generation.
- Add regression tests for JSON extraction edge cases.

Reason:

- These paths are the highest-risk logic in the codebase and currently have little or no coverage.

### 2. Fix failure and persistence semantics

Target files:

- `src/cli/commands/run.ts`
- `src/captain/pipeline.ts`
- `src/state/store.ts`
- `src/state/types.ts`

Scope:

- Make unrecovered non-interactive failures exit non-zero.
- Distinguish `running`, `interrupted`, `failed`, and `completed` workflow states.
- Persist enough state to resume deterministically.

### 3. Implement real resume support

Target files:

- `src/cli/commands/resume.ts`
- `src/captain/pipeline.ts`
- `src/state/store.ts`

Scope:

- Resume from saved decomposition and pass history.
- Continue at the next actionable task or pass.
- Fail clearly when a workflow cannot be resumed safely.

### 4. Harden the interactive input UX

Target files:

- `src/cli/ui/App.tsx`
- `src/cli/ui/PromptInput.tsx`
- `test/cli/ui/` (new)

Scope:

- Show queued input state.
- Allow clearing queued messages.
- Make waiting-for-input vs running states explicit.

Note:

- Multi-line input should be deferred until cancellation exists.

### 5. Add graceful cancellation

Target files:

- `src/captain/pipeline.ts`
- `src/cli/commands/run.ts`
- `src/cli/ui/App.tsx`
- `src/adapters/codex.ts`
- `src/adapters/claude-code.ts`
- `src/adapters/generic.ts`

Scope:

- Add a pipeline cancel API.
- Pass `AbortSignal` into subprocess execution.
- Save interrupted state before exit.

### 6. Add streaming agent output

Target files:

- `src/adapters/codex.ts`
- `src/adapters/claude-code.ts`
- `src/adapters/generic.ts`
- `src/cli/ui/ConversationView.tsx`

Scope:

- Introduce `agent:output` events.
- Render partial progress in the UI.

Reason for sequencing:

- Current adapters parse whole-process output after completion; streaming is the most invasive change and should follow cancellation and test coverage.

### 7. Clean up lower-risk technical debt

Target files:

- `package.json`
- `src/git/worktree.ts`
- `src/workflow/loader.ts`
- `src/adapters/generic.ts`

Scope:

- Remove unused `cosmiconfig`.
- Align `prepublishOnly` with npm usage.
- Stop assuming the default branch is `main`.
- Replace the YAML parsing `any`.
- Decide whether `GenericAdapter` needs schema support or clearer documented limitations.

## Recommended Execution Order

### Phase 1

- Item 1: test coverage for `extractJson` and the pipeline.
- Item 2: failure-state and persistence semantics.
- Item 3: resume implementation.

### Phase 2

- Item 4: interactive input UX.
- Item 5: graceful cancellation.

### Phase 3

- Item 6: streaming agent output.
- Item 7: lower-risk cleanup.

## Concrete Start Order

1. Add `extractJson` tests.
2. Add pipeline tests.
3. Implement exit-state and resume groundwork.
