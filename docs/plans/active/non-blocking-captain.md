# Non-blocking captain — chat-available dispatch

**Status:** **Implementation-ready as of rev 9 (2026-05-09).**
Revisions 2–9 addressed 33 findings across nine review passes
(parallel architect + codex first-pass review, then eight codex
review passes against `9b8d0308`). Codex's ninth-pass verdict:
*"non-blocking-captain.md is implementation-ready: the remaining
POSIX-only historical hits are explicitly marked superseded by rev
6/8 Decision 15, active Decision 15 is platform-aware, and all
`merge_conflict` references now match the recovery contract."* See
"Findings from review" below for the audit trail.

Supersedes the rejection in section 5 of
`docs/plans/parked/long-poll-cost-tuning.md` after a product-vision
update: **chatting with the captain should always (or nearly always)
be available, and dispatched agents / polling must not block the
conversation turn.** That outranks the inline-progress-notification
UX the parked plan was preserving.

## Goal

After `run_agent` / `continue_run` dispatch, the captain ends its turn
so the user can chat freely. Terminal status surfaces:

- **Claude Code (default)**: automatically, via a backgrounded
  `crew-wait` watcher that exits on terminal — completion fires a
  synthetic captain turn. No user input required.
- **Codex / Gemini (default)**: at the next user-initiated turn, when
  the captain checks known pending run IDs (via `get_run_status`) or
  recovers via `list_runs` after `/clear` or context loss.
- **Any host (opt-in, gated on empirical test)**: foregrounded
  `crew-wait` — captain holds the turn through a single shell wait.
  Blocks chat but uses one inference instead of N from the legacy
  long-poll loop. For users who explicitly want immediate notification.
- **All hosts (optional)**: an OS notification fired by the crew
  server on terminal, for users who walked away.

The captain is never an MCP long-poll. The wait happens in `crew-wait`
— backgrounded where the host supports synthetic turns, foregrounded
opt-in otherwise. Same binary, different invocation patterns.

## Background

### What ships today

Per `docs/plans/parked/long-poll-cost-tuning.md`:

- `run_agent` returns `{ status: "running", run_id }` immediately.
- The captain calls `get_run_status({ wait_for_terminal_only: true,
  wait_for_change_ms: 30000, ... })` in a loop until terminal.
- The skill body explicitly forbids ending the turn: "Hard rule: stay
  in the same turn." Long-poll is "the wait."
- Progress UX during the wait comes from MCP `notifications/progress`
  rendered inline by hosts that support them (Claude Code), or the
  generated `tail.command` / `events.log` side-channel (every host).

This works architecturally but produces the failure mode the user
flagged: while the captain holds the turn, the conversation reads as
"locked." Anything the user types queues until the long-poll wakes
or terminal fires.

### Why now

The product vision update is explicit: chat-availability is the
property to optimize for. Inline progress notifications are a nice-to-
have; chat-availability is the load-bearing UX. The earlier
rejection of background dispatch in `long-poll-cost-tuning.md`
section 5 weighed inline-progress preservation more heavily than
chat-availability — that weighting is now reversed.

### What changed since the parked rejection

The parked rejection cited three reasons:

1. *"Bash can't call MCP tools directly, so we'd be reading state.json
   off disk through a parallel API."* → State.json is a stable,
   atomically-written record. Reading it off disk is no longer "a
   parallel API"; it is the canonical persistence layer crew already
   maintains. We formalize the contract; we don't add a new one.
2. *"The captain still needs to inference at the end to take next
   steps."* → Correct, and that inference is exactly the synthetic
   turn the harness fires when the watcher exits. Same one inference
   we'd pay either way.
3. *"The user loses live progress notifications."* → True, and the
   user has accepted this trade. `tail.command` / `events.log` side-
   channel remains the live-progress path. Inline `notifications/
   progress` only existed during in-flight tool calls; the captain no
   longer makes one, so they go away. Deliberate UX regression in
   exchange for chat-availability.

### Cross-host research summary

Empirical findings (2026-05-09):

- **Claude Code** has a wake-up primitive: any `Bash run_in_background`
  or `TaskCreate run_in_background` completion synthesizes a new
  captain turn carrying the result. Confirmed via direct test.
- **Codex CLI** has *no* wake-up. `spawn_agent`/`wait_agent` exists but
  `wait_agent` blocks the turn — same failure mode as today's long-
  poll. Stop hooks can re-engage at end-of-turn but cannot fire from
  idle. Default MCP `tool_timeout_sec` is **60s**. Shell commands run
  on a separate timeout (`background_terminal_max_timeout` default
  5min, observed to extend further in practice).
