#!/usr/bin/env bash
# make-fake-terminal-state.sh — write a synthetic terminal state.json
# under $CREW_HOME/runs/<run_id>/state.json so crew-wait can exercise
# its terminal-detection path without dispatching a real agent run.
#
# Usage:
#   ./scripts/empirical-gates/make-fake-terminal-state.sh <run_id> [status]
#   status defaults to "success". Valid: success | partial | error | cancelled.
#
# Cleanup:
#   rm -rf "$CREW_HOME/runs/<run_id>"
#
# Honors CREW_HOME (default ~/.crew). Prints the absolute state.json
# path on success.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: make-fake-terminal-state.sh <run_id> [status]" >&2
  exit 2
fi

RUN_ID="$1"
STATUS="${2:-success}"
case "$STATUS" in
  success|partial|error|cancelled) ;;
  *) echo "error: status must be one of success|partial|error|cancelled (got: $STATUS)" >&2; exit 2 ;;
esac

CREW_HOME_DIR="${CREW_HOME:-$HOME/.crew}"
RUN_DIR="$CREW_HOME_DIR/runs/$RUN_ID"
STATE_PATH="$RUN_DIR/state.json"

mkdir -p "$RUN_DIR"

NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
cat > "$STATE_PATH" <<EOF
{
  "schemaVersion": 1,
  "runId": "$RUN_ID",
  "agentId": "fake-agent",
  "status": "$STATUS",
  "startedAt": "$NOW",
  "completedAt": "$NOW",
  "worktreePath": "$RUN_DIR/worktree",
  "prompts": [
    {"turn": 1, "prompt": "fake", "startedAt": "$NOW", "completedAt": "$NOW", "summary": "synthetic test fixture"}
  ],
  "filesChanged": []
}
EOF

echo "$STATE_PATH"
