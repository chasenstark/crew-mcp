# `run_panel` tool — design plan (standalone)

**Status:** Draft v6 2026-05-12 (post round-5 review). Builds on the
just-merged [`peer-messages-parameter.md`](./peer-messages-parameter.md)
(commits `bd14ebb1`, `f694cbf6`, `cca6cf28`, `e81688e1`).

### Round-5 review log (2026-05-12)

**Reviewer:** Codex `xhigh` CHANGES NEEDED. v4 fixes mostly held;
R4-1 and R4-7 needed a second pass + 3 remaining gaps. Surgical
convergence pass.

**v6 changes:**

- **[R5-1] §Q1 preflight ordering corrected** to match the
  numbered preflight list in §Tool surface. v5 fixed the
  numbered list but left §Q1 with the old (worktree-probe-first)
  ordering. Now consistent.
- **[R5-2] Dispatch-loop sketch drops the lingering `clientKind`
  arg.** v5 removed `clientKind` from
  `DispatchRunAgentInternalArgs` but the sketch's call site
  still passed it. Removed.
- **[R5-3] Sketch types match actual code.** v5 used
  `AgentPrefsFile` and `RunDispatcher`; actual symbols are
  `AgentPrefsMap` and `ToolDispatcher`. v6 corrected.
- **[R5-4] `ProgressNotifier` export note.** v5 introduced a
  `progress?: ProgressNotifier` arg without saying where the
  type comes from; it's currently local to `serve.ts`. v6
  instruction: export it from `src/cli/commands/serve.ts` (or
  move the type into a small shared module) so the new helper
  module can import it.
- **[R5-5] Parse-error wire code added.** v5 tests
  `readPanelState` throwing on parse error but §Error code wire
  contract didn't define a code for it. v6 adds
  `run_panel.unparsable:` to the wire contract; thrown by
  `readPanelState` AND by the three tools when they encounter
  a corrupted panel.json.

---

### Round-4 review log (2026-05-12)

**Reviewer:** Codex `xhigh` CHANGES NEEDED. Two critical
(cross-repo check order + test gaps), two design clarifications,
four nits.

**v5 changes:**

- **[R4-1] Cross-repo guard runs BEFORE filesystem probes.** v4
  put `existsSync(implementer.worktreePath)` before the repo
  checks. `runStateStore.read()` doesn't filter by repo, so a
  foreign run ID with a missing worktree would have surfaced
  `implementer_worktree_unavailable` instead of the correct
  `implementer_cross_repo:` AND would have done a filesystem
  probe on a foreign path. v5 reorders preflight: status →
  `implementer_legacy_no_repo` → `implementer_cross_repo` →
  `implementer_worktree_unavailable`.
- **[R4-2] Test coverage extended for R3-4 + R3-6.** R3-4
  testing only covered `buildImplementerPeerMessage` files-cap.
  v5 adds matching tests for `aggregate_panel`'s
  terminal-reviewer branch (>1000 files, >4096-char paths).
  R3-6 testing only covered the listener self-dispose; v5 adds
  an explicit test for the `dispatcher.start` sync-throw path
  (mock-throw the dispatcher; assert state marked terminal-error
  AND non-read-only worktree cleaned up).
- **[R4-3] Per-reviewer peer_messages preflight: per-reviewer
  failure.** v4 said "before any dispatch" but also "per-reviewer
  failure" — contradiction. v5: the preflight check
  (`validatePeerMessagesPreflight` per reviewer) is moved INSIDE
  the dispatch loop, BEFORE the existsSync check. Failure becomes
  a per-reviewer `failed_reviewer` (consistent with all other
  per-reviewer failures). This keeps the panel resilient — one
  reviewer's malformed peer_messages doesn't abort the whole
  panel.
- **[R4-4] `dispatcher.start` sync-throw listener leak: acceptable
  collision-only.** v4 was ambiguous. v5 explicitly states:
  duplicate-toolCallId is the only known sync-throw path; the
  listeners installed in step 4 of the helper would not see a
  terminal event and would never self-dispose. Given collision
  probability with `randomUUID()` is ~0 (2^-122), the leak is
  acceptable as-documented; no explicit dispose handle. Future
  hardening can add one if `dispatcher.start` grows other
  sync-throw paths.
- **[R4-5] Sketch signatures match actual code.** v4 had
  `planRunAgent({...input, ctx})` and `markTerminal({status: ...})`;
  actual signatures are `planRunAgent(input, ctx)` and
  `markTerminal(runId, {...})`. v5 sketches updated.
- **[R4-6] File-truncation debug log added to sketches.** v5 R3
  log claimed the helpers emit a debug log on file-truncation;
  v4 sketches didn't show it. v5 sketches now include:
  `if (state.filesChanged.length > 1000 || ...) logger.debug(...)`.
- **[R4-7] `clientKind` removed from helper args.** Helper
  doesn't render markdown, so `clientKind` is unused. v5 drops
  it from `DispatchRunAgentInternalArgs`. (If a future helper
  caller needs it, add it back.)

---

### Round-3 review log (2026-05-12)

**Reviewer:** Codex `xhigh` BLOCKING. Three critical correctness
findings, four new issues, four nits. R2 fixes mostly held — 2
needed corrections.

**v4 changes:**

- **[R3-1] `too_many_reviewers:` made reachable.** v3's Zod
  `.max(20)` rejected before handler preflight could fire the
  named error. v4 loosens the Zod cap to `.max(100)` (anti-DOS
  ceiling, mirrors peer-messages' loose Zod `.max(10000)` /
  runtime-cap-of-50 pattern). Runtime cap stays 20 via
  `validateRunPanelPreflight`; the named error now fires before
  any dispatch when count > 20.
- **[R3-2] Implementer worktree disappearance: explicit
  `existsSync` check.** v3 R2-6 claimed `planRunAgent` would
  throw ENOENT-style on missing `working_directory` — wrong.
  `planRunAgent` passes the path through unchecked
  (`run-agent.ts:175,195`). v4 adds an explicit
  `existsSync(effectiveWorkingDirectory)` check in the dispatch
  loop BEFORE calling the helper. If missing → record
  `failed_reviewer` with "implementer worktree disappeared
  during dispatch" inline. No silent fall-through to async
  adapter failure.
- **[R3-3] Unbound `read_only` default semantics fixed.** v3's
  captain skill said unbound reviewers default to project root.
  Wrong. `run_agent` allocates a fresh worktree when `read_only`
  is unset/false; only `read_only: true` defaults to the host
  repo root (`run-agent.ts:175,186`). v4 captain skill now
  matches reality: unbound + read_only:true → host repo root;
  unbound + read_only:false-or-unset → fresh worktree.
- **[R3-4] Files-list cap enforced in auto-built peer_messages.**
  `buildImplementerPeerMessage` and `aggregate_panel` previously
  passed `filesChanged` through unbounded. `peerMessageInputSchema`
  caps files at 1000 items × 4096 chars each. v4 helpers slice
  to 1000 and skip items > 4096 chars, emitting a debug log if
  truncation happened. Guarantees the auto-built messages parse
  cleanly through the Zod schema.
- **[R3-5] `dispatchRunAgentInternal` handles `plan.kind === 'error'`.**
  v3 sketch didn't show this. Today's `run_agent` handler checks
  it (`serve.ts:425`). v4 helper throws with `plan.message` on
  error so the panel loop records the reviewer as
  `failed_reviewer` with the planner error inline.
- **[R3-6] Listener teardown shape spelled out.** Listeners
  self-dispose on terminal events (`serve.ts:1152`); helper
  doesn't return a teardown handle. Edge case: `dispatcher.start`
  can throw synchronously on duplicate `toolCallId`
  (`tool-dispatcher.ts:61`). The helper uses `randomUUID()` per
  call so collisions are astronomically rare, but v4 documents
  the cleanup path: if `start` throws synchronously AFTER
  `create()` succeeded, the helper's catch block calls
  `runStateStore.markTerminal({status: 'error', ...})` and
  `worktreeManager.cleanupByRunId` (for non-read-only) before
  re-throwing. Mirrors the rollback semantics that don't exist
  for the success path.
- **[R3-7] Lost-warnings limitation acknowledged.** When
  `dispatcher.start` throws synchronously AFTER create()
  succeeded, the warnings returned by `create()` are lost
  unless caller code captures them. v4 helper attaches them to
  the thrown error via a `DispatchError` class with a `warnings`
  field. Panel loop's catch reads `err.warnings` (if present)
  into `dispatchWarnings`.
- **[R3-8] Sketch uses `ctx.crewHome` / `ctx.runStateStore.repoRoot`.**
  v3 sketch had `this.crewHome` and `this.repoRoot` inside a
  free handler — wrong scope. v4 corrected.
