# Interactive `crew-mcp config` TUI — agent-defaults submenu

**Status:** Implemented 2026-05-26 in crew worktree; pending anchor
commit.
**Implementation note 2026-05-26:** Move this plan to
`docs/plans/completed/` and replace this note with the standard shipped
header after the captain lands the anchor commit.
**Predecessor:** `iterate-panel-agent-defaults.md` (merged as `4fa43b3`).
That plan shipped `workflow.agentDefaults` config + the
`get_crew_preferences` MCP tool + CLI `config set/show/unset` access.
This plan closes the gap: the interactive `crew-mcp config` TUI still
only surfaces 3 boolean toggles; the new agent-default keys are
CLI-only.

## Why

`crew-mcp config` (no subcommand) opens a hand-rolled TUI built around
ONE input primitive — a boolean checkbox toggled with space. Agent
defaults need different input types:

- `iterate.implementer`: **single-select** from `list_agents` (plus a
  "(unset)" option to fall back to the heuristic).
- `iterate.reviewers` / `panel.reviewers`: **multi-select** subset of
  `list_agents`, order-preserving (preference order matters).
- `iterate.banList` / `panel.banList`: **multi-select** subset of
  `list_agents`; never auto-pick these.

The fix is small in concept (add input primitives, add a submenu) but
non-trivial in code because the current TUI is a flat list. Doing it
right means a generic screen-stack so future config types compose
the same way.

## What

Three layers, shipped in order. Each layer is independently mergeable.

### Layer 1 — Generalize the TUI from "flat checkbox list" to "screen stack"

The current TUI assumes one screen (the checkbox list) and exits on
`enter`. Replace with a stack-of-screens model:

- A **screen** is `{ render(): string[]; onKey(key): KeyResult }` where
  `KeyResult` is `'continue' | 'pop' | 'save' | 'cancel' | { push: Screen }`.
- The driver maintains a screen stack; top-of-stack handles keypresses.
- `pop` returns control to the parent screen (preserving its cursor).
- `save` and `cancel` exit the whole TUI, same as today.
- The existing checkbox-list screen becomes the root screen with one
  new entry (see Layer 2). Other screens are pushed onto it.

**Files touched:**
- `src/cli/commands/config.ts` — refactor `driveTui` to drive a stack
  rather than a single list. Existing `buildEntries()` and the
  3-toggle behavior preserved byte-identical from the user's
  perspective.
- New: `src/cli/commands/config-tui/screen.ts` — `Screen` interface +
  `KeyResult` type.
- New: `src/cli/commands/config-tui/checkbox-list-screen.ts` — extract
  the existing checkbox-list rendering/keys into a Screen
  implementation. The root TUI builds one of these for the boolean
  toggles.

**Tests:**
- `test/cli/commands/config.test.ts` — extend with a TUI driver harness
  that feeds keypress sequences and asserts saved state. Existing
  3-toggle behavior must round-trip identically (regression guard).
- New test seam: `driveTui({ stdin, stdout, screens, state })` exposes
  the screen stack so tests can `push` a screen programmatically.

**Why this layer first:** without the stack abstraction, Layer 2 would
have to special-case every new input type into the keypress switch.
The stack is the load-bearing simplification.

### Layer 2 — Submenu entry + agent-default screens

Add ONE new entry to the root checkbox list: `Agent defaults...` (a
non-toggle entry). Pressing `enter` (or `space`) on it pushes the
**agent-defaults submenu screen** — itself a list with 5 entries:

```
> Agent defaults
   iterate.implementer       <agent_id | (unset)>
   iterate.reviewers         <comma-separated list | (empty)>
   iterate.banList           <comma-separated list | (empty)>
   panel.reviewers           <comma-separated list | (empty)>
   panel.banList             <comma-separated list | (empty)>
   back
```

Each agent-default entry, when activated, pushes one of two screens:

#### Single-select screen (for `iterate.implementer`)

A radio-button list of `list_agents` results plus an `(unset)`
sentinel. Up/down moves cursor; `space`/`enter` selects and pops;
`q`/`esc` pops without changing.

```
> Pick iterate.implementer
   (•) codex
   ( ) claude-code
   ( ) gemini-cli
   ( ) gemma4
   ( ) (unset — fall back to heuristic)
   back
```

