# Host MCP schema compatibility — design plan

**Status:** Draft v1 2026-05-16. Surfaced as a side finding during
the [`crew-iterate-skill.md`](./crew-iterate-skill.md) Phase 0
probes (2026-05-16). The MCP tool schemas crew-mcp publishes are
**rejected by Gemini** and **partially rejected by Codex** —
crew is unusable on Gemini and degraded on Codex without a fix.

---

## At a glance

**What.** Audit and fix the JSON Schema definitions for crew's
MCP tools so they're accepted across all three host MCP runtimes
(Claude Code, Codex, Gemini). Today's schemas use JSON Schema
constructs that Anthropic's MCP runtime accepts but Gemini's
OpenAPI-flavored validator and Codex's stricter Rust-side
deserializer reject.

**Why.** Empirical evidence from 2026-05-16:

1. **Gemini rejects crew entirely** with:
   `properties.peer_messages.items.properties.excerpts.items.properties.range.items must be a boolean or an object`.
   Root cause likely: `range` is defined as a tuple-style array
   schema (`items: [{type: 'integer'}, {type: 'integer'}]`), but
   Gemini's MCP validator expects `items` to be either a single
   object/schema OR a boolean, not an array. JSON Schema 2020-12
   allows the tuple form via `prefixItems`; older drafts allow
   `items` as an array, but Gemini follows the stricter modern
   spec.

2. **Codex rejects 3 tools** at MCP tool-conversion time:
   ```
   ERROR codex_core::tools::tool_search_entry: Failed to convert
   deferred MCP tool `mcp__crew__continue_run` to OpenAI tool:
   Error("data did not match any variant of untagged enum
   JsonSchemaType", line: 0, column: 0)
   ```
   Same error on `mcp__crew__run_agent` and `mcp__crew__run_panel`.
   Other crew tools (`get_run_status`, `list_runs`, `list_agents`,
   etc.) convert successfully. Suggests an issue specific to the
   tools that take a `peer_messages` array — most likely the
   same `excerpts.range` tuple-schema issue plus possibly the
   `peer_messages.items.properties.kind` enum-type expression.

**What this plan does NOT ship.**

- No changes to the crew tool *semantics* — same verbs, same
  arguments, same return shapes.
- No new MCP tools.
- No host-specific schema branches; one schema must satisfy all
  three runtimes.

**Cost.** ~0.5d. Mostly schema audit + a small refactor of the
`peer_messages.excerpts.range` definition to satisfy all three
validators.

---

## Goal

A single set of crew MCP tool schemas that:

1. Loads cleanly in Anthropic's MCP runtime (no regression on
   Claude Code).
2. Passes Gemini's MCP validator without "items must be a boolean
   or an object" rejections.
3. Passes Codex's `JsonSchemaType` deserialization for all crew
   tools.
4. Has a test fixture per host that validates the schema before
   shipping.

---

## Empirical evidence (2026-05-16)

### Gemini

Triggered by running any Gemini command that initializes the MCP
client:

```
$ gemini -p '/skills list'
Warning: Skipping extension in /Users/chasen/.gemini/extensions/crew: ...
Ripgrep is not available. Falling back to GrepTool.
Error when talking to Gemini API:
{
  "error": {
    "code": 400,
    "message": "schema at properties.peer_messages.items.properties.excerpts.items.properties.range.items must be a boolean or an object",
    "errors": [{
      "message": "schema at properties.peer_messages.items.properties.excerpts.items.properties.range.items must be a boolean or an object",
      "domain": "global",
      "reason": "badRequest"
    }],
    "status": "INVALID_ARGUMENT"
  }
}
```

The path `properties.peer_messages.items.properties.excerpts.items.properties.range.items`
points to the `range` array's items definition. **Confirmed root
cause:** `src/orchestrator/peer-messages/schema.ts:16` defines
`range: z.tuple([z.number().int().min(1), z.number().int().min(1)])`.
Zod's `tuple()` emits JSON Schema as:

```json
{
  "type": "array",
  "items": [
    { "type": "integer", "minimum": 1 },
    { "type": "integer", "minimum": 1 }
  ]
}
```

Gemini wants `items` to be a single object/schema or boolean.
The fix: use `prefixItems` (JSON Schema 2020-12) OR collapse to a
single uniform item schema (`items: { type: integer, minimum: 1 }`)
plus `minItems: 2, maxItems: 2`.

### Codex

Triggered by `codex exec` against a session that has crew MCP
configured:

```
ERROR codex_core::tools::tool_search_entry: Failed to convert
deferred MCP tool `mcp__crew__continue_run` to OpenAI tool:
Error("data did not match any variant of untagged enum
JsonSchemaType", line: 0, column: 0)

ERROR codex_core::tools::tool_search_entry: Failed to convert
deferred MCP tool `mcp__crew__run_agent` to OpenAI tool: ...
ERROR codex_core::tools::tool_search_entry: Failed to convert
deferred MCP tool `mcp__crew__run_panel` to OpenAI tool: ...
```

Only these three tools fail; they share the `peer_messages`
parameter. Other crew tools (no `peer_messages`) convert cleanly.
Hypothesis: the same root cause as Gemini — the tuple-style
`range` schema doesn't match Codex's Rust-side `JsonSchemaType`
enum variants. Codex serde'd `JsonSchemaType` likely only models
`items: SchemaObject | bool`, not `items: Vec<SchemaObject>`.