- **[R3-9] `total_count` doc-clarified.** Doc comment now reads
  "dispatched reviewers (NOT requested reviewers — see
  `failed_reviewers.length` for the dispatch failure count)."
- **[R3-10] `state_unavailable` trigger phrasing fixed.** v3
  said "partial write recovery" — odd given tmp+rename
  atomicity. v4: "parse error / corruption / manual deletion."

---

### Round-2 review log (2026-05-12)

**Reviewer:** Codex `xhigh` BLOCKING. Nine critical findings, six new
issues v2 missed. R1 fixes mostly landed but several partial.

**v3 changes:**

- **[R2-1] `read_only: false` on a bound reviewer is now safe by
  construction.** v2 auto-passed `working_directory=A.worktreePath`
  regardless of `read_only`. `planRunAgent` runs IN the supplied
  `working_directory` even when allocating its own worktree — that
  could mutate the implementer's worktree. v3 rule: when a reviewer
  explicitly sets `read_only: false`, the panel does NOT auto-pass
  `working_directory` (reviewer must supply their own OR fall back
  to plain `run_agent` default). The implementer-context
  `peer_message` is still forwarded; only the `working_directory`
  auto-default is suppressed.
- **[R2-2] `DispatchContext` defined + lifecycle listener ownership
  spelled out.** v2's `dispatchRunAgentInternal` signature took
  `ctx: DispatchContext` without specifying its shape. v3 defines
  `DispatchContext` as `{registry, worktreeManager, runStateStore,
  agentPrefs, dispatcher, crewHome, repoRoot, projectRoot}`. AND
  the helper **MUST install dispatcher lifecycle listeners
  BEFORE calling `dispatcher.start(task)`** (otherwise runs never
  mark terminal — see `serve.ts:1015-1023, 1152-1241`). Helper
  owns listener install + cleanup; callers don't.
- **[R2-3] `RunStateStore.repoRoot` made public + legacy missing-
  repoRoot policy defined.** v2's cross-repo guard reached into
  the private field. v3 adds a public `get repoRoot(): string`
  getter (current field at `run-state.ts:244-258` is private
  readonly; implementation must rename the private field — e.g.,
  to `#repoRoot` — to make room for the getter, matching the
  existing `get caps()` pattern). For implementer records with `repoRoot === undefined`
  (legacy v1 state.json), v3 rejects with
  `run_panel.implementer_legacy_no_repo:` rather than silently
  trusting them — mirrors `list_runs`'s `include_unknown_repo`
  opt-in being explicit rather than default.
- **[R2-4] Panel-level repo isolation added.** v2 only protected the
  implementer-bound path. Unbound panels in a shared crew home
  could leak across repos because `get_panel_status` /
  `aggregate_panel` read panel.json directly by `panel_id`. v3:
  `panel.json` ALWAYS stores `panelRepoRoot` (the serve instance's
  repoRoot at dispatch time). `get_panel_status` and
  `aggregate_panel` reject `run_panel.cross_repo:` when
  `panelRepoRoot !== runStateStore.repoRoot`.
- **[R2-5] Warning persistence claim corrected.** v2 wrongly
  implied peer-message dispatch warnings reach `get_run_status`
  via state.warnings. They don't — `markTerminal` only persists
  read-only dirty-tree warnings. v3:
  - Per-reviewer dispatch warnings are returned in the
    `run_panel` immediate response envelope (ephemeral).
  - **AND** v3 writes them to each reviewer's
    `PanelReviewerRecord.dispatchWarnings` field on panel.json
    so they're durably recoverable via `get_panel_status` even
    if the captain misses the original envelope.
  - No claim that `get_run_status` itself recovers them.
- **[R2-6] Implementer discard/merge mid-panel: explicit behavior.**
  v2's §Edge cases said "unaffected" — wrong, the reviewer's
  `working_directory` disappears if `discard_run` removes it. v3
  rule: this is a NATURAL failure mode. `planRunAgent` resolves
  the working_directory and throws ENOENT-flavor errors when the
  path is gone; the throw flows through `dispatchRunAgentInternal`
  and gets recorded as a `failed_reviewer` with the error text.
  Captain sees "implementer worktree disappeared during dispatch"
  inline. No special-case handling needed.
- **[R2-7] `state_unavailable` shape fixed; misleading example
  removed.** v2's response type required `status` even when
  state was unavailable — invalid by construction. v3: the
  reviewer record is a discriminated union — `state_unavailable: true`
  entries don't have `status`/`summary`/`files_changed`. AND v2's
  "discard_run causes state_unavailable" example was wrong
  (`discard_run` keeps state.json and just flips status to
  `discarded`); v3 cites correct triggers: state.json manually
  removed, fs corruption, partial write recovery.
- **[R2-8] Crash-recovery test corrected.** v2's test expected
  reviewer #3 to be unrecorded when `dispatchRunAgentInternal`
  throws — but v2's sketch records failed reviewers in a catch
  block. Contradiction. v3 distinguishes:
  - "Normal dispatch failure" (helper throws): #3 IS recorded
    in `failed_reviewers`.
  - "Process crash" (signal kill mid-dispatch): #3 is NOT
    recorded. Stub panel.json + the records written before the
    kill remain. Test the two cases separately.
- **[R2-9] Explicit `validateRunPanelPreflight` for max-reviewers.**
  v2's wire contract listed `run_panel.too_many_reviewers:` but
  Zod `.max(20)` rejection emits a generic schema error, not the
  namespaced code. v3 adds a small `validateRunPanelPreflight`
  function (mirroring `validatePeerMessagesPreflight`) that
  throws the namespaced error if the count exceeds the runtime
  cap. The Zod cap remains as an anti-DOS ceiling at 20.
- **[R2-10] Tool catalog includes `tools/index.ts` exports.** v2
  said "update `tool-catalog.ts`" but missed that
  `tool-catalog.ts:15-24` imports from `src/orchestrator/tools/
  index.ts`. v3 Phase 1 step list adds the index.ts exports.
- **[R2-11] Panel schema-version read behavior defined.**
  v2 declared `PANEL_SCHEMA_VERSION = 1` but didn't say what
  happens on read for non-1 versions. v3: `readPanelState`
  throws `run_panel.unknown_schema_version:` if
  `panelState.schemaVersion !== 1`.
- **[R2-12] Architecture doc update added.** `docs/architecture/
  tools.md` still describes the current eight-tool catalog and
  the add-tool workflow. v3 Phase 2 explicitly updates it.
- **[R2-13] `from_label` sanitization added.** Auto-built labels
  embed agent IDs (configurable strings) and error messages.
  These can violate `peerMessageInputSchema.from_label.max(80)`
  / no-control-chars / no-backticks / no-newlines / no-`#`.
  v3 adds a `sanitizeFromLabel(raw, suffix?) → string` helper
  used by both `buildImplementerPeerMessage` and
  `aggregate_panel`.
- **[R2-14] Aggregate de-dupe = NO.** v3 explicitly documents
  that `aggregate_panel` emits ALL reviewer messages even when
  identical. Different reviewers reaching the same conclusion
  is meaningful signal.
- **[R2-15] `list_panels` absence noted; growth quantified.**
  v3 §Future work explicitly notes no `list_panels` verb (captain
  retains `panel_id`s). v3 §Risks quantifies growth: ~1 KB per
  panel × ~10 panels/day captain = ~4 MB/year. Acceptable
  unbounded; documented.
- **[R2-16] Helper extraction estimate bumped 0.5d → 0.75d.**
  Reflects lifecycle listener ownership + cleanup-on-rejection
  path + byte-identical run_agent regression risk.
- **[R2-17] Captain skill voice + Bash example fixed.** v2 mixed
  "you" and "Captain"; v3 uses "you" throughout. v2's example
  used `Bash({{CREW_WAIT_COMMAND}} <reviewer.run_id>, ...)` —
  v3 matches the existing skill's quoted form:
  `Bash("{{CREW_WAIT_COMMAND}} R", run_in_background: true)`.
- **[R2-18] Unbound + working_directory contradiction resolved.**
  v2 skill said "unbound: Captain must supply working_directory"
  but the tool surface said unbound = plain run_agent (where
  working_directory is optional and defaults to project root).
  v3: unbound = plain run_agent semantics; captain supplies
  working_directory only if needed.

---

### Round-1 review log (2026-05-12)

Codex `xhigh` CHANGES NEEDED → v1 to v2. Six critical findings
(summary source, cross-repo behavior, crash-fragile panel
persistence, undercounted helper extraction, missing tool-catalog
work, env-var-vs-Zod conflict). All addressed in v2 per R1-1..R1-15
in the v2 review log (see commit history).

---

## At a glance

**What.** Three new MCP tools — `run_panel`, `get_panel_status`,
`aggregate_panel` — that compose existing primitives into a
first-class captain verb for "dispatch N reviewers in parallel,
collect their findings, fold them back into the implementer."

