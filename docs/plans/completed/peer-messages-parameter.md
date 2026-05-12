# `peer_messages` parameter — design plan (standalone)

> **Status:** Shipped 2026-05-12. **Anchor commits:**
> `bd14ebb1` Phase 1 (schema + prepend + cap pipeline) → `f694cbf6`
> Phase 2 (`withStateLock` + async `RunStateStore`) → `cca6cf28`
> Phase 3 (run_agent / continue_run wiring + planner refactor +
> envelope warnings + captain skill) → `e81688e1` Phase 4 (verify
> probes + status doc baseline). Final test count: 937 passed /
> 5 skipped. Reviewed across all four phases (1 codex per phase
> + Claude code-reviewer added for Phase 3 where it caught
> blockers codex missed). Dogfood held for captain-driven live
> validation post-merge — see `skills/crew-captain.body.md`
> §Forwarding peer context for the captain-facing API doc.

**Status (original):** Draft v6 2026-05-11 (post round-5 review).
Extracted from [`captain-inbox-and-peer-messages.md`](../active/captain-inbox-and-peer-messages.md);
this plan is **authoritative** for the captain-to-worker prepend half.
Parent plan's peer_messages references (lines 1275-1404) are
superseded by this document.

### Round-5 review log (2026-05-11)

**Reviewers:** Claude `code-architect` **READY**; Codex `xhigh`
CHANGES NEEDED (same single finding); Codex `high` CHANGES NEEDED
(same single finding + test gap). All three reviewers converged on
ONE substantive correctness issue:

**Single finding:** R4-1's render-size-accounting includes file
labels, but first-message-force only truncates `body`. An item with
50 × 4 KB file labels (200 KB of labels alone) overshoots the 128 KB
hard ceiling, and body-truncation can't recover.

**v6 changes:**

- **[R5-1] First-message-force extends to metadata.** When item 0's
  rendered size exceeds hard ceiling, truncation proceeds in order:
  (a) excerpts dropped trailing-first until under hard ceiling; (b)
  if still over, files dropped trailing-first; (c) if still over,
  body truncated; (d) if even body=0 + no files + no excerpts is
  still over (only possible if `from_label` + headers + overhead
  exceed hard ceiling), throw `peer_messages.item_too_large:`. Each
  drop step emits a warning naming what was dropped.
- **[R5-2] Test plan adds "aggregate raised above default
  hardCeiling" direction.** Unit-test bullet now covers both override
  directions explicitly (Codex plain finding).
- **[R5-3] `validateCapRelationships` comment/code wording aligned.**
  v5's "prefer the more permissive" prose contradicted the
  reset-both-to-defaults code path. v6 prose says "both invalid →
  reset both" so prose and sketch agree (Codex xhigh finding).

---

### Round-4 review log (2026-05-11)

**Reviewers:** Claude `code-architect` (native subagent); Codex `xhigh`
with code-architect framing; Codex `high` plain review. Verdicts:
Claude **READY**; Codex xhigh **READY**; Codex plain CHANGES NEEDED
("Round 5, but it should be small"). All three flagged the same 3-5
surgical fixes; none architectural.

**v5 changes:**

- **[R4-1] File-path labels capped.** `files[]` items and
  `excerpts[].file` strings now have `.max(4096)` Zod refine. Render-
  size accounting includes label bytes so a long files list can't
  silently exceed aggregate/hard ceiling.
- **[R4-2] `buildPrependBlock` returns post-truncation messages.**
  Signature change so first-message-force body-truncation inside the
  renderer is reflected in stored `peer_messages_input`, preserving
  the byte-reproduction property.
- **[R4-3] Lock-reclaim wording tightened.** Phase 2 test for "dead
  PID reclaims" explicitly sets stale mtime AND dead PID. Changelog
  prose aligned with main sketch: "alive PID refuses reclaim;
  otherwise reclaim only when stale-mtime."
- **[R4-4] `consumeCapOverridesWarning` made conditional.** Only
  invoked when peer_messages were actually used in the dispatch
  (i.e., `peerMessagesInput.length > 0`). Avoids consuming the
  one-shot warning on a dispatch that didn't use peer_messages.
- **[R4-5] `validateCapRelationships` re-checks after upward
  overrides.** A user raising `aggregate` above the default
  `hardCeiling` would invert the relationship; v5 validates both
  directions and falls back symmetrically.

Round 4 issues that needed clarification (R3-5 partial, plus 5
minor stylistic gaps) are addressed via these 5 edits.

---

### Round-3 review log (2026-05-11)

**Reviewers:** Claude `code-architect` (native subagent); Codex `xhigh`
with code-architect framing; Codex `high` plain review. All three
verdict `CHANGES NEEDED`. Unanimous signal: architectural questions
have converged; round 4 should be surgical.

**Codex xhigh's key insight (R3-A1):** Move the composed-prompt cap
check INSIDE the lock, BEFORE `writeAtomic`/`update`. This eliminates
the entire rollback problem — no orphan turns, no `markDiscarded`
rollback for `run_agent`, no `revertLastTurn` for `continue_run`, no
atomicity gap. v4 adopts this restructuring; the simplification
removes ~50 lines of plan text and ~3 risk items.

**v4 changes** (tagged by round-3 finding ID):

- **[R3-A1] Drop rollback entirely.** Cap pipeline + render + composed-
  prompt cap check now run inside the lock BEFORE writeAtomic. If any
  cap fails, lock releases without mutating state.json. Removed:
  `revertLastTurn` API, `run_agent`'s `markDiscarded`-based rollback,
  the §Risks orphan-turn item.
- **[R3-1, all 3] `revertLastTurn` removed.** No longer needed; bonus,
  the invalid "idle status" wording is moot.
- **[R3-2, all 3] `run_agent` worktree-leak path removed.** With cap
  check moved before write, there's no rollback to leak from. (If
  validation throws BEFORE `planRunAgent` runs — count overflow — no
  worktree allocated. If validation throws INSIDE the lock — cap
  overflow — no state mutation; the worktree exists but no run_id is
  registered. Phase 3 cleanup: catch the lock-internal error in the
  `run_agent` handler and call `worktreeManager.cleanupByRunId(plan.runId)`
  before returning the error. Symmetric with existing
  `discard_run` cleanup at `serve.ts:597-606`.)
- **[R3-3, all 3] `aggregate_cap_reached_continued` branch dropped.**
  Subsequent items stop at aggregate cap, period. Hard ceiling only
  protects first-message-force (item 0). No env-conditional render
  branch. §Cap pipeline simplifies back to a 4-step pipeline whose
  step 4 is just "stop at aggregate."
- **[R3-4, Codex plain + Codex xhigh] State-lock root creation moves
  to `RunStateStore` construction.** Not module init. `crewHome` is
  runtime config injected via constructor; `RunStateStore` already
  creates `<crewHome>/runs/` at `run-state.ts:218`, so adding
  `<crewHome>/state-locks/` there is the right home. Phase 2 spec
  updated.
- **[R3-5, Codex xhigh + Claude] State-lock reclaim mirrors
  `worktree.ts:843-880` exactly.** Refuse reclaim when owner PID is
  alive (verified via `process.kill(pid, 0)` returning `0` or `EPERM`).
  Only reclaim on `ESRCH` (dead PID) OR stale `mtime` (>60s).
- **[R3-6, Codex plain] Stale error codes added.** Defined codes now
  include `peer_messages.run_unknown:`, `peer_messages.state_lock_timeout:`,
  `peer_messages.state_lock_unavailable:`.
- **[R3-7, Codex plain] `DispatchAndRespondArgs` + render-markdown
  warning plumbing made explicit.** Phase 3 adds
  `warnings?: readonly string[]` to `DispatchAndRespondArgs`
  (`serve.ts:799`), sets `env.warnings` at `serve.ts:873`, AND adds
  warning rendering to `renderDispatchMarkdown` (`serve.ts:918+`) so
  warnings show inline, not only in `structuredContent`.