#### Multi-select screen (for the four list-valued fields)

Checkbox-style list, but with the agent-id rows pre-populated from
`list_agents`. Order matters for `reviewers` (preference order); the
screen preserves the user's selection order, not list-agents'
insertion order.

```
> Pick iterate.reviewers (order = preference order)
   [x] 1. codex
   [ ]    claude-code
   [x] 2. gemini-cli
   [ ]    gemma4
   space: toggle    j/k or arrows: move    enter: confirm    q: cancel
   back
```

Position numbers (`1. codex`, `2. gemini-cli`) make the order
explicit — the user can see what slot each pick occupies.

#### Validation in-TUI

The existing `validateConfig` enforces:
- ban-vs-reviewer collision (an id may not be in both lists for the
  same scope);
- empty-string ids (impossible from this TUI — the source set is
  `list_agents` names);
- ID format (also enforced upstream).

The TUI must NOT let the user enter a ban-vs-reviewer collision —
instead of erroring on save, surface inline:

> Conflict: 'codex' is in both iterate.reviewers and iterate.banList.
> Remove one before saving.

The save action checks this preflight and refuses with a 1-line
inline error if violated. The user pops the violating screen, fixes
it, retries.

#### `list_agents` integration

Read once at TUI startup via the same code path the rest of the CLI
uses. Cache for the TUI's lifetime — `list_agents` shouldn't change
mid-session, and re-reading on every screen push would slow rendering
for no benefit.

If an existing config has an id not in `list_agents` (matches the
`get_crew_preferences` warnings[] case), show it with a `(unknown)`
suffix in the multi-select list and a header note:

```
> Pick iterate.reviewers
   [x] 1. codex
   [x] 2. claude-3-sonnet  (unknown — not in list_agents)
   [ ]    gemini-cli

   Note: 1 configured id is not in list_agents. Keep them, or
   uncheck to remove from your defaults.
```

This lets the user clean up stale ids without surprise data loss.

**Files touched:**
- New: `src/cli/commands/config-tui/agent-defaults-screen.ts` — the
  submenu screen.
- New: `src/cli/commands/config-tui/single-select-screen.ts` — radio
  list.
- New: `src/cli/commands/config-tui/multi-select-screen.ts` —
  ordered checkbox list.
- `src/cli/commands/config.ts` — add the `Agent defaults...` root
  entry; load `list_agents` and pass through `driveTui`.
- New: `src/cli/commands/config-tui/agent-defaults-state.ts` —
  serializes the TUI's working state back to
  `setConfigValue(... workflow.agentDefaults.X, ...)` calls on save.
  Reuses the existing `setConfigValue` plumbing — no new write path.

**Tests:**
- `test/cli/commands/config-tui/agent-defaults-screen.test.ts` (new):
  enter submenu → cursor positions → push single-select → pick value
  → pop → state mutated.
- `test/cli/commands/config-tui/multi-select-screen.test.ts` (new):
  toggle order preserved across selections; deselect re-numbers.
- `test/cli/commands/config-tui/single-select-screen.test.ts` (new):
  one-active-at-a-time; `(unset)` sentinel removes the field.
- `test/cli/commands/config-tui/validation.test.ts` (new):
  ban-vs-reviewer collision blocks save with inline error;
  unknown-id surface shown but doesn't block save.

### Layer 3 — Non-TTY fallback symmetry

The non-TTY surface (line 96-109 of current `config.ts`) prints the
3 boolean toggles + a hint. Extend it to print the agent-default
state too, so CI users + scripted callers can at least see what's set:

```
crew-mcp config (current settings):

  notifications.success: on
  notifications.error: on
  confirmBeforeMerge: on

  workflow.agentDefaults.iterate.implementer: codex
  workflow.agentDefaults.iterate.reviewers: claude-code, codex
  workflow.agentDefaults.iterate.banList: gemini-cli
  workflow.agentDefaults.panel.reviewers: codex, claude-code
  workflow.agentDefaults.panel.banList: (empty)

Interactive editing requires a TTY. Edit ~/.crew/profiles/default.json
directly, or run `crew-mcp config` in a real terminal.
```

