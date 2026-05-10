# Phase 3 gate #2 — stdout in synthetic turn (HARD GATE)

This is the **load-bearing** gate for the chat-available default
flow on Claude Code. If `crew-wait`'s `CREW_WAIT_TERMINAL ...` stdout
does NOT appear in the synthetic turn's tool-result body, the
captain has no way to identify which run finished and the watcher
overlay has to fall back to the marker-file path
(`list_runs({status: terminal-states, completedAfter: ...})`).

## Setup

```bash
# Build + link the local crew-wait if not already on PATH.
npm run build && npm link

# Confirm the bin shim resolves and runs (smoke test the symlink fix).
crew-wait --help
```

## Procedure

In a fresh Claude Code session inside this repo:

1. Dispatch a short crew run (10-30 seconds is enough — we just need
   one terminal event):

   ```
   mcp__crew__run_agent({
     agent_id: "codex",
     prompt: "Echo OK and exit immediately.",
     read_only: true,
   })
   ```

   Note the returned `run_id`.

2. Spawn the watcher in background:

   ```
   Bash(command="crew-wait <run_id>", run_in_background: true)
   ```

3. End your turn (don't poll, don't reply).

4. Wait for the synthetic turn to fire (when `crew-wait` exits on
   terminal). The turn arrives as a tool-completion event whose body
   includes the bash command's stdout.

## Pass criterion

The synthetic turn's body MUST contain a literal line of the form:

```
CREW_WAIT_TERMINAL run_id=<UUID> agent=<agent> status=<status> worktree=<path>
```

with the same `run_id` you dispatched. The captain parses `run_id`
out of this line and calls `get_run_status({ run_id })` for the rich
payload.

## Fail criterion

If the synthetic turn arrives with an empty body, only the
process-completion metadata, or no body at all, the stdout pipeline
is broken on this Claude Code version. **Result: PASS-DEGRADED.**

The Phase 3 implementation already covers the degraded path: the
captain falls back to `list_runs({ status: terminal-set,
completedAfter: <last-surface-ts> })` and dedupes against
already-surfaced run IDs. Document the version that broke
stdout-surfacing in the status doc so we know when to revisit.

## Recording

Append to `docs/status/captain-flow-review-2026-04-29.md`:

```markdown
### YYYY-MM-DD — Phase 3 gate #2 (stdout synthetic turn): PASS|PASS-DEGRADED|FAIL

- Claude Code version: <claude-code --version>
- Run id used: <UUID>
- Synthetic-turn body excerpt: <paste>
```
