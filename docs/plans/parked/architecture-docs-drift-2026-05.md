# Architecture docs drift — May 2026 audit

> **PARKED 2026-05-08.** The drift is real and the audit findings
> are accurate, but nobody is currently being misled by the stale
> docs in a way that costs the project — the codebase has moved
> on and the docs are simply behind. Picking this up is ~2–2.5
> days of focused doc rewriting, which is too much to slot in
> opportunistically. Better executed as a single dedicated pass
> than dripped in alongside other work.
>
> **Trigger to revisit:** any of (a) onboarding a new contributor
> who reads these docs and writes code against the fictional
> v0.1 architecture, (b) external linking / publishing of the
> docs (where outdated content has reach beyond the immediate
> contributor), (c) a refactor large enough that the doc
> rewrite can ride along, (d) someone has a focused 2-day block
> to take it on.
>
> **Audit transcript is preserved below** so the next pass can
> grep `file:line` anchors directly rather than re-running the
> codex review. The anchors were correct as of 2026-05-08; some
> may have moved by the time this is unparked, so spot-check
> before trusting.

**Status:** Parked 2026-05-08. **Source:** read-only Codex
review run `d6038a22-8874-4e5c-b363-1c585cfcb43a` (discarded after
findings consumed). **Scope:** every file under
`docs/architecture/`. **Anchor:** the May 2026 v0.2 MCP-server
pivot — production runtime is `crew-mcp serve` building an
`McpServer` + `ToolDispatcher` + `RunStateStore` + `WorktreeManager`,
with the v0.1 captain runtime (`src/captain/*`) removed (per
`src/orchestrator/index.ts:3`).

## Why this plan exists

The architecture docs were written against the v0.1 captain-runtime
shape. The v0.2 MCP-server pivot removed `src/captain/*`,
collapsed the tool surface to seven MCP tools, and moved
preset/wrapper-tool work to host responsibility. Five of the eight
docs (`runners.md`, `session.md`, `presets.md`, `tools.md`,
`captain-portability.md`) describe code paths that no longer
exist; two (`README.md`, `adapters.md`) are partially current;
one (`config-registry.md`) is mostly current with a few stale
spurs. The drift is severe enough that a new contributor reading
these docs would write code against a fictional architecture.

## Source code anchors (live, May 2026)

Confirmed during the audit; treat as the rewrite's ground truth.

- **Production entrypoint:** `buildCrewMcpServer` at
  `src/cli/commands/serve.ts:203` constructs `McpServer`,
  `ToolDispatcher`, `WorktreeManager`, `RunStateStore`.
- **Tool surface (live MCP):** seven tools registered in
  `src/cli/commands/serve.ts` (`run_agent` :380, `merge_run` :417,
  `discard_run` :478, `get_run_status` :510, `cancel_run` :576;
  plus `continue_run`, `list_agents`); install-time parity catalog
  is `CATALOG_TOOLS` in `src/install/tool-catalog.ts:26`.
- **Retired v0.1 surface:** explicit in
  `src/orchestrator/tools/index.ts:7` — `ask_user`, `message_user`,
  `plan_tasks`, `analyze_output`, `compress_context`, `finish` are
  all retired/host-side.
- **Adapters loaded by default:** `src/adapters/registry.ts:190`
  registers Claude Code, Codex, Gemini only. Generic /
  openai-compatible adapters exist but are not in the production
  builtin registry.
- **Run-state schema:** `RunStateV1` in
  `src/orchestrator/run-state.ts:54` (incl. `repoRoot`,
  `readOnly`, `warnings`).
- **Adapter dispatch contract:** `src/adapters/types.ts:191`
  defines `sandbox`, `networkAccess`, `writablePaths` constraints;
  `TaskResult.warnings` at `src/adapters/types.ts:240`.
- **Run dispatch:** `src/orchestrator/tools/run-agent.ts:322`
  calls `adapter.execute()`. Cleanup is **merge/discard-owned** —
  terminal listener at `serve.ts:836` only calls `markTerminal`;
  worktree cleanup happens in `merge_run` (`serve.ts:430`) or
  `discard_run` (`serve.ts:495`).
- **Install-time host wiring:** `src/install/hosts/claude-code.ts:45`
  writes `~/.claude.json` + skill file;
  `src/install/hosts/codex.ts:80` writes
  `[mcp_servers.crew]` into `~/.codex/config.toml`;
  `src/install/hosts/gemini.ts:35` writes
  `~/.gemini/settings.json`.
