# Guided installation of dispatch agents — design plan

**Status:** Draft 2026-05-10.
**Trigger:** User tried to register a local Ollama-backed `gemma4` model and
discovered the path requires hand-editing `~/.crew/agents.json` AND that
the file is currently ignored by `serve.ts`. We want parity with the host
CLI install flow: discover, pick, verify, persist.

## Problem statement

Dispatching to anything beyond the three built-in adapters
(`claude-code`, `codex`, `gemini-cli`) requires editing
`~/.crew/agents.json` by hand. Two stacking failures today:

1. **The edit doesn't take effect.** `src/cli/commands/serve.ts:271`
   constructs the registry via `createBuiltinRegistry()`, which only loads
   the three built-ins. The `createRegistryFromConfig` path in
   `src/adapters/registry.ts:310` that handles `openai-compatible` /
   `generic` entries is dead code in production — the
   `OpenAiCompatibleAdapter` class is implemented and tested, but nothing
   wires user-configured entries into the running server.
2. **Even if the wiring existed, the UX is hostile.** The user must
   already know:
   - which `adapter` value to use (`openai-compatible`)
   - the JSON shape (`apiBase`, `apiKey`, `model`, `strengths`)
   - that Ollama specifically lives at `http://localhost:11434/v1`
   - to use a non-empty sentinel `apiKey` even though Ollama ignores it

The existing `crew agents edit` command opens `$EDITOR` on raw JSON; that
is not "guided" by any reasonable measure.

## Goal

A user with Ollama (or LM Studio, or any OpenAI-compatible endpoint)
installed can run **one** interactive command and end up with a working
crew agent they can dispatch to from the captain — with no JSON editing
and no knowledge of the underlying adapter shape.

## Non-goals (v1)

- **Hot reload of `agents.json`.** After adding an agent the user must
  restart `crew-serve`. Watching the file for live reloads is out of
  scope for v1; print a clear restart hint instead.
- **Provider auto-detection during `crew install`.** Probing
  `localhost:11434` on every install is invasive. Detection only
  fires when the user explicitly runs `crew-mcp agents add`.
- **Per-dispatch model override on a single multi-model agent.**
  Registering N models = N agent entries. Captains pick by agent
  name, not by passing `model:` to a generic `ollama` agent. (See
  open question §5.4.)
