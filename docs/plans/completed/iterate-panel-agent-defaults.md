# Configurable agent selection — iterate + panel

> **Status:** Shipped 2026-05-26. **Anchor commit:** `4fa43b3`
> (Layers 1–3 landed as a single crew merge; final verification:
> `npm test` 1128 passed / 3 skipped, `npm run build` exit 0,
> `npm run lint` exit 0). Driven by 14 user-confirmed acceptance
> criteria; converged in 3 implementer-and-review rounds.
> Interactive TUI access shipped separately in
> [`config-tui-agent-defaults.md`](./config-tui-agent-defaults.md)
> (commit `5489742`).

**Predecessor:** `config-future-settings.md` (this plan promotes the
`defaultAgent` candidate from that backlog into a fully-realized
multi-slot scheme).
**Owner skill bodies:** `skills/crew-iterate.body.md`,
`skills/crew-captain.body.md` (panel section).

## Why

The iterate skill is implicitly opinionated about agent choice. The
prose says "Codex for mechanical, Claude Code for behavioral" and
Gemini shows up in dispatch examples that read as defaults. There is
no persistent way to say "never pick Gemini for me" or "use Codex as
the implementer unless I say otherwise" — the user has to repeat the
preference every run, or the captain quietly picks something they
didn't want.

Same shape applies to `run_panel`: today reviewers are always supplied
explicitly, but the captain still chooses them when the user says
"have a panel review this" without naming names.

Goal: let users **set defaults once** and **override per run** for
both flows, without changing the dispatch wire protocol.

## What

Three layers, shipped in order. Each layer is independently valuable.

### Layer 1 — Skill-body changes (no code, ship first)

The captain reads the skill body fresh every session. Changing prose
ships the moment the user re-installs.

**`skills/crew-iterate.body.md`:**