- **MCP registration converters (still exist, mostly unused at
  runtime):** `src/orchestrator/mcp-registration.ts` —
  `resolveCaptainConverter` :160 referenced in tests + legacy
  tool-loop only. Not on the `crew-mcp serve` path.
- **Catalog lock:** `src/orchestrator/catalog-lock.ts:1` (not
  `src/captain/catalog-lock.ts`).
- **Config path registry:** `src/workflow/config-path-registry.ts`
  with `ConfigPathDescriptor` :21, `SUPPORTED_CONFIG_SET_PATHS`
  :574, `captain.preset` parsing/validation :262/:269.
- **Binary name:** `crew-mcp` (`package.json:6`, `src/index.ts:10`).
  No `crew` binary. Live CLI commands: `serve`, `status`,
  `install`, `verify`, `agents edit`, `uninstall`
  (`src/index.ts:27`).

## Per-doc fix list

Severity: **rewrite** > **major edits** > **edits** > **OK**.
Drift quotes are abbreviated; full quotes in the audit transcript
(captain summary above + run d6038a22 events.log).

### `docs/architecture/README.md` — major edits

- `"crew gives that CLI six verbs"` → seven (incl. `cancel_run`
  at `tool-catalog.ts:33`).
- `"Six of seven are dispatched … list_agents is the only purely
  synchronous one"` — wrong; only `run_agent` / `continue_run`
  start dispatcher work. `merge_run`, `discard_run`,
  `get_run_status`, `cancel_run` are direct server handlers.
- Adapter list: drop generic / openai-compatible from the
  "production registry" framing; note they exist as code but are
  not loaded by `crew-mcp serve` by default.
- Binary references: `crew install …` / `crew agents edit` →
  `crew-mcp install …` / `crew-mcp agents edit`. Sweep all
  occurrences.
- `run_agent` envelope shape: missing `agent_id`,
  `events_log_path`, `tail_command_path`, `tail_command_url`
  (`serve.ts:729`).
- Add: running `get_run_status` payload contract — only `status`,
  `events_tail`, `next_event_line` while running (`serve.ts:1058`).
- Add: `merge_run` `force`, `commit_title`, `commit_body` inputs
  (`src/orchestrator/tools/merge-run.ts:33`).
- OK: install host adapter split is broadly accurate
  (`src/install/hosts/types.ts:21`).

### `docs/architecture/runners.md` — **rewrite or retire**

Describes deleted v0.1 internals:
`src/captain/runner-base.ts`, `src/captain/task-execution-core.ts`,
`Pipeline` (`src/captain/pipeline.ts`), `JudgmentRunner`
(`src/captain/judgment-runner.ts`). None present.
Decision: *retire* unless we want a successor doc describing
the server / dispatcher / store runtime. Recommendation:
**retire**, fold a one-page "current runtime" section into
`README.md`. If a longer arch doc is wanted later, write a fresh
`server-runtime.md` rather than salvaging this file.

### `docs/architecture/adapters.md` — major edits

- Drop the `executeWithTools` framing as the production path;
  current production dispatch is `adapter.execute()` at
  `run-agent.ts:322`. Tool-loop APIs in `adapters/types.ts:139`
  remain optional, but they're not the v0.2 MCP-server path —
  they're a legacy / fallback surface.
- Add the dispatch constraints: `sandbox`, `networkAccess`,
  `writablePaths` set by `run_agent` at `run-agent.ts:327`,
  defined in `adapters/types.ts:191`.
- Add `TaskResult.warnings` (used by read-only dirty-tree probe)
  at `adapters/types.ts:240`.
- OK: `src/adapters/tool-loop/` module list; `decision.ts`,
  `constants.ts`, `transcript.ts`, `controller.ts` all present
  and `ToolLoopDecisionSchema` still uses `tool_call | finish |
  fail` at `decision.ts:47`.
- Add (cross-link): if `noise-filter-at-source.md` lands,
  document the "adapters emit only signal on `task.onOutput`"
  contract here.

### `docs/architecture/session.md` — **rewrite or retire**

