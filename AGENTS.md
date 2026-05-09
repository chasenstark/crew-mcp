> **Current as of 2026-05-09.**

# Repository Guidelines

## General Practices
There are no production users, so we do not have to worry about being backward compatible.

## Status Baseline Maintenance
- Keep `docs/status/captain-flow-review-2026-04-29.md` current as the durable
  baseline for captain-flow state, responsiveness work, smoke evidence, and
  next priorities.
- Before starting substantial work on the MCP server runtime, adapters,
  dispatch lifecycle, progress reporting, MCP/tool-loop behavior, or related
  architecture docs, read that status file and reconcile the work against its
  current findings.
- Update the status file in the same change when work materially changes any of
  its claims, priority ordering, verification snapshot, smoke-test evidence, or
  documented risks. Prefer dated notes or clearly labeled replacements so old
  context remains distinguishable from the current state.
- If a change intentionally leaves the status file stale, call that out in the
  PR or handoff with the reason and the follow-up needed.

## Project Structure & Module Organization
- `src/` contains production TypeScript code.
- `src/index.ts` defines the `crew-mcp` binary and the live command surface:
  `serve`, `status`, `install`, `install-tail-handler`, `verify`,
  `agents edit`, and `uninstall`. The old v0.1 `crew run`, `init`,
  `config`, `profile`, `state reset`, and `resume` commands are retired.
- `src/cli/` holds command entrypoints in `commands/` plus
  `step-status.ts`. There is no Ink UI or `src/cli/ui/` tree.
- `src/orchestrator/` owns the MCP tool schemas/barrel, dispatcher-facing
  tool implementations, run state, event filtering, catalog lock helpers, and
  legacy MCP registration converters. Production dispatch for `run_agent`
  uses `adapter.execute()`; `executeWithTools` is a legacy/fallback path.
- `src/orchestrator/tools/` is the seven-tool surface:
  `list_agents`, `run_agent`, `continue_run`, `merge_run`, `discard_run`,
  `get_run_status`, and `cancel_run`. The retired v0.1 tools
  `ask_user`, `message_user`, `finish`, `plan_tasks`, `analyze_output`, and
  `compress_context` are documented in `src/orchestrator/tools/index.ts:6`
  through `src/orchestrator/tools/index.ts:8`.
- `src/install/` handles install-time host wiring: host adapters under
  `hosts/`, skill rendering, install manifests, binary resolution, interactive
  target selection, and tool-catalog parity for `crew-mcp install` /
  `crew-mcp verify`.
- `src/adapters/` contains agent integrations (Claude Code, Codex, Gemini,
  generic, openai-compatible) plus legacy tool-loop abstractions.
- `src/agent-prefs/` stores per-machine agent preferences, and
  `src/provider-session.ts` contains provider session compatibility helpers.
- `src/workflow/` handles workflow config types, loading, defaults, codecs,
  and config path registry logic.
- `src/git/` manages worktrees for per-run isolation under
  `.crew/runs/<runId>/worktree/`.
- `src/utils/` contains shared utilities such as logging and filesystem
  helpers.
- `test/` mirrors runtime modules (`test/orchestrator`, `test/install`,
  `test/cli`, `test/adapters`, `test/workflow`, etc.). The lingering
  `test/fixtures/captain/fake-adapter.ts` fixture remains for legacy
  tool-loop tests, not because `src/captain/` still exists.
- `defaults/workflow.yaml` is the default workflow config template.

### Adding a new MCP tool
Follow `docs/architecture/tools.md` for the full contract. The short version:

1. Add or update the tool implementation under `src/orchestrator/tools/`.
2. Register the live MCP handler in `src/cli/commands/serve.ts`.
3. Add the install-time parity entry to `CATALOG_TOOLS` in
   `src/install/tool-catalog.ts`.
4. Extend `test/install/tool-catalog.test.ts` so the live server and static
   install catalog stay aligned.

### Adding a new host adapter
Follow `docs/architecture/captain-portability.md` for install-time host
wiring. The short version:

1. Add `src/install/hosts/<name>.ts` implementing `HostAdapter`.
2. Register the adapter in `src/install/hosts/index.ts` and include it in the
   relevant target lists.
3. Add or update tests covering config path, skill path, MCP block merge, and
   catalog/skill parity behavior for that host.

## Build, Test, and Development Commands
- `npm run build` - bundle with `tsup` into `dist/`.
- `npm run dev` - watch mode build during active development.
- `npm test` - run Vitest.
- `npm run test:run` - one-shot Vitest run (CI-style).
- `npm run lint` - TypeScript strict check (`tsc --noEmit`).
- `npm run refresh` - build, `npm link`, and reinstall Crew into all supported
  hosts with `crew-mcp install -t all`.
- `crew-mcp serve` - run the stdio MCP server used by host CLIs.
- `crew-mcp install -t <host|all>` - install the MCP server and skill into a
  supported host CLI.
- `crew-mcp verify` - check installed skill and MCP tool catalog parity.

## Coding Style & Naming Conventions
- Language: TypeScript (ESM), strict mode enabled in `tsconfig.json`.
- Use 2-space indentation, semicolons, and single quotes.
- Keep imports explicit with `.js` extension in TS source (existing project pattern).
- Naming:
  - `camelCase` for variables/functions.
  - `PascalCase` for types, interfaces, and classes.
  - kebab-case filenames for most modules (for example `step-status.ts`).
- Keep functions small and composable; centralize shared logic in `src/utils/`
  or domain modules.

## Testing Guidelines
- Framework: Vitest.
- Test files use `*.test.ts` and should mirror source paths.
- Add tests for new behavior and regressions, especially around MCP tool
  schema stability, install-time catalog parity, host config rendering, config
  loading, adapter dispatch, and CLI command handling.
- Run `npm run test:run && npm run lint` before opening a PR.

## Commit & Pull Request Guidelines
- Prefer concise, imperative commit subjects. Conventional prefixes are encouraged (for example `feat(cli): ...`, `fix(workflow): ...`).
- Keep commits scoped to one logical change.
- PRs should include:
  - Problem summary and approach.
  - Key files changed.
  - Test evidence (`npm run test:run`, `npm run lint`).
  - Terminal screenshots or output snippets for CLI behavior changes.

## Configuration & Safety Notes
- Config/state lives under `.crew/` (project-local) and `~/.crew/` (global).
- Do not commit local runtime artifacts or machine-specific state.
- This project uses CLI-based auth for providers; avoid introducing API-key-only workflows unless discussed first.

## Architecture References
- Runtime overview and current command/tool anchors:
  `docs/architecture/README.md`
- MCP tool surface and add-a-tool workflow:
  `docs/architecture/tools.md`
- Adapter dispatch and legacy tool-loop abstractions:
  `docs/architecture/adapters.md`
- Install-time host wiring and legacy converter helpers:
  `docs/architecture/captain-portability.md`
- Workflow config path registry contract:
  `docs/architecture/config-registry.md`
- Historical v0.1 runner/session context:
  `docs/plans/v0.1-archive/`