- **[R3-8, Codex xhigh] `validateCapRelationships` returns
  `ResolvedCaps`.** Called from `RunStateStore` construction (cached
  for the lifetime of the serve instance). Returns the resolved caps
  with defaults swapped in on violation; logs a warn and surfaces a
  `peer_messages.cap_overrides_invalid` warning on the FIRST
  dispatch that uses peer_messages (so the user notices even if they
  don't watch logs).
- **[R3-A2, Codex xhigh] `toolCallId` preservation in `buildTask`.**
  Closure captures `toolCallId` at planner time; the `buildTask` call
  passes the same `toolCallId` so dispatch lifecycle events keep a
  stable correlation key.
- **[R3-A3, Codex xhigh] "No race today" framing tightened.** v3 said
  "today `appendPrompt` is sync, so concurrent calls run sequentially
  on Node's event loop." That's true WITHIN one serve process. ACROSS
  multiple serve processes against the same `crewHome` (rare but
  possible: two host CLI sessions both running `crew-mcp serve` against
  `~/.crew/`), the file-level race already exists. v4 reframes:
  `withStateLock` is the FIRST cross-process serialization for state
  mutations.

Round 2 issues that were partial in v3 (R2-3, R2-5, R2-12) are now
fully addressed via the R3 fixes above.

---

## At a glance

**What.** A new optional `peer_messages` parameter on `run_agent` and
`continue_run`. The captain passes structured peer context (body,
kind, files, excerpts, from_label) as an array; the dispatcher
allocates the turn, renders a byte-deterministic prepend block, and
threads the composed prompt to the adapter via a task-builder closure.
The block is recorded on
`state.json.prompts[turn].peer_messages_input` for audit (bounded).

**Why.** Replaces "captain hand-pastes run A's output into run B's
prompt as a freeform string." Wins: byte-deterministic rendering,
typed sender labels, fenced excerpts, hard caps, audit trail per
turn. Works for **all adapters** because it's a prompt prepend.

**What this plan does NOT ship.** The worker → captain inbox
(`send_message`, restricted serve, per-run tokens, handshake) —
parent plan's domain.

**Cost.** ~4.5 days across 4 phases (trimmed from v3's 5d after
rollback was dropped; the simplification gives back ~0.5d of Phase 2
and Phase 3 effort).

### One-direction flow

```
CAPTAIN                              WORKER B
  |                                     |
  | continue_run(B,                     |
  |   prompt: "review this",            |
  |   peer_messages: [{...}]            |
  | )                                   |
  |   * pre-flight count check          |
  |   * withStateLock(runId) {          |
  |       re-read state                 |
  |       check continuability          |
  |       allocate turn N               |
  |       run cap pipeline (truncate)   |
  |       render prepend block          |
  |       compose <block><userPrompt>   |
  |       check composed-prompt cap     |
  |         FAIL? release without write |
  |       writeAtomic state.json        |
  |     }                               |
  |   * (continue_run only) sync wt     |
  |   * buildTask(composedPrompt)       |
  |   * dispatcher.start            --> | (B sees prepended block + prompt)
```

The cap-check-inside-lock means **no rollback path is ever needed**.
State.json is mutated only after all validation succeeds.

### Key design decisions

- **No persistent storage for rendered block.** State.json holds raw
  validated/truncated input items, bounded by aggregate cap.
- **Works for every adapter.** All five (codex, claude-code, gemini-cli,
  generic, openai-compatible) receive the composed prompt byte-clean
  via `execa` argv (4) or JSON body (1).
- **Planner returns a task-builder closure.** Composition happens
  after state mutation; the closure pattern lets the prompt be
  determined inside the locked state transaction without coupling
  the planner to state.
- **Single-pass dispatch composition.** Turn allocation + rendering +
  audit-write + status flip happen inside one `withStateLock` call.
  No two-phase mutation.
- **No threading IDs.** No `peer_message_id`; audit keyed by
  `(turn, index)`.
- **No `kind`-based behavior branch.** Advisory hint only.

## Goal

Captain orchestrates structured peer context into a worker's prompt
at dispatch with a byte-deterministic prepend block. Smallest unlock:
implement-then-review with one reviewer.

## Non-goals

- Worker → captain `send_message` / inbox.
- Captain inbox tools (`check_captain_inbox`, `acknowledge_messages`).
- Per-run trust boundary / tokens / restricted serve.
- Worker handshake.
- Auto-continue / broadcast / `run_panel`.
- ACK sentinels.
- Cross-turn threading IDs.

## Open design questions

### Q1: Should `peer_messages` and `prompt` ever both be empty?

`continue_run` allows `peer_messages: [...]` with empty `prompt`;
rejects when BOTH empty (`peer_messages.no_op:`). `run_agent.prompt`
stays required.

### Q2: Backticks inside excerpts

Fence escalation 3 → 4 → … → 8; 8+ backtick runs truncate with marker.

### Q3: Body / excerpt overflow

Truncate body / excerpt text, record `body_truncated` /
`excerpt_truncations`, emit envelope warning. Dispatch proceeds.

### Q4: First-message-force semantics

Always render item 0 even if oversize after per-item truncation. If
its rendered size exceeds the hard ceiling, repair in order: drop
trailing excerpts → drop trailing files → truncate body → throw
`peer_messages.item_too_large:` if even body-empty with no
files/excerpts still overshoots (see §Cap pipeline step 3). Each
repair step emits a distinct envelope warning. Subsequent items
stop on aggregate cap overflow.

### Q5: Recoverability across captain restarts

Raw input items stored on
`state.json.prompts[turn].peer_messages_input` (post-validation,
post-truncation), bounded by aggregate cap. Rendered block is NOT
stored — re-render via `buildPrependBlock` if needed.

## Data model

### `peer_messages` input schema

```ts
// src/orchestrator/peer-messages/schema.ts
export const PEER_MESSAGES_SCHEMA_VERSION = 1;

// Zod max() values are anti-DOS ceilings (extremely loose); runtime
// caps own enforcement so env overrides take effect.
export const peerMessageInputSchema = z.object({
  body: z.string().min(1),
  kind: z.enum(['note', 'review', 'question', 'answer', 'status']).default('note'),
  from_label: z.string().max(80).optional()
    .refine(
      s => !s || !/[\x00-\x1f\x7f`#\r\n]/.test(s),
      'no control chars, backticks, newlines, or # in from_label'
    ),
  // File-path labels bounded by 4 KB each (longest sensible filesystem
  // path) so a pathological labels-list can't silently push past the
  // aggregate/hard ceiling.
  files: z.array(z.string().max(4096)).max(1000).optional(),
  excerpts: z.array(z.object({
    file: z.string().max(4096),
    range: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
    text: z.string(),
  })).max(1000).optional(),
});

export type PeerMessageInput = z.infer<typeof peerMessageInputSchema>;

