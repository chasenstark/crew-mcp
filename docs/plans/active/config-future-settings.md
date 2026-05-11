# Future `crew-mcp config` settings — backlog

**Status:** Backlog 2026-05-11. Living doc.
**Context:** `crew-mcp config` shipped in commit `e44eee9` with the
notifications toggle. A follow-up (dispatched run
`9d41235f-396c-4121-823f-fc9d79682667`) adds the notifications
success/error split and `confirmBeforeMerge`. This doc captures the
remaining candidate settings considered during that design pass, so
they're discoverable when the user revisits config UX.

## How to read this

Each candidate has:
- **Key** — proposed config field name.
- **Promotes from** — existing env var, if any (else `(new)`).
- **Default** — proposed default value.
- **Why** — what user pain it solves.
- **Status** — `deferred` (not picked up), `picked` (in flight), or
  `rejected` (consciously skipped).

When promoting an env var, the env var should remain as a runtime
override (matches the precedence we already established for
`CREW_OS_NOTIFICATIONS` and `CREW_CONFIRM_BEFORE_MERGE`).

## High-value behavioral toggles

### `autoOpenTail` (bool)
- **Promotes from:** (new)
- **Default:** `false` (preserve current "emit URL only" behavior)
- **Why:** macOS users who have `install-tail-handler` set up almost
  always want the tail terminal to open automatically on dispatch.
  Today the captain emits a `crew-tail://` markdown link and the user
  clicks it.
- **Where it lands:** dispatch envelope in `serve.ts` would auto-open
  via `open(tail_url)` after returning the envelope.
- **Status:** deferred. Needs a story for non-macOS users (handler is
  mac-only). Could default `false` everywhere and only respect the
  toggle on macOS.

### `defaultAgent` (string)
- **Promotes from:** (new)
- **Default:** unset (captain picks via list_agents)
- **Why:** "Have an agent do X" without naming one is a common phrase;
  today the captain reads `agents.json` strengths and picks. A
  persistent default short-circuits that for users who routinely route
  to one agent.
