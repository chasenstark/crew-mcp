# Installation

Crew installs an MCP server definition and captain skills into a supported host
CLI. Claude Code and Codex support global and project scope. Antigravity
(`agy`) is project-only.

## Requirements

- Node.js 20 or newer
- git
- At least one authenticated captain host: Claude Code or Codex
- Authenticated `gh` CLI with repository access when using PR watch
- Authenticated CircleCI CLI only when `.crew/pr-watch.yaml` enables CircleCI evidence
- macOS is the primary tested platform; the live tail URL handler is macOS-only

## Global install

```sh
npm install -g crew-mcp
crew-mcp install --target all
crew-mcp verify
```

Use a single target when preferred:

```sh
crew-mcp install --target claude-code
crew-mcp install --target codex
```

Restart the host after installation so it reloads its MCP configuration and
skills. `crew-mcp verify` checks the installed configuration, skill rendering,
static tool-catalog parity, and local state probes. It is offline and
repo-independent: it does not execute a provider dispatch or probe GitHub/CI.

## Install from source

```sh
git clone https://github.com/chasenstark/crew-mcp.git
cd crew-mcp
npm install
npm run build
npm link
crew-mcp install --target all
```

## Project-scoped install

Project scope commits portable host configuration and skills to a repository:

```sh
npm install --save-dev crew-mcp
npx crew-mcp install --scope project --target claude-code,codex
git add .mcp.json .claude .codex .crew/install.project.json package.json package-lock.json
```

If the repository ignores `.crew/`, allow `.crew/install.project.json` or add
that marker with `git add -f`.

Project installs call `./node_modules/.bin/crew-mcp serve` by default and write
repo-relative paths to `.crew/install.project.json`. They do not seed global
agent preferences.

After cloning a project-scoped install, each developer runs:

```sh
npm install
npx crew-mcp verify --scope project
```

Project verification requires a non-empty project manifest and enumerates the
exact installed targets. It additionally validates the project PR-watch waiter,
companion skill, trusted commands, and the contained git-common-dir host lock.

Codex loads project `.codex/config.toml` only for trusted repositories. Accept
the trust prompt or add this to `~/.codex/config.toml`:

```toml
[projects."/absolute/path/to/repo"]
trust_level = "trusted"
```

## Antigravity as a captain

Antigravity loads MCP servers only from
`<repo>/.agents/mcp_config.json`, so it has no global target:

```sh
npx crew-mcp install --scope project --target agy
git add .agents .crew/install.project.json package.json package-lock.json
```

Start `agy` inside that repository with
`--dangerously-skip-permissions`. Antigravity has no configuration-level
per-server approval switch.

As a worker, agy is write-capable and cannot enforce read-only access. Crew
therefore routes agy reviews through disposable, non-mergeable snapshot
worktrees.

## Codex completion wake

Crew has two Codex wake transports:

| Launch mode | Minimum Codex | Completion behavior |
| --- | ---: | --- |
| Ordinary `codex` session | 0.149.0 | Queue-backed wake using request thread metadata |
| `crew-mcp codex -- ...` | 0.144.3 | Authenticated direct App Server bridge |

The direct bridge is optional:

```sh
crew-mcp codex -- -C /path/to/project
```

If neither wake transport is available, the captain recovers terminal runs on
the next user turn. Watcher commands pin run generations and take a durable
one-shot claim so stale or duplicate processes do not enqueue duplicate turns.

PR watch uses the same host transports through the separately installed
observation-only `crew-pr-watch-wait` binary. PR watch has no mutation command
in this release. Restart the host after install or upgrade so it loads the
PR-watch tools and companion `ACTION.md`.

## Upgrade

After upgrading the package, refresh the installed skill and tool catalog, then
restart the host:

```sh
npm update -g crew-mcp
crew-mcp install --target all
crew-mcp verify
```

For a source checkout, `npm run refresh` builds, links, and reinstalls all
detected global hosts.

## Uninstall

```sh
crew-mcp uninstall --target claude-code
crew-mcp uninstall --target codex
crew-mcp uninstall --target all
```

Uninstall removes Crew-owned MCP blocks and skills. Run history and preferences
under `~/.crew/` remain available until you remove them separately.
