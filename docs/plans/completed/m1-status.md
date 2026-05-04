# M1 Status — Minimal MCP Server

**Status:** shipped (commit `21e3c76`).
**Tag:** none yet (waiting for M2 lifecycle to cut a v0.2.0-alpha).

## What landed

- `crew serve` — stdio MCP server using `@modelcontextprotocol/sdk@^1.29.0`'s
  `McpServer` + `StdioServerTransport`. Registered in `src/index.ts`.
- 2 tools exposed: `list_agents` (synchronous registry probe) and
  `run_agent` (block-and-wait dispatch into a fresh worktree).
- `RunEnvelope` shape: `{ run_id, worktree_path, status, summary, files_changed }`.
- v2 lifecycle boundary enforced in `planRunAgent`: no auto-merge, no
  auto-cleanup. Worktrees persist past dispatch completion.
- SIGINT / SIGTERM handler cancels in-flight dispatches with a 200ms
  grace window, then `process.exit(0)`.
- `buildCrewMcpServer()` extracted as a transport-less seam so tests can
  drive the server in-process via `InMemoryTransport.createLinkedPair()`.

## Tests

- `test/cli/commands/serve.test.ts` (in-process, 9 cases): tool-surface
  shape, schema presence, list_agents structured content, list_agents
  adapter-failure reporting, run_agent unknown-agent error, run_agent
  success envelope (asserts worktree path + project root untouched),
  run_agent failure envelope, dispatcher cancellation surfaces as
  `status: cancelled`.
- `test/cli/commands/serve.subprocess.test.ts` (out-of-process, 1 case):
  spawns `node dist/index.js serve`, drives via `StdioClientTransport`,
  calls `listTools`. Auto-skipped if `dist/` isn't built.

Suite: 411 passed / 3 skipped / 0 failed across 40 files. Lint clean.
Build clean (122 KB ESM bundle).

## Acceptance map (vs IMPLEMENTATION_PLAN.md)

| Criterion | Status |
|---|---|
| `crew serve` runs and stays open on stdio | done |
| Host CLI sees the server via `mcp list` | deferred — needs `crew install` (M3); subprocess test proves the wire path works |
| `list_agents` returns non-empty result | done (in-process test) |
| `run_agent` returns a diff envelope | done (in-process test) |
| `npm test` passes including new MCP integration tests | 411 / 3 skipped / 0 failed |
| Worktrees clean up | **changed scope** — v2 leaves them alive (host CLI owns lifecycle); cancellation surfaces correctly |
| Errors come back as MCP error responses, not crashes | done |

The "cleanup on success" criterion in the original M1 plan was a
v0.1-shaped expectation. v2 explicitly inverts it: the host CLI controls
the worktree lifecycle through `merge_run` and `discard_run` (M2). The
captain skill (M3) instructs the host CLI to ask the user before
either, which is the safety boundary PRODUCT_VISION.md calls out.

## Decisions worth noting

1. **`McpServer` (high-level) over raw `Server`.** The SDK's `McpServer`
   wrapper handles request-handler wiring, JSON-Schema generation from
   Zod, and validation automatically. Saves ~50 lines vs. setting up
   `setRequestHandler(ListToolsRequestSchema, ...)` manually.

2. **No tool-name namespace prefix at the server.** v0.1's
   `mcp__crew__` prefix was for in-process tool routing; the host CLI
   prepends its own `mcp__<server-name>__` automatically based on the
   server's name field. We expose `list_agents` and `run_agent` plain;
   Claude Code surfaces them as `mcp__crew__list_agents` etc.

3. **Test seam via `buildCrewMcpServer()`.** Avoids subprocess overhead
   in 9/10 tests while keeping production code identical to what ships.
   The single subprocess test gates the stdio framing for regressions.

4. **Removed `mergeRunWorktreeResult` from `planRunAgent`.** v0.1's
   captain runtime relied on it; v2 explicitly hands the merge decision
   to the host CLI. The corresponding test flipped polarity ("merges →
   project root" became "no merge → file lives only in worktree").

## Known gaps (carried into M2)

- No `continue_run` — host CLI can't resume a worktree with new
  instructions yet.
- No `merge_run` / `discard_run` — host CLI has no way to explicitly
  end a run's lifecycle.
- No `get_run_status` — long-running dispatches will hit host-CLI
  tool-call timeouts before M2's async-fallback semantics ship.
- No state.json schema for runs — currently the only run state is
  whatever WorktreeManager records about the worktree.
- No host-side install yet — manual smoke testing requires hand-editing
  host CLI configs. M3 fixes this.

## Carry-forward for M2

`run_agent`'s blocking model ("await terminal then return envelope")
needs to grow an async-fallback path: if the dispatch exceeds 60s,
return `{ status: 'running', run_id }` immediately and let the host
poll via `get_run_status`. The dispatcher already separates start from
terminal-event delivery, so this is a serve.ts change, not a
substrate change.

`merge_run` will reuse `WorktreeManager.mergeRunWorktree` which
survives unchanged from v0.1 (it was the underlying primitive the
auto-merge wrapped). `discard_run` reuses `WorktreeManager.cleanupByRunId`.
`get_run_status` will need a new bit of run-state persistence —
`.crew/runs/<runId>/state.json` per the IMPLEMENTATION_PLAN.

`continue_run` reuses the existing worktree (no `createRunWorktree`
call) and dispatches a fresh adapter invocation against the same path.
The dispatcher already supports independent tool-call IDs sharing a
runId.
