> **Current as of 2026-08-27.**

# Captain portability

Captain portability is install-time host wiring. A host adapter owns config
paths, skill paths, MCP-block merging, install scope, detection, and any
host-specific approval instructions.

## Registry and scopes

`src/install/hosts/index.ts` registers three captain hosts:

| Host | Global scope | Project scope |
| --- | --- | --- |
| Claude Code | Yes | Yes |
| Codex | Yes | Yes |
| Antigravity (`agy`) | No | Yes |

`GLOBAL_HOST_IDS` controls global `--target all`. `PROJECT_HOST_IDS` controls
project `--target all`. Antigravity is deliberately absent from the global set
because it loads MCP servers only from a repository-local config.

## Installed paths

| Host | Global config / skill | Project config / skill |
| --- | --- | --- |
| Claude Code | `~/.claude.json` / `~/.claude/skills/<skill>/SKILL.md` | `.mcp.json` / `.claude/skills/<skill>/SKILL.md` |
| Codex | `~/.codex/config.toml` / `~/.codex/skills/<skill>/SKILL.md` | `.codex/config.toml` / `.codex/skills/<skill>/SKILL.md` |
| agy | Not supported | `.agents/mcp_config.json` / `.agents/skills/<skill>/SKILL.md` |

The canonical skill bodies are `skills/crew-captain.body.md`,
`skills/crew-iterate.body.md`, and `skills/crew-pr-watch.body.md`; PR watch
also owns a canonically rendered sibling `ACTION.md`.
`src/install/skill-renderer.ts` injects
host-specific watcher and invocation text without changing the shared
orchestration contract.

## Install lifecycle

`src/cli/commands/install.ts`:

1. resolves requested targets and scope,
2. resolves the Crew server command,
3. renders each skill for the host,
4. merges the `crew` MCP block without replacing unrelated config,
5. applies supported auto-approval settings,
6. writes an install manifest for later verification and uninstall.

Project installs prefer `./node_modules/.bin/crew-mcp serve` and store
repo-relative paths in `.crew/install.project.json`.

Claude Code stores MCP configuration and permission allowlists in separate
files. Codex stores its server block and per-tool approval blocks in TOML.
Antigravity has no config-level approval switch, so project install notes tell
the user to launch `agy --dangerously-skip-permissions`.

## Codex runtime topology

Ordinary Codex 0.149+ sessions can auto-wake through the durable Codex thread
queue. The active thread id is read from MCP request metadata:

```text
_meta.threadId
      or
_meta["x-codex-turn-metadata"].thread_id
```

Conflicting duplicated metadata fails closed. `CODEX_THREAD_ID` remains a
compatibility fallback.

`crew-mcp codex -- <arguments>` is the optional direct-wake topology for Codex
0.144.3+. It creates an authenticated loopback App Server bridge and connects
the visible TUI with `codex --remote`. Its private bridge descriptor reaches
only the Crew MCP server through `CREW_CODEX_BRIDGE_FILE`.

The direct bridge wins when both transports exist. If neither is available,
the captain recovers terminal state on the next user turn.

Every watcher command carries run-generation tokens. At completion,
`crew-wait` revalidates them under run-state locks and takes a durable
per-thread claim before waking the host, preventing stale and duplicate turns.

PR watch resolves and stores a separate exact `crew-pr-watch-wait` command.
Only that observation-only waiter joins Claude's safe allowlist or Codex's
watcher escalation. PR watch has no mutation command in this release.
PR-watch wake claims bind `(thread, watchId, generation)` and reuse the same
queue/App Server transports without changing run-batch claim semantics.
Project verification checks the exact project waiter command.

## Adding a host

1. Implement `HostAdapter` in `src/install/hosts/<name>.ts`.
2. Register it in `src/install/hosts/index.ts` and the correct scope arrays.
3. Add config merge/remove/detection and skill-path tests.
4. Extend install, verify, uninstall, rendered-skill, and catalog-parity tests.
5. Update this document and the user installation guide.

The retired standalone Gemini CLI is not a host. Google's current integration
is Antigravity (`agy`), whose provider models may still carry Gemini names.
