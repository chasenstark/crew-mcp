> **Historical artifact.** Archived 2026-05-09. This document describes v0.1 runtime captain presets; current install-time skill rendering and config-path behavior live in `docs/architecture/config-registry.md` and `docs/architecture/README.md`.

# Presets

A preset is a named bundle of soft-policy nudges for the captain,
rendered into the system prompt of every captain turn. Presets change
the captain's *behavior*, not its tool surface — editing a preset between
turns does NOT invalidate `providerSessionRef` and does NOT force a
full-message-log replay, because the preset is prompt material, never
tool-schema material.

## Shape

```yaml
captain:
  cli: CLAUDE_CODE
  preset: default

presets:
  default:
    description: >-
      General-purpose captain behavior.
    hint: >-
      Calibrate dialogue to the size of the ask. Share a brief plan
      before dispatching for multi-step or larger requests; just do the
      work for trivial, well-specified asks. Use `ask_user` to clarify
      ambiguous intent or align on approach.
    suggested_agent_roles:
      - reviewer
      - coder
```

Four fields total: `name` (implicit — the map key), `description`, `hint`,
`suggested_agent_roles`. The schema is intentionally tiny. Adding
`steps`, `conditions`, `max_passes`, or `max_iterations` was explicitly
rejected in vision §7.5 ("preset format balloons into a workflow DSL");
any future proposal to extend the schema should re-read that risk line.

### `suggested_agent_roles`

Prose role-suggestion hints rendered under the `hint` as
`Suggested roles: reviewer, security`. These are NOT `agent_id` values —
the captain still dispatches to the registered agent adapters via
`list_agents`. Roles that no registered agent claims in its
`strengths` are rendered with a qualifier:
`Suggested roles: reviewer, security (intent — no adapter registered)`.
This prevents the captain from hallucinating
`run_agent(agent_id='security')` for a role that doesn't exist in the
inventory.

## Built-in presets

Three presets ship in `defaults/workflow.yaml`:

- **`default`** — balanced captain behavior. Calibrates dialogue to ask
  size: shares a plan before dispatching for multi-step or larger
  requests, just does the work for trivial asks, uses `ask_user` for
  scope/alignment rather than only when blocked. Runs a review pass
  after implementation work and calls `finish` when the request is
  addressed (and verified, for planned work). This is the preset
  `crew run` uses out of the box.
- **`thorough-review`** — fans out to a second reviewer with a distinct
  perspective after any implementation `run_agent` call. Calls `finish`
  only after at least one review pass. Use when catching regressions
  matters more than shipping quickly.
- **`read-only`** — refuses to dispatch write-capable `run_agent` calls.
  Replies with diffs + prose descriptions of proposed edits and asks
  the user to confirm before proceeding. Use for exploratory analysis
  or when a change isn't pre-approved.

## Mid-session switching

The `/preset` slash command switches presets on the fly:

```text
/preset                Show help and list available presets
/preset list           List declared presets; * marks the active one
/preset show           Show the currently-active preset's details
/preset <name>         Set the session preset (takes effect next turn)
/preset clear          Clear the session override; revert to captain.preset
```

Semantics:

- The switch takes effect on the captain's **next** turn. The current
  turn's system prompt was built at turn-start and is NOT re-rendered.
  Subagents with `run_agent` calls in flight continue unchanged; they
  see their own prompt verbatim and are unaffected by captain-side
  preset swaps.
- The session's `activePreset` **persists across restarts** — the
  session.json snapshot's v2 schema carries the name. Restoring a
  session preserves the override.
- A preset swap does NOT invalidate `providerSessionRef`. Native-resume
  continues as normal.

The configuration path `captain.preset` also supports set-via-CLI:

```bash
crew config set captain.preset thorough-review
# or, interactively:
/config set captain.preset thorough-review
```

The `/preset` path is a session-scoped override; `/config set` edits the
persisted workflow.yaml. When both are set, the session override wins.

## Resolution

`resolveActivePreset` is the single entry point. It reads three inputs
in priority order:

1. `session.activePreset` (from `/preset`) — wins if it names a declared preset
2. `config.captain.preset` (from `workflow.yaml`) — wins if it names a declared preset
3. nothing → the `## Preset hint` section renders `(none)`

An unknown name at either tier logs a throttled warn (once per name)
and falls through to the next tier. Importantly, an unknown
`session.activePreset` does NOT silently fall back to
`config.captain.preset` at the resolver level — the resolver returns
`undefined`, and the runner renders `(none)` for that turn. This is
deliberate: a user who typed `/preset bogus` then cleared the command
should see the captain use no preset (matching their last explicit
choice) rather than silently inheriting a different preset from the
config.

## Unknown-preset handling

- **Config-declared preset name not in `presets`:** preflight logs a
  one-line warn at load time. The run proceeds with `(none)`.
- **Session's persisted preset name no longer in config:** the resolver
  logs a throttled warn once per turn, falls back to `(none)`, and
  **preserves the stored name** for re-materialization. If the user
  re-adds the preset to the config, the session picks it back up on
  the next turn.
- **`/preset <unknown>`:** the handler returns an error message and
  does NOT call `setActivePreset`. The current active preset is left
  alone. Locked by test/cli/ui/preset/command-handler.test.ts.
- **`captain.preset: ""` (literal empty string):** preflight warns and
  treats as "no preset"; the resolver renders `(none)`.

## Storage & schema

- Session snapshots (`session.json`) carry `activePreset` at schema
  version 2. v1 snapshots load cleanly (upgraded in memory to v2 with
  `activePreset: undefined`) and are written back at v2 on next persist.
- `setActivePreset` is synchronous + atomic: it mutates the in-memory
  field, calls `persist()`, and emits a `preset_changed` SessionEvent —
  all in the same tick. A crash between the mutation and the next turn
  cannot leave the session half-updated.
- The event log records `preset_changed` for debuggability; the session
  loop does NOT react to the event — per-turn preset resolution reads
  `session.activePreset` directly at turn start.

## Invariants (locked by tests)

- **`hint` is prompt material, not tool-schema.**
  `ToolCatalog.getToolSchemaHash()` is independent of preset inputs
  entirely (M5-6 removed `preset` from `ToolCatalogInit`). Locked by
  `test/captain/tools/catalog.test.ts`.
- **Preset switches do not invalidate `providerSessionRef`.** Locked
  by `test/captain/session.active-preset.test.ts` and
  `test/captain/judgment-runner.m5-preset.test.ts`.
- **Per-turn resolution reads the CURRENT session.activePreset** each
  turn — a swap mid-run takes effect at the next turn boundary. Locked
  by `test/captain/judgment-runner.m5-preset.test.ts`.
- **`/preset <unknown>` does NOT mutate the session.** Locked by
  `test/cli/ui/preset/command-handler.test.ts`.
- **v1 session snapshots load cleanly.** Locked by
  `test/captain/session-store.test.ts`.
- **Preset schema is exactly four fields.** Adding runtime-consulted
  fields (e.g., `max_iterations`) requires reopening the §7.5
  scope-discipline decision.
