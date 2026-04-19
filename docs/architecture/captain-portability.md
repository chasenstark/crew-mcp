# Captain portability

Which captain CLIs work, at what version floor, with which
tool-registration mechanism.

## Support matrix

| Captain CLI | Version floor | MCP wiring | Native resume | Notes |
|-------------|---------------|------------|---------------|-------|
| **claude-code** | 1.0.23+ | `--mcp-config <inline-json>` | `stream-json` stateful resume | Inline JSON via `toClaudeMcpConfigJson(catalog)`; no install-time file writes. |
| **codex** | 0.121+ (tested) | `-c mcp_servers.<name>.*=...` argv | `exec resume <id>` | argv flags projected via `toCodexConfigOverrides(catalog)`. |
| **gemini-cli** | 0.20.0+ | `--allowed-mcp-server-names <csv>` + file-based settings.json | `-o stream-json --resume <id>` | Allowed-names per invocation; settings.json kept in sync via preflight + `.crew/config.lock.json`. |
| **generic** | — | none | none | No native MCP wiring; captain can call through `executeWithTools` but the per-invocation MCP payload is ignored. |
| **openai-compatible** | — | none | none | Adapter does not yet participate in MCP registration. |

## The three converters

One source — `ToolCatalog.toMcpRegistrationCatalog()` — drives three
shapes:

- `toCodexConfigOverrides(catalog)` → `string[]` argv fragment.
- `toClaudeMcpConfigJson(catalog)` → `string` inline JSON for
  `--mcp-config`.
- `toGeminiMcpSettings(catalog)` → `{settingsJson, allowedServerNames}`
  for settings regen + per-invocation argv.

`resolveCaptainConverter(adapter.name, catalog)` picks the right shape
per captain. The session-loop attaches the resulting
`McpRegistrationPayload` to `ToolLoopContext.mcpRegistration`. Adapters
extract their own kind; unknown kinds are ignored (defense-in-depth).

## Drift discipline

A parity test in `test/captain/mcp-registration.test.ts` asserts that
adding or removing a server propagates uniformly through all three
converters. A new captain CLI MUST come with:

1. Its own converter sibling (alongside the three above).
2. A `resolveCaptainConverter` branch matching its adapter `name`.
3. A per-adapter argv test that exercises the MCP flag placement.

## Session resume + replay (N9 semantics)

All captain CLIs may reject a stored `providerSessionRef` mid-turn
(version bump, server-side invalidation, etc.). The session-loop handles
this with exactly ONE automatic replay per turn:

1. First rejection → drop the ref, optionally re-probe the CLI version
   tag, retry the turn with full-message-log context.
2. Second consecutive rejection in the same turn → hard failure.

The first post-M3 turn on an existing session is expected to consume
this replay because M3 bumps the tool-schema hash. See
`docs/plans/active/m3-exit-smoke-log.md` for the per-captain matrix.