Heaviest drift in the set. Describes deleted `src/captain/*`
files: `session.ts`, `session-loop.ts`, `judgment-runner.ts`,
`catalog-lock.ts`, plus retired tool wrappers. The 8-tool
catalog is now seven. There is no current session loop, no
session-scoped preset state, no compression advisory, no
`compress_context`. Decision: *retire*, link the run-lifecycle
material to a new short note in `README.md` or to the
async-first-dispatch material in `long-poll-cost-tuning.md`.

### `docs/architecture/presets.md` — **rewrite or retire**

Describes a runtime captain system prompt that no longer exists,
the `/preset` slash command (no `src/cli/ui` directory), `crew
run` (removed in v0.2 per `src/index.ts:16`), and
`resolveActivePreset` (symbol not present). Tests under
`test/captain/...` and `test/cli/ui/preset/...` paths don't
exist. Decision: *retire*. The remaining live behavior — YAML
parse/serialize for `suggested_agent_roles` at
`src/workflow/config-codec.ts:229` / :377 — and the install-time
preset → skill-rendering at
`src/install/skill-renderer.ts:121` are documentable in 2–3
paragraphs, probably as a section of `config-registry.md` or a
new short `install-time-rendering.md`.

### `docs/architecture/tools.md` — major rewrite

- Catalog count: 8 → 7. Update the headline framing.
- `src/captain/tools/catalog.ts` doesn't exist; replace with
  `serve.ts:230` (live registration) and
  `src/install/tool-catalog.ts:26` (install-time parity).