**Why.** The captain can already orchestrate this manually (the
implement-then-review pattern shipped in `skills/crew-captain.body.md`
§Forwarding peer context). The manual version is ~6-8 verbose
steps; `run_panel` collapses them to 3. No new dispatch capability —
purely ergonomic sugar.

**What this plan does NOT ship.** `cancel_panel`, `continue_run_with_panel`
sugar, ACK sentinels / auto-cancel-on-blocker / auto-continue
daemon, `list_panels` discovery verb.

**Cost.** ~2.75 days across 2 phases. v4 is a surgical fix-up of
v3's correctness gaps; estimate unchanged.

### One-direction flow

```
CAPTAIN
  |
  | (implementer A is terminal — success/partial/error/cancelled,
  |  worktree preserved, A.repoRoot === captain serve.repoRoot,
  |  A.repoRoot is non-empty)
  |
  | run_panel({
  |   implementer_run_id: "A",
  |   reviewers: [
  |     { agent_id: "codex", prompt: "review correctness" },
  |     { agent_id: "claude-code", prompt: "review style" },
  |   ],
  | })
  |   * preflight: count cap; implementer state checks
  |   * compose implementer peer_message (sanitized from_label)
  |   * write stub panel.json (panelRepoRoot, panel_id, reviewers: [])
  |   * for each reviewer i:
  |       call dispatchRunAgentInternal(...)
  |       (helper installs lifecycle listeners before dispatcher.start)
  |       atomically update panel.json with reviewer record
  |       (including dispatchWarnings from the helper result)
  |   * return panel envelope
  |
  | (panel dispatch is async; each reviewer follows the existing
  |  dispatch lifecycle. Captain yields after this call.)
  |
  | ... later, when all reviewers are terminal ...
  |
  | aggregate_panel({ panel_id })
  |   → { peer_messages: [...sanitized PeerMessageInputs...] }
  |
  | continue_run({
  |   run_id: "A",
  |   peer_messages: <aggregated>,
  |   prompt: "revise per these findings",
  | })
```

### Key design decisions

- **No new dispatch path.** `run_panel` calls a shared
  `dispatchRunAgentInternal` helper N times under the hood; each
  reviewer is a normal crew run with a normal `run_id`.
  `get_run_status` / `cancel_run` / `discard_run` / `merge_run`
  all work per-reviewer unchanged.
- **Helper owns lifecycle listener install.** `dispatchRunAgentInternal`
  installs dispatcher listeners BEFORE calling `dispatcher.start`,
  matching what `runDispatchAndRespond` does today. Without this,
  the run never marks terminal. Callers (run_agent handler,
  run_panel dispatch loop) don't touch listener wiring.
- **Panel state is logical + repo-isolated.**
  `<crewHome>/panels/<panel_id>/panel.json` stores `panelRepoRoot`
  always. `get_panel_status` / `aggregate_panel` reject when
  `panelRepoRoot !== runStateStore.repoRoot`. Bound panels add an
  additional `implementerRepoRoot` guard at dispatch time.
- **Incremental panel.json writes.** Stub at dispatch start;
  atomic update after each reviewer. Crash-survivable: a
  mid-flight `kill -9` leaves the panel discoverable with
  whichever reviewers completed their record-update before the
  crash.
- **Per-reviewer dispatch warnings durable.** Peer-message cap
  warnings from each reviewer's `runStateStore.create()` are
  written to `PanelReviewerRecord.dispatchWarnings`. Captain
  recovers them via `get_panel_status` even after the initial
  `run_panel` envelope is gone. (Note: this is panel-scope only;
  `get_run_status` on the reviewer itself still doesn't surface
  these — that's an existing limitation, out of scope.)
- **`read_only: false` + bound = working_directory NOT
  auto-passed.** Reviewer is responsible for their own
  `working_directory` (or falls back to plain `run_agent`
  default). The implementer-context `peer_message` is still
  forwarded. Prevents accidental mutation of the implementer's
  worktree.
- **Snapshot semantics + natural failure modes.** Implementer
  state read once at dispatch. If implementer is later discarded
  / merged, reviewers' `working_directory` resolves to a
  now-gone path → `planRunAgent` throws → helper records the
  reviewer as `failed_reviewer` with the path error. No
  special-case logic.
- **Aggregation is a pure read.** No panel.json mutation. Emits
  all reviewer messages even when identical (no dedup).
- **Captain stays chat-available.** `run_panel` returns
  immediately; per-reviewer watcher overlay drives termination
  surfacing.

## Goal

Captain orchestrates a parallel review panel against an implementer's
output with three MCP calls (dispatch → wait → aggregate-and-continue)
instead of N+M manual `run_agent`/`get_run_status` calls. Smallest
unlock: 2 reviewers + 1 aggregate-and-continue pass.

## Non-goals

- `cancel_panel({panel_id, except_run_ids?})` verb.
- `continue_run_with_panel({panel_id, prompt})` sugar verb.
- `list_panels` discovery (captain retains `panel_id`s).
- ACK sentinels.
- Auto-continue daemon.
- Cross-panel scheduling / quotas.
- Worker-side panel awareness.
- Reviewer dependency graphs.
- Persistent recovery of dispatch warnings via
  `get_run_status` (existing architectural limit, not introduced
  here).

## Open design questions

### Q1: What implementer states allow panel dispatch?

Allow: `success`, `partial`, `error`, `cancelled` — all have a
preserved worktree.

Reject:
- `running` → `run_panel.implementer_not_terminal:`.
- `discarded` → `run_panel.implementer_not_terminal:`.
- `merged` → `run_panel.implementer_not_terminal:`.
- `merge_conflict` → `run_panel.implementer_not_terminal:`.

After the status check, in this order (R4-1: repo checks run
BEFORE any filesystem probe so a cross-repo run never touches
foreign FS paths):
- `implementerState.repoRoot === undefined` (legacy v1 record
  without repoRoot field) → `run_panel.implementer_legacy_no_repo:`.
- `implementerState.repoRoot !== runStateStore.repoRoot` →
  `run_panel.implementer_cross_repo:`.
- `existsSync(implementerState.worktreePath)` false →
  `run_panel.implementer_worktree_unavailable:`.

### Q2: What does the auto-built implementer peer_message look like?

```ts
function buildImplementerPeerMessage(state: RunStateV1): PeerMessageInput {
  const lastTurn = state.prompts.at(-1);
  const rawSummary = lastTurn?.summary?.trim();
  // body cannot be empty (peerMessageInputSchema.body.min(1)).
  const body = rawSummary && rawSummary.length > 0
    ? rawSummary
    : `(no summary captured for implementer ${state.runId.slice(0, 8)}; status=${state.status})`;
  // R3-4: cap files-list to satisfy peerMessageInputSchema.files
  // (max 1000 items × 4096 chars each). Drop oversize paths and
  // slice to 1000. Emit a debug log if truncation happened.
  const tooManyFiles = state.filesChanged.length > 1000;
  const oversizePaths = state.filesChanged.filter((f) => f.length > 4096).length;
  const safeFiles = state.filesChanged
    .filter((f) => f.length <= 4096)
    .slice(0, 1000);
  if (tooManyFiles || oversizePaths > 0) {
    logger.debug('peer-message files truncated for schema fit', {
      runId: state.runId, originalCount: state.filesChanged.length,
      keptCount: safeFiles.length, oversizeDropped: oversizePaths,
    });
  }
  return {
    body,
    kind: 'review',
    from_label: sanitizeFromLabel(state.agentId, `run ${state.runId.slice(0, 8)}`),
    ...(safeFiles.length > 0 ? { files: safeFiles } : {}),
  };
}
```

`sanitizeFromLabel` (see §Data model) ensures the label fits within
the peer_messages schema constraints regardless of input.

### Q3: Can a single reviewer override the panel-level defaults?

Yes. Per-reviewer fields layer on top of panel defaults:

- `working_directory`: overrides auto-pointing to implementer.
- `read_only`: overrides the panel default (`true` when bound,
  `false` when unbound). **`read_only: false` on a bound reviewer
  SUPPRESSES the implementer-worktree auto-default** for
  `working_directory` — the reviewer must either supply their own
  `working_directory` or accept plain `run_agent` default (worktree
  allocated at the project root). The implementer-context
  `peer_message` is still forwarded.
- `peer_messages`: per-reviewer items are APPENDED after the
  auto-built implementer message (when bound). Order:
  `[implementer_message, ...reviewer.peer_messages]`. When
  unbound, the reviewer's `peer_messages` is used as-is.
- `model` / `effort`: standard per-call overrides.

### Q4: Behavior when reviewer dispatch fails mid-panel?

Continue dispatching the remaining reviewers. After each reviewer's
dispatch attempt (success or failure), update `panel.json`
atomically to record the outcome. If the server dies mid-dispatch
(SIGKILL, OS reboot, etc.):
- The stub `panel.json` written at dispatch START preserves the
  panel_id and the captured implementer snapshot.
- Any reviewers whose record-write completed before the crash are
  preserved.
- Reviewers in-flight at the crash moment are NOT recorded; their
  underlying runs may exist as orphan run_ids (discoverable via
  `list_runs`). Subsequent `get_panel_status` shows the partial
  state; captain can `discard_run` orphans manually.

Return envelope:

```jsonc
{
  panel_id: "...",
  partial: true,                                       // any reviewer dispatched=false
  reviewers: [
    {
      run_id: "abc",
      agent_id: "codex",
      tail_url: "...",
      worktree_path: "...",
      warnings: [],
    },
    {
      run_id: "def",
      agent_id: "gemini-cli",
      tail_url: "...",
      worktree_path: "...",
      warnings: ["peer_messages.body_truncated: item[0] body was 32768 chars, capped at 16384"],
    },
  ],
  failed_reviewers: [
    { agent_id: "claude-code", error: "agent unavailable: claude-code adapter healthcheck failed" },
  ],
}
```

The same warnings ALSO end up in `panel.json.reviewers[i].dispatchWarnings`
so `get_panel_status` can replay them later.

### Q5: How does aggregate_panel handle non-terminal reviewers?

Reject if ANY dispatched reviewer is still `running`. Caller should
retry once all reviewers are terminal.

Error: `run_panel.aggregate_not_ready: <K> of <N> reviewers still running`.

Include reviewers in `error`/`cancelled` terminal states — emit them
in the aggregated `peer_messages` with the prior-turn summary in the
body (or a fallback string if no summary). `from_label` notes the
status when non-success.

If a reviewer's state.json is missing or unparsable (rare —
manual deletion, fs corruption, or parse error; NOT triggered by
`discard_run` which keeps state.json), emit a synthetic message
noting the state-loss: `body: "(reviewer state unavailable;
possibly removed externally)"`, `from_label: "<sanitized agent_id>
(state lost)"`.