**Files touched:**
- `src/cli/commands/config.ts` — extend the non-TTY branch.

**Tests:**
- Extend `test/cli/commands/config.test.ts` non-TTY assertion to cover
  the agent-defaults display.

## Non-goals

- **No new schema fields.** The schema landed in
  `iterate-panel-agent-defaults.md`; this plan only adds UI.
- **No CLI changes.** `crew-mcp config set/show/unset` for these keys
  already works; this plan is TUI-only.
- **No live `list_agents` refresh inside the TUI.** Read once at
  startup. If the user adds an agent, they re-run `crew-mcp config`.
- **No effort/model defaults in this TUI.** Those are deferred in
  `config-future-settings.md` (`defaultEffort` candidate). When
  picked up, they can reuse the screen-stack from Layer 1.
- **No profile-switcher UI.** Profiles + scopes are an orthogonal
  config system; the TUI operates on the currently-active profile
  (same as today).

## Order of work

Layer 1 first (no user-visible behavior change, but unblocks
everything else and ships a regression test on the existing 3
toggles). Layer 2 second (the actual user value). Layer 3 third
(small CI-friendly polish).

Each layer is a separate commit.

## Reviewer rubric (for the iterate loop that builds this)

- **[M]** `test/cli/commands/config.test.ts` existing 3-toggle TUI
  tests pass byte-identically after the screen-stack refactor.
- **[M]** New `test/cli/commands/config-tui/*.test.ts` files cover
  single-select, multi-select (with order preservation), submenu
  navigation, and validation (collision blocks, unknown-id allows).
- **[M]** Full `npm test` exit 0, `npm run build` exit 0,
  `npm run lint` exit 0.
- **[B]** TUI handles edge cases gracefully:
  - empty `list_agents` (no agents configured) → submenu shows
    "(no agents available — run crew-mcp install first)" and
    pop returns to root without writing.
  - existing config has unknown ids → shown with `(unknown)`
    suffix, kept on save unless user unchecks.
  - SIGINT mid-submenu restores terminal raw mode (same cleanup
    path the current driver already has).
- **[B]** Save action calls existing `setConfigValue` / `unsetConfigValue`
  — no new write path, validation diagnostics surface through the
  same channel as the CLI.
- **[N]** Existing 3-toggle behavior preserved: same keys, same
  layout (with the new `Agent defaults...` entry appended below).
- **[N]** Non-TUI flows (`config set/show/unset`) unchanged.
- **[N]** `validateConfig` rules unchanged on the wire — the TUI
  preflight is a *layer above* validation, not a replacement.

## Files anticipated

- `src/cli/commands/config.ts` — refactor (Layer 1), root entry +
  list_agents wiring (Layer 2), non-TTY printout (Layer 3).
- `src/cli/commands/config-tui/screen.ts` — Screen interface (new).
- `src/cli/commands/config-tui/checkbox-list-screen.ts` (new).
- `src/cli/commands/config-tui/agent-defaults-screen.ts` (new).
- `src/cli/commands/config-tui/single-select-screen.ts` (new).
- `src/cli/commands/config-tui/multi-select-screen.ts` (new).
- `src/cli/commands/config-tui/agent-defaults-state.ts` (new).
- `test/cli/commands/config.test.ts` — TUI regression coverage.
- `test/cli/commands/config-tui/*.test.ts` (4 new files).
- `docs/plans/active/config-future-settings.md` — add backlink:
  "interactive TUI access shipped in
  `config-tui-agent-defaults.md`."

## Open questions

- **Single-select cursor convention.** Today's TUI uses `space` to
  toggle. For radio-button (single-select), should `space` and
  `enter` both select-and-pop, or should `space` select-without-popping
  (so the user can see the selection update before committing)?
  Default: `space`/`enter` both select-and-pop — fewer keys to
  remember, matches "active immediately" semantics. Open to feedback.
- **Multi-select selection order.** Order = order-of-selection or
  order-of-list? Plan picks order-of-selection (preference order).
  If the user deselects an entry then reselects it, it goes to the
  END (not back to its prior position). Open to feedback.
- **Discoverability of the submenu.** Append at the bottom of the
  root list or insert between existing entries? Plan picks append
  for now; the entries already share a "settings" theme.
