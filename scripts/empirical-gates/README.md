# Phase 3 empirical gates

Manual / live-host checks the `non-blocking-captain` plan's Phase 3
documents as **deferred** because they require running host CLIs
(Claude Code, Codex, Gemini) and cannot be exercised purely from CI.
Run them when:

- Promoting `crew-wait` from local-built to a published release.
- Onboarding a new captain skill body change that touches the
  watcher invocation prose.
- Investigating a captain report that "the watcher silently fails."

Each gate has its own script or runbook. Record the outcome (pass /
fail / N/A + dated notes) in
`docs/status/captain-flow-review-2026-04-29.md` so the deferred
status in the plan can move to "passed."

| Gate | File | Host needed | Pass criterion |
|---|---|---|---|
| #1 Allowlist matcher | [`check-allowlist.sh`](./check-allowlist.sh) | Claude Code | `Bash(crew-wait:*)` (and absolute fallback) accept without prompt |
| #2 Stdout in synthetic turn | [`check-stdout-synthetic.md`](./check-stdout-synthetic.md) | Claude Code | Background watcher's `CREW_WAIT_TERMINAL ...` line appears in synthetic-turn payload |
| #3 Foreground on Codex ≥5min | [`check-foreground-codex.md`](./check-foreground-codex.md) | Codex CLI | Foreground `crew-wait` runs to completion past 5min and ESC cancels cleanly |
| #4 Foreground on Gemini ≥5min | [`check-foreground-gemini.md`](./check-foreground-gemini.md) | Gemini CLI | Same as #3 for Gemini |

## Shared harness

`make-fake-terminal-state.sh` writes a synthetic `state.json` under
`$CREW_HOME/runs/<id>/` so you can exercise `crew-wait` against a
known-good record without dispatching a real agent run. Used by the
allowlist check and useful for any local crew-wait debugging.
