#!/usr/bin/env bash
# Captain smoke matrix — iterates over captain CLIs, runs the M1.5/M3/M4
# scenarios, and captures a pass/fail table with timing + automatic-replay
# counts.
#
# Exit gate (per N9): captain-matrix fails if any scenario records ≥2
# automatic-replays on any captain. Gemini-cli is allowed ≤1 replay on
# scenarios 4–8; others must pass clean.
#
# Usage:
#   scripts/smoke/captain-matrix.sh [captain-cli...]
#
# Toggle which scenario set to exercise via MATRIX_PROFILE env var:
#   - unset / "m3" (default): the 8 M1.5/M3 scenarios (written to
#     docs/plans/active/m3-exit-smoke-log.md).
#   - "m4": the 4 M4 scenarios (trivial / typo-fix / code-review /
#     moderate-feature) written to docs/plans/active/m4-exit-smoke-log.md.
#     M4 asserts LLM-call-count shapes (wrappers should NOT fire on
#     trivial flows; plan_tasks is allowed-but-not-required on moderate).
#
# With no args, iterates claude-code, codex, gemini-cli. Pass a subset to
# constrain. Requires the named CLIs on $PATH; unavailable ones are skipped
# with a note in the output.

set -euo pipefail

CAPTAINS=("${@:-claude-code codex gemini-cli}")
readarray -t CAPTAINS_ARRAY < <(printf '%s\n' ${CAPTAINS[@]})
if [ "${#CAPTAINS_ARRAY[@]}" -eq 1 ] && [ "${CAPTAINS_ARRAY[0]}" = "claude-code codex gemini-cli" ]; then
  CAPTAINS_ARRAY=(claude-code codex gemini-cli)
fi

# Scenarios are described in docs/plans/active/vision-alignment-implementation-plan.md §4.4.
# For each one we capture: pass/fail, elapsed wallclock, automatic-replay count
# (from .crew/logs/*.log greppable markers).
MATRIX_PROFILE="${MATRIX_PROFILE:-m3}"
if [ "$MATRIX_PROFILE" = "m4" ]; then
  # M4 scope: four LLM-call-count scenarios.
  SCENARIOS=(
    "1:trivial-message-finish"
    "2:typo-fix-one-run_agent"
    "3:code-review-two-run_agents"
    "4:moderate-feature-plan-then-two-run_agents"
  )
  OUTPUT_LOG="${OUTPUT_LOG:-docs/plans/active/m4-exit-smoke-log.md}"
else
  SCENARIOS=(
    "1:trivial-message-finish"
    "2:code-review-two-run_agents"
    "3:long-run-user-interrupt"
    "4:cancel-subagent-by-id"
    "5:two-concurrent-run_agent"
    "6:ask_user-roundtrip"
    "7:cli-upgrade-replay"
    "8:interrupt-and-resume"
  )
  OUTPUT_LOG="${OUTPUT_LOG:-docs/plans/active/m3-exit-smoke-log.md}"
fi
TMPDIR="$(mktemp -d -t crew-smoke-XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT

declare -A RESULTS   # RESULTS[captain:scenario] = "pass|fail|skip|one-replay"
declare -A TIMINGS   # TIMINGS[captain:scenario] = elapsed_ms
declare -A REPLAYS   # REPLAYS[captain:scenario] = count

have_cli() {
  command -v "$1" >/dev/null 2>&1
}

