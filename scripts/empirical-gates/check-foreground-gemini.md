# Phase 3 gate #4 — Foreground crew-wait on Gemini (≥5min)

Same shape as gate #3 but for Gemini CLI. Phase 2 skill body's hard
gate blocks foreground `crew-wait` use on Gemini until this passes.

## Procedure

In a Gemini CLI session inside this repo:

1. Dispatch a long crew run (≥6 minutes wall-time):

   ```
   mcp__crew__run_agent({
     agent_id: "codex",
     prompt: "Sleep 360 seconds then exit."
   })
   ```

   Note the `run_id`.

2. Foreground the watcher:

   ```
   Bash(command="crew-wait <run_id>")
   ```

   (Gemini's tool naming may differ; use whatever produces a blocking
   foreground shell call, NOT `is_background: true`.)

3. Wait for terminal. Confirm the call doesn't get cut off by
   Gemini's own internal shell timeouts.

4. After terminal, observe the stdout payload:

   ```
   CREW_WAIT_TERMINAL run_id=<UUID> agent=codex status=success worktree=...
   ```

5. Repeat with whatever cancellation mechanism Gemini exposes
   (Ctrl-C, ESC, "stop" command, etc.). Confirm clean cancellation.

## Pass criterion

- Foreground `crew-wait` runs to completion past 5 minutes without
  Gemini-side timeout.
- Stdout payload delivered intact.
- Cancellation works cleanly without corrupting session or run state.

## Fail criterion

Any of:
- Gemini kills the foreground shell before 5 minutes elapse.
- Stdout truncated / missing.
- Cancellation corrupts session.

If the gate fails, foreground crew-wait stays Claude-only. Update
the status doc; the skill body's hard gate is already in place.

## Recording

Append to `docs/status/captain-flow-review-2026-04-29.md`:

```markdown
### YYYY-MM-DD — Phase 3 gate #4 (Gemini foreground ≥5min): PASS|FAIL

- Gemini CLI version: <gemini --version>
- Run id used: <UUID>
- Wait duration: <seconds>
- Cancellation: <observed behavior>
```
