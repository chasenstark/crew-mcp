# Presets

M3 ships a preset surface that lets a captain's behavior be tuned by a
soft-policy `hint` paragraph rendered into the system prompt. The
mechanism is deliberately prompt-only — presets DO NOT touch the
tool-schema hash, so editing a hint between turns does not invalidate
`providerSessionRef` or force a full-message-log replay.

## Shape

In `workflow.yaml`:

```yaml
captain:
  cli: CLAUDE_CODE
  preset: default

presets:
  default:
    description: >-
      General-purpose captain behavior.
    hint: >-
      Prefer running a review pass after implementation. Call `finish`
      when the user's request is addressed. Reach for `ask_user` only
      when you are genuinely blocked.
```

The shipping `default` preset covers the three soft-policy nudges from
the architectural plan §5:

- Prefer running a review for implementation work.
- Call `finish` when the user's request is addressed.
- `ask_user` is for genuine blocks — not for minor clarifications.

## M3 scope

Only the `default` preset is live. The captain-system prompt renders the
matching preset's `hint` verbatim; when `captain.preset` is absent the
section header appears with `(none)` as body. Unknown preset names produce
a soft warning at load time (the loader does not fail); non-default
presets and a `/preset` slash command are M5-scope.

## Invariants

- The `hint` string is prompt material. `ToolCatalog.getToolSchemaHash()`
  does not hash it. A dedicated test
  (`test/captain/tools/catalog.test.ts`: "preset hint changes do not
  affect the schema hash") locks the invariant.
- Preset loading is additive — legacy configs without `presets` /
  `captain.preset` roundtrip cleanly through `serializeWorkflowYaml`.