// Server stamps these at dispatch; both stored and rendered:
export interface PeerMessageRendered {
  peer_messages_schema_version: 1;
  // Identity is (turn, index); no peer_message_id field.
  body: string;                                          // post-truncation
  kind: 'note' | 'review' | 'question' | 'answer' | 'status';
  from_label?: string;
  files?: readonly string[];
  excerpts?: ReadonlyArray<{
    file: string;
    range: readonly [number, number];
    text: string;                                        // post-truncation
  }>;
  rendered_at: string;                                   // ISO 8601 dispatch time
  rendered_in_turn: number;                              // server-allocated
  body_truncated?: { original_length: number };
  excerpt_truncations?: ReadonlyArray<{ index: number; original_length: number }>;
}
```

Top-level array on the call also uses a high static ceiling:
`z.array(peerMessageInputSchema).max(10000)`.

### State recording

```ts
type RunPromptRecord = {
  turn: number;
  prompt: string;                                        // user-supplied; truncatePromptForStorage applies
  peer_messages_input?: PeerMessageRendered[];           // post-truncation, bounded by aggregate cap
  startedAt: string;
  completedAt?: string;
  summary?: string;
  // ... existing fields ...
};
```

**Storage bound.** Per-turn `peer_messages_input` is bounded by the
aggregate cap (default 64 KB); per-turn `prompt` is bounded by
`truncatePromptForStorage` (default 16 KB). Worst-case per-turn
storage ≈ 80 KB. Across 50 turns ≈ 4 MB.

### Caps

| Item | Default | Override |
|---|---|---|
| Per-item `body` size | 16 KB | `CREW_PEER_MESSAGE_BODY_CAP_CHARS` |
| Per-item `excerpt.text` size | 4 KB | `CREW_PEER_MESSAGE_EXCERPT_CAP_CHARS` |
| Per-item excerpts count | 8 | `CREW_PEER_MESSAGE_MAX_EXCERPTS` |
| Per-call items count | 50 | `CREW_PEER_MESSAGES_MAX_ITEMS` |
| Aggregate rendered size | 64 KB | `CREW_PEER_MESSAGES_PREPEND_CAP_CHARS` |
| Hard prepend ceiling | 128 KB | `CREW_PEER_MESSAGES_HARD_CEILING` |
| Composed prompt total | 256 KB | `CREW_DISPATCH_PROMPT_CAP_CHARS` |

Max single-item rendered ≈ 16 KB body + 8 × 4 KB excerpts + overhead
= ~50 KB, fits within aggregate.

**Startup cap-relationship validator** (Phase 1):

```ts
interface ResolvedCaps {
  body: number;
  excerpt: number;
  maxExcerpts: number;
  maxItems: number;
  aggregate: number;
  hardCeiling: number;
  composedPromptCap: number;
  overridesInvalid?: string[];   // names of caps that were overridden invalidly and fell back to defaults
}

function validateCapRelationships(envCaps: Partial<ResolvedCaps>): ResolvedCaps {
  const resolved = { ...DEFAULTS, ...envCaps };
  const overridesInvalid: string[] = [];
  // Bidirectional: if aggregate is raised above hardCeiling, OR
  // hardCeiling is lowered below aggregate, either way the
  // relationship is broken. Reset whichever was overridden; if
  // both were overridden invalidly, fall back symmetrically to
  // defaults (see "both overridden" branch).
  if (resolved.hardCeiling < resolved.aggregate) {
    if (envCaps.hardCeiling !== undefined && envCaps.aggregate === undefined) {
      overridesInvalid.push('hardCeiling');
      resolved.hardCeiling = DEFAULTS.hardCeiling;
    } else if (envCaps.aggregate !== undefined && envCaps.hardCeiling === undefined) {
      overridesInvalid.push('aggregate');
      resolved.aggregate = DEFAULTS.aggregate;
    } else {
      // Both overridden invalidly: reset both to defaults
      // (deterministic recovery — don't try to pick a "winner").
      overridesInvalid.push('aggregate', 'hardCeiling');
      resolved.aggregate = DEFAULTS.aggregate;
      resolved.hardCeiling = DEFAULTS.hardCeiling;
    }
  }
  if (resolved.composedPromptCap < resolved.hardCeiling) {
    if (envCaps.composedPromptCap !== undefined) {
      overridesInvalid.push('composedPromptCap');
      resolved.composedPromptCap = Math.max(DEFAULTS.composedPromptCap, resolved.hardCeiling);
    } else {
      // composedPromptCap is default but hardCeiling was raised above it.
      resolved.composedPromptCap = resolved.hardCeiling;
    }
  }
  // Soft check: warn but don't override (caller may intentionally
  // set aggregate < worstCase to encourage truncation).
  const worstCasePerItem = resolved.body + resolved.maxExcerpts * resolved.excerpt + 4 * 1024;
  if (resolved.aggregate < worstCasePerItem) {
    logger.warn(
      `peer_messages aggregate cap (${resolved.aggregate}) is smaller than ` +
      `worst-case per-item render (${worstCasePerItem}); first-message-force ` +
      `will frequently exceed aggregate.`
    );
  }
  return overridesInvalid.length > 0 ? { ...resolved, overridesInvalid } : resolved;
}
```

Called once from `RunStateStore` construction (the same place
`crewHome` is injected and `<crewHome>/runs/` is created). The
resolved caps are cached on the store instance. If `overridesInvalid`
is non-empty, the first peer_messages dispatch surfaces a
`peer_messages.cap_overrides_invalid: <names>` warning on the
envelope.

### Cap pipeline (4 steps, executed in order)

1. **Pre-flight count check** (handler, BEFORE `planRunAgent`).
   - If `items.length > caps.maxItems`, reject
     `peer_messages.too_many:`.
   - For each item: if `excerpts.length > caps.maxExcerpts`, reject
     `peer_messages.too_many_excerpts:`.
   - These reject BEFORE worktree allocation.
2. **Per-item truncation** (inside locked `appendPrompt` / `create`).
   For each item:
   a. If `body.length > caps.body`, truncate and set `body_truncated`.
   b. For each excerpt: if `text.length > caps.excerpt`, truncate
      and record in `excerpt_truncations`.
3. **First-message-force render.** Render item 0. If its rendered
   size exceeds `caps.hardCeiling`, apply hard-ceiling repair in
   this order (each step emits a warning naming what was dropped):
   a. Drop trailing `excerpts` until under hard ceiling. Emit
      `peer_messages.hard_ceiling_dropped_excerpts: dropped N`.
   b. If still over, drop trailing `files` labels. Emit
      `peer_messages.hard_ceiling_dropped_files: dropped N`.
   c. If still over, truncate `body` with marker `[... truncated by
      hard prepend ceiling]`. Emit
      `peer_messages.hard_ceiling_reached`.
   d. If even `body=''` with no files and no excerpts still exceeds
      hard ceiling (the static headers + `from_label` + overhead
      alone overshoot — only possible with absurd env caps), throw
      `peer_messages.item_too_large:` from inside the lock. State
      not mutated.
4. **Subsequent items: aggregate cap stop.** For each subsequent
   item, in order:
   - Compute `would_be_rendered = rendered_so_far + item_rendered`.
   - If `would_be_rendered <= caps.aggregate`: render the item.
   - Else: stop, emit `peer_messages.aggregate_cap_reached: dropped
     N items` warning; do NOT include the dropped items in
     `peer_messages_input`.

(No env-conditional branches; aggregate is a hard stop. Hard ceiling
only ever applies to item 0 via step 3.)

Truncation/drop emit warnings on the envelope; reject errors fire
before any state mutation.

**Composed-prompt cap (inside the same lock, after step 4 render):**
- Compose `composed = rendered_block + user_prompt`.
- If `composed.length > caps.composedPromptCap`, throw
  `peer_messages.composed_prompt_too_large:` from inside the locked
  block. State.json is NOT mutated (writeAtomic happens AFTER this
  check). The lock releases on throw via the `finally` in `withStateLock`.

## Tool surface

### Modified tool: `continue_run`

```ts
export const continueRunInputSchema = z.object({
  run_id: z.string().min(1),
  prompt: z.string().default(''),                       // CHANGED: relax from min(1)
  peer_messages: z.array(peerMessageInputSchema).max(10000).optional(),
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});
```

**Pre-flight (handler, BEFORE adapter resolution / state mutation):**
- If `prompt === ''` AND (no `peer_messages` OR `peer_messages.length === 0`):
  reject `peer_messages.no_op:`.
- Count checks (step 1) → reject if exceeded.

**Authoritative continuability check (inside locked `appendPrompt`):**
- Re-read state.json INSIDE the lock.
- If `read()` returns `undefined`: throw `peer_messages.run_unknown:`.
- If `status === 'running'`: throw `peer_messages.run_in_flight:`.
- If `status` ∈ {`discarded`, `merged`, `merge_conflict`}: throw
  `peer_messages.run_terminal:`.

### Modified tool: `run_agent`

```ts
export const runAgentInputSchema = z.object({
  agent_id: z.string().min(1),
  prompt: z.string().min(1),
  peer_messages: z.array(peerMessageInputSchema).max(10000).optional(),
  // ... existing fields ...
});
```

Same pre-flight count check. Locked continuability check is N/A
(new run).

### Error code wire contract

All peer_messages errors return `{content: [{type: 'text', text}],
isError: true}` per existing `errorContent` (`serve.ts:1654`). Text
starts with namespaced prefix `peer_messages.<code>:`. Extraction
regex: `^peer_messages\.([a-z_]+):`. Collision-free with existing
tool-level errors like `'continue_run: ...'` (which match
`^([a-z_]+):` but not the namespaced form).

Defined codes:
- `peer_messages.no_op:` — both `prompt` and `peer_messages` empty
- `peer_messages.too_many:` — items count over cap
- `peer_messages.too_many_excerpts:` — per-item excerpts count over cap
- `peer_messages.run_unknown:` — run_id not found inside locked re-read
- `peer_messages.run_in_flight:` — concurrent dispatch caught inside lock
- `peer_messages.run_terminal:` — run in terminal state caught inside lock
- `peer_messages.composed_prompt_too_large:` — composed prompt over dispatch cap
- `peer_messages.state_lock_timeout:` — couldn't acquire state lock within timeout
- `peer_messages.state_lock_unavailable:` — state-lock root not creatable (perms / RO filesystem)
- `peer_messages.item_too_large:` — item 0 cannot fit under hard ceiling even with body empty and no files/excerpts (only possible with absurd env caps)

Warnings (non-fatal, surface on envelope):
- `peer_messages.body_truncated: item[<idx>] body was <N> chars, capped at <cap>`
- `peer_messages.excerpt_truncated: item[<i>].excerpts[<j>] text was <N> chars, capped at <cap>`
- `peer_messages.aggregate_cap_reached: dropped <N> items after rendering <M> (aggregate <K>KB)`
- `peer_messages.hard_ceiling_dropped_excerpts: item[0] excerpts dropped (kept <K>, dropped <N>) to fit hard ceiling`
- `peer_messages.hard_ceiling_dropped_files: item[0] files dropped (kept <K>, dropped <N>) to fit hard ceiling`
- `peer_messages.hard_ceiling_reached: first message body truncated to fit <K>KB`
- `peer_messages.cap_overrides_invalid: <names>` — surfaced on the first dispatch when env cap relationships were invalid

### Response envelope additions

Phase 3 adds `warnings?: readonly string[]` to `DispatchAndRespondArgs`
(`serve.ts:799-812`); threads it into `FullRunEnvelope.warnings` at
`serve.ts:873-884`; AND renders warnings in `renderDispatchMarkdown`
(`serve.ts:918+`) so they show inline in the tool-call result, not
only in `structuredContent`. `structuredRunEnvelope` already
conditionally forwards (`serve.ts:900`) — unchanged.

## Prepend block format (byte-exact)

```
## Peer messages