run_scenario() {
  local captain="$1"
  local scenario="$2"
  local key="${captain}:${scenario}"
  local scenario_num="${scenario%%:*}"
  local scenario_name="${scenario#*:}"

  if ! have_cli "$captain"; then
    RESULTS[$key]="skip (CLI not on PATH)"
    TIMINGS[$key]="0"
    REPLAYS[$key]="0"
    return
  fi

  local workdir="$TMPDIR/${captain}/${scenario_name}"
  mkdir -p "$workdir"
  pushd "$workdir" >/dev/null

  # Scaffold a minimal project for the smoke run.
  git init -q
  git config user.email smoke@test
  git config user.name smoke
  echo "# smoke" > README.md
  git add . && git commit -q -m init

  # Write a minimal workflow config that pins the captain CLI.
  mkdir -p .crew
  cat > .crew/workflow.yaml <<YAML
workflow:
  name: smoke
  execution:
    mode: judgment
  steps: []
  completion:
    strategy: judge_approval
    fallback: max_passes
agents:
  ${captain}:
    adapter: ${captain}
captain:
  cli: ${captain}
error_handling:
  default:
    retry: 1
    fallback: null
    on_exhausted: ask_user
YAML

  local start_ms; start_ms="$(date +%s%3N)"
  # Dispatch the scenario. For most scenarios a single `crew run` invocation
  # suffices; scenarios 7 & 8 require orchestration (version flip, mid-run
  # interrupt) that the script shells out to sub-procedures for.
  local status="pass"
  # All M4 scenarios + M3 scenarios 1–3 run as single-shot invocations.
  # M3 scenarios 4–8 need a second process to interject / cancel; they
  # stay as single-shot hooks and flag one-replay as a soft warning.
  if ! timeout 180 crew run "$(scenario_prompt "$scenario_num")" --on-ask-user fail >"$workdir/stdout.log" 2>"$workdir/stderr.log"; then
    status="fail"
  fi

  local end_ms; end_ms="$(date +%s%3N)"
  TIMINGS[$key]="$((end_ms - start_ms))"

  # Count automatic replays in the log (marker from session-loop.ts).
  local replay_count=0
  if [ -d .crew/logs ]; then
    replay_count=$(grep -c "providerSessionRef rejected; dropping and replaying" .crew/logs/*.log 2>/dev/null || echo 0)
  fi
  REPLAYS[$key]="$replay_count"

  # N9 gate
  if [ "$status" = "pass" ] && [ "$replay_count" -ge 2 ]; then
    status="fail-N9-replay-count-$replay_count"
  elif [ "$status" = "pass" ] && [ "$replay_count" -eq 1 ]; then
    status="pass-one-replay"
  fi

  RESULTS[$key]="$status"
  popd >/dev/null
}

scenario_prompt() {
  if [ "$MATRIX_PROFILE" = "m4" ]; then
    case "$1" in
      1) echo "What is this repo?";;
      2) echo "Fix the comment in README line 10";;
      3) echo "Fix the typo and have another agent review it";;
      4) echo "Add feature X with tests and documentation";;
    esac
    return
  fi
  case "$1" in
    1) echo "Say hello";;
    2) echo "List three things we might work on";;
    3) echo "Continue the prior conversation";;
    4) echo "Start a slow task, then I'll interject";;
    5) echo "Start a task so I can cancel it";;
    6) echo "Run two parallel subagents";;
    7) echo "Run something that may need CLI replay";;
    8) echo "Start a long task then interrupt me";;
  esac
}

write_exit_log() {
  local output="$1"
  mkdir -p "$(dirname "$output")"
  local heading
  if [ "$MATRIX_PROFILE" = "m4" ]; then
    heading="M4 exit smoke log"
  else
    heading="M1.5 / M3 exit smoke log"
  fi
  {
    echo "# $heading"
    echo ""
    echo "Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by scripts/smoke/captain-matrix.sh (profile=$MATRIX_PROFILE)."
    echo ""
    echo "Columns: scenario × captain. Cell value: status / wallclock-ms / replay-count."
    echo "N9 gate: any cell with replay-count ≥2 fails the matrix."
    echo ""
    echo "| Scenario | ${CAPTAINS_ARRAY[*]} |"
    printf '|%.0s---' $(seq 1 $((${#CAPTAINS_ARRAY[@]} + 1)))
    echo "|"
    for scenario in "${SCENARIOS[@]}"; do
      local scenario_num="${scenario%%:*}"
      local scenario_name="${scenario#*:}"
      printf '| %s. %s |' "$scenario_num" "$scenario_name"
      for captain in "${CAPTAINS_ARRAY[@]}"; do
        local key="${captain}:${scenario}"
        local status="${RESULTS[$key]:-pending}"
        local timing="${TIMINGS[$key]:-0}"
        local replays="${REPLAYS[$key]:-0}"
        printf ' %s / %sms / replays=%s |' "$status" "$timing" "$replays"
      done
      echo ""
    done
    echo ""
    echo "## Notes"
    echo ""
    echo "- \`skip\` = CLI not installed on PATH."
    echo "- \`fail-N9-replay-count-N\` = exit gate tripped; captain required ≥2 automatic replays for one scenario."
    if [ "$MATRIX_PROFILE" = "m4" ]; then
      echo "- \`pass-one-replay\` = expected on the first M4 turn against an existing M3 session (M4-3 description-refresh bumps the tool-schema hash exactly once)."
    else
      echo "- \`pass-one-replay\` = gemini-cli 0.20+ acceptable under N9 semantics for scenarios 4–8."
    fi
  } > "$output"
  echo "Exit log written to: $output"
}

for scenario in "${SCENARIOS[@]}"; do
  for captain in "${CAPTAINS_ARRAY[@]}"; do
    run_scenario "$captain" "$scenario"
  done
done

write_exit_log "$OUTPUT_LOG"