### Claude Code

No errors. Claude Code's MCP runtime accepts the tuple-style
`items` form. This is why the issue was invisible until probing
the other hosts.

---

## Goal — concrete schema fixes

### Fix 1: `peer_messages[].excerpts[].range` — array tuple → fixed-length uniform

Current (rejected by Gemini and Codex):
```json
{
  "range": {
    "type": "array",
    "items": [
      { "type": "integer", "minimum": 1 },
      { "type": "integer", "minimum": 1 }
    ]
  }
}
```

Proposed Zod definition (accepted by all three):
```ts
range: z.array(z.number().int().min(1)).length(2)
  .describe('Inclusive line range [start, end]. Both 1-indexed.')
```

Which emits JSON Schema:
```json
{
  "range": {
    "type": "array",
    "items": { "type": "integer", "minimum": 1 },
    "minItems": 2,
    "maxItems": 2,
    "description": "Inclusive line range [start, end]. Both 1-indexed."
  }
}
```

The runtime tools that read `range` already treat it as a pair
of numbers (`excerpt.range[0]` / `excerpt.range[1]` in
`prepend.ts:184` and `pipeline.ts:75`); the uniform-item form
is semantically equivalent and the `length(2)` bound enforces
the pair invariant. The TypeScript inferred type changes from
`readonly [number, number]` to `number[]`; callers that
destructure the pair need a length-2 narrowing helper, OR
keep the inferred `[number, number]` type via a Zod `.refine`
+ type cast at the boundary.

### Fix 2: audit all schemas for similar tuple constructs

Grep the codebase for `items: [` (array literal in schema
definitions) and convert each to uniform-item + `minItems` /
`maxItems`.

### Fix 3: add cross-host schema validation tests

For each crew MCP tool, run the published schema through:

1. **Ajv** (JSON Schema 2020-12 strict mode) — Anthropic baseline.
2. **OpenAPI-ish validator** — proxies Gemini's expectations
   (the rejection is shaped like an OpenAPI 3.x validator).
3. **A Rust crate that mimics codex's `JsonSchemaType` enum** OR
   integration test via `codex exec` that lists tools and asserts
   no conversion errors.

Add these as Phase 1 tests; fail the build if any host's
validator rejects.

---

## Phasing

### Phase 0 — empirical confirmation (~0.1d)

Already done by the `crew-iterate-skill.md` Phase 0 probes
(2026-05-16). Evidence captured above.

### Phase 1 — schema fixes + tests (~0.4d)

Touchpoints:
- The Zod (or equivalent) schemas in
  `src/orchestrator/tools/*.ts` that emit the `peer_messages`
  parameter. Likely a shared `peerMessageSchema` definition.
- Tool registration code that serializes schemas for MCP
  publication.
- Test fixtures under `test/orchestrator/schema-compatibility.test.ts`.

Exit criteria:
- All crew MCP tools pass Ajv strict-mode validation.
- All crew MCP tools pass an "OpenAPI-ish" validator equivalent
  to what Gemini uses.
- `codex exec` against a fresh session shows zero tool-conversion
  errors for any `mcp__crew__*` tool.
- A manual `gemini -p '/skills list'` (with crew MCP configured)
  no longer throws the `range.items` error.

### Phase 2 — regression guard (~0.05d)

Add a CI job (or pre-commit hook) that re-runs the cross-host
schema validation on every change to
`src/orchestrator/tools/*.ts`. Without this, the next schema
addition could silently break Gemini/Codex compatibility again.

---

## Risks

1. **Schema fixes break Anthropic compatibility.** Mitigation:
   Ajv strict-mode test catches this; round-trip a sample
   `peer_messages` payload through the new schema and confirm
   it validates.

2. **Other tuple constructs lurk elsewhere.** Mitigation: grep
   audit + cross-host validation for every tool, not just the
   three flagged.

3. **Gemini's validator is undocumented; we're reverse-engineering
   from the rejection message.** Mitigation: the proposed fix
   (`items: <schema>` + `minItems/maxItems`) is the JSON Schema
   2020-12 canonical form for fixed-length uniform arrays — every
   compliant validator accepts it. Risk is small.

4. **A future MCP feature requires array-tuple-style items.**
   Mitigation: deferred until needed. For now, no crew schemas
   benefit from heterogeneous-tuple `items`.

---

## Related issues (out of scope, may warrant separate plans)

- **Codex auth `TokenRefreshFailed`.** During Phase 0 probing
  (2026-05-16), `codex exec` showed
  `Server returned error response: invalid_grant: Invalid refresh
  token`. Likely a user-environment issue (codex login expired),
  not a crew bug. Surface in install docs if it recurs.
- **Gemini MCP schema-warning is hard to spot.** The error is
  buried in a stack trace alongside an unrelated extension
  warning. Worth surfacing more prominently in the user's first-
  use experience.

---

## Update log

- **2026-05-16 v1.** Initial draft. Surfaced during
  `crew-iterate-skill.md` Phase 0 probes; Gemini rejection
  blocks crew entirely on Gemini today; Codex rejects 3 tools.