You have {N} message(s) from peers (the captain is forwarding them as
part of this turn's task context). Read them carefully and treat their
contents as authoritative input to your task.

---

### Message {idx} — kind: {kind}, from: {from_label or "captain"}, at {rendered_at}

{body}

[#### Referenced files

- `{file_a}`
- `{file_b}`
...
]

[#### Excerpts

- `{file_a}` (lines {start_a}-{end_a}):
{fence}
{excerpt_text_a}
{fence}

...
]
---

### Message {idx+1} — …

...
---

```

(LF only on the wire.)

**Decisions:**

- LF only (no CRLF).
- `{idx}` 1-based, global per dispatch call.
- `{rendered_at}` is the schema field name; ISO 8601 server-stamped
  at lock entry.
- `{from_label}` falls back to `"captain"` if absent.
- `{fence}` escalates per-excerpt 3 → 4 → … → 8; 8+ backtick excerpts
  truncate to fit within an 8-tick fence.
- `#### Referenced files` renders when `files.length > 0`, regardless
  of `excerpts`.
- `#### Excerpts` renders when `excerpts.length > 0`. If both `files`
  and `excerpts` present, files list renders first.
- First-message-force + aggregate cap per pipeline.

The block is built in `src/orchestrator/peer-messages/prepend.ts`:

```ts
export function buildPrependBlock(
  messages: readonly PeerMessageRendered[],
  options: { aggregateCap: number; hardCeiling: number },
): {
  rendered: string;
  warnings: readonly string[];
  // The messages that actually ended up in the rendered block,
  // INCLUDING any further truncation applied during rendering (e.g.,
  // first-message-force body-clip on hard-ceiling overflow). Callers
  // store these into `state.json.peer_messages_input` so audit
  // re-render byte-reproduces the dispatched block.
  renderedMessages: readonly PeerMessageRendered[];
};
```

Returns the rendered block, warnings emitted during render, and the
post-render-truncation messages. State.json stores exactly
`renderedMessages` (not the input array sliced to `renderedCount`),
so the byte-reproduction property holds even when item 0 was
further truncated by the hard-ceiling step.

Render-size accounting includes file-label bytes: each
`#### Referenced files` bullet adds `len(file) + 4` bytes (the `- \`,
\`` markdown wrappers); each `#### Excerpts` bullet adds
`len(file) + len(range_str) + ~20` bytes (the markdown bullet +
fence). The cap pipeline uses these adjusted sizes so a 50-file
list of 4 KB paths (200 KB of labels) correctly trips the
aggregate cap.

## Dispatch composition order

### `planRunAgent` refactor

Today `planRunAgent` returns `task: DispatchTask` whose `run` lambda
closes over `args.prompt` (`run-agent.ts:209-222`, prompt captured
at `:213` and consumed at `:347`). The task has no mutable `prompt`
field.

v4 splits the planner so task construction happens AFTER prompt
composition:

```ts
// run-agent.ts (after):
export interface RunAgentDispatchPlan {
  readonly kind: 'dispatched';
  readonly runId: string;
  readonly worktreePath: string;
  readonly readOnly: boolean;
  readonly adapter: AgentAdapter;
  readonly toolCallId: string;                                       // stable correlation key
  readonly buildTask: (composedPrompt: string) => DispatchTask;      // closure for late composition
}

export async function planRunAgent(input, ctx): PlanResult {
  // ... resolve agent, alloc worktree, resolve model/effort (unchanged) ...
  const toolCallId = randomUUID();
  const buildTask = (composedPrompt: string) =>
    buildAdapterDispatchTask({
      toolCallId,                          // captured; same value passed to dispatcher
      runId,
      adapter,
      prompt: composedPrompt,
      effectiveWorkingDirectory,
      worktreePath,
      readOnly,
      effectiveModel,
      effectiveEffort,
      worktreeManager: ctx.worktreeManager,
      input: { ...input },
    });
  return {
    kind: 'dispatched',
    runId,
    worktreePath,
    readOnly,
    adapter,
    toolCallId,
    buildTask,
  };
}
```

### `run_agent` handler flow

```ts
// serve.ts:357 (after):
// 1. Pre-flight count check (peer_messages.too_many, .too_many_excerpts).
const validatedInput = validatePeerMessagesPreflight(args.peer_messages, runStateStore.caps);

// 2. Plan (worktree alloc, adapter resolution).
const plan = await planRunAgent({...}, ctx);
if (plan.kind === 'error') return errorContent(plan.message);

// 3. State create + render + compose + cap check (atomic under lock).
let createResult;
try {
  createResult = await runStateStore.create({
    runId: plan.runId,
    agentId: args.agent_id,
    worktreePath: plan.worktreePath,
    initialPrompt: args.prompt,
    initialPeerMessagesInput: validatedInput,
    readOnly: plan.readOnly,
  });
} catch (err) {
  // Lock-internal errors (composed_prompt_too_large, state_lock_timeout)
  // throw BEFORE writeAtomic — state.json was not created. Clean up
  // the orphaned worktree allocated by step 2.
  if (!plan.readOnly) {
    try {
      await ctx.worktreeManager.cleanupByRunId(plan.runId);
    } catch (cleanupErr) {
      logger.warn(`run_agent cleanup after rejection failed: ${cleanupErr}`);
    }
  }
  return errorContent(err instanceof Error ? err.message : String(err));
}

const { composedPrompt, warnings } = createResult;

// 4. Build task with composed prompt.
const task = plan.buildTask(composedPrompt);

return runDispatchAndRespond({
  task,
  warnings,
  // ... existing args (runId, agentName, worktreePath, toolCallId from plan) ...
});
```

### `continue_run` handler flow

```ts
// serve.ts:385 (after):
// 1. Pre-flight read (existing) — cheap fast-fail.
const preState = runStateStore.read(args.run_id);
if (!preState) return errorContent(`Unknown run_id "${args.run_id}".`);

// 2. Pre-flight count check.
const validatedInput = validatePeerMessagesPreflight(args.peer_messages, runStateStore.caps);

// 3. No-op gate.
if (args.prompt === '' && validatedInput.length === 0) {
  return errorContent('peer_messages.no_op: continue_run requires either prompt or peer_messages');
}

// 4. Adapter / effort / model resolution (existing, unchanged).

// 5. State append + render + compose + cap check (atomic under lock).
//    Throws peer_messages.run_unknown / run_in_flight / run_terminal /
//    composed_prompt_too_large / state_lock_timeout if any check fails.
//    NO state mutation if any check fails.
let appendResult;
try {
  appendResult = await runStateStore.appendPrompt(args.run_id, {
    userPrompt: args.prompt,
    peerMessagesInput: validatedInput,
  });
} catch (err) {
  // Lock-internal rejection. No worktree cleanup needed (continue_run
  // does not allocate a worktree). State.json not mutated.
  return errorContent(err instanceof Error ? err.message : String(err));
}

const { state, composedPrompt, warnings } = appendResult;

// 6. Worktree sync (PRESERVED from serve.ts:448-460).
if (state.readOnly !== true) {
  try {
    await worktreeManager.syncUncommittedToRunWorktree(args.run_id);
  } catch (err) {
    logger.warn(`continue_run: uncommitted-state sync failed for ${args.run_id}: ${err}`);
  }
}

// 7. Build task with composed prompt.
const toolCallId = randomUUID();
const task = buildAdapterDispatchTask({
  toolCallId,
  runId: args.run_id,
  adapter,
  prompt: composedPrompt,
  effectiveWorkingDirectory: state.worktreePath,
  worktreePath: state.worktreePath,
  readOnly: state.readOnly === true,
  effectiveModel,
  effectiveEffort,
  worktreeManager,
  input: { ...args },
});

return runDispatchAndRespond({
  task,
  warnings,
  // ... existing args ...
});
```

### `appendPrompt` and `create` signatures (Phase 2)

```ts
// src/orchestrator/run-state.ts

interface AppendPromptOptions {
  readonly userPrompt: string;
  readonly peerMessagesInput?: readonly PeerMessageInput[];
}

interface AppendPromptResult {
  readonly state: RunStateV1;
  readonly turnNumber: number;
  readonly renderedPeerMessages: readonly PeerMessageRendered[];
  readonly composedPrompt: string;
  readonly warnings: readonly string[];
}

// async; wraps with withStateLock; ALL validation (cap pipeline,
// composed-prompt cap, continuability) happens inside the lock
// BEFORE the writeAtomic. Throws peer_messages.* errors on
// validation failure without mutating state.json.
async appendPrompt(runId: string, options: AppendPromptOptions): Promise<AppendPromptResult>;

interface CreateRunStateInit {
  // ... existing fields ...
  readonly initialPrompt: string;
  readonly initialPeerMessagesInput?: readonly PeerMessageInput[];
}

interface CreateRunStateResult {
  readonly state: RunStateV1;
  readonly renderedPeerMessages: readonly PeerMessageRendered[];
  readonly composedPrompt: string;
  readonly warnings: readonly string[];
}

async create(init: CreateRunStateInit): Promise<CreateRunStateResult>;
```

Inside `appendPrompt` (sketch — all validation BEFORE writeAtomic):

```ts
async appendPrompt(runId, options) {
  return withStateLock({crewHome: this.crewHome, runId}, async () => {
    // 1. Authoritative continuability check.
    const fresh = this.read(runId);
    if (!fresh) throw new Error(`peer_messages.run_unknown: ${runId}`);
    if (fresh.status === 'running')
      throw new Error(`peer_messages.run_in_flight: ${runId}`);
    if (['discarded','merged','merge_conflict'].includes(fresh.status))
      throw new Error(`peer_messages.run_terminal: ${runId} status=${fresh.status}`);

    // 2. Allocate turn.
    const turnNumber = fresh.prompts.length + 1;
    const now = new Date().toISOString();

    // 3. Per-item truncation (cap pipeline step 2).
    const truncated = truncateInputs(options.peerMessagesInput ?? [], now, turnNumber, this.caps);

    // 4. Render (cap pipeline steps 3-4). renderedMessages includes
    //    any further truncation buildPrependBlock applied (e.g.,
    //    first-message-force body-clip on hard-ceiling overflow).
    const { rendered, warnings: renderWarnings, renderedMessages } =
      buildPrependBlock(truncated, {
        aggregateCap: this.caps.aggregate,
        hardCeiling: this.caps.hardCeiling,
      });

    // 5. Compose.
    const composedPrompt = rendered + options.userPrompt;

    // 6. Composed-prompt cap check (THROWS without mutating state).
    if (composedPrompt.length > this.caps.composedPromptCap) {
      throw new Error(
        `peer_messages.composed_prompt_too_large: ${composedPrompt.length} > ${this.caps.composedPromptCap}`
      );
    }

    // 7. ONLY NOW: write state. Store the post-render-truncation form
    //    so audit re-render byte-reproduces.
    const nextState = this.update(runId, (s) => ({
      ...s,
      status: 'running',
      completedAt: undefined,
      serverPid: process.pid,
      prompts: [...s.prompts, {
        turn: turnNumber,
        prompt: truncatePromptForStorage(options.userPrompt),
        peer_messages_input: [...renderedMessages],
        startedAt: now,
      }],
    }));

    // 8. Surface cap_overrides_invalid warning, only if this dispatch
    //    actually used peer_messages.
    const capWarnings = (options.peerMessagesInput?.length ?? 0) > 0
      ? this.consumeCapOverridesWarning()
      : [];
    const warnings = [...renderWarnings, ...capWarnings];

    return {
      state: nextState,
      turnNumber,
      renderedPeerMessages: renderedMessages,
      composedPrompt,
      warnings,
    };
  });
}
```

`create` is analogous; writes `prompts[0]` with `initialPeerMessagesInput`
already validated. (Cap pipeline runs in create just like appendPrompt;
composed-prompt-cap throws BEFORE the writeAtomic.)

### State lock primitive (Phase 2)

```ts
// src/orchestrator/run-state-lock.ts (NEW)

interface WithStateLockOptions {
  readonly crewHome: string;
  readonly runId: string;
}

export async function withStateLock<T>(
  options: WithStateLockOptions,
  operation: () => Promise<T>,
): Promise<T>;
```

**Lock root creation.** `RunStateStore` constructor calls
`mkdirSync(<crewHome>/state-locks/, {recursive: true})` alongside
the existing `<crewHome>/runs/` mkdir at `run-state.ts:218`. If the
mkdir throws (read-only filesystem, perms drift), the constructor
propagates — `crew-mcp serve` startup fails fast with a clear
error. `withStateLock` does NOT lazy-create the root; the contract
is "if you got a RunStateStore instance, locking is available."

`crew-mcp verify` asserts that `<crewHome>/state-locks/` is writable
at startup; surfaces a clear failure if not.

**Per-run lock dir.** `<crewHome>/state-locks/<encodeURIComponent(runId)>/`.
Acquired via mkdir; `owner.json` written inside with `{ownerId,
pid, acquiredAt}`. Released via `rmSync(lockDir, {recursive: true,
force: true})` after ownerId match.

**Owner / reclaim heuristic (mirrors `worktree.ts:843-880` exactly):**

```ts
function canReclaimStateLock(lockDir: string): boolean {
  const record = readOwnerRecord(lockDir);
  // Refuse if owner PID is alive (verified via process.kill(pid, 0):
  // returns true if signal sent successfully, or false on ESRCH;
  // EPERM means process exists but is owned by another user).
  if (record?.pid && isProcessAlive(record.pid)) {
    return false;
  }
  return isStaleLock(lockDir);   // mtime > 60s
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) {
    return (typeof err === 'object' && err !== null
      && 'code' in err && (err as {code?: string}).code === 'EPERM');
  }
}
```

**Acquire loop.** Try mkdir. On `EEXIST`:
- Check `canReclaimStateLock` → if true, `rmSync` lock dir, retry.
- Else wait 50ms, retry.
- If `Date.now() > timeoutAt`, throw `peer_messages.state_lock_timeout:`.

Default `LOCK_TIMEOUT_MS=30000` (acquire timeout) and
`LOCK_STALE_MS=60000` (mtime threshold for reclaim).

**Lock scope: narrow.** Only `appendPrompt` and `create` are wrapped.
`markTerminal`, `markMerged`, `markMergeConflict`, `markDiscarded`
stay sync and unwrapped.

**Residual race (named, out of scope).** Concurrent `appendPrompt` +
`markTerminal` can still interleave through `update()`'s RMW at
`run-state.ts:335`. Pre-exists this plan; v4's lock reduces but
doesn't eliminate it. Parent plan's full state-lock sweep is the
proper fix.

**Cross-process posture.** The mkdir lock is filesystem-level, so it
serializes across multiple `crew-mcp serve` processes against the
same `<crewHome>`. Until v4, there is no cross-process serialization
for state mutations — two `serve` instances writing to the same
`state.json` concurrently could corrupt it. This is rare (most users
run one serve instance) but technically pre-exists.

**Interaction with worktree lock.** `withRunLock` (worktree-scoped,
`worktree.ts:993`) and `withStateLock` (state-scoped) never nest:
`run_agent` releases the worktree lock at the end of `createRunWorktree`
before `RunStateStore.create` runs; `continue_run` doesn't acquire
the worktree lock at all. No ordering invariants needed.

## Captain skill changes

Append to `skills/crew-captain.body.md`:

```markdown
## Forwarding peer context

You can pass structured peer context to a worker at dispatch time via
the `peer_messages` parameter on `run_agent` and `continue_run`. Use
it instead of pasting freeform strings into the prompt.

### `peer_messages`: captain → worker context

Both `run_agent` and `continue_run` accept an optional `peer_messages`
array. Each item is `{body, kind, from_label, files, excerpts}`. The
dispatcher prepends a typed block to the worker's prompt.

Use cases:
- Forward run A's output to run B's review prompt.
- Forward synthesized feedback from multiple reviewers back to the
  implementer.
- Provide structured "here's context you'll need" alongside a normal
  prompt.

### Pattern: implement-then-review

1. `run_agent(implementer, "implement X")` → run A.
2. Wait for A terminal.
3. Read A.summary + A.files_changed via `get_run_status`.
4. `run_agent(reviewer, "review this implementation",
   peer_messages: [{body: A.summary, kind: 'review', from_label: "A
   (implementer)", files: A.files_changed}])` → run B.
5. Wait for B terminal; read B.summary.
6. If revisions needed: `continue_run(A, peer_messages: [{body:
   B.summary, from_label: "B (reviewer)", kind: 'review'}],
   prompt: "revise per these findings")`.

Worker findings come back via the existing `terminal.summary` path.
There is no `send_message` / inbox return path in this plan.

### When NOT to use peer_messages

- Single freeform string of context: just put it in the prompt.
- One-shot forwarding where structure adds noise: prompt is fine.

`peer_messages` is for STRUCTURED forwarding where typed labels,
fenced excerpts, and audit records aid orchestration.

### `kind` is advisory

`note | review | question | answer | status`. Crew-mcp does NOT
branch on `kind`. Use it as a hint to the worker.

### Caps

Default per-item body: 16 KB; per-excerpt: 4 KB; excerpts per item:
8; items per call: 50; aggregate rendered: 64 KB; hard ceiling: 128
KB; composed prompt total: 256 KB.

Errors all use `peer_messages.<code>:` prefix. See plan for full
list. Truncation and drops emit `warnings` on the envelope (non-fatal).
```

## Edge cases

### Pre-flight vs lock-internal validation
Count checks fire before any allocation; truncation, render, composed-
prompt cap, continuability all fire INSIDE the lock and throw before
writeAtomic on failure. No state mutation on any rejection.

### Composed-prompt cap exceeded
Throws `peer_messages.composed_prompt_too_large:` from inside the
lock. State.json untouched. `run_agent` handler additionally cleans
up the worktree allocated by step 2 (no run_id registered, so the
worktree is orphaned otherwise).

### `peer_messages` aggregate cap reached
Trailing items dropped; warning emitted; `peer_messages_input`
stores only rendered items.

### Single item exceeds body cap
Truncated; `body_truncated` set; warning emitted.

### First-message-force overflow
Item 0 repaired in order: drop trailing excerpts → drop trailing
files → truncate body with marker → throw `peer_messages.item_too_large:`
if even body-empty with no files/excerpts still overshoots. Each
repair step emits a distinct envelope warning. See §Cap pipeline
step 3.

### Captain restart mid-dispatch
`appendPrompt` / `create` are atomic per call (state lock +
tmp+rename in `writeAtomic`). If captain dies between state mutation
and adapter dispatch, prompt record exists with `peer_messages_input`
but no terminal status. Existing stale-run sweeper handles on next
serve startup. Lock owner/reclaim recovers from dead-PID locks.

### Concurrent `continue_run` on the same run_id
Lock serializes. Second call's lock-internal continuability check
finds status=`running` (from first call's status flip), throws
`peer_messages.run_in_flight:`.

### Two serve processes on the same `crewHome`
Mkdir lock serializes them too. The slower acquirer waits up to
30s. If the faster process dies mid-lock, the slower process
reclaims via owner-PID + stale-mtime heuristic.

### Backticks inside excerpts
Fence escalation 3 → 4 → … → 8; 8+ truncate.

### Control chars / newlines / backticks / `#` in `from_label`
Zod refine rejects.

### `peer_messages` on a read-only run
Allowed; prepend block in prompt the same way. No worktree to clean
up on rejection (read-only `run_agent` doesn't allocate one).

### Worker prompt approaches ARG_MAX
Composed-prompt cap (256 KB default) keeps argv well under macOS
ARG_MAX (~1 MB) and Linux (~2 MB).

### `truncatePromptForStorage` interaction
User `prompt` on `state.json.prompts[].prompt` is truncated at
16 KB (existing behavior); `peer_messages_input` is stored
post-pipeline (bounded by aggregate cap). Audit reconstruction is
partial when user prompt > 16 KB — see §Risks.

### Env override misuse
`validateCapRelationships` resolves invalid override permutations:
- Lowered hardCeiling below default aggregate → reset hardCeiling.
- Raised aggregate above default hardCeiling → reset aggregate.
- Both overridden invalidly → reset both (deterministic recovery).
- Lowered composedPromptCap below resolved hardCeiling → reset to
  `max(default, hardCeiling)`.
- Raised hardCeiling above default composedPromptCap (no explicit
  composedPromptCap override) → silently raise composedPromptCap to
  match (user implicitly wanted the chain to stay valid).

The first dispatch that uses peer_messages surfaces a
`peer_messages.cap_overrides_invalid: <names>` warning on the
envelope. Subsequent dispatches don't repeat the warning (consumed
once).

### State lock root not creatable at construction
`RunStateStore` constructor throws if `mkdirSync(<crewHome>/state-locks)`
fails. `crew-mcp serve` startup fails with a clear message. `crew-mcp
verify` asserts writability up front.

### State lock acquire times out
`peer_messages.state_lock_timeout:` after 30s. Most acquisition
contention is microseconds; a 30s timeout suggests a held-and-leaked
lock that the reclaim heuristic couldn't free (process alive but
hung).

## Risks

- **Adapter prompt length.** All adapters pass `task.prompt` via
  argv (`codex.ts:401`, `claude-code.ts:456-458`,
  `gemini-cli.ts:290`, `generic.ts:83-94`) except
  `openai-compatible.ts:77` (JSON body). `execa` skips shell so
  encoding is byte-clean. With composed-prompt cap 256 KB, argv stays
  well under ARG_MAX on macOS and Linux.
- **`withStateLock` extraction cost.** ~60-line async helper
  including owner/reclaim heuristic mirroring `worktree.ts:843-880`.
  Phase 2 budget includes it; the worktree primitive is the
  reference implementation.
- **Test sweep size.** ~33 sites in `test/orchestrator/run-state.test.ts`
  need `await` after `appendPrompt` / `create` become async. Phase 2
  estimate includes this.
- **Residual `appendPrompt` vs `markTerminal` race.** Pre-exists.
  Named in §State lock primitive as out-of-scope. If it bites during
  dogfood, parent plan's full state-lock sweep is the fix.
- **Audit-trail gap when user prompt > 16 KB.** Existing
  `truncatePromptForStorage` clips the tail. The audit reconstruction
  (peer_messages_input + prompts[].prompt + buildPrependBlock) doesn't
  byte-reproduce the dispatched prompt when the user pasted a >16 KB
  string into `prompt`. Pre-existing behavior; not introduced here.
  Captains who care about full reconstruction should put the large
  context in `peer_messages.body` (capped at 16 KB per-item but kept
  in `peer_messages_input`).
- **State.json size with env overrides.** Aggregate cap env override
  directly bounds per-turn `peer_messages_input` size. A user
  setting `CREW_PEER_MESSAGES_PREPEND_CAP_CHARS=1048576` scales
  state.json to ~1 MB/turn. Documented in §State recording; no hard
  cap enforced.
- **Scope creep.** Resist mid-implementation pressure to add inbox /
  send_message / threading. Each "small addition" trades against the
  4.5-day budget.

## Testing

### Unit tests (Phase 1)

- `peerMessageInputSchema` validation matrix: each refinement
  (control chars, newlines, backticks, `#` in from_label);
  static `.max(...)` ceilings confirm env overrides aren't bounded.
- `validateCapRelationships`:
  - **Lowered hard ceiling direction:** `hardCeiling < aggregate` via
    `CREW_PEER_MESSAGES_HARD_CEILING` lowered below default →
    `overridesInvalid` contains `hardCeiling`; `hardCeiling` reset to
    default.
  - **Raised aggregate direction:** `aggregate > hardCeiling` via
    `CREW_PEER_MESSAGES_PREPEND_CAP_CHARS` raised above default →
    `overridesInvalid` contains `aggregate`; `aggregate` reset to
    default.
  - **Both overridden invalidly:** `overridesInvalid` contains
    `aggregate, hardCeiling`; both reset to defaults.
  - `composedPromptCap < hardCeiling` (explicitly overridden) →
    `overridesInvalid` contains `composedPromptCap`; reset to
    `max(DEFAULTS.composedPromptCap, hardCeiling)`.
  - `composedPromptCap < hardCeiling` via raised `hardCeiling` only
    → silently raise `composedPromptCap` to match (no
    `overridesInvalid` entry; user implicitly wanted the chain to
    stay valid).
  - `aggregate < worstCasePerItem` → warns via logger but doesn't
    override.
  - Resolved caps returned; defaults swapped only for fields that
    failed.
- `buildPrependBlock` golden tests: zero / one / many; with/without
  files / excerpts / from_label / `body_truncated` /
  `excerpt_truncations`. LF-only byte-exact.
- Fence escalation 3 → 4 → … → 8; 8+ backtick excerpt truncates.
- Cap pipeline:
  - Pre-flight: count overflow → `peer_messages.too_many:` /
    `peer_messages.too_many_excerpts:`.
  - Step 2: body / excerpt truncation produces correct markers and
    truncation records.
  - Step 3: first-message-force renders oversize item; hard-ceiling
    repair pipeline:
    - Item 0 with body+files fits but excerpts push over → drop
      trailing excerpts; warning emitted.
    - Item 0 with body+files alone over → drop excerpts then drop
      trailing files; warning emitted (both).
    - Item 0 with body alone over (no files/excerpts) → truncate
      body; `peer_messages.hard_ceiling_reached` warning.
    - Item 0 with `from_label` + overhead alone > hard ceiling
      (absurd env caps) → throw `peer_messages.item_too_large:`;
      state not mutated.
  - Step 4: aggregate cap stop drops trailing items; only rendered
    items in `peer_messages_input`.
  - No `aggregate_cap_reached_continued` branch exists.
- `(turn, index)` keying confirmed; no `peer_message_id` in fixtures.

### Unit tests (Phase 2)

- `withStateLock` mkdir lock under `<crewHome>/state-locks/`;
  acquires/releases.
- Lock root creation by `RunStateStore` constructor; missing perms
  → constructor throws.
- Lock contention: concurrent acquire → second waits → first releases
  → second acquires.
- Lock reclaim on dead PID + stale mtime: write `owner.json` with
  `pid=<dead>` AND set the lock dir's mtime > 60s ago; acquire-attempt
  reclaims after retry. (The reclaim heuristic requires BOTH: a
  non-alive PID AND a stale mtime; mirrors `worktree.ts:843-848`.)
- Lock reclaim on alive PID + stale mtime: write `owner.json` with
  `pid=process.pid` and old mtime; reclaim REFUSED (alive guard wins).
- Lock reclaim on dead PID + recent mtime: reclaim REFUSED (stale-mtime
  guard prevents reclaim when the lock was acquired very recently
  even by a now-dead process — the alive process may have crashed
  mid-acquire).
- Lock timeout: hold lock for >30s, expect `peer_messages.state_lock_timeout:`.
- `appendPrompt` lock-internal validation:
  - `read()` returns undefined → throws `peer_messages.run_unknown:`.
  - Status `running` → throws `peer_messages.run_in_flight:`.
  - Status terminal → throws `peer_messages.run_terminal:`.
  - Composed prompt too large → throws
    `peer_messages.composed_prompt_too_large:`. **Verify state.json
    not mutated after throw** (re-read shows prior turn count).
- `appendPrompt` strictly-increasing turn numbers under concurrent
  contention.
- `create` writes turn-1 audit record with `initialPeerMessagesInput`.
- Composed-prompt-cap throw in `create` leaves state.json absent
  (run dir may exist but no state.json).

### Integration tests (Phase 3)

- `run_agent` + `peer_messages`: captured worker prompt argv
  contains the prepend block byte-for-byte;
  `state.json.prompts[0].peer_messages_input` matches.
- `continue_run` + `peer_messages`: same; verifies the planner
  refactor compiles and runs end-to-end.
- Each adapter (codex, claude-code, gemini-cli, generic,
  openai-compatible) receives the prepend block via fixture probes.
- `peer_messages.no_op:` rejection.
- `peer_messages.too_many:` rejection BEFORE worktree allocation
  (verify with worktree-count probe).
- `peer_messages.run_in_flight:` rejection on concurrent
  `continue_run` (race test).
- `peer_messages.composed_prompt_too_large:` rejection on `run_agent`
  cleans up worktree (verify no orphan worktree remains).
- `peer_messages.composed_prompt_too_large:` rejection on `continue_run`
  leaves prior state intact (verify state.json identical pre- and
  post-rejection).
- Env overrides take effect (`CREW_PEER_MESSAGES_MAX_ITEMS=5`, send
  6 → reject; without env, accept 6).
- `cap_overrides_invalid` warning fires on first dispatch when env
  is misconfigured; doesn't fire again on second dispatch.
- Body / excerpt truncation surfaces on envelope `warnings`.
- Aggregate cap drop warning on envelope.
- `CREW_FULL_ENVELOPE=1` full envelope and default mode both surface
  `warnings`; `renderDispatchMarkdown` includes warnings inline.
- `continue_run` worktree sync (`syncUncommittedToRunWorktree`)
  still runs after `appendPrompt` (regression guard).
- `toolCallId` is stable across `planRunAgent` → `buildTask` →
  dispatcher (correlation key preserved).

### Property tests

- Random valid `peer_messages` arrays render to byte-identical blocks
  given the same inputs and runtime caps.
- Round-trip: write `peer_messages_input` to state.json, read back,
  re-render → byte-identical to the originally-rendered block.

## Phasing

### Phase 1 — schema, prepend builder, cap pipeline

- `src/orchestrator/peer-messages/schema.ts` — types + Zod (5-kind
  enum, body/excerpt/from_label validators with tightened refines).
  Static `.max(...)` set to anti-DOS ceilings (10000 / 1000 / 1000).
- `src/orchestrator/peer-messages/caps.ts` — env-resolved runtime
  cap reads + `validateCapRelationships` returning `ResolvedCaps`.
- `src/orchestrator/peer-messages/prepend.ts` — pure function
  `buildPrependBlock(messages, options)` implementing first-message-
  force, aggregate cap stop, fence escalation, files+excerpts
  rendering.
- `src/orchestrator/peer-messages/pipeline.ts` — orchestrates step 2
  (per-item truncation) and step 3-4 invocation via `buildPrependBlock`.
- `src/orchestrator/peer-messages/preflight.ts` — handler-level
  count check `validatePeerMessagesPreflight(input, caps)` that runs
  before worktree allocation.
- Unit tests per §Testing Phase 1.

**Estimate:** 1 day.

### Phase 2 — `withStateLock` primitive + RunStateStore migration

- `src/orchestrator/run-state-lock.ts` (NEW) — mkdir-based lock with
  owner/reclaim, mirroring `worktree.ts:843-880` heuristics. ~60
  lines. Constructor-creates `<crewHome>/state-locks/`.
- `RunStateStore` constructor: extend to call
  `mkdirSync(<crewHome>/state-locks/)` and `validateCapRelationships`;
  cache `caps` on the instance; track an `overridesInvalidPending`
  flag for first-dispatch warning surfacing.
- `RunStateStore.appendPrompt` migrates to async + options form;
  wraps with `withStateLock`; runs cap pipeline AND composed-prompt
  cap check inside lock BEFORE `update()`/writeAtomic. Throws
  named errors on failure; no state mutation on throw.
- `RunStateStore.create` migrates similarly with
  `initialPeerMessagesInput`. Composed-prompt-cap throw in `create`
  leaves the run dir empty (no state.json); handler is responsible
  for worktree cleanup on this path (run_agent's catch block).
- Call-site sweep:
  - Prod sites: `serve.ts:357` (run_agent), `serve.ts:446`
    (continue_run). Both already in async handlers; add `await` +
    try/catch.
  - Test sites: `test/orchestrator/run-state.test.ts` (~33 sites).
- Unit tests per §Testing Phase 2.

**Estimate:** 1.25 days (1d core + 0.25d test sweep).

### Phase 3 — `peer_messages` parameter wiring

- `continueRunInputSchema`: relax `prompt` to `default('')`, add
  `peer_messages` field.
- `runAgentInputSchema`: add same `peer_messages` field; prompt
  stays required.
- `planRunAgent` refactor: returns `buildTask: (composedPrompt) =>
  DispatchTask` closure + `toolCallId` for correlation.
- `continue_run` handler per §`continue_run` handler flow:
  - Pre-flight read + count check + no-op gate.
  - Adapter/effort/model resolution (unchanged).
  - `appendPrompt` call wrapped in try/catch.
  - `syncUncommittedToRunWorktree` (preserved).
  - `buildAdapterDispatchTask(composedPrompt)`.
- `run_agent` handler per §`run_agent` handler flow:
  - Pre-flight count check.
  - `planRunAgent`.
  - `create` call wrapped in try/catch; on catch, clean up worktree
    via `worktreeManager.cleanupByRunId(plan.runId)`.
  - `plan.buildTask(composedPrompt)`.
- `DispatchAndRespondArgs` adds optional `warnings`; thread into
  `FullRunEnvelope.warnings` at `serve.ts:873`; add warnings
  rendering in `renderDispatchMarkdown` (`serve.ts:918+`).
- Error wire-contract codes all use `peer_messages.<code>:` prefix.
- Integration tests per §Testing Phase 3.

**Estimate:** 1.75 days (1d core + 0.25d planner refactor + 0.5d
adapter integration test matrix).

### Phase 4 — captain skill + status doc + dogfood

- Update `skills/crew-captain.body.md` with the "Forwarding peer
  context" section.
- Update `docs/status/captain-flow-review-2026-04-29.md` baseline.
- Update `crew-mcp verify` to assert `<crewHome>/state-locks/` is
  writable and the peer_messages parameter validates correctly under
  default caps.
- Dogfood: 2 real implement-then-review tasks end-to-end. Verify
  state.json audit records contain post-pipeline `peer_messages_input`.

**Estimate:** 0.5 days.

**Total: ~4.5 days.** Phase 1: 1d; Phase 2: 1.25d; Phase 3: 1.75d;
Phase 4: 0.5d. Could trim to 4d if the test sweep is mechanical and
the adapter matrix uses a shared fixture probe. Could grow to 5-5.5d
if owner/reclaim has macOS-vs-Linux PID semantics issues during the
test sweep.

## Future work

When the captain accumulates evidence the inbox / `send_message`
side is worth building, return to the parent plan
[`captain-inbox-and-peer-messages.md`](./captain-inbox-and-peer-messages.md).
This plan's prepend builder, schema, state.json audit fields, cap
pipeline, `withStateLock` primitive, planner refactor, and validator
are reusable as-is.

Other deferred items:
- ACK signals for "did the worker attend to peer_messages."
- `peer_message_id` + `in_reply_to_peer_message_id` for prior-turn
  threading.
- Broadcast / `run_panel` tool.
- Auto-continue daemon.
- Cancel-then-steer atomic.
- Full state-lock sweep (parent plan) — closes the residual
  `appendPrompt`-vs-`markTerminal` race.