Aggregate emits all reviewer messages even when bodies are
identical — different reviewers reaching the same conclusion is
meaningful signal. No de-dup.

## Data model

### Panel state schema

```ts
// src/orchestrator/panels/schema.ts
export const PANEL_SCHEMA_VERSION = 1;

export interface PanelStateV1 {
  readonly schemaVersion: 1;
  readonly panelId: string;
  readonly createdAt: string;                            // ISO 8601
  // ALWAYS present — the serve instance's repoRoot at dispatch
  // time. Used by get_panel_status / aggregate_panel to enforce
  // cross-repo isolation.
  readonly panelRepoRoot: string;
  // Implementer fields present only when bound.
  readonly implementerRunId?: string;
  readonly implementerWorktreePath?: string;
  readonly implementerSummarySnapshot?: string;
  readonly implementerRepoRoot?: string;
  readonly reviewers: ReadonlyArray<PanelReviewerRecord>;
}

export interface PanelReviewerRecord {
  // null when dispatched: false
  readonly runId: string | null;
  readonly agentId: string;
  readonly dispatched: boolean;
  // Present when dispatched: false
  readonly error?: string;
  // Present when dispatched: true
  readonly dispatchedAt?: string;
  // Captured at dispatch time from
  // dispatchRunAgentInternal.result.warnings. Includes
  // peer_messages.body_truncated / .excerpt_truncated /
  // .aggregate_cap_reached / .hard_ceiling_* /
  // .cap_overrides_invalid warnings.
  readonly dispatchWarnings: readonly string[];
}
```

Stored at `<crewHome>/panels/<encodeURIComponent(panelId)>/panel.json`.
Written incrementally (stub at start, atomic update per reviewer).
~1 KB typical. No cleanup — small + audit-relevant; see §Risks for
quantification.

### `sanitizeFromLabel`

```ts
// src/orchestrator/panels/sanitize.ts
const FROM_LABEL_FORBIDDEN = /[\x00-\x1f\x7f`#\r\n]/g;
const FROM_LABEL_MAX = 80;

export function sanitizeFromLabel(raw: string, suffix?: string): string {
  const cleanedRaw = raw.replace(FROM_LABEL_FORBIDDEN, '_');
  const cleanedSuffix = suffix?.replace(FROM_LABEL_FORBIDDEN, '_');
  const composed = cleanedSuffix
    ? `${cleanedRaw} (${cleanedSuffix})`
    : cleanedRaw;
  return composed.length > FROM_LABEL_MAX
    ? composed.slice(0, FROM_LABEL_MAX)
    : composed;
}
```

Used by `buildImplementerPeerMessage` and `aggregate_panel`. The
peer_messages Zod schema rejects from_labels with control chars /
backticks / newlines / `#` / > 80 chars; auto-built labels embed
agent IDs and error messages that can violate any of these. The
helper guarantees the output passes the Zod refine.

### `peer_messages` reuse

The auto-built implementer message AND per-reviewer items pass
through the existing peer-messages cap pipeline inside each
reviewer's `runStateStore.create()` call. No new schema, no new
caps.

## Dispatch helper extraction (Phase 1 prerequisite)

`run_agent` MCP handler today does roughly:

```
preflight peer_messages → planRunAgent → runStateStore.create →
  plan.buildTask(composedPrompt) → runDispatchAndRespond
```

`runDispatchAndRespond` (in `serve.ts:1010-1333`) owns:
- `progressNotifierFrom(extra, ...)` — MCP progress channel.
- `getClientKind()` — client identity.
- **Lifecycle listener install (`serve.ts:1015-1023, 1152-1241`)**
  — without this, runs never mark terminal.
- Lifecycle start (`dispatcher.start(task)`).
- Warning merging (`mergeEnvelopeWarnings`).
- Envelope shaping (`structuredRunEnvelope`).
- Markdown rendering (`renderDispatchMarkdown`).
- Tail URL construction.

For `run_panel`, we want the run lifecycle WITHOUT the MCP-specific
envelope shaping/rendering. Factor out:

```ts
// src/orchestrator/dispatch-run-agent-internal.ts (NEW)

export interface DispatchContext {
  readonly registry: AgentRegistry;
  readonly worktreeManager: WorktreeManager;
  readonly runStateStore: RunStateStore;
  readonly agentPrefs: AgentPrefsMap;          // R5-3: actual symbol
  readonly dispatcher: ToolDispatcher;         // R5-3: actual symbol
  readonly crewHome: string;
  readonly repoRoot: string;
  readonly projectRoot: string;
}

export interface DispatchRunAgentInternalArgs {
  readonly input: RunAgentInput;
  readonly ctx: DispatchContext;
  // ProgressNotifier is currently a local type in
  // src/cli/commands/serve.ts. R5-4: Phase 1 exports it (or
  // moves it to a small shared module like
  // src/orchestrator/progress.ts) so the helper can import it.
  readonly progress?: ProgressNotifier;
}

export interface DispatchRunAgentInternalResult {
  readonly runId: string;
  readonly worktreePath: string;
  readonly readOnly: boolean;
  readonly tailUrl: string;
  readonly tailCommandPath: string;
  readonly toolCallId: string;
  readonly warnings: readonly string[];
}

export async function dispatchRunAgentInternal(
  args: DispatchRunAgentInternalArgs,
): Promise<DispatchRunAgentInternalResult>;
```

