# Crew v2 — Implementation Plan

> Pivot from v0.1 (Terminal UI + captain LLM) to v2 (MCP server +
> captain skill installed into the user's existing AI coding CLI).
> See [PRODUCT_VISION.md](./PRODUCT_VISION.md) for the why; this
> document is the how.

---

## Overview

| Milestone | Goal | Deliverable |
|---|---|---|
| M0 | Fork + clean | New repo; v0.1 frozen; dead code removed |
| M1 | Minimal MCP server | `crew serve` with `list_agents` + `run_agent` |
| M2 | Full lifecycle | `continue_run`, `merge_run`, `discard_run`, `get_run_status` |
| M3 | Skill + install | Per-host skill rendering, `crew install`, `crew verify` |
| M4 | Eval + field report | A/B harness, 2 weeks of dogfooding, write-up |

**Total estimated effort: 3–5 weeks of focused part-time work.**

Strict linear dependencies. Each milestone lands cleanly before the
next starts. Resist scope creep within milestones.

---

## M0 — Fork + Cleanup

**Goal:** Two clean repos. v0.1 frozen as a portfolio artifact. v2
fork has dead code removed and structural rename done.

### Scope

**In:**

- Tag v0.1-tui on the original repo
- Add a "what I learned + link to v2" header to v0.1 README
- Fork on GitHub (preserves link)
- Pick a name for v2 (or keep "crew")
- Delete TUI / captain runtime / preset code in visible commits
- Rename `src/captain/` → `src/orchestrator/`
- Cherry-pick what survives unchanged

**Out:**

- Anything new (no new files in M0; only deletions and renames)
- Production-grade tests for new files (none exist yet)

### Tasks

1. **Tag v0.1.** On the original repo:
   ```
   git tag -a v0.1-tui -m "v0.1 — Terminal UI captain; superseded by v2"
   git push origin v0.1-tui
   ```

2. **Update v0.1 README.** Add a single paragraph at the top:
   "This is v0.1 of crew. It hosted a captain LLM in a TUI and
   dispatched to Claude Code / Codex / Gemini as workers. After
   3 weeks of dogfooding I realized the host CLI was already a
   better captain than I could write. v2 inverts the architecture:
   crew is now an MCP server + skill installed into the host CLI.
   See [link]. This repo is preserved as-is for historical context."

3. **Fork on GitHub.** New repo. Same owner. New name (or "crew").

4. **First fork commits, in order.** Each visible in history:
   - `chore: tag from v0.1-tui at <sha>`
   - `chore: README — pivot to MCP + skill (see PRODUCT_VISION.md)`
   - `chore: copy v0.1 docs/plans/ into docs/plans/v0.1-archive/`
   - `chore: delete src/cli/ui/ (TUI retired)`
   - `chore: delete src/captain/judgment-runner.ts and session-* (captain runtime retired)`
   - `chore: delete src/captain/prompts/captain-system.ts (preserved as content into v2 skill)`
   - `chore: delete preset code in src/workflow/, defaults/, src/cli/commands/preset.ts`
   - `chore: delete tests for removed code`
   - `refactor: rename src/captain/ → src/orchestrator/`
   - `refactor: trim src/cli/commands/ to install / serve / verify only`

5. **What survives unchanged (cherry-pick if needed):**
   - `src/adapters/*` — all of it
   - `src/captain/action-server.ts` (rename to `src/orchestrator/action-server.ts`)
   - `src/captain/tools/catalog.ts`, `tools/run-agent.ts`, `tools/list-agents.ts`
   - `src/captain/tool-dispatcher.ts`
   - `src/captain/mcp-registration.ts` (refactored: install-time
     writer instead of per-invocation argv builder — see M3)
   - `src/git/*` — worktree code
   - `src/state/runs/*` (drop `state/session*` — that was captain state)
   - `src/utils/*`, `src/workflow/agents.ts` (registry only — drop
     workflow steps / presets)
   - `src/adapters/types.ts`

6. **Final structure:**
   ```
   src/
   ├── adapters/         # unchanged
   ├── orchestrator/     # was src/captain/, trimmed
   │   ├── action-server.ts
   │   ├── tools/        # only catalog + 6 tool definitions
   │   ├── tool-dispatcher.ts
   │   └── mcp-registration.ts
   ├── cli/
   │   └── commands/
   │       ├── serve.ts     # M1 (new)
   │       ├── install.ts   # M3 (new)
   │       └── verify.ts    # M3 (new)
   ├── git/              # unchanged
   ├── state/
   │   └── runs/         # unchanged
   ├── workflow/
   │   └── agents.ts     # registry only
   └── index.ts
   ```

### Acceptance

- `git tag` shows `v0.1-tui` on original repo
- v0.1 README has the pivot header
- Fork repo exists; first 10 commits are clearly the cleanup history
- `npm run lint` passes on the fork (no broken imports from deletions)
- `npm test` passes for surviving code (with deleted-test files gone)
- `find src -name "*.ts" | wc -l` is roughly 60% of v0.1's count

### Risks

- **Cherry-picking misses a dependency.** Mitigation: `npm run lint`
  after each delete commit; fix in same commit.
- **Renaming `src/captain/` breaks downstream import paths.** All
  internal imports updated in the rename commit; test files updated
  in the same commit.

---

## M1 — Minimal MCP Server

**Goal:** `crew serve` is a working stdio MCP server exposing
`list_agents` and `run_agent`. End-to-end: install the MCP block
manually in `~/.codex/config.toml`, open Codex, call the tool, get
a result.

### Scope

**In:**

- `crew serve` command using `@modelcontextprotocol/sdk`
  `Server` + `StdioServerTransport`
- `list_agents` returning agent registry status
- `run_agent` blocking-but-streaming for one full dispatch
- Worktree creation + cleanup on success
- Per-tool error responses (not crashes)
- Graceful shutdown on SIGINT / SIGTERM

**Out:**

- The other 4 tools (M2)
- Skill rendering or install (M3)
- Async/polling lifecycle (M2)
- Multi-target install (M3)

### Tasks

1. **Add MCP SDK dependency.**
   ```
   npm install @modelcontextprotocol/sdk
   ```

2. **Implement `src/cli/commands/serve.ts`.** Wires:
   - `Server({ name: 'crew', version })` from the SDK
   - `StdioServerTransport()`
   - `setRequestHandler(ListToolsRequestSchema, ...)` →
     `ToolCatalog.listTools()`
   - `setRequestHandler(CallToolRequestSchema, ...)` →
     `ToolDispatcher.dispatch(...)`
   - Top-level error boundary that returns errors as MCP error
     responses, not subprocess crashes
   - Graceful shutdown: SIGINT/SIGTERM → resolve in-flight runs
     with `status: cancelled`, clean up worktrees, exit clean

3. **Trim ToolCatalog to 2 tools.** Temporarily remove the other
   4 from the catalog (they come back in M2). Lets us land M1 with
   a minimal verified surface.

4. **Decide tool-name namespace.** v0.1 uses `mcp__crew__*` prefix
   for in-process registration. In stdio MCP, the server name + tool
   name is what host CLIs see. Drop the prefix at the server (cleaner)
   — host CLIs surface them as `mcp__crew__list_agents` automatically.
   Document the decision in `src/orchestrator/action-server.ts`.

5. **Manual end-to-end smoke test.** Until install is built (M3):
   - Hand-write `[mcp_servers.crew]` block in `~/.codex/config.toml`
     pointing at locally-built `dist/index.js serve`
   - Restart Codex
   - Run `codex mcp list` → confirm crew shows up
   - In a Codex session: "use mcp__crew__list_agents" → see agents
   - "use mcp__crew__run_agent agent_id=claude-code prompt='echo hello'"
     → see worktree spawn, claude run, result return

6. **Tests:**
   - Unit: `Server.listTools()` returns 2 tools with correct shapes
   - Unit: `Server.callTool('list_agents')` returns agents from a
     mock registry
   - Integration: spawn `crew serve` as a subprocess; send MCP
     handshake + listTools over stdio; parse the response
   - Integration: spawn `crew serve`; call `run_agent` with a fake
     adapter; verify worktree creation + result envelope
   - Lifecycle: SIGINT during in-flight run → clean shutdown +
     worktree marked cancelled

### Acceptance

- `crew serve` runs and stays open on stdio
- `codex mcp list` (or Claude Code equivalent) sees the server
- Either CLI can call `list_agents` and get a non-empty result
- Either CLI can call `run_agent` and get back a diff envelope
- `npm test` passes including new MCP integration tests
- Worktrees clean up on success and on SIGINT
- Errors come back as MCP error responses, not subprocess crashes

### Risks

- **MCP SDK version compatibility.** Pin `@modelcontextprotocol/sdk`
  at install time and document the host CLI versions tested against.
- **Stdio framing.** MCP uses Content-Length-framed JSON-RPC. SDK
  handles this; don't roll our own.

---

## M2 — Full Lifecycle

**Goal:** All 6 tools available. Worktree lifecycle (continue,
merge, discard, status) is host-controllable.

### Scope

**In:**

- `continue_run(run_id, prompt)` — resume the same worktree with
  new instructions
- `merge_run(run_id)` — fast-forward or merge-commit the worktree
  back into the host's HEAD; report conflicts
- `discard_run(run_id)` — delete worktree without merging
- `get_run_status(run_id)` — return status + recent log lines
- Run-state schema in `.crew/runs/<id>/state.json`
- Async-fallback semantics for `run_agent`: if dispatch exceeds
  60 s, return `{status: 'running', run_id}` immediately; host polls
  via `get_run_status`

**Out:**

- Skill rendering (M3)
- Install command (M3)
- Multi-host coordination (post-v0.2)

### Tasks

1. **Implement `continue_run`.** Reuse the worktree at
   `.crew/runs/<runId>/worktree/`. Spawn the same agent with new
   prompt + the worktree as cwd. Adapter sees nothing new.

2. **Implement `merge_run`.** Use `simple-git` (already a dep) on
   the host's repo:
   - Fetch the worktree branch
   - Try fast-forward; fall back to merge commit
   - On conflict: report conflicts; keep worktree alive; leave host
     HEAD untouched
   - On success: optionally clean up worktree per
     `defaults.cleanup_on_merge`
   - Refuse merge if host worktree has uncommitted changes (unless
     `force: true` parameter is set)

3. **Implement `discard_run`.** Remove the worktree; mark state as
   discarded. Idempotent.

4. **Implement `get_run_status`.** Read `state.json` + tail
   `events.log`. Useful when the host CLI's tool-call timeout < the
   dispatch duration.

5. **Async fallback in `run_agent`.** Spawn the dispatch in-process;
   race against a 60s timer. If timer fires, return the running-status
   envelope and let the worker continue in-process (host polls via
   `get_run_status`). Worktree state.json is the source of truth.

6. **Run-state schema.** Bump `state.json` schema. Fields:
   ```
   {
     runId, agentId, status,
     startedAt, completedAt?,
     prompts: [{turn, prompt, response, timestamp}],
     filesChanged: [...],
     lastError?,
     mergeStatus?
   }
   ```

7. **Tests:**
   - Unit: each tool's input/output shape
   - Integration: full lifecycle — `run_agent` → `continue_run` →
     `merge_run` cleanly merges
   - Integration: `merge_run` with conflicts returns conflicts and
     leaves HEAD untouched
   - Integration: long-running `run_agent` returns running-status
     after 60s; subsequent `get_run_status` returns final result
   - Concurrency: two simultaneous `run_agent` calls don't collide
   - Edge: `merge_run` refuses with dirty host worktree

### Acceptance

- All 6 tools callable from a host CLI with correct envelopes
- Manual smoke: in Codex, dispatch implementation → continue with fix
  prompt → merge → see commit on host HEAD
- Concurrency smoke: two `run_agent` calls in parallel land in
  separate worktrees; both can be merged independently
- `npm test` passes; integration coverage for each tool

### Risks

- **`merge_run` corner cases.** Branch policies, signed commits, dirty
  host worktree. Document constraints clearly; refuse merge if host
  has uncommitted changes (unless explicitly forced).
- **Async-fallback transcript clarity.** When `run_agent` returns
  early with `running` status, the host CLI's display might confuse
  users. Mitigation: include in the response a clear "still running;
  call `get_run_status` to check" hint.

---

## M3 — Skill + Install + Verify

**Goal:** One-command install on each host. Skill content shipped with
the package, rendered per-host. Verification at install time + via
`crew verify`.

### Scope

**In:**

- Canonical skill body at `skills/crew-captain.body.md`
- Per-host templates at `skills/targets/{claude-code,codex,gemini}.md.tmpl`
- `crew install --target {claude-code,codex,gemini,all}` command
- `crew verify` command — checks installed skill ↔ MCP tools parity
- `crew uninstall --target {...}`
- Absolute-binary-path resolution at install
- Restart-warning UX (if host is detected running)
- Idempotent install (re-runs are safe)
- `~/.crew/install.json` tracks installed targets + version

**Out:**

- Auto-update on `npm update` (post-v0.2)
- Per-project skill installs (post-v0.2)
- Custom skill paths (post-v0.2)

### Tasks

1. **Author the canonical skill body.** Migrate v0.1's
   `captain-system.ts` content into `skills/crew-captain.body.md`,
   editing per the rules in [PRODUCT_VISION.md](./PRODUCT_VISION.md):
   - Drop retired tools
   - Reframe role
   - Add dispatch-vs-inline heuristic up top
   - Add escape-hatch paragraph
   - Add merge-boundary safety rule

2. **Build the per-host templates.** Each ~10–30 lines wrapping the
   body:
   - `claude-code.md.tmpl`: frontmatter (`name`, `description`),
     description tuned for skill auto-match
   - `codex.md.tmpl`: prompt-file frontmatter, opening framing for
     explicit invoke
   - `gemini.md.tmpl`: extension descriptor

3. **Implement `crew install`.** Steps:
   - Resolve absolute path of the `crew` binary (`process.argv[0]` +
     script path; or `which crew`)
   - For each `--target`:
     - Detect host CLI installed + version
     - Read host config; merge in `[mcp_servers.crew]` block (or
       equivalent for that host's format)
     - Render skill from canonical body + target template
     - Write skill to host's skills/prompts directory
     - Verify: `host_cli mcp list` shows crew
   - Detect running host CLIs and print restart warning
   - Update `~/.crew/install.json`

4. **Implement `crew verify`.** Sanity-check parity:
   - For each installed target: read its skill file; extract every
     `mcp__crew__*` tool name reference
   - Compare against `ToolCatalog.listTools()` output
   - Report drift (extra refs, missing refs)
   - Suggest `crew install` to re-sync

5. **Implement `crew uninstall`.** Reverse of install:
   - Remove `[mcp_servers.crew]` block from host config
   - Remove skill file
   - Update `~/.crew/install.json`
   - Idempotent

6. **`crew install --target all` UX.** Detects which hosts are
   installed; installs to detected ones; skips others with a note.

7. **Tests:**
   - Unit: template rendering produces expected shape per host
   - Integration: install into a tmpdir-based fake host config →
     read back the host config + skill file → verify
   - Integration: install + verify happy path
   - Integration: install + manually break the skill → verify reports
     drift correctly
   - Integration: uninstall removes everything install added
   - Idempotency: install twice → same end state

### Acceptance

- `crew install --target codex` writes both files; `codex mcp list`
  sees crew; manual smoke test in Codex confirms the skill auto-loads
  on intent like "have claude implement X"
- Same for `--target claude-code` and `--target gemini`
- `crew verify` passes after install
- `crew uninstall` cleanly removes
- Re-running `crew install` is safe (idempotent)
- `npm test` passes

### Risks

- **Host config-file format quirks.** TOML / JSON / settings.json each
  have their own merge semantics. Use existing libraries (`yaml`,
  `JSON.parse`, plus a small TOML parse/stringify dep for Codex).
  Snapshot-test the merge output.
- **Skill auto-match in Claude Code.** Description text tuning matters
  for whether the skill loads on intent. Iterate after M4 dogfooding.

---

## M4 — Eval + Field Report

**Goal:** A measurable, dogfoodable v0.2.0. The portfolio artifact is
the field report.

### Scope

**In:**

- 20-task fixture spanning easy / medium / hard
- A/B harness: with-skill vs. empty-skill (control)
- Metrics: dispatch decisions, review-pass count, completion rate,
  token spend (approximated via timing + agent reports), wall time
- Two weeks of personal dogfooding on real work
- Field report: `docs/FIELD_REPORT.md` — what worked, what didn't,
  what changed
- v0.2.0 release: tag (publish to npm optional)

**Out:**

- Anything that's not the eval or the report

### Tasks

1. **Build the fixture.** 20 tasks:
   - 5 easy (single-file edits, formatting, simple bug fixes)
   - 10 medium (multi-file features, refactors, test additions)
   - 5 hard (cross-module changes, design ambiguity, large diffs)

   Each task has: a starting repo state, a user prompt, an oracle
   judgment (LLM-judged "did this satisfy the prompt?").

2. **Build the A/B harness.** Run each task twice:
   - With the captain skill loaded
   - With an empty skill (control)

   Both arms use the same MCP server. Both arms record:
   - Number of `run_agent` calls
   - Number of review-style dispatches
   - Wall time
   - Final diff evaluated by oracle
   - Conversation transcript

3. **Run + analyze.** 40 runs total. Aggregate:
   - Completion rate (oracle pass rate)
   - Avg dispatches per task
   - Review-after-implementation rate (proxy for "did the captain
     suggest review?")
   - Token spend ratio (with-skill / control)

4. **Two weeks of dogfooding.** Use crew on real work in real repos.
   Keep a journal. Note frictions, surprises, breakages.

5. **Write the field report.** Sections:
   - The thesis going in
   - The eval design and what it measured
   - The numbers
   - What surprised us
   - What didn't work as expected
   - What we'd change for v0.3
   - Engineering decisions that held up vs. didn't

   This is the portfolio artifact. Aim for ~1500–2500 words. Honest
   about both wins and disappointments.

6. **Release v0.2.0.** Git tag, README update, optionally
   `npm publish`.

### Acceptance

- Eval results + `docs/FIELD_REPORT.md` exist
- v0.2.0 tagged
- Author has used the tool on at least 5 real-work tasks outside the
  fixture and not reverted to v0.1's TUI
- The repo's README points at the field report prominently

### Risks

- **The eval oracle is itself an LLM** and may judge poorly.
  Mitigation: spot-check oracle judgments manually for 10% of runs;
  use a stronger model for the oracle than for the workers if possible.
- **Two weeks isn't enough dogfooding.** Possibly. The field report
  can include "this was the 2-week snapshot; here's what I expect
  from continued use."

---

## What's NOT In Scope (v0.2)

- Web UI (intentionally rejected; the host CLI IS the UI)
- Plugin marketplace (no)
- Cost/token tracking as a feature (eval-only in M4)
- Captain LLM in-process (intentionally retired)
- Persistent captain session (host CLI owns sessions)
- Hosted/cloud version (no)
- API key auth (subscription auth only)
- Parallel multi-agent within a single dispatch
- MCP HTTP transport (stdio only at MVP; HTTP only if a host forces it)
- Auto-update on `npm update`
- Per-project skill installs

---

## Dependency Graph

```
M0 (fork+cleanup) ─→ M1 (serve+2 tools) ─→ M2 (full 6 tools) ─→ M3 (skill+install) ─→ M4 (eval+report)
```

Strictly linear. M0 unblocks everything. M3 depends on the full 6-tool
surface (M2) so the skill can reference them. M4 depends on M3 (you
can't A/B a skill that's not installable).

---

## Estimated Effort

| Milestone | Calendar weeks (part-time) | Focused days |
|---|---|---|
| M0 | 0.5 | 2 |
| M1 | 1 | 4 |
| M2 | 1 | 5 |
| M3 | 1 | 5 |
| M4 | 1.5 | 7 |
| **Total** | **5 weeks part-time** | **~23 days focused** |

For personal-use + portfolio, this is the right shape: 5 calendar
weeks gets a working v0.2 with a field report. The hard cap is M4 —
without the field report, the project is back to "just code" and
loses the portfolio dimension.

---

## Tracking

Per-milestone status pages live at:

- `docs/plans/active/m0-status.md` (during M0)
- `docs/plans/active/m1-status.md` (during M1)
- etc.

Move to `docs/plans/completed/` when the milestone's acceptance is met.
Same milestone discipline as v0.1 with lighter ceremony.

---

## Out-Of-Band Decisions To Make Before M0 Starts

1. **Name for the v2 fork.** Can be deferred to early M0 but blocks
   the fork commit.
2. **npm package name.** If keeping "crew" and the name is taken, pick
   `@chasen/crew` or similar.
3. **Whether to actually `npm publish` v0.2 or keep it install-from-source.**
   For personal use, install-from-source is fine. For portfolio, npm
   publish is a nice-to-have ("you can install my tool with one
   command") but not load-bearing.

These are 30-minute decisions, not week-long ones. Resolve and move on.