1. Insert new **Step 0.5 — Confirm agent picks** after Step 0. The
   captain:
   - Calls `list_agents` (already required by safety invariant #4).
   - Calls `get_crew_preferences({scope: "iterate"})` (new tool — see
     Layer 2). On hosts without that tool yet, the captain skips the
     call and falls back to the heuristic.
   - Filters out same-host product (invariant #5) and `banList`
     entries (from preferences).
   - Proposes implementer + reviewer(s), preferring the user's
     preferences when present and respecting the heterogeneity
     heuristic only as fallback.
   - Surfaces verbatim:
     > Agents for this iteration:
     > - Implementer: <id> <reason: "your default" | "heuristic: …">
     > - Reviewer(s): <id, id> <reason …>
     >
     > Override (e.g., "swap implementer to claude-code", "drop
     > gemini", "use codex for both") or OK.
   - Waits for OK. **Silence is not consent** (per invariant #8).
2. Demote the prescriptive "Codex for mechanical / Claude Code for
   behavioral" guidance to *one* example of a fallback heuristic.
   Strip Gemini from examples that read as defaults — keep it in
   `<reviewer>` placeholder lists only.
3. Add an "Override grammar" subsection listing recognized phrases so
   the captain parses inline overrides consistently:
   - `swap implementer to <id>` → set implementer
   - `add reviewer <id>` / `drop reviewer <id>` → mutate reviewer set
   - `use only <id>` / `use <id> for both` → collapse picks
   - `no <id>` / `never <id>` → session-scoped ban (per-run, not
     persisted)

**`skills/crew-captain.body.md`:**

4. In the **Review panels** section, insert the same
   "Confirm reviewer picks" gate before the `run_panel` example. Same
   surfacing format; reads from `panel.reviewers` defaults; respects
   `panel.banList`. The captain proposes; the user OKs.

5. Cross-reference both bodies: each one points at the other for
   "agent-picking happens here, see [[other-body]] for the parallel
   flow".

**Test coverage (mandatory, since tests don't catch prose drift —**
**see memory `feedback_skill_body_sync`):**

- `test/skills/crew-iterate-body.test.ts` — assert the load-bearing
  Step 0.5 anchors are present:
  - `"### Step 0.5 — Confirm agent picks"` heading
  - The user-facing "Agents for this iteration:" prompt
  - `"Override grammar"` subsection
  - `get_crew_preferences` referenced exactly once in Step 0.5
- `test/skills/crew-captain-body.test.ts` (already exists per
  prior work pattern; add to it) — analogous anchors for the panel
  section.

### Layer 2 — Persistent defaults via `crew-mcp config`

Hook into the **existing** `~/.crew/profiles/<profile>.json` config
system (`src/workflow/config-service.ts`). No new file, no new
schema versioning machinery — extend `FullConfig`.

**Schema additions to `WorkflowConfig` (`src/workflow/types.ts`):**

```ts
export interface WorkflowConfig {
  // … existing fields
  agentDefaults?: {
    iterate?: {
      implementer?: string;       // agent_id from list_agents
      reviewers?: string[];       // ordered preference list
      banList?: string[];         // never auto-pick these
    };
    panel?: {
      reviewers?: string[];
      banList?: string[];
    };
  };
}
```

**Validation rules** (added to `validateConfigOrThrow`):
- Every id in `implementer` / `reviewers` / `banList` is a non-empty
  string. We do NOT validate against `list_agents` at config-write
  time — the host might not be installed yet, and the registered
  agent inventory is mutable. The captain validates at read time and
  surfaces unknown ids as warnings, not errors.
- `banList` and `reviewers` may not contain the same id — fail loud
  rather than silently letting the ban win at read time.
- Both `iterate` and `panel` may be partially populated; missing
  fields fall through to the captain's heuristic.

**New MCP tool: `get_crew_preferences`**

`src/orchestrator/tools/get-crew-preferences.ts`:

```ts
{
  name: "get_crew_preferences",
  description: "Read user-set agent defaults for iterate / panel. Captain calls this in Step 0.5 (iterate) or before run_panel reviewer-pick (umbrella) to honor user preferences without re-prompting every run.",
  inputSchema: {
    type: "object",
    properties: {
      scope: { type: "string", enum: ["iterate", "panel", "all"] }
    }
  },
  // returns: { iterate?: {...}, panel?: {...}, warnings: string[] }
}
```

- Reads `FullConfig.workflow.agentDefaults` via existing config
  loader (respects profile + scope precedence).
- Cross-references against `list_agents` at read time. Each
  unresolved id becomes a `warnings[]` entry:
  `"preferred implementer 'codex' is not in list_agents (agent unavailable or uninstalled)"`.
- Returns `{}` when no defaults set — captain falls back to
  heuristic.
- Read-only. Mutation goes through `crew-mcp config set`.

Register in `src/install/tool-catalog.ts` and
`src/cli/commands/serve.ts`.

**Effect on `run_panel` / `run_agent`** (per user answer to "scope of
effect"):

- `run_panel` with `reviewers: []` or `reviewers: undefined` now
  fills from `agentDefaults.panel.reviewers`, minus `banList`,
  minus same-host product. If the resulting list is empty, the call
  fails with a clear `run_panel.no_reviewers` error pointing at
  `crew-mcp config` and inline-override syntax.
- `run_agent` does NOT auto-fill an implementer from preferences.
  The skill body teaches the captain to propose explicitly; the wire
  protocol stays strict (caller must name an agent). Reason: a
  silent server-side default for `run_agent` would surprise users
  invoking the tool directly via other clients.

**Tests:**

- `test/workflow/config-service.test.ts` — extend with
  `agentDefaults` round-trip, validation (ban-vs-reviewer collision,
  empty-string ids), partial population.
- `test/orchestrator/tools/get-crew-preferences.test.ts` — new file:
  empty config → empty result; populated config → returns prefs;
  unresolved id → warning; scope filter narrows the response.
- `test/orchestrator/tools/run-panel.test.ts` — extend: empty
  `reviewers` + preferences set → fills correctly; empty after
  ban-list filter → returns `no_reviewers`; explicit
  `reviewers` arg always wins over preferences (per-run override).

### Layer 3 — CLI mutation surface

Extend `crew-mcp config set` to accept the new dotted-key paths:

```bash
crew-mcp config set workflow.agentDefaults.iterate.implementer codex
crew-mcp config set workflow.agentDefaults.iterate.reviewers '["claude-code"]'
crew-mcp config set workflow.agentDefaults.iterate.banList '["gemini-cli"]'
crew-mcp config set workflow.agentDefaults.panel.reviewers '["codex","claude-code"]'
crew-mcp config unset workflow.agentDefaults.iterate.implementer
```

- Array values: parse as JSON when the value starts with `[`.
  Existing `crew-mcp config set` likely already handles this — verify
  in `src/workflow/config-service.ts:resolveConfigInput`.
- `crew-mcp config show` already prints the full effective config;
  the new fields appear automatically.
- Add `crew-mcp config set --interactive` support for the new keys
  if the existing implementation has interactive prompts (check
  before writing — keep this in scope only if cheap).

**Tests:**

- `test/cli/commands/config.test.ts` — extend with set/show/unset
  cycles for each new key.

## Non-goals

- **In-chat mutation MCP tool (`set_crew_preferences`).** Explicitly
  deferred. The captain reads preferences; the user writes them via
  CLI. Avoids a write surface the captain could fire accidentally
  and keeps the source-of-truth single (the config file the user
  can inspect on disk).
- **Repo-local overrides.** The existing config system supports
  `project` scope at `<repo>/.crew/profiles/<profile>.json`. We do
  NOT add per-repo `agentDefaults` UX in this plan — the user
  explicitly chose global scope only. If a repo-local override is
  later wanted, the existing scope machinery picks it up for free;
  this is forward-compatible.
- **Effort / model / per-agent-strength preferences.** Out of scope.
  Tracked separately in `config-future-settings.md` (`defaultEffort`
  candidate). This plan addresses agent *identity* only.
- **`run_agent` server-side default-fill.** See Layer 2 reasoning;
  not adding.

## Order of work

Layer 1 first (prose-only; ships value immediately even without
preferences set). Layer 2 second (delivers the persistent-defaults
goal). Layer 3 third (UX polish on top of working tool surface).

Each layer is a separate commit. Layer 2's `get_crew_preferences`
tool is what makes Layer 1's "Step 0.5" gate actually honor user
intent — without it, the gate runs but the captain has nothing to
read except `list_agents`. So Layer 1 ships a working flow even
solo; Layer 2 upgrades the flow.

## Reviewer rubric (for the iteration loop that builds this)

When dispatching reviewers per `/crew-iterate` on this plan:

- **[M]** `test/skills/crew-iterate-body.test.ts` and
  `test/skills/crew-captain-body.test.ts` both pass with the new
  Step 0.5 / panel-pick anchors.
- **[M]** `test/orchestrator/tools/get-crew-preferences.test.ts`
  covers empty, populated, unresolved-id-warning, scope-filter
  cases.
- **[M]** `test/orchestrator/tools/run-panel.test.ts` covers
  preference-fill, ban-filter, explicit-arg-wins, and
  `no_reviewers` error.
- **[B]** Skill bodies stop reading as "Gemini is the default" —
  scan for the strings `gemini`, `codex`, `claude-code` in both
  bodies and confirm each appearance is either a placeholder
  `<id>`, an explicit example labeled "example", or inside a
  fallback heuristic that the user can override.
- **[B]** The captain audit-trail rule (existing in iterate body)
  is extended to include the agent-pick block in every downstream
  prompt — reviewers should see which implementer was chosen, and
  why, so criteria drift detection covers agent drift too.
- **[N]** Existing `crew-mcp config` flows (notifications,
  confirmBeforeMerge) still round-trip via `set` / `show`.
- **[N]** `run_panel({reviewers: [...]})` with an explicit list
  ignores preferences (per-run override unchanged).
- **[N]** `list_agents` envelope and `run_agent` schema unchanged
  on the wire.

## Files touched (anticipated)

- `skills/crew-iterate.body.md` — Step 0.5, override grammar
- `skills/crew-captain.body.md` — panel-pick gate
- `src/workflow/types.ts` — `agentDefaults` field
- `src/workflow/config-service.ts` — validation
- `src/orchestrator/tools/get-crew-preferences.ts` (new)
- `src/orchestrator/tools/run-panel.ts` — preference-fill
- `src/install/tool-catalog.ts` — tool registration
- `src/cli/commands/serve.ts` — tool wiring
- `test/skills/crew-iterate-body.test.ts` — Step 0.5 anchors
- `test/skills/crew-captain-body.test.ts` — panel-pick anchors
- `test/workflow/config-service.test.ts` — schema validation
- `test/orchestrator/tools/get-crew-preferences.test.ts` (new)
- `test/orchestrator/tools/run-panel.test.ts` — preference-fill
- `test/cli/commands/config.test.ts` — new dotted keys

## Update `config-future-settings.md`

Mark the `defaultAgent` candidate in
`docs/plans/active/config-future-settings.md` as `picked` and add a
backlink to this plan. The candidate's surface area expanded
(implementer / reviewers / banList rather than a single
`defaultAgent` field) — note that in the entry.
