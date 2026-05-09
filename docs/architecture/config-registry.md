> **Current as of 2026-05-09.**

## Load-bearing source anchors

- Descriptor contract: `src/workflow/config-path-registry.ts:21`, `src/workflow/config-path-registry.ts:32`, `src/workflow/config-path-registry.ts:33`.
- Supported path export: `src/workflow/config-path-registry.ts:574`, `test/workflow/config-path-registry.test.ts:11`.
- Config service consumers: `src/workflow/config-service.ts:20`, `src/workflow/config-service.ts:125`, `src/workflow/config-service.ts:225`, `src/workflow/config-service.ts:257`.
- `captain.preset` path: `src/workflow/config-path-registry.ts:255`, `src/workflow/config-path-registry.ts:262`, `src/workflow/config-path-registry.ts:268`, `src/workflow/config-path-registry.ts:284`.
- `captain.preset` tests: `test/workflow/config-path-registry.test.ts:28`, `test/workflow/config-path-registry.test.ts:54`, `test/workflow/config-path-registry.test.ts:78`.

# Config Path Registry

## Registry Contract

Config set-path behavior is centralized in `src/workflow/config-path-registry.ts`. Each `ConfigPathDescriptor` declares `path`, `examples`, `match`, `read`, `parse`, `write`, and `options` at `src/workflow/config-path-registry.ts:21` through `src/workflow/config-path-registry.ts:33`.

`SUPPORTED_CONFIG_SET_PATHS` is derived from the registry at `src/workflow/config-path-registry.ts:574`. The canonical supported set is locked by `test/workflow/config-path-registry.test.ts:11` through `test/workflow/config-path-registry.test.ts:25`:

```text
captain.cli
captain.model
captain.preset
workflow.execution.mode
workflow.roleModels.<role>
agents.<name>.adapter
agents.<name>.model
agents.<name>.command
agents.<name>.args
agents.<name>.strengths
workflow.steps.<role>.agents
workflow.reviewer.maxPasses
errorHandling.default.retry
```

## Consumers

`config-service.ts` imports `resolveConfigPath` and `SUPPORTED_CONFIG_SET_PATHS` at `src/workflow/config-service.ts:18` through `src/workflow/config-service.ts:22`. Unsupported-path errors render the supported set and examples at `src/workflow/config-service.ts:124` through `src/workflow/config-service.ts:130`.

Option lookup is programmatic: `getConfigValueOptions()` resolves the descriptor and calls `descriptor.options()` at `src/workflow/config-service.ts:225` through `src/workflow/config-service.ts:228`.

Patch application is programmatic: `applyConfigPatch()` resolves the descriptor, parses the raw value through `descriptor.parse()`, and writes through `descriptor.write()` at `src/workflow/config-service.ts:257` through `src/workflow/config-service.ts:265`.

There is no live `src/cli/ui/config` consumer in v0.2; the v0.2 CLI command list is `serve`, `status`, `install`, `install-tail-handler`, `verify`, `agents edit`, and `uninstall` in `src/index.ts:28`, `src/index.ts:36`, `src/index.ts:44`, `src/index.ts:68`, `src/index.ts:90`, `src/index.ts:101`, and `src/index.ts:114`.

## `captain.preset`

`captain.preset` is a registered path at `src/workflow/config-path-registry.ts:255`. Its parser first requires a non-empty string at `src/workflow/config-path-registry.ts:262` through `src/workflow/config-path-registry.ts:263`.

When `config.presets` declares names, `captain.preset` validation rejects unknown names. The declared-name check starts at `src/workflow/config-path-registry.ts:268`, and the error branch is `src/workflow/config-path-registry.ts:269` through `src/workflow/config-path-registry.ts:277`.

The options list is not session-scoped. It sorts declared presets and includes the current config value through `withCurrentOption()` at `src/workflow/config-path-registry.ts:284` through `src/workflow/config-path-registry.ts:287`.

The tests cover parse/write at `test/workflow/config-path-registry.test.ts:28`, rejection of undeclared names at `test/workflow/config-path-registry.test.ts:54`, and options including declared presets plus the current value at `test/workflow/config-path-registry.test.ts:78`.

## Adding A Path

Add one descriptor to `CONFIG_PATH_REGISTRY`; the registry derives `SUPPORTED_CONFIG_SET_PATHS` at `src/workflow/config-path-registry.ts:574`. Add or update tests next to the supported-list assertion at `test/workflow/config-path-registry.test.ts:11`.
