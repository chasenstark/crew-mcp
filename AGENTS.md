# Repository Guidelines

## General Practices
There are no production users, so we do not have to worry about being backward compatible.

## Project Structure & Module Organization
- `src/` contains production TypeScript code.
- `src/cli/` holds terminal entrypoints and Ink UI (`commands/` and `ui/`).
- `src/captain/` contains the captain runtime:
  - `tools/` — M3 tool surface (catalog.ts + 8 tools); the single source of
    truth fed to each captain CLI via `mcp-registration.ts`.
  - `prompts/captain-system.ts` — the captain system prompt renderer.
  - `session.ts`, `session-loop.ts`, `session-store.ts`,
    `tool-dispatcher.ts` — durable conversation + event loop + dispatcher.
  - `mcp-registration.ts` — Claude / Gemini / Codex argv converters.
  - `catalog-lock.ts` — `.crew/config.lock.json` cache for Gemini settings regen.
  - `judgment-runner.ts` — the production runner (M3 tool surface default).
  - `steps/` — legacy step helpers still wrapped by `plan_tasks` /
    `analyze_output` / `compress_context` tools; the deprecated
    `judge.ts` / `dispatch.ts` survive as backing for `toolSurface: 'legacy'`.
- `src/adapters/` contains agent integrations (Claude Code, Codex, Gemini,
  generic, openai-compatible).
- `src/workflow/` handles config types/loading/defaults (PresetConfig +
  captain.preset live here).
- `src/state/` stores workflow persistence logic (schema v5 — v4-to-v5
  migration in `migrations/`); `src/git/` manages worktrees (per-run layout
  under `.crew/runs/<runId>/worktree/`).
- `test/` mirrors runtime modules (`test/workflow`, `test/cli`, `test/captain`, etc.).
- `test/fixtures/captain/fake-adapter.ts` — reusable fake captain for
  end-to-end tests.
- `defaults/workflow.yaml` is the default config template used at init.

### Adding a new captain tool
1. Add a new file under `src/captain/tools/` with the zod input schema +
   handler signature (pattern: `src/captain/tools/run-agent.ts`).
2. Register the action-catalog entry in `src/captain/tools/catalog.ts`
   (update `M3_TOOL_NAMES` + `DESCRIPTIONS` + `INPUT_SCHEMAS`).
3. Wire the scheduler branch in
   `src/captain/judgment-runner.ts:buildM3SessionLoopPair` if the tool
   needs dispatcher lifecycle (long-running) or session mutation.
4. Add a tool-specific test under `test/captain/tools/` and a catalog
   test that asserts it's exposed via `toActionCatalog()`.

### Adding a new captain CLI
1. Add an adapter under `src/adapters/<name>.ts` implementing
   `AgentAdapter.executeWithTools` + honoring
   `ToolLoopContext.mcpRegistration`.
2. Add the CLI-specific converter in `src/captain/mcp-registration.ts`
   (alongside `toClaudeMcpConfigJson` / `toGeminiMcpSettings` /
   `toCodexConfigOverrides`).
3. Extend `resolveCaptainConverter` so session-loop picks the right
   payload shape for the adapter's `name` field.
4. Add adapter MCP argv tests under `test/adapters/<name>.mcp.test.ts`.

## Build, Test, and Development Commands
- `npm run build` — bundle with `tsup` into `dist/`.
- `npm run dev` — watch mode build during active development.
- `npm test` — run Vitest in watch mode.
- `npm run test:run` — one-shot test run (CI-style).
- `npm run lint` — TypeScript strict check (`tsc --noEmit`).
- `crew run` — start interactive mode.
- `crew run "<prompt>"` — non-interactive workflow execution.

## Coding Style & Naming Conventions
- Language: TypeScript (ESM), strict mode enabled in `tsconfig.json`.
- Use 2-space indentation, semicolons, and single quotes.
- Keep imports explicit with `.js` extension in TS source (existing project pattern).
- Naming:
  - `camelCase` for variables/functions.
  - `PascalCase` for React/Ink components.
  - kebab-case filenames for most modules (for example `step-status.ts`).
- Keep functions small and composable; centralize shared logic in `src/utils/` or domain modules.

## Testing Guidelines
- Framework: Vitest (`vitest` + `ink-testing-library` for UI components).
- Test files use `*.test.ts` / `*.test.tsx` and should mirror source paths.
- Add tests for new behavior and regressions, especially around pipeline state, config loading, and CLI/UI command handling.
- Run `npm run test:run && npm run lint` before opening a PR.

## Commit & Pull Request Guidelines
- Prefer concise, imperative commit subjects. Conventional prefixes are encouraged (for example `feat(cli): ...`, `fix(workflow): ...`).
- Keep commits scoped to one logical change.
- PRs should include:
  - Problem summary and approach.
  - Key files changed.
  - Test evidence (`npm run test:run`, `npm run lint`).
  - Terminal screenshots or output snippets for CLI/UI behavior changes.

## Configuration & Safety Notes
- Config/state lives under `.crew/` (project-local) and `~/.crew/` (global).
- Do not commit local runtime artifacts or machine-specific state.
- This project uses CLI-based auth for providers; avoid introducing API-key-only workflows unless discussed first.

## Architecture References
- Runner lifecycle/core split: `docs/architecture/runners.md`
- Adapter tool-loop abstractions: `docs/architecture/adapters.md`
- Config path registry contract: `docs/architecture/config-registry.md`
