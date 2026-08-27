> **Current as of 2026-08-27.**

# Config path registry

Crew has two scripted configuration paths:

- server settings in `~/.crew/config.json`, handled directly by
  `src/cli/commands/config.ts`;
- surviving workflow agent defaults, resolved through
  `src/workflow/config-path-registry.ts`.

The interactive `crew-mcp config` TUI edits those settings plus agent
preferences and cleanup retention.

## Direct server settings

`crew-mcp config set` and `unset` handle these server-setting paths directly:

```text
notifications.success
notifications.error
confirmBeforeMerge
iterate.maxRoundsPerEpoch
iterate.maxTotalRounds
prWatch.maxActionableWakes
prWatch.maxActionRounds
prWatch.maxWatchAgeDays
cleanup.prWatchTtlDays
```

The notification and merge paths are booleans. Iteration limits are positive
integers, with `maxTotalRounds >= maxRoundsPerEpoch`; their code-defined
defaults are 3 and 9. Unset restores the corresponding default. Cleanup
retention is edited through the TUI, these direct PR-watch paths, or environment
overrides rather than the workflow registry. `-1` disables maximum watch age or
PR-watch retention; positive wake/round budgets are snapshotted when a watch
starts and bound any later grant.

## Workflow registry contract

Each `ConfigPathDescriptor` declares a public path, examples, matching, reading,
parsing, writing, and optional values. `SUPPORTED_CONFIG_SET_PATHS` is derived
from the descriptor array instead of maintained separately.

The current workflow set is intentionally narrow:

```text
workflow.agentDefaults.iterate.implementer
workflow.agentDefaults.iterate.reviewers
workflow.agentDefaults.iterate.banList
workflow.agentDefaults.panel.reviewers
workflow.agentDefaults.panel.banList
```

Agent-default subcommands write global workflow preferences. Project
`.crew/workflow.yaml` remains a compatibility layer for agent defaults; the
retired v0.1 workflow DSL, presets, runner steps, completion policy, and
role-model surfaces are not supported.

## Consumers

`src/workflow/config-service.ts` uses `resolveConfigPath` for show/set/unset
operations and formats supported-path errors from the registry. The config TUI
uses the same workflow codec while presenting purpose-built screens.

Per-agent `useWhen`, strengths, model, effort, command, and endpoint settings do
not belong to workflow YAML. They live in `~/.crew/agents.json` and are edited
through `crew-mcp agents` or the agent-strengths screen.

## Adding a path

1. Add one descriptor to `CONFIG_PATH_REGISTRY`.
2. Define parse and write behavior without mutating unrelated config.
3. Extend the supported-path and command tests.
4. Update the configuration guide when the path is user-facing.