- **Non-OpenAI-compatible local providers** (raw llama.cpp HTTP,
  text-generation-webui, anything that doesn't speak `/v1/chat/completions`).
  The existing `generic` shell-command adapter remains the escape
  hatch; we just don't add interactive UX for it in v1.

## Three workstreams

### W1 — wiring (load-bearing, ships first)

**Goal:** make custom agent entries in `agents.json` actually surface to
the captain, without any new CLI commands.

Changes:

1. `src/cli/commands/serve.ts:271` — replace `createBuiltinRegistry()`
   with a builder that:
   - Starts from the built-in registry (claude-code, codex, gemini-cli
     always present).
   - Reads `agents.json` via `readAgentPrefsFile(crewHome)`.
   - For each entry whose `adapter` is `openai-compatible` or `generic`
     AND whose key is not a built-in name, registers it lazily via the
     same loader functions `createRegistryFromConfig` already uses.
   - Skips/warns on malformed entries rather than throwing, so a typo
     in `agents.json` doesn't take down serve.
2. `src/adapters/registry.ts` — extract a
   `mergeCustomAgents(registry, configMap)` helper so serve.ts and tests
   share one path. Today's `createRegistryFromConfig` rebuilds from
   scratch; we want additive merging on top of an existing registry.
3. `src/agent-prefs/store.ts` — extend the type to allow the
   openai-compatible fields (`adapter`, `model`, `apiBase`, `apiKey`)
   which currently only exist as soft hints. Validate that
   `openai-compatible` entries have at least `apiBase` set before
   registering.
4. Tests:
   - serve integration test: write a fixture `agents.json` with a fake
     openai-compatible entry pointed at a `nock`/`undici` mock, dispatch
     `list_agents`, assert the entry shows up `available: true`.
   - Dispatch `run_agent` against the custom entry, assert it round-trips
     through the openai-compatible adapter.
   - Malformed entry is skipped with a warning, doesn't break the rest
     of registry init.
   - Reserved name collision (`adapter: "openai-compatible"` keyed under
     `claude-code`) is rejected with a clear error.

**Acceptance:** the existing `gemma4` entry already in
`~/.crew/agents.json` (added 2026-05-10) starts working without any CLI
changes — `list_agents` shows it, `run_agent` dispatches to it through
Ollama.

### W2 — `crew-mcp agents add` interactive command

**Goal:** match the polish of `crew install` for adding a dispatch agent.

Changes:

1. `src/cli/commands/agents.ts` — refactor the single-purpose
   `agentsEditCommand` into a multi-subcommand surface:
   - `crew-mcp agents edit` (existing)
   - `crew-mcp agents list` (new — print current entries with health)
   - `crew-mcp agents add` (new — interactive)
   - `crew-mcp agents remove <name>` (new — with confirmation)
2. `src/cli/commands/agents/add.ts` — new file. Flow:
   - Prompt: "What kind of provider?" → enum of {Ollama, LM Studio,
     vLLM, OpenAI-compatible URL, custom shell command (generic)}.
   - For Ollama / LM Studio: probe the default endpoint
     (`localhost:11434` / `localhost:1234`). If unreachable, surface a
     clear error and offer to enter a custom URL.
   - For OpenAI-compatible URL: prompt for base URL + API key.
   - `GET /v1/models` to list available models. Fall back to free-text
     model entry if that fails.
   - Multi-select model(s); registering N models = N agent entries.
   - For each selection: prompt agent name (default: model id with
     non-DNS chars stripped), strengths (free-form, comma-separated,
     with sensible defaults like `local, private` for Ollama).
   - Verify each one with a 1-token round-trip via the adapter, surface
     latency.
   - Atomic write to `agents.json`: read → merge → write to tmp → rename.
     Never destroy existing entries.
   - Print restart hint if `crew-serve` is detected running.
3. `src/install/provider-detection.ts` — new module with probe functions
   for known local providers (Ollama, LM Studio). Used by `agents add`
   only (not `crew install`, per non-goal §3 / open question §5.2).
4. `src/install/model-discovery.ts` — `listOpenAiCompatibleModels(apiBase, apiKey)`
   helper using `fetch /v1/models`.
5. `--non-interactive` flag form so this skill, scripts, and Codex-driven
   runs can use it without a TTY:

   ```
   crew-mcp agents add --provider ollama --model gemma4:latest --name gemma4
   crew-mcp agents add --provider openai-compatible \
       --api-base https://my.endpoint/v1 \
       --api-key $TOKEN \
       --model claude-on-bedrock --name bedrock-claude
   ```

6. Tests:
   - `agents add` flow with stubbed prompts + mocked `/v1/models` writes
     the correct JSON.
   - Unreachable endpoint surfaces a clear error and doesn't write
     partial state.
   - Existing entries are preserved across `add`.
   - Verification ping failure aborts with no write.
   - Non-interactive flag form exercises the same code path with no TTY
     prompts.

### W3 — discoverability + polish

**Goal:** the user finds out this exists.

Changes:

1. `crew install` final summary — append "Run `crew-mcp agents add` to
   register additional models (Ollama, LM Studio, OpenAI-compatible
   endpoints)." This is the only `crew install` touch; we don't add
   probes per non-goal §3.
2. `crew-mcp agents list` — show health (running adapter `healthCheck`
   per row), version where available, and a final hint pointing at
   `agents add` / `edit`.
3. README + `crew agents edit` seed file `_readme` — add a paragraph
   showing one openai-compatible entry as a worked example, and mention
   `crew-mcp agents add` as the recommended path.
4. Skill body update if any captain-facing copy mentions the available
   adapters (it currently does not, but recheck after W1 lands so the
   captain knows custom entries from `list_agents` are first-class).

## Order of work / shippability

Each workstream is independently mergeable, but they layer:

1. **W1 first.** Without it, the rest is decorative. Smallest surface,
   highest leverage. Ship, smoke-test with the existing `gemma4` entry
   to confirm it dispatches end-to-end.
2. **W2 next.** Larger but contained — all new files except the
   `agents.ts` refactor.
3. **W3 last.** Mostly copy + small additions; can come in the same PR
   as W2 or as a follow-up.

## Open questions

### 5.1 — naming collisions

What if the user names an entry `claude-code`? Today's
`createRegistryFromConfig` rejects that. The new add command should
**refuse** to use built-in adapter names with a clear error message,
rather than silently shadowing. W1 must enforce this at the registry
merge point too — the merge helper rejects entries that collide with
built-in adapter names.

### 5.2 — `apiKey` for keyless providers

Ollama ignores the API key but the OpenAI client requires non-empty.
The 2026-05-10 `gemma4` entry uses `"apiKey": "ollama"` as a sentinel.
For the add command — auto-fill a sentinel like `"ollama"` for keyless
providers and document it inline ("Ollama doesn't use an API key; we
fill a sentinel because the OpenAI client library requires non-empty").
Don't omit, because the adapter currently treats absent `apiKey` as
"send no Authorization header," which breaks providers that DO require
auth and might be added later.

### 5.3 — hot reload vs restart

`serve.ts` reads `agents.json` once at startup. After `agents add` the
user must restart `crew-serve`. Worth investing in file-watch reload?
**No, not in v1.** Print a clear "restart `crew-serve`" message and
call it done; the user pattern is install-then-restart anyway. Revisit
if this becomes a friction point.

### 5.4 — per-call `model` override on a multi-model provider

If a user registers `gemma4` and `llama3.2` against the same Ollama
endpoint, do they want them as 2 separate agent names, or one `ollama`
agent with `model:` override per dispatch? **Plan calls for one entry
per model**; that's simpler for the captain (it picks by name, no
extra cognitive load on remembering which models exist on which
endpoint) but verbose for users with many models. If we revisit, the
fix is additive: keep per-model entries as the default, and allow a
"family" entry (`adapter: openai-compatible`, no `model`) that the
captain can target with a `model:` override at dispatch time.

### 5.5 — verification round-trip cost

The verify step in W2 sends a real prompt ("respond with the single
word 'ok'") to ensure the round-trip works. For a paid endpoint
(OpenRouter, Together, etc.) that's a few cents at worst, but we
should make it skippable via `--no-verify` for users who don't want
the call.

## Out of scope (deferred)

- A `crew-mcp agents test <name>` command for manually re-running the
  verification ping after the fact. Would be useful but the user can
  always `run_agent` with a tiny prompt.
- Cost / quota probes on `list_agents` for paid endpoints. The
  `quotaProbe` plumbing exists in `list_agents` but no adapter
  implements it; that's a separate (M4-era) workstream.
- Multi-endpoint failover (try Ollama first, fall back to a hosted
  endpoint if local is down). This belongs at the captain layer, not
  the registry.

## Smoke-test gates per workstream

- **W1 done when:** `gemma4` entry in `~/.crew/agents.json` shows up
  in `list_agents` with `available: true` and a `run_agent` call
  returns a real Ollama response.
- **W2 done when:** Removing the manual `gemma4` entry, running
  `crew-mcp agents add` and following prompts produces an equivalent
  entry, and dispatch still works.
- **W3 done when:** A new user reading the README can find the
  `agents add` flow without prior context.
