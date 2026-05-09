> **Current as of 2026-05-09.**

## Load-bearing source anchors

- Install command and per-host write path: `src/cli/commands/install.ts:130`, `src/cli/commands/install.ts:177`, `src/cli/commands/install.ts:252`, `src/cli/commands/install.ts:274`, `src/cli/commands/install.ts:279`, `src/cli/commands/install.ts:291`.
- Host adapter interface: `src/install/hosts/types.ts:21`, `src/install/hosts/types.ts:28`, `src/install/hosts/types.ts:31`, `src/install/hosts/types.ts:40`.
- Host paths: `src/install/hosts/claude-code.ts:45`, `src/install/hosts/claude-code.ts:46`, `src/install/hosts/codex.ts:80`, `src/install/hosts/codex.ts:81`, `src/install/hosts/gemini.ts:35`, `src/install/hosts/gemini.ts:36`.
- Host registries: `src/install/hosts/index.ts:14`, `src/install/hosts/index.ts:20`.
- Converter helpers: `src/orchestrator/mcp-registration.ts:33`, `src/orchestrator/mcp-registration.ts:55`, `src/orchestrator/mcp-registration.ts:100`, `src/orchestrator/mcp-registration.ts:160`, `src/orchestrator/mcp-registration.ts:217`.
- Converter tests: `test/orchestrator/mcp-registration.test.ts:1`, `test/orchestrator/mcp-registration.test.ts:3`, `test/orchestrator/mcp-registration.test.ts:251`.

# Captain Portability

## Current Framing

Captain portability in v0.2 is install-time host wiring. `installCommand()` is the entry point at `src/cli/commands/install.ts:130`, and it calls `installSingleTarget()` for each selected host at `src/cli/commands/install.ts:177`.

`installSingleTarget()` renders and writes the skill file at `src/cli/commands/install.ts:266` through `src/cli/commands/install.ts:277`, merges the MCP block into the host config at `src/cli/commands/install.ts:279` through `src/cli/commands/install.ts:284`, and applies or clears auto-approval at `src/cli/commands/install.ts:286` through `src/cli/commands/install.ts:302`.

The host adapter contract is `HostAdapter` at `src/install/hosts/types.ts:21`. Host adapters provide `configPath()` at `src/install/hosts/types.ts:28`, `skillPath()` at `src/install/hosts/types.ts:31`, and `mergeMcpBlock()` at `src/install/hosts/types.ts:40`.

## Supported Hosts

The installed host registry maps `claude-code`, `codex`, and `gemini` at `src/install/hosts/index.ts:14` through `src/install/hosts/index.ts:18`; `--target all` enumerates `ALL_HOST_IDS` at `src/install/hosts/index.ts:20`.

| Host | Config path | Skill path | Anchor |
| --- | --- | --- | --- |
| Claude Code | `~/.claude.json` | `~/.claude/skills/crew/SKILL.md` | `src/install/hosts/claude-code.ts:45`, `src/install/hosts/claude-code.ts:46` |
| Codex | `~/.codex/config.toml` with `[mcp_servers.crew]` | `~/.codex/skills/crew/SKILL.md` | `src/install/hosts/codex.ts:80`, `src/install/hosts/codex.ts:81`, `src/install/hosts/codex.ts:44` |
| Gemini CLI | `~/.gemini/settings.json` | `~/.gemini/extensions/crew/SKILL.md` | `src/install/hosts/gemini.ts:35`, `src/install/hosts/gemini.ts:36` |

Claude Code's config merge writes an `mcpServers.crew` block with `command` and `args` at `src/install/hosts/claude-code.ts:48` through `src/install/hosts/claude-code.ts:56`. Codex renders a `[mcp_servers.crew]` block; the header pattern is `src/install/hosts/codex.ts:44`, and the merge path calls `renderCodexBlock()` at `src/install/hosts/codex.ts:83` through `src/install/hosts/codex.ts:85`. Gemini writes an `mcpServers.crew` object at `src/install/hosts/gemini.ts:38` through `src/install/hosts/gemini.ts:46`.

## Legacy Converter Helpers

`src/orchestrator/mcp-registration.ts` still contains converter helpers, but those helpers are not the `crew-mcp serve` install path. Their narrow input shape is the plain `ToolCatalog` interface at `src/orchestrator/mcp-registration.ts:33`.

The retained converter functions are:

| Helper | Shape | Anchor |
| --- | --- | --- |
| `toCodexConfigOverrides()` | `-c mcp_servers.<name>.*=...` argv fragments. | `src/orchestrator/mcp-registration.ts:55` |
| `toClaudeMcpConfigJson()` | Inline Claude MCP JSON. | `src/orchestrator/mcp-registration.ts:100` |
| `toGeminiMcpSettings()` | Gemini settings JSON plus allowed server names. | `src/orchestrator/mcp-registration.ts:217` |
| `resolveCaptainConverter()` | Adapter-name switch over those helper shapes. | `src/orchestrator/mcp-registration.ts:160` |

The tests live under `test/orchestrator/mcp-registration.test.ts`; imports start at `test/orchestrator/mcp-registration.test.ts:1` through `test/orchestrator/mcp-registration.test.ts:8`, and the `resolveCaptainConverter()` coverage starts at `test/orchestrator/mcp-registration.test.ts:251`.

Do not describe these helpers as session-loop attachment. The v0.1 `SessionLoop` runtime has been archived; the current server runtime is `buildCrewMcpServer()` at `src/cli/commands/serve.ts:214`.
