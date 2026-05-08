# crew-mcp

> v2 of [crew](https://github.com/chasenstark/crew). An MCP server +
> portable captain skill that turns any AI coding CLI (Claude Code,
> Codex, Gemini) into the orchestrator of a worktree-isolated
> multi-agent crew.

**Status: pre-release (v0.2.0-dev).** Installable from source. Eval +
field report (M4) is the remaining v0.2 milestone.

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

## Install (from source)

```sh
git clone <this repo>
cd crew-mcp
npm install
npm run build
npm link

# Install into one or more host CLIs
crew-mcp install --target codex          # ~/.codex/config.toml + ~/.codex/prompts/crew.md
crew-mcp install --target claude-code    # ~/.claude.json + ~/.claude/skills/crew/SKILL.md
crew-mcp install --target gemini         # ~/.gemini/settings.json + ~/.gemini/extensions/crew/SKILL.md
crew-mcp install --target all            # auto-detects installed hosts

# Verify the install (skill ↔ MCP tool surface parity)
crew-mcp verify

# Reverse it
crew-mcp uninstall --target codex
```

On macOS, dispatch output can open a side Terminal window directly for live
run logs through an optional `crew-tail://` handler. Install it once after
linking; without it, the manual `tail -F` line printed in dispatch output
remains the fallback.

```sh
crew-mcp install-tail-handler
```

Then restart your host CLI session. From inside it, ask things like
"have Claude review this changelog parser" or "send this to Codex" —
the skill loads and `mcp__crew__*` tools become available.

## v0.1

Frozen as the [v0.1-tui git tag](https://github.com/chasenstark/crew-mcp/releases/tag/v0.1-tui)
on this repo, and as the entire [crew repo](https://github.com/chasenstark/crew)
in archive form.