- Drop documentation for `ask_user`, `message_user`,
  `plan_tasks`, `analyze_output`, `compress_context`, `finish`;
  link to `src/orchestrator/tools/index.ts:7` for the retired-
  tools index. (Replace prose with a short "v0.2 retired this
  surface" note.)
- `run_agent` lifecycle: terminal listener marks state only,
  cleanup is merge/discard-owned. Match the wording in the
  current `README.md` rewrite.
- `ToolCatalog.toolNames()` reference is stale — point at
  `CATALOG_TOOLS` in `src/install/tool-catalog.ts:26`.
- "Adding a tool" section needs a rewrite: today's flow touches
  `src/cli/commands/serve.ts`, `src/orchestrator/tools/`, and
  `src/install/tool-catalog.ts`. No `judgment-runner.ts`
  involvement.
- Add: `continue_run`'s `model` and `effort` inputs
  (`continue-run.ts:17`) and `get_run_status.max_events_tail`
  default 10 / cap 500 (`get-run-status.ts:34, 42`).

### `docs/architecture/config-registry.md` — edits

- `src/cli/ui/config/command-handler.ts` /
  `command-parser.ts` references stale (no `src/cli/ui` dir, no
  `config` command in `src/index.ts:27`). Either remove the
  command-side material or rewrite to describe the
  programmatic / install-time consumers of the registry.
- `captain.preset` parsing also validates against declared
  presets (`config-path-registry.ts:262/:269`); add the
  validation fact + the test at
  `test/workflow/config-path-registry.test.ts:54`.
- Drop the "session-scoped current value" framing — there is no
  current session-scoped preset state; options only include the
  current config value at
  `config-path-registry.ts:284`.
- Add: list the full supported path set (`captain.model`,
  agent adapter/model/command/args/strengths, workflow step
  agents, retry) — the canonical list is locked by
  `test/workflow/config-path-registry.test.ts:11`.
- OK: `ConfigPathDescriptor` shape and
  `SUPPORTED_CONFIG_SET_PATHS` derivation; preserve.

### `docs/architecture/captain-portability.md` — major edits

- Reframe: today's host wiring is **install-time file writes**,
  not per-invocation argv injection. The `--mcp-config` /
  `-c mcp_servers.<name>.*=…` / `--allowed-mcp-server-names`
  paths described are mostly legacy seams used by tests / the
  legacy tool-loop, not the v0.2 production install path.
- `claude-code` writes `~/.claude.json` + skill file at
  `src/install/hosts/claude-code.ts:45`.
- `codex` writes `[mcp_servers.crew]` into
  `~/.codex/config.toml` at `src/install/hosts/codex.ts:80`.
- `gemini-cli` writes `~/.gemini/settings.json` at
  `src/install/hosts/gemini.ts:35`. Drop references to
  `src/cli/runtime/preflight.ts` (not present).
- `ToolCatalog.toMcpRegistrationCatalog()` doesn't exist —
  current converter input is the plain `ToolCatalog` interface
  at `src/orchestrator/mcp-registration.ts:33`.
- Drop the "session-loop attaches McpRegistrationPayload"
  framing — no session loop. `resolveCaptainConverter`
  (`mcp-registration.ts:160`) lives but is referenced only in
  tests and the legacy tool-loop, not `crew-mcp serve`.
- Test path: `test/captain/mcp-registration.test.ts` →
  `test/orchestrator/mcp-registration.test.ts:1`.
- Drop "Session resume + replay (N9 semantics)" — no
  `SessionLoop` / replay implementation present.
- OK: the three converter functions exist at
  `mcp-registration.ts:55, :100, :217`. Worth keeping a short
  section explaining what they're for if/when an adapter wants
  to bypass install-time wiring.

## Top priorities (ranked by user impact)

1. **`tools.md` + `README.md` tool count and shapes.** Public
   contract surface; readers writing host integrations will copy
   wrong shapes. Highest blast radius.
2. **Retire `session.md` + `runners.md`** (or replace with a
   single short server-runtime doc). They actively mislead by
   describing deleted `src/captain/*` runtime internals as if
   they were current.
3. **`captain-portability.md` install-time vs per-invocation
   wiring.** Anyone writing a new host adapter today reads this
   and gets the wrong mental model.
4. **`presets.md` retire or shrink.** `/preset`, `crew run`,
   captain sessions, prompt-rendered presets — all gone in v0.2.
5. **`README.md` lifecycle semantics.** Async-first dispatch
   payloads, explicit merge cleanup, `get_run_status` cursor
   behavior — these are the highest-frequency captain-side
   contracts and the doc still describes the old shape.

`adapters.md` and `config-registry.md` are last priority — both
have material that's still accurate; surgical edits suffice.

## Sequencing

Recommend three landing PRs:

1. **PR A — retirements + headline rewrites.** Delete or
   skeleton-rewrite `session.md`, `runners.md`, `presets.md`.
   Rewrite `README.md` headline + tool count + lifecycle.
   Highest user-impact, lowest churn (mostly deletions).
2. **PR B — surface-area corrections.** `tools.md`,
   `captain-portability.md` rewrites against the live source
   anchors. Cross-link from `README.md` to these.
3. **PR C — surgical edits.** `adapters.md`,
   `config-registry.md` edits. Add the dispatch-constraint
   material in `adapters.md`; widen the supported-path
   coverage in `config-registry.md`.

Optionally a PR D after `noise-filter-at-source.md` lands to
add the "adapters emit only signal" rule to `adapters.md`.

## Risk

- **Low.** This is documentation. The risk is making the new
  docs equally drift-prone. Mitigation: every concrete claim
  should carry a `file:line` anchor (as the audit transcript
  itself did). A future drift audit becomes a grep job rather
  than a re-read.
- **Test coverage:** the only test we should add is a doc-link /
  anchor sanity check (e.g., `pnpm docs:check` that greps for
  `src/captain/` references and fails — since `src/captain/` is
  fully retired). Catches regressions cheaply.
- **Recommended convention:** every architecture doc should
  start with a date-stamped "current as of" line and a list of
  load-bearing source anchors at the top, mirroring the style
  of plan files. Makes the next audit trivial.

## Validation plan

1. After PR A merges, re-run a smaller-scope codex audit (just
   the rewritten files) and confirm no remaining drift.
2. After PR B / C, repeat once more across the full set.
3. Add the `src/captain/` grep guard to CI.

## Effort

- PR A: ~half-day (mostly deletions + a rewritten `README.md`
  intro).
- PR B: ~1 day (`tools.md` + `captain-portability.md` rewrites
  with anchored claims).
- PR C: ~half-day (surgical edits).
- Optional: ~1–2 hours to add the `src/captain/` grep guard.

Total ~2–2.5 days for a full sweep that puts every architecture
doc back in sync with the live tree.

## Open questions

- Do we keep `runners.md` and `session.md` as historical
  artifacts under `docs/plans/v0.1-archive/`? The v0.2 retirement
  is a significant moment in the project; a "what changed and
  why" archive doc is cheap to keep. Recommend yes — move them
  rather than deleting outright. Add a one-line README at the
  archive root.
- Should architecture docs live alongside the code they describe
  (e.g., `src/orchestrator/README.md`)? Reduces drift by
  proximity. Out of scope for this plan but worth raising once
  the rewrite settles.