- **Gemini CLI** has *no* wake-up. `is_background:true` on shell tools
  returns immediately with no notification mechanism. MCP
  `notifications/progress` is UI-only (added v0.32.1); server-
  initiated messages are not delivered to the model (issue #3052).

Empirical findings on Claude Code synthetic-turn behavior:

- Background bash completions fire as their own turns, queued behind
  any in-flight user message (verified — user message arrived first
  during a 30s/60s staggered test, then each bash fired its own
  separate synthetic turn).
- Synthetic turns are NOT batched. N close-together completions
  produce N separate synthetic turns. (Plan accepts this rather than
  trying to coalesce.)

## Findings from review

Three review passes happened before this revision. All findings
below have been addressed; the audit trail is preserved here so
future readers can verify each issue's resolution.

### First-pass review (revision 1 → revision 2)

Two reviewers — `code-architect` (Claude Code subagent) and `codex`
(crew read-only run `9b8d0308` turn 1) — independently converged on
these load-bearing gaps in revision 1. All resolved in revision 2.

1. **No `list_runs` mechanism.** Captain had no way to remember
   in-flight runs across `/clear` or context compaction. Resolved:
   adds `list_runs` MCP tool as Phase 1 prerequisite.
2. **`Bash(<path>:*)` allowlist pattern unproven.** Resolved: ship a
   named binary `crew-wait` on PATH; allowlist becomes
   `Bash(crew-wait:*)`.
3. **State.json contract had race-condition gaps.** Resolved:
   watcher exits only on the four `markTerminal` statuses;
   `discard_run` will refuse running runs (cancel first).
4. **Skill-body rewrite scope was too narrow.** Resolved: expanded
   from 2 named sections to 8.
5. **Server restart leaves orphaned `running` state.** Resolved:
   stale-run sweeper at server startup. *Rev 4 narrows scope — see
   third-pass finding 19.*
6. **`HostAdapter` lacks "install extra asset" hook.** Resolved
   (pragmatic): Claude-specific install branch in v1; deferred
   adapter-contract change to v2.
7. **Wrong config path** (`~/.claude.json` →
   `~/.claude/settings.json`). Resolved.
8. **`crewHome` divergence** when `$CREW_HOME` is set. *Rev 3
   committed to env-with-fallback; rev 4 mandates reuse of
   `resolveCrewHome()` — see refinements below.*
9. **`~/.crew/config.json` is fictional.** Resolved: env var
   (`CREW_OS_NOTIFICATIONS=off`).
10. **Multi-run flooding UX needed captain guidance.** *Rev 2 added
    skill-body batching guidance; rev 3 reversed this — see
    second-pass finding 17 — accepting N synthetic turns.*
11. **Synthetic-turn payload needed to be self-describing.**
    Resolved: `crew-wait` echoes a one-line metadata payload on
    exit; rev 3 added an empirical test that this stdout is
    actually delivered. *Rev 4 strengthens that test to a hard
    Phase 3 ship gate.*

### Second-pass review (revision 2 → revision 3)

Codex re-review (`9b8d0308` turn 2) found 7 further issues. All
resolved in revision 3.

12. **`list_runs` underspecified for actual implementation.**
    Resolved: registration paths in `serve.ts:241` +
    `tool-catalog.ts:26` made explicit; `include_unknown_repo` arg
    added. *Rev 4 adds barrel export from
    `src/orchestrator/tools/index.ts` and clarifies `summary`
    field semantics.*
13. **Decision 11 only fixed one of three races.** Resolved:
    Phase 1 adds running-guards to `merge_run` and `continue_run`
    in addition to `discard_run`. *Rev 4 adds an explicit example
    table for `continue_run` semantics.*
14. **Stale-run sweeper was contradictory.** *Rev 3 committed to
    "mark-all-running" v1; rev 4 narrows scope per third-pass
    finding 19.*
15. **Skill rewrite scope still missed two surfaces.** Resolved:
    Phase 2 expanded. *Rev 4 corrects the source-of-truth path —
    see third-pass finding 20.*
16. **`crewHome` propagation muddled.** *Rev 3 committed to env +
    fallback; rev 4 mandates reuse of `resolveCrewHome()` and
    addresses binary wiring per third-pass finding 21.*
17. **Multi-run batching cannot be solved in skill prose.**
    Resolved: rev 3 dropped the batching promise.
18. **`crew-wait` stdout-into-synthetic-turn unverified.** *Rev 3
    added an empirical test; rev 4 makes it a hard Phase 3 ship
    gate per third-pass finding 23.*

### Foreground `crew-wait` unification (rev 3 addition)

User raised mid-discussion: Codex's TUI clearly waits on long-running
shell commands. A foreground `crew-wait` shell call gives Codex/Gemini
captains a single-inference wait — strictly better than the legacy
N-iteration `wait_for_terminal_only` long-poll loop, even though it
still blocks chat. Resolved: rev 3 makes `crew-wait` the universal
wait primitive. *Rev 4 gates the "any host opt-in" promise on
empirical tests per third-pass finding 22.*

### Fifth-pass review (revision 5 → revision 6)

Codex fifth-pass review (`9b8d0308` turn 5) verified rev-5 fixes
landed directionally but identified 3 remaining small ambiguities.
All resolved in revision 6.

26. **`merge_conflict` recovery was contradictory.** Phase 1 said
    "discard the run with `discard_run` and re-dispatch" but
    Decision 11's table refused `discard_run` on `merge_conflict`.
    Combined with `merge_run` and `continue_run` also refusing, the
    user was stranded with no recovery path. Resolved: rev 6
    revises Decision 11's `merge_conflict` row — `merge_run`
    allowed (retry after manual resolution), `discard_run` allowed
    (cleanup after `git merge --abort`), `continue_run` still
    refused. Phase 1's `merge-run.ts:26` prose update reflects this.
27. **`list_runs` API shape inconsistent.** Decision 3 defined
    `status?: RunStatus` (singular); Decision 16 / Phase 3 test #2
    used `status: terminal-states` (array) and `repoRoot: current`
    (not in spec). Resolved: rev 6 revises the input to
    `{ status?: RunStatus | RunStatus[], include_unknown_repo?:
    boolean, completedAfter?: string, limit?: number }`; `repoRoot`
    filtering remains implicit (always current MCP server's repo);
    default sort is newest-first by `completedAt`.
28. **`resolveCrewWaitBinary()` lacked Windows + executable-check
    guardrails.** Algorithm assumed POSIX `which`; missed Windows
    `where` + extension handling (`.cmd`, `.ps1`, `.exe`); didn't
    `fs.access` the candidate before returning. Resolved: rev 6
    expands Decision 15 with platform-aware lookup and an
    executable-check step.

Refinements addressed in rev 6:

- **Phase 3 tests #3 and #4** duration bumped from ≥3 minutes to
  ≥5 minutes — better headroom for foreground wait stability
  against shell timeout ceilings.

### Fourth-pass review (revision 4 → revision 5)

Codex fourth-pass review (`9b8d0308` turn 4) verified findings 19,
20, 22, 23 landed cleanly; identified 2 remaining block-level gaps
+ refinements. All resolved in revision 5.

24. **`crew-wait` absolute binary resolution still abstract.** Plan
    said "derive via the same mechanism `crew-binary.ts:34` uses,"
    but that resolver returns the args for invoking the MCP server
    (`node + dist/index.js serve`), not a `crew-wait` executable
    path. Resolved: rev 5 specified a concrete `resolveCrewWaitBinary()`
    rule (initial POSIX-only sketch — *superseded by rev 6/8
    Decision 15*, which adds platform-aware `which`/`where`
    lookup, `fs.access` executable-check, and Windows extension
    ordering for `.cmd` / `.ps1` / `.exe` / `.bat`).
    Phase 3 test #1 explicitly tests both `Bash(crew-wait:*)` and
    the absolute fallback `Bash(<absolute-path>:*)`.
25. **Marker-file fallback contract undefined.** Rev 4 said "writes
    metadata to a file the captain reads on next `list_runs`" but
    `list_runs` returns only `{ run_id, agent_id, status, ... }` —
    no path for marker exposure. Resolved: rev 5 simplifies the
    fallback. `list_runs` IS the marker-file equivalent (already
    returns the same fields the stdout payload would have). When
    the synthetic turn arrives empty, captain calls `list_runs(status:
    'success' | 'partial' | 'error' | 'cancelled')` filtered to
    current `repoRoot`, surfaces all newly-terminal runs, dedupes
    via conversation history. On `/clear` re-surfacing is accepted
    as the recovery cost. No new file format needed.

Refinements addressed in rev 5:

- **`merge-run.ts:26` prose conflict.** Existing prose suggests
  "resolve, retry, or iterate via `continue_run`" on
  `merge_conflict`. Decision 11's refusal of `continue_run`
  contradicts this. Resolved: Phase 1 updates `merge-run.ts:26`
  to reflect v1's actual recovery paths (per Decision 11 as of
  rev 6): retry `merge_run` after manual conflict resolution,
  OR `git merge --abort` + `discard_run`; `continue_run` is
  refused.
- **`list_runs` `summary` fallback.** When sweeper marks a run as
  `error` without calling `markTerminal()`, `prompts.at(-1)?.summary`
  is undefined. Resolved: `list_runs` falls back to `lastError` text
  when summary is missing.
- **Phase 3 test #3/#4 wording tightened.** "Multi-minute" replaced
  with "≥3 minutes (exceeding Codex's 60s MCP `tool_timeout_sec`)."
- **Test matrix shows fallback row explicitly.** Added: if Phase 3
  tests #3 and #4 fail, the "Any host opt-in" row is removed from
  the production matrix; foreground `crew-wait` ships Claude-only.

### Third-pass review (revision 3 → revision 4)

Codex third-pass review (`9b8d0308` turn 3) found 5 block-level
issues + several refinements. All addressed in revision 4.

19. **Stale-run sweeper too broad.** Walking all of `~/.crew/runs/`
    and marking every running run as `error` is unsafe with normal
    multi-process use (two host sessions, two repos, two
    `crew-mcp serve` instances on shared `$CREW_HOME`). Resolved:
    sweeper now scopes to runs where `repoRoot === current
    projectRoot`. Same-repo multi-session remains a documented false
    positive — narrower and more acceptable.
20. **`get_run_status` description source misstated.** The tool
    catalog imports `GET_RUN_STATUS_DESCRIPTION` from
    `src/orchestrator/tools/get-run-status.ts:91`. Updating
    `tool-catalog.ts` alone does nothing. Resolved: Phase 2 now
    points to `get-run-status.ts:91` as the source-of-truth.
21. **`crew-wait` binary wiring incomplete.** Existing packaging
    builds only `src/index.ts` via `tsup.config.ts:4`; package.json
    exposes only `crew-mcp`. Adding `src/cli/wait.ts` plus a `bin`
    entry isn't enough — also need a second tsup entry, regenerate
    `package-lock.json`, and address PATH fragility (existing
    `crew-mcp install` captures absolute `node + dist/index.js
    serve` precisely to avoid PATH dependence). Resolved: Phase 3
    expanded with all of these; install verifies `crew-wait`
    discoverability or falls back to absolute path.
22. **Foreground unification needs empirical gating per host.**
    "Any host opt-in" promised without verifying multi-minute
    foreground command behavior, timeout ceilings, or ESC/cancel
    semantics on Codex / Gemini. Resolved: Phase 3 adds three new
    empirical pre-merge tests for foreground use; "any host
    opt-in" claim gated on those tests passing.
23. **Turn-start pending-run guidance too narrow.** Plan said "call
    `list_runs` if you don't have run_ids in context" — missed the
    common case where captain DOES remember a run. Resolved:
    skill-body guidance now reads "on each user turn, check known
    pending run IDs first via `get_run_status`; use `list_runs` as
    recovery after `/clear` or unknown context."

Refinements addressed in rev 4:

- **Decision 10 wording corrected.** `wait_for_terminal_only` is
  not "strictly obsolete" — foreground `crew-wait` only emits
  metadata; captain still needs `get_run_status` for summary /
  files / events_tail. Reworded as: "deprecated for default
  captain flow, not deprecated as a capability."
- **`list_runs` `summary` field semantics clarified.** `RunStateV1`
  has no top-level `summary`; it's per-prompt. List_runs returns
  the latest-prompt summary.
- **`continue_run` example table added** to clarify which statuses
  are continue-allowed: `success/partial/error/cancelled →
  allowed (resets to running)`; `running → refuse`; `merged /
  merge_conflict / discarded → refuse (post-merge / post-discard
  terminal)`.
- **`crew-wait` reuses `resolveCrewHome()`** from
  `src/utils/crew-home.ts` rather than reimplementing env/fallback
  semantics.
- **Phase 3 stdout test promoted to hard ship gate.** If
  `CREW_WAIT_TERMINAL ...` stdout isn't model-visible in the
  synthetic turn, the marker-file fallback (write to a file the
  captain reads on next `list_runs`) must be implemented and
  empirically tested before the Claude overlay ships at all.

## Decisions

1. **Captain ends its turn after dispatch.** No in-turn long-poll.
2. **`state.json` is the producer-side contract.** Atomic-written;
   exposed as a public contract via Phase 1 docs.
3. **`list_runs` MCP tool ships in Phase 1.** Registered in
   `serve.ts:241` + `tool-catalog.ts:26`, exported from
   `src/orchestrator/tools/index.ts` barrel.

   Input: `{ status?: RunStatus | RunStatus[],
   include_unknown_repo?: boolean, completedAfter?: string,
   limit?: number }`. `status` accepts a single value or array
   (e.g., `["success", "partial", "error", "cancelled"]` for
   "any terminal"). `repoRoot` filtering is implicit — always
   the current MCP server's repo, with `include_unknown_repo:
   true` including legacy records that lack `repoRoot`.
   `completedAfter` is an ISO timestamp filter for "newly-terminal
   since X." `limit` caps result count (default reasonable, e.g., 50).

   Returns runs sorted **newest-first by `completedAt`** (then
   `startedAt` for non-terminal). Per-run shape: `{ run_id,
   agent_id, status, startedAt, completedAt, worktreePath,
   summary }` where `summary` is `prompts.at(-1)?.summary` with
   fallback to `lastError` when the latest prompt has no summary
   (e.g., sweeper-marked errors that didn't go through
   `markTerminal()`).
4. **`crew-wait` is the universal wait primitive.** Single binary,
   three invocation patterns:
   - **Backgrounded on Claude Code (default)** → chat-available +
     synthetic-turn surface.
   - **Foregrounded on any host (opt-in, gated on empirical test)** →
     blocks chat, single-inference wait, requires Phase 3
     foreground-test pass.
   - **Unused on Codex/Gemini default** — captain ends turn and
     `list_runs` at next turn.

   Polls `state.json` for status ∈ `{success, partial, error,
   cancelled}` with 1s sleep. On exit, echoes `CREW_WAIT_TERMINAL
   run_id=<id> agent=<agent> status=<status> worktree=<path>` to
   stdout. Single watcher per run; no batching.
5. **No `crew-wait` background watcher on Codex / Gemini default.**
   Their hosts can't synthesize turns from background completions.
   Default baseline: check known pending run IDs via
   `get_run_status` at next turn; `list_runs` as recovery after
   `/clear` or context loss.
6. **Baseline (all hosts): check pending runs at next user turn.**
   On every captain turn, before answering: (a) check known
   pending run IDs from conversation context via `get_run_status`,
   and (b) call `list_runs` as recovery after `/clear` or when
   user references a run the captain doesn't recognize.
7. **Server fires OS notification on terminal (optional, env-var
   configurable).** Disabled with `CREW_OS_NOTIFICATIONS=off`.
   Default: on. Real config subsystem deferred.
8. **Install-time Claude Code setup.** `crew-mcp install --target
   claude-code` adds a narrow `Bash(crew-wait:*)` entry to
   `~/.claude/settings.json` permissions. Implementation in a
   Claude-specific install branch (helper-wrapped, uninstall
   mirrored); `HostAdapter` contract unchanged in v1.
9. **Graceful degradation.** If the watcher fails to spawn
   (permission denied, binary missing, host unsupported), the
   captain logs and falls back to the baseline.
10. **`wait_for_terminal_only` is deprecated for default captain
    flow — not deprecated as a capability.** Foreground
    `crew-wait` is cheaper for opt-in blocking waits, but only
    emits terminal metadata; captain still needs `get_run_status`
    for `summary` / `filesChanged` / `events_tail`. Skill body
    advises ending the turn (default flow) or foreground
    `crew-wait` (opt-in); legacy `wait_for_terminal_only` flag
    stays available for backward compatibility.
11. **Running-guards on `discard_run`, `merge_run`, and
    `continue_run`.** Behavior table:

    | current `status` | `continue_run` | `merge_run` | `discard_run` |
    |---|---|---|---|
    | `running` | refuse | refuse | refuse |
    | `success` | allowed (resets to `running`) | allowed | allowed |
    | `partial` / `error` / `cancelled` | allowed (resets to `running`) | allowed | allowed |
    | `merged` | refuse (post-merge terminal) | refuse | refuse |
    | `merge_conflict` | refuse | **allowed (retry after manual conflict resolution)** | **allowed (cleanup after `git merge --abort`)** |
    | `discarded` | refuse (post-discard terminal) | refuse | refuse |

    Caller must `cancel_run` first to abort an in-flight run, then
    `discard_run`. For `merge_conflict`, two recovery paths: (a)
    resolve the conflicts in the host repo and retry `merge_run`,
    or (b) `git merge --abort` and `discard_run` to throw away the
    run.
12. **Stale-run sweeper at server startup, scoped to current
    `repoRoot`.** On `crew-mcp serve` boot, walk `~/.crew/runs/`;
    for any state.json with `status: "running"` AND `repoRoot ===
    current projectRoot`, mark as `error` with `lastError:
    "abandoned (server restart)"`. Idempotent. Documented v1
    limitation: same-repo multi-session false positives. Runs in
    other repos are untouched. pid/heartbeat field deferred until
    same-repo multi-session false positives become real.
13. **No multi-run batching primitive in v1.** N close-together
    completions on Claude Code produce N synthetic turns. Captain
    produces tight per-turn responses (one line each); user sees
    them as a sequence. Skill body explicitly tells the captain
    not to attempt coalescing — synthetic turns don't queue
    together.
14. **`crew-wait` reuses `resolveCrewHome()`** from
    `src/utils/crew-home.ts`. Don't reimplement env/fallback
    semantics. Power users with non-default `$CREW_HOME` must
    ensure their shell config exports it so Claude Code's Bash
    subprocess inherits it (documented in install output). New
    `package.json` `bin` entry adds `crew-wait` alongside
    `crew-mcp`. Tsup config (`tsup.config.ts`) gets a second
    entry for `src/cli/wait.ts`. `package-lock.json` regenerated.
15. **`resolveCrewWaitBinary()` install-time helper.** New helper
    in `src/install/crew-binary.ts` (alongside the existing
    `crew-mcp` resolver). Platform-aware algorithm:
    1. **Lookup**: use `which crew-wait` on POSIX, `where
       crew-wait` on Windows. (Or implement manually via
       `process.env.PATH.split(path.delimiter)` + extension
       trial — same logic, no shelling out.) If `where`/`which`
       returns multiple paths, evaluate candidates in order and
       return the first that passes the executable-check (step 2).
    2. **Executable-check**: `fs.accessSync(path,
       fs.constants.X_OK)` on POSIX, `fs.constants.F_OK` on
       Windows (the X bit is meaningless on Windows). Failure =
       fall through.
    3. **Sibling derivation** (if direct lookup failed): locate
       `crew-mcp` the same way (POSIX `which` / Windows `where`).
       If found, generate candidate names in this order, applying
       the executable-check to each, returning the first that
       passes:
       - **POSIX**: just `path.join(dirname(crewMcpPath),
         'crew-wait')` (no extension).
       - **Windows**: if `crew-mcp` resolved with extension
         (e.g., `crew-mcp.bat`), try same-extension first
         (`crew-wait.bat`), then `.cmd`, `.ps1`, `.exe`, then
         bare (`crew-wait`). If `crew-mcp` resolved with no
         extension, try `.cmd`, `.ps1`, `.exe`, `.bat`, then
         bare in that order. (npm-installed bin shims on
         Windows are typically `.cmd`; pnpm uses `.cmd` +
         `.ps1`; yarn varies; `.bat` is the legacy form.)
    4. If still not found, throw with instruction to install
       `crew-mcp` globally (`npm install -g crew-mcp` or
       package-manager equivalent).

    Install uses this helper to compute the absolute path for the
    Claude allowlist fallback (see Phase 3).
16. **Marker-file fallback uses `list_runs`, no new file format.**
    If Phase 3 stdout-in-synthetic-turn test fails, the
    fallback delivery is: synthetic turn arrives empty; captain
    calls `list_runs({ status: ["success", "partial", "error",
    "cancelled"], completedAfter: <timestamp of last surface> })`
    (repoRoot filter is implicit per Decision 3); surfaces all
    newly-terminal runs newest-first; dedupes via conversation
    history of previously-surfaced run_ids. On `/clear`,
    re-surfacing of recently-terminal runs is accepted as the
    recovery cost. `list_runs` returns the same fields the
    stdout payload would have carried — no separate marker file
    needed.

## Implementation phases

### Phase 1 — Server-side primitives (required, ships standalone)

Establishes the contract every other phase depends on.

- **`list_runs` MCP tool** (`src/orchestrator/tools/list-runs.ts`).
  Walks `~/.crew/runs/`, reads each `state.json`. Full input
  contract (mirrors Decision 3):
  - `status?: RunStatus | RunStatus[]` — single value or array
    (e.g., `["success", "partial", "error", "cancelled"]` for
    "any terminal").
  - `include_unknown_repo?: boolean` — when true, includes
    records missing `repoRoot` (legacy / pre-M3.5). Default
    false.
  - `completedAfter?: string` — ISO timestamp; only return runs
    with `completedAt > completedAfter`.
  - `limit?: number` — cap result count (default 50).

  `repoRoot` filtering is **implicit** (always the current MCP
  server's repo) — not an input argument.

  Returns runs sorted **newest-first by `completedAt`** (then
  `startedAt` for non-terminal runs lacking `completedAt`); ties
  broken by `run_id` descending for deterministic test output.
  Per-run shape: `{ run_id, agent_id, status, startedAt,
  completedAt, worktreePath, summary }` where `summary` is
  `prompts.at(-1)?.summary` with **fallback to `lastError`** when
  the latest prompt has no summary (e.g., sweeper-marked errors
  that didn't go through `markTerminal()`).
- **`list_runs` registration:**
  - Add to MCP tool registration in `src/cli/commands/serve.ts:241`.
  - Add to install-catalog parity in `src/install/tool-catalog.ts:26`.
  - Add to barrel export in `src/orchestrator/tools/index.ts`
    (matches existing pattern for other tools).
  - Tests in `test/orchestrator/tools/list-runs.test.ts`.
- **`state.json` contract documentation.** New
  `docs/architecture/run-state-contract.md`. Documents:
  - Atomic-write semantics (tmp + rename via `writeAtomic`).
  - The `status` field's terminal values: `{success, partial,
    error, cancelled}` are the four `markTerminal` statuses;
    `{merged, merge_conflict, discarded}` are post-terminal user
    actions. `crew-wait` distinguishes.
  - Schema-stability guarantee: `status` as top-level string field
    is load-bearing and never moves.
- **`discard_run` running-guard.** Refuse on `status: "running"`;
  return error directing to `cancel_run` first. Update
  `src/orchestrator/tools/discard-run.ts` (or relevant handler).
- **`merge_run` running-guard.** Refuse on `status: "running"` (in
  addition to existing `read_only|discarded|merged` guards).
  Update `src/cli/commands/serve.ts:399`.
- **`continue_run` running-guard.** Refuse on `status: "running"`
  (the most-recent prompt is in-flight). Behavior matches
  `appendPrompt()` semantics — terminal runs reset to `running`,
  so blocking only current `status === "running"` protects
  in-flight prompts without breaking continue-after-terminal.
  Update `src/cli/commands/serve.ts:311`.
- **Stale-run sweeper, scoped to repoRoot.** On `crew-mcp serve`
  startup, walk `~/.crew/runs/`; for any state.json with
  `status: "running"` AND `repoRoot === current projectRoot`,
  mark as `error` with `lastError: "abandoned (server restart)"`.
  Idempotent. Records missing `repoRoot` (legacy) are untouched.
  Documented limitation: same-repo multi-session false positives.
- **`merge-run.ts:26` prose update.** Existing prose suggests
  "resolve, retry, or iterate via `continue_run`" on
  `merge_conflict`. v1's Decision 11 refuses `continue_run` on
  `merge_conflict` runs, so the prose must be updated to reflect
  the actual recovery paths (per Decision 11 table): (a)
  "resolve conflicts in the host repo, then retry `merge_run`,"
  or (b) "`git merge --abort` and `discard_run` to throw away
  the run." `continue_run` is no longer a recovery option for
  `merge_conflict` in v1.

Phases 2–5 all depend on these landing.

### Phase 2 — Skill body + tool description sources + dispatch envelope (portable)

The captain reads dispatch-flow guidance from multiple surfaces.
All of them need updates.

**`skills/crew-captain.body.md`:**

- **Remove**: "Polling lifecycle — every dispatch" section.
- **Remove**: "Hard rule: stay in the same turn" subsection.
- **Replace** "The default flow — code → review → iterate → merge"
  step 2 (currently says "when `run_agent` returns, look at
  `files_changed` and `summary`"; the live envelope returns
  `running` with empty `files_changed`).
- **Replace** "Worked shape" code block with the new
  dispatch-and-yield pattern.
- **Replace** "Cancellation" subsection. New behavior: `cancel_run`
  works at any time; the watcher detects `cancelled` like any
  other terminal.
- **Replace** "How users follow progress" second bullet
  (`notifications/progress` rendered inline). With no in-flight
  tool call, those don't exist; `tail.command` is the only
  progress UX.
- **Replace** "Step 1 dispatch confirmation" line. New shape:
  confirm dispatch + tail link + "ended turn — chat freely."
- **Add** "Background watcher overlay (Claude Code only)"
  subsection. Brief: spawn `crew-wait <run_id>` via `Bash
  run_in_background:true` immediately after `run_agent` returns.
- **Add** "Foreground `crew-wait` opt-in (any host, gated on
  Phase 3 empirical test)" subsection. When user explicitly wants
  to wait in-turn (e.g., "wait for this", "I'll wait"), or on
  Codex/Gemini when in-turn waiting is preferable, call
  `crew-wait <run_id>` as a foreground shell command. Same
  binary; blocks chat but uses one inference vs N from the
  legacy long-poll. Captain still calls `get_run_status` after
  the foreground wait returns to get the rich payload (summary,
  files_changed, events_tail).
- **Add** "Checking pending runs at turn start" subsection. On
  every captain turn, before answering: (a) check known pending
  run IDs from conversation context via `get_run_status`, and (b)
  call `list_runs` as recovery after `/clear` or when the user
  references a run not in context.
- **Add** "Multiple terminations don't batch" guidance: each
  synthetic turn from a watcher exit gets one terse response.
  Don't try to coalesce — synthetic turns don't queue together.

**`src/orchestrator/tools/get-run-status.ts:91`** — source-of-truth
for `GET_RUN_STATUS_DESCRIPTION`:

- Currently says "Always poll after `run_agent` / `continue_run`"
  and "Always pass `wait_for_change_ms: 30000`."
- New text: describe `get_run_status` as the on-demand status
  read; the captain doesn't poll by default (the new dispatch
  flow ends the turn). `wait_for_terminal_only` and
  `wait_for_change_ms` are advanced/legacy options for opt-in
  in-turn waiting.

**`src/install/tool-catalog.ts`:**

- Add `list_runs` description (catalog parity).
- Verify `GET_RUN_STATUS_DESCRIPTION` is imported from
  `get-run-status.ts` (not redefined here); no duplicate update
  needed if the import is correct.

**`src/cli/commands/serve.ts`** dispatch markdown:

- Lines `:756` and `:813` (formerly `:811`) currently include
  polling instructions in the dispatch envelope text. Replace
  with new dispatch-and-yield language: "Dispatched as
  `<run_id>`. End your turn after spawning the watcher (Claude
  Code) or after this dispatch returns (Codex/Gemini); user is
  free to chat."

### Phase 3 — Claude Code overlay: `crew-wait` binary + install + empirical gates

**`crew-wait` binary:**

- New `src/cli/wait.ts`. Reuses `resolveCrewHome()` from
  `src/utils/crew-home.ts` for crew-home resolution. Polls
  `<crewHome>/runs/<run_id>/state.json` every 1s for `status` ∈
  `{success, partial, error, cancelled}`. Tolerates missing file
  (race between worktree allocation and `create()`). On terminal,
  echoes `CREW_WAIT_TERMINAL run_id=<id> agent=<agent>
  status=<status> worktree=<path>` to stdout. Exits 0.
- Add second entry to `tsup.config.ts`:4 for `src/cli/wait.ts`.
- Add `bin` entry in `package.json`: `"crew-wait":
  "./dist/wait.js"` (or whatever tsup outputs).
- Regenerate `package-lock.json`.

**Install integration** (Claude-specific branch in
`installSingleTarget()`):

- **PATH discoverability check.** Before adding the allowlist
  entry, verify `crew-wait` resolves in the user's shell PATH.
  If not, fall back to the absolute path computed by
  `resolveCrewWaitBinary()` per Decision 15 (platform-aware
  lookup + executable-check + sibling derivation; full algorithm
  there).
- Add `Bash(crew-wait:*)` to `~/.claude/settings.json`
  `permissions.allow` array if PATH check passes; otherwise add
  `Bash(<absolute-path>:*)` using the resolver output. Idempotent.
- Document `$CREW_HOME` env propagation requirement in install
  output for power users.

**Uninstall.** Mirror: remove the allowlist entry. Binary stays
(part of the npm package).

**`HostAdapter` contract unchanged.** Helper-wrapped
Claude-specific branch. Adapter contract change deferred to v2.

**Empirical pre-merge tests (HARD ship gates for Phase 3):**

1. **Allowlist matcher test.** Test BOTH:
   - `Bash(crew-wait:*)` (PATH form) accepts and runs without prompt.
   - `Bash(<absolute-path>:*)` (absolute form, e.g.,
     `Bash(/usr/local/bin/crew-wait:*)`) accepts and runs without
     prompt.
   At least one must pass to ship Phase 3. If only the absolute
   form works, install always uses absolute paths. If neither,
   block ship and explore alternative shapes (`Bash(crew-wait *)`
   space-form, etc.).
2. **Stdout-in-synthetic-turn test (HARD GATE).** Background
   `Bash run_in_background:true` invocation of `crew-wait`
   produces a synthetic turn whose model-visible payload
   includes the `CREW_WAIT_TERMINAL ...` stdout line.
   **Fallback (Decision 16) if stdout isn't surfaced:** synthetic
   turn arrives empty; captain's surfacing path becomes "call
   `list_runs` filtered to terminal statuses + current
   `repoRoot`; surface all newly-terminal runs; dedupe via
   conversation history of previously-surfaced run_ids." No new
   file format needed — `list_runs` IS the marker contract. The
   Claude overlay ships either way; only the captain skill body's
   "synthetic turn handling" subsection differs.
3. **Foreground `crew-wait` on Codex.** Foreground shell command
   runs for **≥5 minutes (well above Codex's 60s MCP
   `tool_timeout_sec` and the 5-minute `background_terminal_max_timeout`
   ceiling, to verify foreground waits aren't silently
   short-circuited)** to completion without timeout; ESC
   cancels the wait cleanly; captain's subsequent
   `get_run_status` call returns the rich terminal payload. If
   any of these fails, the "any host opt-in" promise is removed
   from the plan and foreground `crew-wait` ships Claude-only.
4. **Foreground `crew-wait` on Gemini.** Same as #3 for Gemini
   CLI; same Claude-only fallback if it fails.

### Phase 4 — OS notification on terminal (optional, ships separately)

`src/orchestrator/notifications.ts` (new), invoked from the same
code paths as `markTerminal()`.

- Cross-platform fan-out: `osascript` (Darwin), `notify-send`
  (Linux), `BurntToast` PowerShell (Windows). Best-effort;
  failures are logged and ignored.
- **Config: env var only for v1.** `CREW_OS_NOTIFICATIONS=off`
  disables. Default: on.
- Notification text: short, one line, includes run_id and status.

### Phase 5 — Hooks layer (deferred)

Per-host hook installation that injects pending/terminal run state
as additional context at every captain turn. Removes the captain's
burden of remembering to call `list_runs` / check pending runs.

Defer until Phases 1–4 ship. Phase 1's `list_runs` tool gives
captains a workable baseline; hooks are the polish.

## Test matrix

| host | dispatch (default) | wait | terminal surface | OS notification |
|---|---|---|---|---|
| Claude Code | run_agent + spawn `crew-wait` (background) | watcher polls state.json | synthetic turn from watcher exit (stdout payload) OR `list_runs` fallback if Phase 3 test #2 stdout fails | optional |
| Codex CLI | run_agent | none (chat-available) | check known pending run IDs at next turn; `list_runs` as recovery | optional |
| Gemini CLI | run_agent | none (chat-available) | check known pending run IDs at next turn; `list_runs` as recovery | optional |
| Any host (opt-in, gated on Phase 3 tests #3 + #4) | run_agent + foreground `crew-wait` | shell call blocks until terminal | inline at terminal | optional |
| Claude Code only (fallback if Phase 3 tests #3 or #4 fail) | run_agent + foreground `crew-wait` | shell call blocks until terminal | inline at terminal | optional |

Acceptance criteria:

- Captain returns turn within ~1s of dispatch (default flow).
- User can send arbitrary chat messages between dispatch and
  terminal in default flow; captain answers normally.
- Terminal eventually surfaces (auto on Claude Code; via
  per-turn `get_run_status` / `list_runs` elsewhere).
- OS notification fires (when enabled).
- `cancel_run` works mid-flight regardless of host.
- After `/clear` mid-flight on Claude Code, the watcher's
  synthetic turn payload (`CREW_WAIT_TERMINAL ...` stdout) is
  self-describing enough that the captain can ask the user about
  merge/iterate/discard with no prior context. (Or, if stdout
  surfacing fails Phase 3 test, marker-file fallback delivers
  equivalent context.)
- After `/clear` mid-flight on Codex/Gemini, the next user turn
  triggers `list_runs`, surfacing the in-flight run.
- After server restart with in-flight runs in the current repo:
  stale-run sweeper marks them as `error` on next boot; captain's
  next `list_runs` call surfaces them as terminal-with-error.
  Runs in other repos remain untouched.
- Multi-run termination on Claude Code: 3 close-together
  completions produce 3 separate synthetic turns. Captain
  produces 3 tight per-turn responses. No coalescing attempted.
- `merge_run` / `discard_run` / `continue_run` all refuse running
  runs and direct caller to `cancel_run` first.
- All three refuse `merged` and `discarded` post-terminal runs.
- `merge_conflict` per Decision 11: `merge_run` allowed (retry
  after manual conflict resolution); `discard_run` allowed
  (cleanup after `git merge --abort`); `continue_run` refused.

## Risks / open questions

- **Watcher orphaning on `/clear` (Claude Code).** Mitigated by
  `crew-wait`'s self-describing exit payload (or marker-file
  fallback). Residual: user has no idea a watcher is still
  running until its synthetic turn lands. Acceptable.
- **Phase 3 empirical tests are real ship blockers.** The plan
  cannot ship the Claude overlay without test 2 (stdout
  surfacing OR marker-file fallback) passing. The plan cannot
  promise "any host opt-in" without tests 3 and 4 passing.
  Sequencing matters.
- **Stale-run sweeper false positives in same-repo multi-session.**
  Two `crew-mcp serve` instances running against the same repo
  (e.g., dev + production) would have one mark the other's runs
  as abandoned. Documented limitation; pid/heartbeat field
  deferred to a future plan.
- **Running-guards may break existing call sites.** Any internal
  caller that relied on `discard_run` / `merge_run` /
  `continue_run` accepting a running run needs updating.
  Migration: `cancel_run → discard_run` is the documented pattern.
- **PATH dependence reintroduced for `crew-wait`.** Existing
  `crew-mcp` install captures absolute paths to avoid PATH
  fragility. `crew-wait` (and the `Bash(crew-wait:*)` allowlist
  entry) reintroduces it. Mitigated by install-time PATH check
  + absolute-path fallback in the allowlist entry, but worth
  empirical verification on common shell setups.
- **Multi-watcher synthetic-turn flood (Claude Code).** Plan
  accepts. Captain's per-turn response is short; user sees
  them as a sequence. If painful, revisit (Phase 5 hooks could
  centralize surfacing).
- **Lost inline progress UX.** Users who relied on inline
  `notifications/progress` chunks during long-polls will lose
  them (default flow has no in-flight tool call). Foreground
  `crew-wait` also doesn't produce progress notifications — it's
  a shell command, not an MCP tool. Worth a callout in release
  notes.
- **`$CREW_HOME` env propagation gotcha.** Power users with
  non-default `$CREW_HOME` must ensure their shell config
  exports it so Claude Code's Bash subprocess inherits it.
  Documented in install output.
- **`continue_run` semantics with `merge_conflict`.** Decision 11
  refuses `continue_run` on `merge_conflict` (`merge_run` and
  `discard_run` are allowed for recovery — see the table). If
  users want the agent to attempt a fresh pass after they
  manually resolve conflicts, they `discard_run` and re-dispatch
  via `run_agent`. Acceptable; revisit if the use case proves
  common.
- **State.json schema stability.** Promoted to public contract
  (Phase 1 docs). Any future schema bump must keep the `status`
  string field at the top level.

## Out of scope (for this plan)

- TaskCreate-based watcher. We picked `crew-wait` for cost.
- Server-initiated MCP push to Codex / Gemini. Their MCP clients
  don't deliver server-initiated messages to the model.
- Batched watcher / multi-run coalescing. Single watcher per run;
  N completions = N synthetic turns. Skill body explicitly tells
  the captain not to attempt coalescing.
- Removing `wait_for_terminal_only` from `get_run_status`.
  Stays available, deprecated for default flow only.
- Changing `MAX_LONG_POLL_MS`. Section 1 of the parked plan still
  applies; not relevant here since the captain isn't long-polling
  by default.
- **`HostAdapter` contract change** for adapter-supplemental-asset
  hooks. Phase 3 uses a Claude-specific install branch.
- **Real per-user config subsystem.** Phase 4 uses an env var.
- **Pid/heartbeat field on state.json.** v1 sweeper accepts
  same-repo multi-session false positives.
- **`continue_run` on `merge_conflict`.** Refuse for v1.
  (Decision 11 still allows `merge_run` retry and `discard_run`
  cleanup on conflict — those are the recovery paths.)

## Related plans

- `docs/plans/parked/long-poll-cost-tuning.md` — the design we're
  superseding (specifically section 5's rejection of
  background-CLI dispatch).
- `docs/plans/active/m4-eval-and-field-report.md` — field-data
  source that would inform whether Phase 5 (hooks) becomes
  load-bearing.

## Decision log

- 2026-05-09: Product-vision update from user — chat-availability
  outranks inline progress UX. Reverses parked-plan section 5
  weighting.
- 2026-05-09: Cross-host research confirms Claude Code is uniquely
  capable of synthetic-turn-from-background-completion. Codex and
  Gemini get baseline (`list_runs` / `get_run_status` at next turn)
  only.
- 2026-05-09: State.json confirmed as suitable contract (atomic
  writes, single status field).
- 2026-05-09: Bash watcher chosen over TaskCreate for cost (no LLM
  tokens, one OS process).
- 2026-05-09: Single-watcher-per-run chosen over batched watcher.
- 2026-05-09: Synthetic-turn queueing behavior verified empirically
  (queue-not-interleave behind user messages); not batched.
- 2026-05-09 (rev 2): `list_runs` MCP tool promoted from Phase 5
  to Phase 1.
- 2026-05-09 (rev 2): Watcher changed from inline bash script to
  named `crew-wait` binary on PATH.
- 2026-05-09 (rev 2): `discard_run` will refuse running runs.
- 2026-05-09 (rev 2): Stale-run sweeper added at Phase 1.
- 2026-05-09 (rev 2): `HostAdapter` contract change deferred to v2.
- 2026-05-09 (rev 2): Phase 4 uses env var instead of fictional
  config file.
- 2026-05-09 (rev 2): `crew-wait` echoes self-describing metadata
  on terminal.
- 2026-05-09 (rev 2): Skill-body rewrite scope expanded from 2 to
  8 sections.
- 2026-05-09 (dogfood): Tested the bash-watcher pattern in this
  conversation — Claude Code captain ran `crew-wait`-shaped
  watcher (inline shell loop) against a Codex agent run
  (`9b8d0308`); watcher detected terminal, harness fired
  synthetic turn, captain surfaced findings inline while user
  remained free to chat. Validates the design end-to-end.
- 2026-05-09 (rev 3): `list_runs` registration in `serve.ts` +
  `tool-catalog.ts` made explicit; added `include_unknown_repo`
  arg.
- 2026-05-09 (rev 3): Running-guards expanded from `discard_run`
  alone to also cover `merge_run` and `continue_run`.
- 2026-05-09 (rev 3): Stale-run sweeper committed to v1
  "mark-all-running" heuristic. *Reversed in rev 4 — see below.*
- 2026-05-09 (rev 3): Skill rewrite scope expanded to also update
  `tool-catalog.ts:15` and `serve.ts:756/:811`. *Source-of-truth
  corrected in rev 4 — see below.*
- 2026-05-09 (rev 3): `crew-wait` reads `$CREW_HOME` from env,
  falls back to `~/.crew/`. *Rev 4 mandates `resolveCrewHome()`
  reuse — see below.*
- 2026-05-09 (rev 3): Multi-run batching abandoned; N completions
  = N synthetic turns.
- 2026-05-09 (rev 3): Phase 3 adds two empirical pre-merge tests.
  *Rev 4 strengthens stdout test to hard ship gate and adds two
  more empirical tests for foreground use — see below.*
- 2026-05-09 (rev 3): `crew-wait` made the universal wait
  primitive. *Rev 4 gates "any host opt-in" on empirical tests
  — see below.*
- 2026-05-09 (rev 3): `wait_for_terminal_only` long-poll mode
  marked deprecated. *Rev 4 narrows the deprecation scope to
  default captain flow only — see below.*
- 2026-05-09 (rev 4): Stale-run sweeper scoped to runs where
  `repoRoot === current projectRoot`. Records missing `repoRoot`
  (legacy) untouched. Same-repo multi-session false positives
  documented; pid/heartbeat deferred.
- 2026-05-09 (rev 4): `get_run_status` description source-of-truth
  corrected — Phase 2 now updates `get-run-status.ts:91` (where
  `GET_RUN_STATUS_DESCRIPTION` is defined) rather than
  `tool-catalog.ts` (which imports it).
- 2026-05-09 (rev 4): `crew-wait` binary wiring expanded — second
  tsup entry, `package-lock.json` regeneration, install-time PATH
  discoverability check with absolute-path fallback for the
  allowlist entry.
- 2026-05-09 (rev 4): "Any host opt-in" foreground `crew-wait`
  promise gated on Phase 3 empirical tests for Codex and Gemini
  (multi-minute foreground command, timeout, ESC/cancel
  semantics). If tests fail, foreground use stays Claude-only.
- 2026-05-09 (rev 4): Turn-start guidance widened — captain
  checks known pending run IDs first via `get_run_status`;
  `list_runs` is recovery for `/clear` or unknown context, not
  the primary path.
- 2026-05-09 (rev 4): `wait_for_terminal_only` deprecation
  narrowed — deprecated for default captain flow, not deprecated
  as a capability. Captain still needs `get_run_status` (with or
  without wait flag) for rich terminal payload after foreground
  `crew-wait`.
- 2026-05-09 (rev 4): `list_runs` `summary` field clarified as
  latest-prompt summary (`prompts.at(-1)?.summary`) since
  `RunStateV1` has no top-level summary. Barrel export from
  `src/orchestrator/tools/index.ts` added.
- 2026-05-09 (rev 4): `continue_run` / `merge_run` / `discard_run`
  status-acceptance table added to Decision 11 for clarity.
- 2026-05-09 (rev 4): `crew-wait` mandated to reuse
  `resolveCrewHome()` from `src/utils/crew-home.ts`; no parallel
  env/fallback semantics.
- 2026-05-09 (rev 4): Phase 3 stdout-in-synthetic-turn test
  promoted to hard ship gate. *Rev 5 simplified the fallback
  contract — see below.*
- 2026-05-09 (rev 5): `resolveCrewWaitBinary()` install-time
  helper specified concretely (initial POSIX-only sketch —
  *superseded by rev 6/8 Decision 15*, which adds platform-aware
  lookup, executable-check, and Windows extension ordering).
  Phase 3 test #1 expanded
  to cover both `Bash(crew-wait:*)` and absolute-path forms.
- 2026-05-09 (rev 5): Marker-file fallback simplified —
  `list_runs` IS the marker contract. If stdout-in-synthetic-turn
  test fails, captain calls `list_runs` filtered to terminal
  statuses + current `repoRoot` and surfaces newly-terminal
  runs. No new file format needed.
- 2026-05-09 (rev 5): Phase 1 also updates `merge-run.ts:26`
  prose to remove the "iterate via `continue_run`" suggestion
  on `merge_conflict`. *Recovery wording superseded by rev 6 —
  `merge_run` retry and `discard_run` cleanup are now allowed
  on `merge_conflict`; only `continue_run` is refused.*
- 2026-05-09 (rev 5): `list_runs` `summary` field falls back to
  `lastError` when the latest prompt has no summary
  (sweeper-marked errors).
- 2026-05-09 (rev 5): Phase 3 tests #3 and #4 wording tightened
  to "≥3 minutes (exceeding Codex's 60s MCP `tool_timeout_sec`)."
- 2026-05-09 (rev 5): Test matrix shows explicit
  Claude-only-fallback row for foreground `crew-wait` if Phase 3
  tests #3 or #4 fail.
- 2026-05-09 (rev 6): `merge_conflict` recovery paths defined —
  Decision 11 table now allows `merge_run` (retry after manual
  resolution) and `discard_run` (cleanup after `git merge --abort`)
  on `merge_conflict`; `continue_run` still refuses. Resolves
  the strand-the-user contradiction.
- 2026-05-09 (rev 6): `list_runs` input shape extended to
  accept `status: RunStatus | RunStatus[]`, plus
  `completedAfter?: string` and `limit?: number`. Default sort
  newest-first by `completedAt`. `repoRoot` filtering remains
  implicit (always current MCP server's repo). Decision 16's
  fallback rewritten to use the new shape concretely.
- 2026-05-09 (rev 6): `resolveCrewWaitBinary()` algorithm
  expanded — platform-aware lookup (`which` POSIX / `where`
  Windows), Windows extension handling (`.cmd` / `.ps1` /
  `.exe`), and `fs.access` executable-check on each candidate
  before returning.
- 2026-05-09 (rev 6): Phase 3 tests #3/#4 duration bumped from
  ≥3 to ≥5 minutes for foreground wait stability.
- 2026-05-09 (rev 7): Stale `merge_conflict` wording cleanup —
  acceptance criteria, risks, and out-of-scope sections updated
  to reflect Decision 11's allowance of `merge_run` retry and
  `discard_run` cleanup on `merge_conflict`. Rev-5 audit-log
  entry annotated as superseded by rev 6.
- 2026-05-09 (rev 7): Phase 1 `list_runs` bullet expanded to
  mirror the full Decision 3 input contract (`completedAfter`,
  `limit`, newest-first sort, `lastError` summary fallback).
- 2026-05-09 (rev 7): `resolveCrewWaitBinary()` Windows sibling
  candidate ordering made explicit — same-extension first, then
  `.ps1`, `.exe`, bare. `where`/`which` multi-path return
  evaluated in order with first-passing-executable-check.
- 2026-05-09 (rev 8): Final stale-text cleanup — rev-5 refinement
  bullet at the `merge-run.ts:26` entry rewritten to reflect rev
  6's actual recovery contract; Phase 3 install-integration
  bullet's resolver summary replaced with "use
  `resolveCrewWaitBinary()` per Decision 15" (was POSIX-only
  abbreviation).
- 2026-05-09 (rev 8): Minor robustness — `list_runs` sort adds
  `run_id` descending tie-breaker for deterministic test output;
  Windows sibling candidate ordering extended to include `.bat`
  (legacy form) alongside `.cmd`/`.ps1`/`.exe`.
- 2026-05-09 (rev 9): Historical audit-log cleanup — the rev-5
  finding-24 summary and the rev-5 decision-log entry that
  restated the original POSIX-only `resolveCrewWaitBinary()`
  sketch are now annotated as superseded by rev 6/8 Decision
  15. Active implementation sections were already correct;
  this round only touches the audit trail to prevent future
  readers from grepping the historical sketch and treating it
  as live truth.