- **Where it lands:** `list_agents` envelope surfaces it; captain skill
  reads it as a routing nudge ("if the user is ambiguous, prefer
  `defaultAgent`").
- **Status:** deferred. Soft signal only — easy to add but low impact
  unless captain skill explicitly honors it.

### `defaultEffort` (low | medium | high | xhigh | max)
- **Promotes from:** (new)
- **Default:** unset
- **Why:** Global override for `run_agent({effort})`. Per-call effort
  always wins; per-agent prefs in `agents.json` win over this. Useful
  for users who want all dispatched runs at `high` regardless of
  agent default.
- **Where it lands:** `serve.ts` `run_agent` handler. Precedence:
  per-call > agents.json > config.defaultEffort > adapter default.
- **Status:** deferred. Clear precedence chain; small surface area.

## Promote existing env-only knobs

These already work via env var; persistent UI just removes the
"export this in your shell rc" friction.

### `logLevel` (debug | info | warn | error)
- **Promotes from:** `CREW_LOG_LEVEL`
- **Default:** `info`
- **Why:** Users debugging the MCP server today set the env var in
  their host CLI's launcher config. Persisting it survives shell
  reloads and is discoverable.
- **Status:** deferred. Cheapest entry — single picker.

### `fileLogLevel` (debug | info | warn | error)
- **Promotes from:** `CREW_FILE_LOG_LEVEL`
- **Default:** `info`
- **Why:** Controls `~/.crew/logs/*` verbosity independently from
  console.
- **Status:** deferred. Pair-ship with `logLevel`.

### `streamIdleTimeoutMs` (number)
- **Promotes from:** `CREW_STREAM_IDLE_TIMEOUT_MS`
- **Default:** `120000` (current hardcoded default)
- **Why:** Slow networks frequently hit the 120s default; users
  currently set the env var. The adapter error message already
  references the env var name as the fix.
- **Status:** deferred. Needs string→number TUI input (TUI is
  checkbox-only today; see §"TUI input shape" below).

### `promptStorageCapChars` (number, 0 disables)
- **Promotes from:** `CREW_PROMPT_STORAGE_CAP_CHARS`
- **Default:** `16384`
- **Why:** Users who want full-fidelity prompt logs (debugging captain
  framing) currently set the env var. Surfacing this also documents
  that the cap exists.
- **Status:** deferred. Same TUI input-shape blocker.

### `fullEnvelope` (bool)
- **Promotes from:** `CREW_FULL_ENVELOPE`
- **Default:** `false`
- **Why:** Opt-in richer envelope fields. Documented as a
  power-user/debug toggle.
- **Status:** deferred. Edge-case toggle; low priority unless we hear
  user demand.

### `healthcheckTtlMs` (number)
- **Promotes from:** `CREW_HEALTHCHECK_TTL_MS`
- **Default:** whatever `health-check-cache.ts` currently uses
- **Why:** Tuning the adapter availability cache. Niche.
- **Status:** deferred. Low priority.

## New ideas

### `worktreeRetention` (`merge` | `terminal` | `manual`)
- **Promotes from:** (new)
- **Default:** `merge` (current behavior — auto-cleanup on merge)
- **Why:** Some users want to inspect worktrees post-mortem. `terminal`
  would keep worktrees until a terminal status is reached + explicit
  discard; `manual` would never auto-cleanup.
- **Status:** deferred. Needs more thought on disk-usage UX (users
  with many runs could pile up worktrees fast).

### `tailHandlerEnabled` (bool, macOS only)
- **Promotes from:** (new)
- **Default:** `true` if handler is installed, else `false`
- **Why:** Gate `crew-tail://` URL emission without uninstalling the
  handler. Useful for screen-sharing or muting noise.
- **Status:** deferred. Low impact — users can ignore the URL today.

## TUI input shape — blocker for number/string entries

The current `crew-mcp config` TUI supports only checkbox-style boolean
toggles. Several deferred entries need:
- **Numeric input** (`streamIdleTimeoutMs`, `promptStorageCapChars`,
  `healthcheckTtlMs`)
- **Enum picker** (`logLevel`, `fileLogLevel`, `defaultEffort`,
  `defaultAgent`, `worktreeRetention`)
- **Free-text** (`defaultAgent`)

**Implementation note:** once we want to land a string/number entry,
extend `ConfigEntry` in `src/cli/commands/config.ts` with a
`kind: 'bool' | 'enum' | 'number' | 'string'` discriminator + per-kind
input handlers (raw-mode line editor for text/number; horizontal
arrow picker for enum). Keep the entry list flat until it grows past
~6 items; introduce sections (`Notifications`, `Routing`,
`Diagnostics`) at that point.

## Explicitly rejected

- **`CREW_OPENAI_API_KEY` / `CREW_OPENAI_BASE_URL`** — secrets, keep
  env-only. Persistent storage in a plaintext JSON file is the wrong
  shape; users who need it can write a `direnv` `.envrc`.
- **`CREW_HOME`** — chicken-and-egg (where would the config live?).
- **Per-agent prefs (`strengths` / `effort` / `model`)** — already
  in `agents.json` with its own `crew-mcp agents edit` command.
  Duplication would create config-conflict ambiguity.

## Sequencing

If picking these up in batches, suggested order:
1. **Tier 1** (cheap, high-utility, no TUI extension): `defaultAgent`,
   `defaultEffort`, `autoOpenTail`, `logLevel`, `fileLogLevel`.
   `defaultAgent`/`defaultEffort`/`logLevel`/`fileLogLevel` need enum
   input though — see TUI shape blocker.
2. **Tier 2** (after TUI input extension): `streamIdleTimeoutMs`,
   `promptStorageCapChars`, `fullEnvelope`, `healthcheckTtlMs`.
3. **Tier 3** (UX-heavier): `worktreeRetention`, `tailHandlerEnabled`.

Realistically Tier 1 is gated by the TUI extension too unless we add a
single boolean (`autoOpenTail`) ahead of the input refactor.
