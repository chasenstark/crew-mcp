# Config Path Registry

## Overview
Config set-path behavior is now declarative and centralized in:

- `src/workflow/config-path-registry.ts`

Each descriptor defines:

- `match(path)`
- `read(config, params)`
- `parse(raw, config, params, path)`
- `write(config, params, value, path)`
- `options(config, params)`
- `examples`

`SUPPORTED_CONFIG_SET_PATHS` is derived from the registry instead of being manually duplicated.

## Consumers

- `src/workflow/config-service.ts`
  - Uses registry for read/write/parse/options and path resolution
- `src/cli/ui/config/command-handler.ts`
  - Uses registry examples for help text
- `src/cli/ui/config/command-parser.ts`
  - Uses registry resolution to reject unsupported paths early

## Extension Points

1. Add a new `/config set` path
- Add one descriptor in `config-path-registry.ts`
- Add/adjust tests in `test/workflow/config-path-registry.test.ts`

2. Add path-specific validation/options
- Implement in descriptor `parse` and `options`
- No service-level branching required
