# crew-mcp documentation

The root [README](../README.md) is the fastest way to understand Crew and run
your first dispatch. Use this page when you need setup detail, operating
guidance, or implementation contracts.

```text
documentation
|
|-- start
|   |-- installation
|   |-- agents and models
|   `-- crew-iterate
|
|-- operate
|   |-- configuration
|   `-- operations and troubleshooting
|
`-- understand
    |-- runtime architecture
    |-- MCP tool surface
    |-- adapters
    |-- host portability
    |-- run-state contract
    `-- durable PR watch
```

## Guides

- [Installation](guides/installation.md) — global, source, and project-scoped
  installs; Codex and Antigravity notes; upgrades and uninstalling.
- [Agents and models](guides/agents-and-models.md) — captains versus workers,
  model discovery, exact pins, routing defaults, and local agents.
- [crew-iterate](guides/crew-iterate.md) — criteria-gated implementation and
  review, user confirmation gates, and bounded Claude `/goal` inner loops.
- [Configuration](guides/configuration.md) — interactive and scripted settings,
  cleanup retention, configuration ownership, and useful environment variables.
- [Operations and troubleshooting](guides/operations-and-troubleshooting.md) —
  watchers, live logs, stuck runs, cleanup, and common install failures.

## Architecture and reference

- [Runtime overview](architecture/README.md)
- [MCP tool surface](architecture/tools.md)
- [Adapter contracts](architecture/adapters.md)
- [Captain portability](architecture/captain-portability.md)
- [Config path registry](architecture/config-registry.md)
- [Run-state contract](architecture/run-state-contract.md)
- [Durable PR watch](architecture/pr-watch.md)

Guides explain what users should do. Architecture documents explain how the
runtime enforces those behaviors. Keep detailed claims in one canonical place
and link across that boundary instead of copying them.
