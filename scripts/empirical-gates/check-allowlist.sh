#!/usr/bin/env bash
# check-allowlist.sh — Phase 3 empirical gate #1 (allowlist matcher).
#
# Validates that Claude Code's `Bash(<cmd>:*)` allowlist matcher
# accepts both the bare `crew-wait` form and the absolute-path form.
# This is what `crew-mcp install --target claude-code` writes; if the
# matcher silently rejects either form, the captain's watcher won't
# spawn and the dispatch-and-yield flow degrades to baseline.
#
# **Manual flow** — the actual matcher test must run inside Claude
# Code (the host enforcing the allowlist), so this script's job is to:
#   1. Verify both forms are present in ~/.claude/settings.json.
#   2. Print exact `Bash(...)` invocation lines a captain can paste
#      into a Claude Code session to confirm no permission prompt
#      fires.
#   3. Synthesize a terminal state.json so the watcher exits fast.
#
# Pass criterion: in Claude Code, both invocations run without a
# permission prompt and print the CREW_WAIT_TERMINAL line. Record the
# pass in docs/status/captain-flow-review-2026-04-29.md.

set -euo pipefail

SETTINGS="$HOME/.claude/settings.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== Phase 3 gate #1 — allowlist matcher =="
echo

if [[ ! -f "$SETTINGS" ]]; then
  echo "WARN: $SETTINGS not found. Run \`crew-mcp install --target claude-code\` first." >&2
fi

if [[ -f "$SETTINGS" ]]; then
  echo "Allowlist entries in $SETTINGS:"
  if command -v jq >/dev/null 2>&1; then
    jq -r '.permissions.allow[]? | select(test("crew-wait"))' "$SETTINGS" || true
  else
    grep -o '"Bash([^)]*crew-wait[^)]*)"' "$SETTINGS" || echo "  (none)"
  fi
  echo
fi

CREW_WAIT_BIN="$(command -v crew-wait || true)"
if [[ -z "$CREW_WAIT_BIN" ]]; then
  echo "ERROR: crew-wait not on PATH. Build + link the package:" >&2
  echo "  cd <crew-mcp repo> && npm run build && npm link" >&2
  exit 1
fi
ABSOLUTE_BIN="$(realpath "$CREW_WAIT_BIN" 2>/dev/null || readlink -f "$CREW_WAIT_BIN" 2>/dev/null || echo "$CREW_WAIT_BIN")"

# Synthesize a quick-terminal state so the test is fast.
RUN_ID="phase3-gate1-$(date +%s)"
"$SCRIPT_DIR/make-fake-terminal-state.sh" "$RUN_ID" success >/dev/null

cat <<EOF
Now, in Claude Code, run BOTH of the following Bash invocations
and confirm:
  - Neither produces a permission prompt.
  - Each prints "CREW_WAIT_TERMINAL run_id=$RUN_ID agent=fake-agent status=success ...".

Form 1 (PATH):
  Bash("crew-wait $RUN_ID")

Form 2 (absolute):
  Bash("$ABSOLUTE_BIN $RUN_ID")

After running them, clean up:
  rm -rf "${CREW_HOME:-\$HOME/.crew}/runs/$RUN_ID"

Pass criterion: BOTH invocations succeed without prompt. (At minimum
one form must pass; absolute is the fallback if PATH visibility
breaks. Skill body uses the form install resolved.)

Record the result in docs/status/captain-flow-review-2026-04-29.md.
EOF
