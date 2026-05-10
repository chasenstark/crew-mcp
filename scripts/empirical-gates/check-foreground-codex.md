# Phase 3 gate #3 — Foreground crew-wait on Codex (≥5min)

Validates that `crew-wait` works as a foreground shell command from
inside a Codex CLI session for runs that exceed Codex's 60s MCP
`tool_timeout_sec` AND its 5-minute `background_terminal_max_timeout`
ceiling.

## Why this matters

The Phase 2 skill body says foreground `crew-wait` is **Claude-only**
until this gate passes (per docs/plans/active/non-blocking-captain.md
Decision 4 + Phase 2 review's hard gate). Without this evidence,
captains on Codex must default to the portable baseline (end turn,
check at next user turn).

## Procedure

In a Codex CLI session inside this repo:

1. Dispatch a long crew run from Codex (≥6 minutes wall-time so the
   wait clears the 5-min `background_terminal_max_timeout`):

   ```
   mcp__crew__run_agent({
     agent_id: "codex",
     prompt: "Sleep 360 seconds then exit. Use whatever sleep mechanism Codex allows (e.g., a Python sleep loop with stdout heartbeats). Do not write files."
   })
   ```

   Note the `run_id`.

2. Foreground the watcher:

   ```
   Bash(command="crew-wait <run_id>", run_in_background: false)
   ```

3. Wait for terminal. The shell call should NOT time out at 60s
   (that's the MCP `tool_timeout_sec` for tool RESPONSES, not for
   shell commands) and should NOT time out at 5min (that's the
   `background_terminal_max_timeout`, which only applies to
   `is_background:true` shell calls — foreground is supposed to
   block until completion).

4. After terminal, observe the stdout payload:

   ```
   CREW_WAIT_TERMINAL run_id=<UUID> agent=codex status=success worktree=...
   ```

5. Repeat with ESC mid-wait (around minute 3): does Codex cleanly
   cancel the foreground shell? Does the partial wait return the
   shell to Codex without losing the run state?

## Pass criterion

- Foreground `crew-wait` runs to completion past 5 minutes without
  timeout.
- Stdout payload is delivered intact to Codex.
- ESC during wait cancels the wait cleanly (the underlying run is
  unaffected; subsequent `get_run_status({ run_id })` returns the
  rich payload once the agent itself finishes).

## Fail criterion

Any of:
- Codex kills the foreground shell at 60s or 5min boundaries.
- Stdout payload is truncated or missing.
- ESC corrupts Codex session state or destroys the run.

If the gate fails, the foreground crew-wait promise is removed for
Codex. Skill body already encodes that ambiguity ("Codex blocked
until empirical gates pass"); update the status doc to record the
fail and keep the skill body's hard gate in place.

## Recording

Append to `docs/status/captain-flow-review-2026-04-29.md`:

```markdown
### YYYY-MM-DD — Phase 3 gate #3 (Codex foreground ≥5min): PASS|FAIL

- Codex CLI version: <codex --version>
- Run id used: <UUID>
- Wait duration: <seconds>
- ESC cancellation: <observed behavior>
```