The helper:
1. Runs `validatePeerMessagesPreflight` on `input.peer_messages`.
2. Calls `planRunAgent(input, ctx)` (R4-5: actual signature, not
   the spread form). If `plan.kind === 'error'`, throws
   `DispatchError(plan.message)` immediately (matches the existing
   handler's check at `serve.ts:425`).
3. Calls `ctx.runStateStore.create({...})` — peer-messages
   pipeline + composed-prompt cap + state lock all run inside.
   Capture the returned `warnings` in a local — they need to
   survive past step 4 even if it throws.
4. **Installs dispatcher lifecycle listeners** on
   `ctx.dispatcher` keyed by `plan.toolCallId`. Today's listeners
   self-dispose on terminal events (`serve.ts:1152`); no
   teardown handle needed in the success path.
5. Calls `plan.buildTask(composedPrompt)` and
   `ctx.dispatcher.start(task)`. `start` can throw synchronously
   on duplicate `toolCallId` (`tool-dispatcher.ts:61`) — rare
   given the `randomUUID()` minted in step 2 but possible.
6. Returns `{...result, tailUrl, warnings}` constructed inline.

**Error paths:**
- Throw between steps 1 and 2 (preflight, planner error): no
  state mutation, no worktree allocated. Re-throw as
  `DispatchError(message)`.
- Throw inside step 3 (create() — composed_prompt_too_large,
  state_lock_timeout, etc.): no state.json written. If a worktree
  was already allocated by step 2, clean it up via
  `ctx.worktreeManager.cleanupByRunId(plan.runId)` (only when
  `!plan.readOnly`). Re-throw as `DispatchError(message)`.
- Throw inside step 5 (dispatcher.start sync-throw, AFTER
  create() succeeded — the only known sync-throw path today is
  duplicate `toolCallId` at `tool-dispatcher.ts:61`): state.json
  exists with status='running'. Helper: mark it terminal-error
  via `ctx.runStateStore.markTerminal(plan.runId, {status:
  'error', summary: <error message>, filesChanged: []})` (R4-5:
  signature takes runId first) AND cleanup worktree (when
  `!plan.readOnly`) — mirrors the rollback that doesn't exist
  for the success path. Lifecycle listeners installed in step 4
  will NOT see a terminal event from the dispatcher (because
  start threw before any event fired); the listener leak is
  acceptable on this collision-only path (~2^-122 probability
  with `randomUUID()`). Re-throw as `DispatchError(message,
  {warnings: <captured-from-step-3>})` so the panel loop can
  hoist `warnings` into the failed reviewer's `dispatchWarnings`.

```ts
export class DispatchError extends Error {
  readonly warnings: readonly string[];
  constructor(message: string, options?: { warnings?: readonly string[] }) {
    super(message);
    this.warnings = options?.warnings ?? [];
  }
}
```

`run_agent` MCP handler becomes a thin wrapper that calls
`dispatchRunAgentInternal` and renders envelope + markdown.
`run_panel` dispatch loop calls the helper N times.

**Regression risk:** existing `run_agent` tests (and the dispatch
adapter probes from peer-messages Phase 3) MUST continue to pass
byte-identical. Helper extraction is a refactor; commit it
separately from the panel code so a bisect can identify
regressions.

## Tool surface

### New tool: `run_panel`

```ts
export const runPanelInputSchema = z.object({
  implementer_run_id: z.string().min(1).optional(),
  reviewers: z.array(z.object({
    agent_id: z.string().min(1),
    prompt: z.string().min(1),
    model: z.string().optional(),
    effort: z.enum(['low','medium','high','xhigh','max']).optional(),
    working_directory: z.string().optional(),
    read_only: z.boolean().optional(),
    peer_messages: z.array(peerMessageInputSchema).max(10000).optional(),
  })).min(1).max(100),
}).strict();
```

Zod cap is a loose anti-DOS ceiling (100); runtime cap (20) is
enforced by `validateRunPanelPreflight` so the named
`run_panel.too_many_reviewers:` error fires before any dispatch.
Mirrors peer-messages' loose-schema-cap / explicit-preflight
pattern (`peerMessagesInputSchema.max(10000)` vs runtime
`maxItems: 50`).

**Pre-flight (handler, BEFORE any dispatch):**
- Validate schema (Zod cap of 100; rare to hit).
- `validateRunPanelPreflight(input.reviewers)` — throws
  `run_panel.too_many_reviewers:` if `reviewers.length > 20`
  (runtime cap, lower than Zod's loose ceiling so the named
  error reliably fires).
- If `implementer_run_id` set, in this order (R4-1 — repo
  checks run BEFORE any filesystem probe so a cross-repo
  run never touches foreign FS paths):
  1. `runStateStore.read(implementer_run_id)` — reject
     `run_panel.implementer_unknown:` if undefined.
  2. Status in `{success, partial, error, cancelled}` else
     `run_panel.implementer_not_terminal:`.
  3. `implementer.repoRoot === undefined` →
     `run_panel.implementer_legacy_no_repo:`.
  4. `implementer.repoRoot !== runStateStore.repoRoot` →
     `run_panel.implementer_cross_repo:`.
  5. `existsSync(implementer.worktreePath)` else
     `run_panel.implementer_worktree_unavailable:`.

Per-reviewer `peer_messages` validation runs INSIDE the dispatch
loop, BEFORE the per-reviewer existsSync check, and treats failure
as a per-reviewer `failed_reviewer` (R4-3) so one bad reviewer
doesn't abort the whole panel.

**Dispatch loop sketch (serial, incremental panel.json updates):**

```ts
const panelId = randomUUID();
const panelDir = join(ctx.crewHome, 'panels', encodeURIComponent(panelId));
mkdirSync(panelDir, { recursive: true });

let implementerMessage: PeerMessageInput | undefined;
if (implementerState) {
  implementerMessage = buildImplementerPeerMessage(implementerState);
}

// Stub: panel.json with no reviewers yet. Crash-survivable.
let panelState: PanelStateV1 = {
  schemaVersion: 1,
  panelId,
  createdAt: new Date().toISOString(),
  panelRepoRoot: ctx.runStateStore.repoRoot,
  implementerRunId: implementerState?.runId,
  implementerWorktreePath: implementerState?.worktreePath,
  implementerSummarySnapshot: implementerState?.prompts.at(-1)?.summary,
  implementerRepoRoot: implementerState?.repoRoot,
  reviewers: [],
};
await writePanelStateAtomic(panelDir, panelState);

const dispatchEnvelopes: ReviewerDispatchEnvelope[] = [];

for (const r of input.reviewers) {
  const composed = [
    ...(implementerMessage ? [implementerMessage] : []),
    ...(r.peer_messages ?? []),
  ];

  const reviewerHasExplicitReadOnly = r.read_only !== undefined;
  const effectiveReadOnly = r.read_only
    ?? (implementerState !== undefined);     // bound default true; unbound default false

  // R2-1: when reviewer explicitly sets read_only:false on a bound
  // panel, SUPPRESS the working_directory auto-default. The
  // implementer-context peer_message still forwards.
  const suppressWorkingDirDefault = reviewerHasExplicitReadOnly
    && !effectiveReadOnly
    && implementerState !== undefined;

  const effectiveWorkingDirectory = r.working_directory
    ?? (suppressWorkingDirDefault ? undefined : implementerState?.worktreePath);

  // R4-3: per-reviewer peer_messages preflight inside the loop, so
  // one malformed reviewer fails as failed_reviewer instead of
  // aborting the whole panel.
  try {
    validatePeerMessagesPreflight(composed, ctx.runStateStore.caps);
  } catch (preflightErr) {
    panelState = {
      ...panelState,
      reviewers: [...panelState.reviewers, {
        runId: null,
        agentId: r.agent_id,
        dispatched: false,
        error: preflightErr instanceof Error ? preflightErr.message : String(preflightErr),
        dispatchWarnings: [],
      }],
    };
    await writePanelStateAtomic(panelDir, panelState);
    continue;
  }

  // R3-2: explicit existsSync check — planRunAgent doesn't validate
  // working_directory existence, so an implementer worktree that
  // disappeared mid-panel would silently let the reviewer dispatch
  // and fail async inside the adapter. Catch it here so the
  // reviewer is recorded as failed_reviewer with a clear error.
  if (effectiveWorkingDirectory && !existsSync(effectiveWorkingDirectory)) {
    panelState = {
      ...panelState,
      reviewers: [...panelState.reviewers, {
        runId: null,
        agentId: r.agent_id,
        dispatched: false,
        error: `working_directory does not exist: ${effectiveWorkingDirectory} (implementer worktree may have been removed)`,
        dispatchWarnings: [],
      }],
    };
    await writePanelStateAtomic(panelDir, panelState);
    continue;
  }

  let record: PanelReviewerRecord;
  try {
    const result = await dispatchRunAgentInternal({
      input: {
        agent_id: r.agent_id,
        prompt: r.prompt,
        model: r.model,
        effort: r.effort,
        working_directory: effectiveWorkingDirectory,
        read_only: effectiveReadOnly,
        peer_messages: composed.length > 0 ? composed : undefined,
      },
      ctx,
      progress,
    });
    record = {
      runId: result.runId,
      agentId: r.agent_id,
      dispatched: true,
      dispatchedAt: new Date().toISOString(),
      dispatchWarnings: result.warnings,        // durable per R2-5
    };
    dispatchEnvelopes.push({
      run_id: result.runId,
      agent_id: r.agent_id,
      tail_url: result.tailUrl,
      worktree_path: result.worktreePath,
      warnings: result.warnings,
    });
  } catch (err) {
    // R3-7: DispatchError carries partial warnings on the rare
    // post-create() throw path. Plain Errors fall through with [].
    const warnings = err instanceof DispatchError ? err.warnings : [];
    record = {
      runId: null,
      agentId: r.agent_id,
      dispatched: false,
      error: err instanceof Error ? err.message : String(err),
      dispatchWarnings: warnings,
    };
  }

  // Atomic update after each reviewer's dispatch attempt.
  panelState = { ...panelState, reviewers: [...panelState.reviewers, record] };
  await writePanelStateAtomic(panelDir, panelState);
}

return {
  panel_id: panelId,
  partial: panelState.reviewers.some(r => !r.dispatched),
  reviewers: dispatchEnvelopes,
  failed_reviewers: panelState.reviewers
    .filter(r => !r.dispatched)
    .map(r => ({ agent_id: r.agentId, error: r.error ?? 'unknown failure' })),
};
```

### New tool: `get_panel_status`

```ts
export const getPanelStatusInputSchema = z.object({
  panel_id: z.string().min(1),
}).strict();
```

Returns (discriminated union per reviewer):
```ts
type PanelReviewerStatus =
  | {
      run_id: string;
      agent_id: string;
      state_unavailable: false;
      status: 'running' | 'success' | 'partial' | 'error' | 'cancelled' | 'merged' | 'merge_conflict' | 'discarded';
      summary?: string;                           // present iff terminal
      files_changed?: readonly string[];
      completedAt?: string;
      dispatch_warnings: readonly string[];        // from panel.json
    }
  | {
      run_id: string;
      agent_id: string;
      state_unavailable: true;
      state_unavailable_reason: string;
      dispatch_warnings: readonly string[];
    };

interface GetPanelStatusResult {
  panel_id: string;
  implementer_run_id?: string;
  partial: boolean;                                // panel.json had dispatch failures
  total_count: number;                             // DISPATCHED reviewers (NOT requested — see failed_reviewers.length for dispatch failures)
  terminal_count: number;
  running_count: number;
  reviewers: readonly PanelReviewerStatus[];
  failed_reviewers: ReadonlyArray<{
    agent_id: string;
    error: string;
  }>;
}
```

Reads panel.json + each reviewer's state.json. No lock needed
(both are read-only). No wait variant.

**Failure modes:**
- panel.json missing → `run_panel.unknown:`.
- panel.json unparsable (corruption, malformed JSON) →
  `run_panel.unparsable:`.
- panel.json `schemaVersion !== 1` → `run_panel.unknown_schema_version:`.
- panel.json `panelRepoRoot !== runStateStore.repoRoot` →
  `run_panel.cross_repo:`.
- A dispatched reviewer's state.json missing or unparsable →
  inline `state_unavailable: true` entry with diagnostic. The
  reviewer's `dispatch_warnings` from panel.json are still
  surfaced. NOT a panel-level throw.

### New tool: `aggregate_panel`

```ts
export const aggregatePanelInputSchema = z.object({
  panel_id: z.string().min(1),
}).strict();
```

Returns:
```ts
{
  panel_id: string;
  peer_messages: PeerMessageInput[];           // ready to feed into continue_run
}
```

Implementation:
- Same panel-existence + schema-version + cross-repo checks as
  `get_panel_status`.
- Read panel.json + each reviewer's state.json.
- Reject `run_panel.aggregate_not_ready:` if any dispatched
  reviewer is still `running`.
- For each dispatched reviewer:
  - `state_unavailable: true` → emit:
    ```ts
    {
      body: `(reviewer state unavailable: ${reason})`,
      kind: 'review',
      from_label: sanitizeFromLabel(agentId, 'state lost'),
    }
    ```
  - Terminal → read `summary` (= `state.prompts.at(-1)?.summary`)
    and `files_changed` (= `state.filesChanged`). Build, applying
    the same files-list cap as `buildImplementerPeerMessage`:
    ```ts
    const filesChanged = state.filesChanged ?? [];
    const tooMany = filesChanged.length > 1000;
    const oversize = filesChanged.filter((f) => f.length > 4096).length;
    const safeFiles = filesChanged.filter((f) => f.length <= 4096).slice(0, 1000);
    if (tooMany || oversize > 0) {
      logger.debug('aggregate_panel files truncated for schema fit', {
        reviewerRunId: state.runId, originalCount: filesChanged.length,
        keptCount: safeFiles.length, oversizeDropped: oversize,
      });
    }
    return {
      body: summary?.trim() || `(no summary; status=${status})`,
      kind: 'review',
      from_label: sanitizeFromLabel(
        agentId,
        `review${status !== 'success' ? `, status=${status}` : ''}`,
      ),
      ...(safeFiles.length > 0 ? { files: safeFiles } : {}),
    };
    ```
- For each failed-dispatch reviewer:
  ```ts
  {
    body: `(reviewer dispatch failed: ${error})`,
    kind: 'review',
    from_label: sanitizeFromLabel(agentId, 'dispatch failed'),
  }
  ```
- Order: dispatched reviewers in panel.json order, then failed
  reviewers in panel.json order. Deterministic.
- **Emit all messages even when identical.** Different reviewers
  reaching the same conclusion is signal; no de-dup.
- DO NOT enforce peer_messages caps here. The consumer
  (`continue_run`) runs the cap pipeline.

### Error code wire contract

All panel errors use `run_panel.<code>:` prefix.

Defined codes:
- `run_panel.too_many_reviewers:` — reviewers count over cap
  (named explicit preflight; supplements the implicit Zod cap).
- `run_panel.implementer_unknown:` — implementer_run_id not found.
- `run_panel.implementer_not_terminal:` — status in
  `{running, discarded, merged, merge_conflict}`.
- `run_panel.implementer_worktree_unavailable:` — path doesn't
  exist on disk.
- `run_panel.implementer_legacy_no_repo:` — implementer state.json
  has no `repoRoot` field (legacy v1 record).
- `run_panel.implementer_cross_repo:` — implementer.repoRoot !==
  serve.repoRoot.
- `run_panel.unknown:` — panel_id not found.
- `run_panel.unparsable:` — panel.json exists but cannot be
  parsed (corruption, manual edit gone wrong). Thrown by
  `readPanelState` and surfaced by `get_panel_status` /
  `aggregate_panel` when they read existing panel state.
  (`run_panel` itself writes a fresh panel and doesn't
  encounter this path.)
- `run_panel.unknown_schema_version:` — panel.json schemaVersion
  != 1.
- `run_panel.cross_repo:` — panel.panelRepoRoot !== serve.repoRoot.
- `run_panel.aggregate_not_ready:` — at least one dispatched
  reviewer still running.

Per-reviewer dispatch failures DO NOT surface as panel-level errors
— they're embedded in the `failed_reviewers` array.

Per-reviewer peer_messages cap/truncation warnings use the existing
`peer_messages.*` namespace; they surface on each reviewer's
dispatch envelope AND in panel.json `dispatchWarnings` (durable).

## Captain skill changes

Append to `skills/crew-captain.body.md` at EOF (current file has no
trailing closing sections after §Forwarding peer context):

```markdown
## Review panels

When you want N agents to review the same implementer in parallel,
`run_panel` collapses dispatch + collection into three calls.

### `run_panel`: parallel reviewers with shared context

Bound to an implementer:

```
run_panel({
  implementer_run_id: "A",
  reviewers: [
    { agent_id: "codex", prompt: "correctness pass" },
    { agent_id: "claude-code", prompt: "style + repo-conventions pass" },
  ],
})
```

When bound: each reviewer is auto-dispatched with `read_only: true`,
`working_directory: <A.worktree>`, and a prepended `peer_message`
carrying A's summary + files_changed. The reviewers can READ A's
edits directly. If you explicitly set `read_only: false` on a
reviewer, you take responsibility for that reviewer's
`working_directory` — the panel won't auto-point at A's worktree
(prevents accidental mutation).

Standalone (no implementer):

```
run_panel({
  reviewers: [
    { agent_id: "codex", prompt: "...", read_only: true },
    { agent_id: "gemini-cli", prompt: "...", working_directory: "/path", peer_messages: [...] },
  ],
})
```

When unbound: each reviewer is a plain `run_agent` call.
`read_only: true` reviewers default to running in the host repo
root (no worktree allocated). `read_only: false` or unset
reviewers allocate a fresh run worktree (the standard `run_agent`
default). You can override either with explicit `working_directory`.

### Lifecycle

`run_panel` returns immediately with `panel_id` and per-reviewer
`run_id` + `tail_url`. Each reviewer follows the existing dispatch
lifecycle independently. On Claude Code, spawn the watcher overlay
per reviewer:

```
Bash("{{CREW_WAIT_COMMAND}} <reviewer.run_id>", run_in_background: true)
```

On Codex / Gemini, rely on the next-user-turn snapshot.

### Aggregating findings

Once all reviewers are terminal:

```
aggregate_panel({ panel_id })
  → { peer_messages: [...] }   // one message per reviewer

continue_run({
  run_id: "A",
  peer_messages: <aggregated>,
  prompt: "revise per these findings",
})
```

`aggregate_panel` rejects with `run_panel.aggregate_not_ready:` if
any reviewer is still running. It emits all reviewer messages
even when they're identical — different reviewers reaching the
same conclusion is signal, not noise.

### Partial dispatch

If any reviewer fails to dispatch (agent unavailable, worktree
allocation failure, etc.), the rest still run. The response
envelope includes a `failed_reviewers` array; `aggregate_panel`
emits an inline "(reviewer dispatch failed: ...)" message so the
implementer sees what happened. You decide whether to proceed.

### When NOT to use run_panel

- One reviewer only: just `run_agent` with `read_only: true` +
  `working_directory`. Panel is overhead.
- Reviewers need wildly different context per-reviewer: use
  `run_agent` per reviewer for tighter `peer_messages` control.
- You want auto-cancel-on-blocker: not supported (yet). Cancel
  per-reviewer with `cancel_run`.
```

## Edge cases

### Implementer status changes during panel lifetime
Snapshot semantics: `run_panel` reads implementer once at dispatch
time. `markTerminal` uses tmp+rename (atomic), so the read returns
the prior state without tearing.

### Implementer discarded / merged mid-dispatch
If `discard_run` (non-read-only) removes the implementer's worktree
WHILE `run_panel` is iterating reviewers, the dispatch loop's
explicit `existsSync(effectiveWorkingDirectory)` check (R3-2)
catches it BEFORE calling the helper. The reviewer is recorded as
`failed_reviewer` with "working_directory does not exist:
\<path\> (implementer worktree may have been removed)" inline. No
silent fall-through to async adapter failure.

### Reviewer's auto-built implementer message has empty summary
Fallback string `(no summary captured for implementer X; status=Y)`
keeps body non-empty. Length is bounded; pipeline truncation
handles oversized cases.

### Reviewer hits peer_messages cap warnings on dispatch
Cap-pipeline warnings (`body_truncated`, `aggregate_cap_reached`,
etc.) emit as part of the reviewer's run envelope AND get written
to `panel.json.reviewers[i].dispatchWarnings`. `get_panel_status`
surfaces them via that field. (Note: `get_run_status` on the
reviewer itself does NOT surface these — that's an existing
architectural limit, out of scope for this plan.)

### Concurrent `run_panel` calls
Multiple panels can run concurrently. Panel.json writes are
atomic per-panel (tmp+rename in a per-panel dir). Each reviewer's
dispatch goes through the existing per-run `withStateLock`; no
panel-level lock needed.

### Same agent appearing twice in reviewers
Allowed. Two independent `run_agent` dispatches → two
independent read-only runs pointing at the implementer worktree.

### Reviewer cancellation mid-panel
Captain calls `cancel_run({run_id})` for the reviewer they want
to abort. The cancelled reviewer's terminal status is `cancelled`;
`get_panel_status` reflects it; `aggregate_panel` emits an inline
"(review, status=cancelled)" message.

### Implementer is a read-only run
Implementer read-only runs have `worktreePath` pointing at the
host repo (not a separate worktree dir). Auto-bound
`working_directory` for reviewers points at the host repo.
Multiple read_only reviewers reading the host repo in parallel is
fine; the existing post-run dirty-tree probe still fires
per-reviewer.

### Implementer worktree was deleted after dispatch but before aggregate
`aggregate_panel` doesn't touch the worktree — only reads each
reviewer's state.json. Aggregation succeeds even if the
implementer's worktree is gone.

### Server crash during run_panel dispatch loop
Two distinct cases:
- **Normal dispatch failure** (helper throws):
  `dispatchRunAgentInternal` rejects, the catch block records a
  failed_reviewer with the error, panel.json updates atomically.
  Tested separately as "normal dispatch failure."
- **Process crash** (`kill -9`, OS reboot): no catch block runs;
  panel.json reflects whichever reviewers had completed their
  record-update before the crash. In-flight reviewer's underlying
  run may exist orphan-style; captain can `list_runs` to find +
  `discard_run`. Tested separately as "process crash recovery."

### `get_panel_status` finds a reviewer's state.json missing
Surface `state_unavailable: true` in the discriminated-union
reviewer entry. Don't throw — the rest of the panel is still
readable. Aggregation handles this case explicitly (synthetic
"(state lost)" message).

### Unknown panel schema version
`readPanelState` throws `run_panel.unknown_schema_version:` when
`schemaVersion !== 1`. Future migrations bump `PANEL_SCHEMA_VERSION`
and add a migration path; v1 has none.

### Cross-repo panel access
`get_panel_status` / `aggregate_panel` reject
`run_panel.cross_repo:` when `panel.panelRepoRoot !== runStateStore.repoRoot`.
Closes the v2 gap where unbound panels weren't repo-isolated.

## Risks

- **Dispatch helper extraction breakage.** Pulling
  `dispatchRunAgentInternal` out of `run_agent` is a real
  refactor; existing run_agent tests + adapter probes must pass
  byte-identical. Mitigation: commit the helper extraction
  SEPARATELY from panel code, verify suite green at each step.
- **Lifecycle listener ownership.** Helper MUST install
  dispatcher listeners before `dispatcher.start`. Test that
  reviewer runs actually reach terminal in the panel path
  (regression-prone if listener wiring drifts).
- **`failed_reviewers` UX clarity.** Captain inspects a separate
  array on partial panels. Surface failure count in markdown
  rendering for `run_panel` results to make it harder to miss.
- **Aggregate-not-ready churn.** Captain calls `aggregate_panel`
  too early → error → wait → retry. The `partial` flag and
  per-reviewer `status` in `get_panel_status` make the wait
  condition visible.
- **Stale snapshot for long-running panels.** Implementer summary
  captured at dispatch. If captain dispatches a 10-minute panel
  and meanwhile continues the implementer WITHOUT panel feedback,
  the eventual aggregated feedback addresses a stale state.
  Documented in captain skill.
- **Skill-body drift.** Same memory feedback as peer-messages:
  captain skill body update MUST ship in the same change as the
  tool surface.
- **Tool catalog parity.** `src/install/tool-catalog.ts` AND
  `src/orchestrator/tools/index.ts` must include the new tools.
  Missing either means `crew-mcp install --target <host>` won't
  surface them.
- **`<crewHome>/panels/` unbounded growth.** ~1 KB per panel.
  Heavy captain usage (~10 panels/day) → ~4 MB/year. Light usage
  → KBs/year. Acceptable unbounded for now; revisit if a captain
  workflow shows orders-of-magnitude higher usage.

## Testing

### Unit tests (Phase 1)

- `panelStateSchemaV1` validation matrix; unknown schemaVersion
  rejected with `run_panel.unknown_schema_version:`.
- `sanitizeFromLabel`:
  - Strips control chars (`\x00-\x1f\x7f`).
  - Strips backticks, `#`, `\r`, `\n`.
  - Truncates to 80 chars.
  - Composes `raw (suffix)` form correctly.
  - Returns valid input unchanged.
- `buildImplementerPeerMessage`:
  - Terminal-success with non-empty summary + non-empty filesChanged.
  - Terminal-success with empty summary → fallback string.
  - Terminal-error with summary.
  - Empty filesChanged → `files` field omitted.
  - `agentId` containing forbidden chars (backtick, `#`) → sanitized.
  - Long summary (passes through peer_messages pipeline truncation
    when fed into a reviewer's `runStateStore.create`).
  - **filesChanged with > 1000 items → sliced to 1000 (R3-4).**
  - **filesChanged with paths > 4096 chars → dropped (R3-4).**
  - Output ALWAYS passes `peerMessageInputSchema.parse(...)`.
- Pre-flight validation:
  - `validateRunPanelPreflight` throws `run_panel.too_many_reviewers:`
    when count > runtime cap.
  - `implementer_unknown`: missing run_id.
  - `implementer_not_terminal`: each of `running`, `discarded`,
    `merged`, `merge_conflict`.
  - `implementer_worktree_unavailable`: status fine but worktree
    pruned.
  - `implementer_legacy_no_repo`: state.json with no `repoRoot`.
  - `implementer_cross_repo`: differs from serve.repoRoot.
- `writePanelStateAtomic`: tmp+rename, idempotent, propagates
  ENOENT on missing dir.
- `readPanelState`: returns undefined when missing, throws
  `run_panel.unparsable:` on parse error, throws
  `run_panel.unknown_schema_version:` on unknown schemaVersion.

### Integration tests (Phase 1)

- `run_panel` with 2 reviewers, bound to terminal implementer:
  - panel.json stub written before dispatch loop (assert via
    fs probe).
  - panel.json updated incrementally (assert reviewers list
    grows per iteration via a deterministic helper stub).
  - Both reviewers' state.json contains composed peer_messages
    including the implementer-context block.
  - `working_directory` points at implementer.worktreePath.
  - `read_only: true` set when not overridden.
  - `panelRepoRoot` set to serve.repoRoot.
- `run_panel` with `read_only: false` per-reviewer override:
  - Reviewer allocates its own worktree.
  - `working_directory` auto-default SUPPRESSED (reviewer does
    NOT operate against implementer.worktreePath unless they
    supplied their own).
- `run_panel` with `read_only: false` + explicit
  `working_directory`: reviewer uses the explicit path.
- `run_panel` unbound (no implementer): plain `run_agent`
  semantics per reviewer; no auto-forwarded peer_message;
  panelRepoRoot still set.
- `run_panel` with 1 failing reviewer (agent unavailable):
  `partial=true`, `failed_reviewers` non-empty, other reviewers
  still dispatched; panel.json records both states correctly.
- `run_panel` rejection paths (all cite the namespaced error):
  - `too_many_reviewers` (count > 20 via preflight; Zod cap 100
    is too loose to fire first).
  - `implementer_unknown`.
  - `implementer_not_terminal` (each disallowed status).
  - `implementer_worktree_unavailable`.
  - `implementer_legacy_no_repo`.
  - `implementer_cross_repo`.
- **Implementer worktree disappears mid-dispatch (R3-2):**
  fixture deletes implementer.worktreePath between reviewer #2
  and #3 dispatch attempts; reviewer #3 is recorded as
  `failed_reviewer` with the explicit "working_directory does
  not exist" error. Reviewers #1, #2 already dispatched
  successfully.
- Concurrent `run_panel` calls (two simultaneous panels):
  both succeed, panel.jsons don't cross-contaminate.
- **Normal dispatch failure**: throw `DispatchError` inside
  `dispatchRunAgentInternal` for reviewer #3 → record in
  `failed_reviewers`; panel.json reflects #1, #2 dispatched and
  #3 failed. **AND** when the helper throws after `create()`
  succeeded (i.e., `DispatchError` carries `warnings`), the
  partial warnings are preserved in
  `panel.json.reviewers[i].dispatchWarnings`.
- **`plan.kind === 'error'` handling**: planRunAgent returns
  error (e.g., agent not in registry); helper throws
  `DispatchError`; panel records `failed_reviewer`.
- **R4-2 dispatcher.start sync-throw**: mock-throw `dispatcher.start`
  for reviewer #2 AFTER its `runStateStore.create()` succeeded.
  Helper's catch block runs: state.json marked `status: 'error'`
  with the throw message; non-read-only worktree cleaned up via
  `cleanupByRunId`; `DispatchError` carries the warnings
  captured from `create()`. Panel records reviewer #2 as
  `failed_reviewer` with those warnings in `dispatchWarnings`.
- **R4-3 per-reviewer peer_messages preflight failure:**
  reviewer with 51 items (over runtime `maxItems: 50`) →
  recorded as `failed_reviewer` with `peer_messages.too_many:`
  error; remaining reviewers still dispatched.
- **Process crash recovery**: simulate by aborting after
  reviewer #2's record-update commits but before #3's dispatch
  starts → panel.json shows #1, #2 dispatched; #3 unrecorded;
  panel observable via `get_panel_status`.
- `get_panel_status`:
  - Reflects terminal_count / running_count across lifecycle.
  - Surfaces `state_unavailable: true` when reviewer's state.json
    deleted manually (discard_run does NOT trigger this).
  - Returns `dispatch_warnings` from panel.json per reviewer.
  - Rejects `run_panel.unknown:` for missing panel_id.
  - Rejects `run_panel.unparsable:` for corrupted panel.json.
  - Rejects `run_panel.unknown_schema_version:` for v != 1.
  - Rejects `run_panel.cross_repo:` for foreign-repo panel.
- `aggregate_panel`:
  - Rejects when any reviewer is `running`.
  - Happy path: one peer_message per reviewer, correct `from_label`
    (sanitized).
  - Includes failed-dispatch reviewers with inline error
    messages.
  - Handles `state_unavailable` reviewers with synthetic message.
  - Emits all messages even when identical (no de-dup).
  - Cross-repo rejection.
  - **R4-2: files-list cap in terminal-reviewer branch.**
    Reviewer state.json with filesChanged.length > 1000 → emitted
    message has files.length === 1000. Reviewer state.json with
    some path > 4096 chars → oversize paths dropped, debug log
    emitted. Resulting peer_messages all pass
    `peerMessageInputSchema.parse(...)`.
- `aggregate_panel` + `continue_run` round-trip: feed aggregated
  peer_messages into continue_run, verify implementer state.json
  records them post-pipeline. Confirm sanitized from_labels
  survive the round-trip.
- **Adapter prompt probe (one end-to-end)**: dispatch a panel
  with one reviewer, inspect the reviewer's adapter invocation,
  assert the prepend block contains the implementer-context
  message byte-for-byte.
- **Lifecycle listener install**: integration test that a panel-
  dispatched reviewer actually reaches terminal (regression
  guard for helper extraction).
- **Tool catalog parity**: confirm `run_panel`,
  `get_panel_status`, `aggregate_panel` are in both
  `src/install/tool-catalog.ts` AND `src/orchestrator/tools/index.ts`;
  parity test passes.

### Property tests

- Random panel sizes 1..20: every dispatched reviewer's run_id
  appears in `get_panel_status.reviewers`.
- `aggregate_panel` idempotency: given a frozen panel
  (all reviewers terminal, no state changes), two consecutive
  calls produce byte-identical peer_messages output.
- `sanitizeFromLabel` round-trip: any output is accepted by
  `peerMessageInputSchema.from_label.parse`.

## Phasing

### Phase 1 — helper extraction + 3 tools + storage + catalog + tests

Step order (commits land separately for bisect-friendliness):

1. **Helper extraction** (~0.75d):
   - `src/orchestrator/dispatch-run-agent-internal.ts` (NEW) with
     full `DispatchContext` + listener install.
   - **R5-4: Export `ProgressNotifier` from
     `src/cli/commands/serve.ts`** (or move the type into a
     small shared module like `src/orchestrator/progress.ts`)
     so the new helper module can import it. Today it's
     local-to-file.
   - `src/cli/commands/serve.ts` updated to delegate to the
     helper; existing run_agent tests + adapter probes stay
     byte-identical green.
   - `src/orchestrator/run-state.ts`: rename the private
     `repoRoot` field and add a public `get repoRoot()` getter
     so the cross-repo guards can read it from outside the class.
2. **Panel core** (~1.25d):
   - `src/orchestrator/panels/` (NEW dir):
     - `schema.ts` — `PanelStateV1`, `PanelReviewerRecord`,
       `PANEL_SCHEMA_VERSION`.
     - `sanitize.ts` — `sanitizeFromLabel`.
     - `store.ts` — `writePanelStateAtomic`, `readPanelState`.
     - `implementer-message.ts` — `buildImplementerPeerMessage`.
     - `aggregate.ts` — `aggregatePanel`.
     - `preflight.ts` — `validateRunPanelPreflight`.
   - `src/orchestrator/tools/run-panel.ts`,
     `get-panel-status.ts`, `aggregate-panel.ts` — schemas +
     handlers.
   - `src/orchestrator/tools/index.ts` — export new tools.
   - `src/cli/commands/serve.ts` — register 3 new tools.
   - `src/install/tool-catalog.ts` — add 3 catalog entries.
   - Unit + integration tests per §Testing Phase 1.
   - `test/install/tool-catalog.test.ts` — parity passes.

**Estimate:** 2 days (0.75d helper + 1.25d panel).

### Phase 2 — captain skill + verify probe + architecture doc + status doc

- `skills/crew-captain.body.md` — append §Review panels at EOF.
- `src/cli/commands/verify.ts` — add a `panels/` writability
  probe (mkdir + probe-write + delete; mirrors the
  `state-locks/` probe shipped in peer-messages Phase 4).
- `docs/architecture/tools.md` — update the tool catalog +
  add-tool workflow to reflect the 3 new tools (existing
  catalog plus run_panel / get_panel_status / aggregate_panel).
- `docs/status/captain-flow-review-2026-04-29.md` — short note
  on the panel surface + dispatch-helper extraction.

**Estimate:** 0.75 days (was 0.5d; +0.25d for architecture doc).

**Dogfood (post-merge, captain-driven, not in plan estimate):**
One real implement-then-panel-then-iterate cycle on a small
bounded task. Verify `panel.json` shape, `aggregate_panel`
output, `continue_run` audit record.

**Total: ~2.75 days.** Phase 1: 2d; Phase 2: 0.75d.

## Future work

- `cancel_panel({panel_id, except_run_ids?})` — bulk cancel.
- `continue_run_with_panel({implementer_run_id, panel_id, prompt})`
  — sugar verb composing aggregate_panel + continue_run.
- `list_panels({repoRoot?})` — discovery verb so captains don't
  need to retain `panel_id`s.
- ACK sentinels — reviewer returns "blocking issue"; server
  cancels siblings automatically.
- Auto-continue daemon — server-driven iteration loops.
- Reviewer dependency graphs — "R2 starts after R1 terminates."
- `get_run_status` surfacing of dispatch-time peer_messages
  warnings — existing limitation; not introduced here but worth
  noting for a future warning-persistence sweep.
