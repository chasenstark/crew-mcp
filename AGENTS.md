# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains production TypeScript code.
- `src/cli/` holds terminal entrypoints and Ink UI (`commands/` and `ui/`).
- `src/orchestrator/` contains pipeline logic and step implementations (`steps/`).
- `src/adapters/` contains agent integrations (Claude Code, Codex, generic).
- `src/workflow/` handles config types/loading/defaults.
- `src/state/` stores workflow persistence logic; `src/git/` manages worktrees.
- `test/` mirrors runtime modules (`test/workflow`, `test/cli`, `test/orchestrator`, etc.).
- `defaults/workflow.yaml` is the default config template used at init.

## Build, Test, and Development Commands
- `npm run build` — bundle with `tsup` into `dist/`.
- `npm run dev` — watch mode build during active development.
- `npm test` — run Vitest in watch mode.
- `npm run test:run` — one-shot test run (CI-style).
- `npm run lint` — TypeScript strict check (`tsc --noEmit`).
- `orchestrator run` — start interactive mode.
- `orchestrator run "<prompt>"` — non-interactive workflow execution.

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
- Config/state lives under `.orchestra/` (project-local) and `~/.orchestra/` (global).
- Do not commit local runtime artifacts or machine-specific state.
- This project uses CLI-based auth for providers; avoid introducing API-key-only workflows unless discussed first.

## Architecture References
- Runner lifecycle/core split: `docs/architecture/runners.md`
- Adapter tool-loop abstractions: `docs/architecture/adapters.md`
- Config path registry contract: `docs/architecture/config-registry.md`
