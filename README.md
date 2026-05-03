# crew-mcp

> v2 of [crew](https://github.com/chasenstark/crew). An MCP server +
> portable captain skill that turns any AI coding CLI (Claude Code,
> Codex, Gemini) into the orchestrator of a worktree-isolated
> multi-agent crew.

**Status: in development.** v0.2 planned. Not yet installable.

## What this is

v0.1 of crew was a Terminal UI hosting its own captain LLM that
dispatched to Claude Code / Codex / Gemini as workers. v2 inverts
the architecture: crew-mcp is an MCP server you install into your
existing AI coding CLI, plus a captain skill that ships with it.
The host CLI's LLM becomes the captain; crew provides the
orchestration verbs and the playbook.

See:

- [docs/plans/mcp-pivot/PRODUCT_VISION.md](./docs/plans/mcp-pivot/PRODUCT_VISION.md) — the why
- [docs/plans/mcp-pivot/IMPLEMENTATION_PLAN.md](./docs/plans/mcp-pivot/IMPLEMENTATION_PLAN.md) — the how
- [docs/plans/mcp-pivot/HISTORICAL_CONTEXT.md](./docs/plans/mcp-pivot/HISTORICAL_CONTEXT.md) — what came before

## v0.1

Frozen as the [v0.1-tui git tag](https://github.com/chasenstark/crew-mcp/releases/tag/v0.1-tui)
on this repo, and as the entire [crew repo](https://github.com/chasenstark/crew)
in archive form.
