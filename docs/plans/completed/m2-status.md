# M2 Status — Full Lifecycle

**Status:** shipped (commit `8eaa29e`).
**Tag:** none yet (M3 install + skill closes the v0.2.0 work; tag at end of M3).

## What landed

The 6-tool surface, run-state persistence, and async-fallback for slow
dispatches.

### New tools

| Tool | Returns | Mutates |
|---|---|---|
| `continue_run` | RunEnvelope (same as run_agent) | worktree state |
| `merge_run` | `{ run_id, status: 'merged'\|'conflict'\|'no-changes', commit_sha?, conflicts? }` | host HEAD (with confirmation) |
| `discard_run` | `{ run_id, ok: true }` | removes worktree |
| `get_run_status` | `RunStateV1 + log_tail` | none |

### New module — `src/orchestrator/run-state.ts`

`RunStateStore` manages `.crew/runs/<runId>/state.json` + `events.log`.
Schema-versioned (v1), atomic writes via tmp+rename, error-tolerant
event-log appends. Status transitions: `running` → terminal (`success` |
`partial` | `error` | `cancelled`) → optional post-terminal
(`merged` | `merge_conflict` | `discarded`).

### Async-fallback

`run_agent` and `continue_run` race the dispatch terminal against a
60s timer (configurable via `asyncFallbackMs` for tests). Timer wins →
return early with `{ status: 'running', run_id }`; dispatch continues
in-process and writes its terminal state to state.json regardless of
when the host polls. Listeners self-dispose on the terminal event so
the dispatcher's EventEmitter doesn't accumulate dead handlers.

### WorktreeManager changes

- `mergeRunWorktree(runId, options?)` → returns `MergeRunResult` instead
  of throwing. Captures conflict file paths via
  `git diff --name-only --diff-filter=U`. Returns `'no-changes'` when
  worktree HEAD matches target HEAD. `options.force` skips the
  dirty-host refusal.
- `cleanupByRunId` no longer recursively removes the run dir.
  `rmdirSync` (non-recursive) preserves state.json + events.log so
  `get_run_status` can still report on a discarded run.

## Tests

- `test/orchestrator/run-state.test.ts` (new, 10 cases) — store
  primitives + schema versioning.
- `test/cli/commands/serve.test.ts` (extended, +13 cases) —
  continue_run (turn increment, refuses unknown / discarded),
  merge_run (success, real-conflict with conflicting host commit,
  no-changes, refuses double-merge), discard_run (removes worktree +
  preserves state, idempotent), get_run_status (full state + log_tail,
  errors on unknown), async-fallback (early return → status:running,
  in-flight poll, eventual completion).
- `test/git/worktree.test.ts` (updated) — new return type, no-changes
  path, force flag.
- `test/cli/commands/serve.subprocess.test.ts` (updated) — listTools
  asserts on the 6-tool surface.

Suite: 418 passed / 3 skipped / 0 failed across 40 files. Lint clean.
Build clean (138 KB ESM bundle, +16 KB over M1).

## Acceptance map (vs IMPLEMENTATION_PLAN.md)

| Criterion | Status |
|---|---|
| All 6 tools callable with correct envelopes | done (tested via SDK Client) |
| `run_agent → continue_run → merge_run` cleanly merges | done |
| `merge_run` with conflicts returns conflicts, leaves HEAD untouched | done (real conflict scenario) |
| Long-running `run_agent` returns running-status, then `get_run_status` returns final | done |
| Concurrency: two `run_agent` calls in separate worktrees | not tested explicitly (substrate already supports it; M4 eval will exercise) |
| `merge_run` refuses dirty host worktree without force | done |

## Decisions worth noting

1. **`buildAdapterDispatchTask` extracted from `planRunAgent`.** Lets
   `continue_run` reuse the dispatch logic against an existing worktree
   without re-allocating one. Single-source-of-truth for "how an adapter
   gets invoked inside a worktree."

2. **`runDispatchAndRespond` as the shared lifecycle.** Both
   `run_agent` and `continue_run` go through the same:
   create-or-append state → install lifecycle listeners (terminal
   writes + stream-log appends) → start dispatch → race terminal vs.
   timeout → format envelope. Keeps the two handlers thin.

3. **`installRunLifecycleListeners` self-disposes.** On terminal, the
   listener that writes state.json AND the listener that resolves the
   race promise are the same callback — they fire together, dispose
   themselves, and the host CLI sees a coherent envelope. The
   stream-log subscription is part of the same set so it disposes too.

4. **State.json survives `discard_run`.** v0.1 (and the original
   `cleanupByRunId`) recursively removed the run dir. v2 keeps state +
   events alongside the worktree so `get_run_status` can still report
   on a discarded run for debugging / portfolio-style audit. Only
   removes the run dir if truly empty (rmdirSync, non-recursive).

5. **Conflict capture via `git diff --name-only --diff-filter=U`.**
   simple-git throws on merge conflict; we catch, run a separate
   diff to enumerate the conflicting paths, and return them as a
   structured envelope. The merge is left in-progress in the user's
   working tree so they can resolve it (or `git merge --abort`).

6. **No state migration plumbing.** v0.1's state had v3→v4→v5
   migrations for backward compat. v2's run-state ships at
   schemaVersion: 1 and the reader throws on unknown versions. When
   we eventually bump (probably never for personal-use scope), the
   migration story can be added then. Don't pre-build it.

## Carry-forward for M3

The substrate is now feature-complete for the host-side. M3 builds
the install + skill rendering on top:

- Canonical skill body lives at `skills/crew-captain.body.md`
  (migrate from v0.1's `captain-system.ts` content via the
  v0.1-tui git tag, edit per PRODUCT_VISION.md rules).
- Per-host templates at `skills/targets/{claude-code,codex,gemini}.md.tmpl`.
- `crew install --target {host|all}` writes both the MCP block and
  the skill, resolves absolute crew binary path, runs `host_cli mcp
  list` as a self-test.
- `crew verify` parity-checks installed skill ↔ `listTools` output.
- `crew uninstall` reverses install.

## Manual smoke (deferred to M3)

The "manual smoke in Codex / Claude Code" criterion still requires
hand-editing host configs to point at `dist/index.js serve`. M3's
`crew install` automates this. Until then, the subprocess test +
in-process integration tests cover the wire path.
