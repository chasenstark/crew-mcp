# Captain inbox + `peer_messages` — design plan

**Status:** Final v9 2026-05-11 (architecturally converged after 8
review rounds). Own code-architect verdict READY at rounds 7-8;
Codex verdict tightened with each round but kept finding surgical
phase-ownership and stale-text issues. v9 closes the architecturally
real items Codex flagged in round 8 (Phase 1 → Phase 2/3/5 compile
dependencies; wx flag spec correction) and accepts residual
stale-text drift as cosmetic-resolve-at-implementation. See §"Round
8 review log" for the convergence rationale and §"Round 1-7 review
logs" for full history.
**Predecessor:** [`inbox-send-message.md`](../completed/inbox-send-message.md) — captain-only
inbox plan ratified across 7 review rounds. After design discussion the
captain-to-worker direction is well-served by direct prompting, so this
plan supersedes it: it descopes captain-to-worker storage (replacing it
with an inline `peer_messages` parameter on `continue_run`) and brings
worker-to-captain forward into v1 with a restricted trust boundary.
**Inspiration:** CAO's `send_message` + watchdog inbox model.

## At a glance

**What.** Two complementary capabilities:

1. **Captain → worker** via a new `peer_messages` parameter on
   `continue_run` and `run_agent`. The captain inlines structured peer
   context (body, files, excerpts) at dispatch time; the dispatcher
   prepends a typed block to the agent's prompt. No storage layer.
2. **Worker → captain** via a worker-callable `send_message` tool that
   writes into a per-repo captain inbox. Captain reads the consolidated
   inbox via `check_captain_inbox`. Trust boundary is a per-run token in
   a 0600 sidecar; workers run a restricted `crew-mcp serve` mode that
   exposes only `send_message`.

**Why.** The architectural payoff is on the worker-to-captain return
path: workers reporting structured findings into one inbox lets the
captain orchestrate multi-panel reviews and large feature work without
polling each run's terminal status and scraping output streams. The
captain-to-worker direction is well-served by direct prompting (the
captain composes the body in chat regardless), so its storage layer was
descoped. The inline `peer_messages` parameter keeps the structured
prepend block (template, first-message-force, hard ceiling) without the
claim/delivery transaction.

**Cost.** ~10.25 days across 6 phases (v7 estimate after round-6
fixes). Trajectory: v1=5.5-6.5d, v2=8.5-10d, round-2=13-16d, v3=9-11d
("already plumbed" claim was false), v4=12-14d, v5=9.5d (descope),
v6=9.5d (gemini defense + cleanup), v7=10.25d (added `revertTurn`
API, planner→task-builder-closure refactor, full per-step rollback
paths).

### Two-direction flow

```
CAPTAIN                              WORKER B (Codex)
  |                                     |
  | run_agent(codex, "...") ----------> |
  |   * generate per-run token          |
  |   * write ~/.crew/runs/B/.auth.json |
  |   * spawn adapter w/                |
  |     CREW_RUN_ID + CREW_RUN_TOKEN -->| (codex starts; worker MCP
  |                                     |  boots in restricted mode)
  |                                     |
  |                                     | (codex implements...)
  |                                     |
  |                                     | send_message({
  |                                     |   body: "<findings>",
  |                                     |   kind: 'review',
  |                                     |   files: [...]
  |                                     | })
  |                                     |   * validate token
  |                                     |   * stamp `from` + repo
  |                                     |   * write to
  |                                     |     ~/.crew/captain-inbox/
  |                                     |     <repoHash>/<msgId>.json
  |                                     | (terminal)
  |                                     |
  | check_captain_inbox()               |
  |  <- [{from: B, kind, body, files}]  |
  |                                     |
  | continue_run(A,                     |
  |   prompt: "<synthesized plan>",     |
  |   peer_messages: [{                 |
  |     body: "<from B's msg>",         |
  |     from_label: "B (codex review)"  |
  |   }]                                |
  | ) -- dispatcher prepends to A ----> | (A sees prepended block)
```

### Scope (v1 vs v2)

| In v1 | Deferred to v2 |
|---|---|
| Worker -> captain `send_message` (codex + claude-code only) | Worker -> worker `send_message`; gemini / generic / openai-compatible worker `send_message` |
| Captain -> worker via `peer_messages` (inline; all adapters) | Captain -> worker via durable inbox (storage) |
| `check_captain_inbox` (captain reads) | `read_inbox` for individual run inboxes |
| Per-run token in 0600 sidecar | Cryptographic capability tokens |
| Single-repo, single-host | Cross-machine messaging |
| Captain dispatches N reviewers in parallel | Broadcast / `run_panel` (separate plan) |
| Worker findings via MCP `send_message` (Tier 2) OR `terminal.summary` (non-Tier-2) | Output-stream parser; raw output capture; ACK sentinels |

### Key design decisions

- **No persistent inbox for captain -> worker.** The captain composes
  bodies in chat regardless; storing them in a per-run inbox doesn't
  save context or enable functionality the captain can't already do
  inline. `peer_messages` is a structured `continue_run` parameter
  whose prepend rendering matches the v7 template (first-message-force,
  hard ceiling, fence escalation).
- **Worker -> captain has a fail-closed trust boundary in v1.** Per-run
  token written to `~/.crew/runs/<runId>/.auth.json` (mode 0600) at
  dispatch. Worker's `crew-mcp serve` runs in restricted mode
  (env-triggered): registers only `send_message`, validates token
  against the sidecar, stamps `from` from the validated identity.
  **Fail-closed semantics:** partial env (one of CREW_RUN_ID /
  CREW_RUN_TOKEN missing) → refuse to start; sidecar mode != 0600 →
  refuse to start; token mismatch → refuse to start. Token re-issued
  at every dispatch (run_agent OR continue_run); old token revoked
  before new spawn so a stale subprocess can't reuse it.
- **One captain inbox per repo.**
  `~/.crew/captain-inbox/<repoHash>/<msgId>.json` where `repoHash` is
  `sha256(repoRoot).slice(0, 12)`. Workers can only write to the
  repoHash bound to their token. Captain reads via
  `check_captain_inbox`.
- **Workers cannot address peers.** `send_message`'s `to` field is
  fixed to `{kind: 'captain'}` in v1 (implicit; not user-supplied).
  This sidesteps the peer-addressing trust complexity.
- **Captain inbox messages are simple: unread / read / dismissed.**
  No claim/delivery transaction (workers write, captain reads).
- **Adapter compatibility (post-spike, v5 descope).** Two
  categories:
  - **Tier 2 (codex, claude-code)**: per-invocation MCP env injection
    via argv/inline-JSON. Workers get the `send_message` MCP tool;
    findings land in captain inbox with full structure (kind, files,
    excerpts, threading).
  - **Non-Tier-2 (gemini-cli, generic, openai-compatible)**: no
    per-invocation MCP env, OR no MCP child at all. Workers do NOT
    have `send_message`; findings are reported via `terminal.summary`
    only (status quo). Captain reads via `get_run_status`.
  - **Tier 1 (ambient env propagation) does not exist** — codex
    `env_clear()`s; gemini sanitizes env names matching `/TOKEN/i`.
  - Output-stream parser / raw output capture / ACK sentinels —
    descoped to v2 (see §"Future work"). The complexity-to-value
    ratio didn't earn v1 inclusion (round-4 iteration repeatedly
    found new bugs in these parsers).
- **Handshake is background, not on dispatch path.** v3 runs the
  `.worker-ready.json` check in a detached task; result lives on
  `state.json.worker_ready`; first `check_captain_inbox` /
  `get_run_status` reads it.
- **Per-run dispatch transaction.** Critical section per run
  spanning: status compare-and-set, sidecar revoke + issue, prompt
  append (or create), status flip to running, install lifecycle
  listeners, `dispatcher.start`. Two concurrent `continue_run` calls
  serialize on the state lock.

---

## Goal

Two narrow capabilities that compose into the multi-agent workflows the
captain actually needs:

- **Captain orchestrates structured peer context** into a worker's
  prompt at dispatch, with the same byte-deterministic prepend block
  agents will see across multiple-message panels.
- **Workers report findings back** to the captain without the captain
  having to poll each run's terminal status and scrape output streams.

The smallest unlock is a 3-agent panel review:

```
captain dispatches A (implementer)         -> A produces diff
captain dispatches B,C,D (reviewers) with peer_messages: [{body: A's diff}]
B,C,D each call send_message({body: <findings>, kind: 'review'})
captain check_captain_inbox -> 3 typed reviews, sender-stamped
captain synthesizes; continue_run(A, peer_messages: [{body: <synth>, ...}])
```

No hand-copying of A's diff into B/C/D's prompts; no terminal-polling
of B/C/D individually; one inbox read for all three reviews.

## Non-goals (v1)

- **Worker -> worker messaging.** Workers cannot address peers in v1.
  `send_message`'s `to` field is implicitly `{kind: 'captain'}` and
  rejects any other value.
- **Read-back of captain-to-worker history.** Captain's `peer_messages`
  go into the prompt and are recorded on `state.json.prompts[].peer_messages`
  for audit. There is no separate retrieval tool — the captain composed
  them and has them in chat.
- **Auto-continue.** When a worker writes to captain inbox, crew-mcp
  does NOT automatically wake the captain. Captain checks the inbox
  on its own cadence (typically as part of a scheduled `crew-wait`
  watcher firing on worker terminal).
- **Broadcast / fan-out tools.** Captain dispatches each reviewer
  individually with `run_agent`. Broadcast lives in v2's `run_panel`.
- **Cross-machine messaging.** Inbox is local-disk only.
- **Encrypted-at-rest sidecar.** 0600 file permissions only; relies on
  OS user account isolation.

## Open design questions

### Q1: Should `peer_messages` and `prompt` ever both be empty?

Today `continue_run` requires `prompt.length > 0`. With `peer_messages`,
captain might want "just deliver this peer context, no extra prompt."

**Recommendation:** allow `peer_messages: [{...}]` with empty
`prompt`; reject only when BOTH are empty. The dispatcher's prepend
block already terminates with `---\n\n` and the empty-prompt case just
means the agent's prompt is the prepend block alone. New rejection
code: `continue_run_no_op` (matches v7 plan).

### Q2: Captain inbox auto-cleanup

Captain inbox grows unbounded if not pruned. After how long should
read messages be auto-deleted?

**Recommendation:** keep `unread` forever, auto-delete `read` and
`dismissed` after 7 days (configurable via
`CREW_CAPTAIN_INBOX_RETENTION_DAYS`). Sweep runs at serve startup and
on `check_captain_inbox` calls.

### Q3: Does `check_captain_inbox` mark messages as read?

**Recommendation:** read-only by default. Captain explicitly calls
`acknowledge_messages({msg_ids, action: 'read' | 'dismiss'})` to
transition. Two tools, but keeps "peek" cheap and "mark consumed"
explicit.

### Q4: What does the worker know about its identity at send time?

The token is per-run, stamped with `agent_id` at issuance. Worker's
restricted serve reads the sidecar at startup and caches `{run_id,
agent_id, repo_root}`. `send_message` stamps `from: {kind: 'run',
run_id, agent_id}` from this validated identity (NOT from anything
the worker passes in the call).

### Q5: What if the captain serve dies before the worker writes?

Worker writes to disk regardless. On captain serve restart, captain's
`check_captain_inbox` returns the queued message. The captain inbox is
durable.

### Q6: Repo-scope check on worker writes

Worker's token is bound to the captain's repoHash at issuance. Worker
writes to `~/.crew/captain-inbox/<repoHash>/<msgId>.json` where
`repoHash` comes from the sidecar (NOT from the worker's local cwd).
This prevents a worker that has somehow traversed to a different
worktree from writing into the wrong captain's inbox.

## Data model

### Captain inbox layout

```
~/.crew/captain-inbox/
  <repoHash>/                    # sha256(repo_root_absolute).slice(0, 12)
    <msgId>.json                 # one file per message; ULID for time-sort
    .lock/                       # ephemeral mkdir-lock for concurrent writes
```

`repoHash` lives at the top level (not nested under runs/) because the
captain inbox is repo-scoped, not run-scoped.

**Atomicity and lock scope.** Each message file is written via
`<msgId>.json.${pid}.${random}.tmp` then atomic rename — independent
between writers because each msg is its own file (different
filenames, no collision).

The mkdir lock at `<repoHash>/.lock` is held through the FULL critical
section of a `send_message` call: cap-check (count unread + total
files in the inbox directory via a single readdir pass), tmp write,
and rename. Writers are serialized through the lock so two concurrent
sends can't both pass a cap check that would be exceeded by their
combined writes. There is no separate "unread counter" file in the
schema — `total_unread` is always derived from directory walk + per-file
status read. (v1 plan originally said "mkdir lock for cap-checks only"
which contradicted the §Edge cases language; v2 said "and unread-count
increment" which implied a counter that doesn't exist; v4 settles on:
the lock covers cap-check + write + rename.)

For READ paths (`check_captain_inbox`): no lock needed. Reads are a
directory listing + per-file read; each file is atomic on its own.
Worst case: a listing snapshot misses an in-flight write — a benign
stale read; next call picks it up.

### Captain inbox message schema

```ts
// src/orchestrator/captain-inbox/schema.ts
export const CAPTAIN_INBOX_SCHEMA_VERSION = 1;

export type CaptainInboxKind =
  | 'note'        // worker reporting general info
  | 'review'      // worker delivering review findings
  | 'question'    // worker asking captain for clarification
  | 'answer'      // worker answering a captain peer_message
  | 'status';     // worker reporting progress / status

export type CaptainInboxStatus =
  | 'unread'
  | 'read'
  | 'dismissed';

// Forward-compatible tagged unions; v2 expands with peer addressing.
export type CaptainInboxAddress =
  | { kind: 'captain' }
  | { kind: 'run'; run_id: string; agent_id: string };

export interface CaptainInboxMessage {
  inbox_schema_version: 1;
  msg_id: string;                       // ULID
  to: CaptainInboxAddress;              // v1: always { kind: 'captain' }
  from: CaptainInboxAddress;            // v1: always { kind: 'run', ... }
  kind: CaptainInboxKind;
  body: string;                         // capped per §Caps
  body_truncated?: { original_length: number };
  in_reply_to?: string;                 // captain peer_message_id this answers
  files?: string[];                     // top-level (matches send_message input)
  excerpts?: Array<{
    file: string;
    range: [number, number];            // 1-indexed inclusive
    text: string;
  }>;
  status: CaptainInboxStatus;
  read_at?: string;                     // ISO 8601 when transitioned to 'read'
  dismissed_at?: string;                // ISO 8601 when transitioned to 'dismissed'
  created_at: string;                   // ISO 8601, server clock
  worker_run_id_at_send: string;        // audit: from.run_id snapshot
  worker_agent_id_at_send: string;      // audit: from.agent_id snapshot
  repo_root_at_send: string;            // audit: validated against token
}
```

### `peer_messages` parameter shape

```ts
// src/orchestrator/peer-messages/schema.ts
export const PEER_MESSAGES_SCHEMA_VERSION = 1;

export const peerMessageInputSchema = z.object({
  body: z.string().min(1),                          // capped per §Caps
  kind: z.enum(['note', 'review', 'question', 'answer', 'status']).default('note'),
  from_label: z.string().max(80).optional()
    .refine(s => !s || !/[\x00-\x1f]/.test(s), 'no control chars'),
  files: z.array(z.string()).max(20).optional(),
  excerpts: z.array(z.object({
    file: z.string(),
    range: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
    text: z.string(),
  })).max(8).optional(),
  in_reply_to_captain_inbox_msg: z.string().optional(),  // captain inbox msg_id (must exist & belong to current repo)
});

// Server stamps these at dispatch:
export interface PeerMessageRendered extends z.infer<typeof peerMessageInputSchema> {
  peer_messages_schema_version: 1;     // for forward-compat migration
  peer_message_id: string;             // server-derived ULID; used for in_reply_to threading and audit
  rendered_at: string;                 // ISO 8601 dispatch time
  rendered_in_turn: number;            // continue_run / run_agent turn (turn 1 for run_agent)
}
```

`peer_messages` are NOT persisted as separate inbox files. They live on
`state.json.prompts[turnNumber].peer_messages = PeerMessageRendered[]`
for audit and `in_reply_to` validation on subsequent turns.

**Empty array vs absent.** `peer_messages: []` is treated as
"absent" for the no-op gate (`peer_messages.length === 0` AND
`prompt === ''` -> reject `continue_run_no_op`). Storing an empty
array vs not storing the field at all is implementation choice; the
no-op gate uses logical absence.

**Turn 1 audit path (run_agent).** `RunStateStore.create()` is
extended to accept `initialPeerMessages?: PeerMessageRendered[]` so
that turn 1's `prompts[0].peer_messages` is recorded atomically with
run creation. Without this, peer_messages on run_agent would land in
turn 1 without a prompt record, and `in_reply_to` validation against
turn-1 messages on subsequent turns would have no source of truth.
See §"Recording on state.json" for the API change.

### Token sidecar schema

```ts
// ~/.crew/runs/<runId>/.auth.json (mode 0600)
export interface RunAuthSidecar {
  schema_version: 1;
  run_id: string;
  agent_id: string;
  token: string;                        // 64-char hex (32 bytes random)
  repo_root: string;                    // absolute path, captain's cwd at dispatch
  repo_hash: string;                    // sha256(repo_root).slice(0, 12)
  captain_pid: number;                  // captain serve PID at issuance
  captain_serve_instance: string;       // ULID; matches the captain's serve instance
  issued_at: string;                    // ISO 8601
  revoked: boolean;                     // flipped to true on terminal+merge or terminal+discard
  revoked_at?: string;
}
```

### Caps

| Item | Default | Override |
|---|---|---|
| `peer_messages` body size | 16 KB | `CREW_PEER_MESSAGE_BODY_CAP_CHARS` |
| `peer_messages` excerpt size | 4 KB | `CREW_PEER_MESSAGE_EXCERPT_CAP_CHARS` |
| `peer_messages` excerpts per item | 8 | `CREW_PEER_MESSAGE_MAX_EXCERPTS` |
| `peer_messages` items per call | 50 | `CREW_PEER_MESSAGES_MAX_ITEMS` |
| Aggregate prepend on dispatch | 32 KB | `CREW_PEER_MESSAGES_PREPEND_CAP_CHARS` |
| Hard prepend ceiling | 64 KB | `CREW_PEER_MESSAGES_HARD_CEILING` |
| Captain inbox body size | 16 KB | `CREW_CAPTAIN_INBOX_BODY_CAP_CHARS` |
| Captain inbox excerpts | 8 × 4 KB | (shared with peer_messages overrides) |
| Captain inbox messages per repo (all statuses) | 1000 | `CREW_CAPTAIN_INBOX_MAX_TOTAL` |
| Captain inbox unread per repo | 200 | `CREW_CAPTAIN_INBOX_MAX_UNREAD` |
| Read/dismissed retention | 7 days | `CREW_CAPTAIN_INBOX_RETENTION_DAYS` |

Body / excerpt overflow truncates with marker `[... truncated; original
was N chars]` and `body_truncated` set. Caps on `peer_messages` items,
unread count, and total are reject-the-call (caller fixes input).

## Tool surface

### Modified tool: `continue_run` and `run_agent`

Add `peer_messages` parameter to both:

```ts
export const continueRunInputSchema = z.object({
  run_id: z.string().min(1),
  prompt: z.string().default(''),                       // CHANGED: relax from min(1)
  peer_messages: z.array(peerMessageInputSchema).max(50).optional(),
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});

export const runAgentInputSchema = z.object({
  agent_id: z.string().min(1),
  prompt: z.string().min(1),                            // run_agent prompt stays required
  peer_messages: z.array(peerMessageInputSchema).max(50).optional(),
  // ... existing fields ...
});
```

**Validation (continue_run):**
- If `prompt === ''` AND no `peer_messages`: reject `continue_run_no_op`.
- If `peer_messages.length > CREW_PEER_MESSAGES_MAX_ITEMS`: reject
  `peer_messages_too_many`.
- If any `in_reply_to_captain_inbox_msg` references a message that
  doesn't exist (or belongs to a different repo): reject
  `peer_message_in_reply_to_not_found`.

**Behavior:** dispatcher composes the agent's prompt as
`<rendered peer_messages block><userPrompt>`. The block ends with
`---\n\n`; no extra separator added. If `peer_messages` is empty/absent,
the prompt is just `userPrompt` (current behavior).

### New tool: `send_message` (worker-only, restricted serve)

```ts
// src/orchestrator/tools/send-message.ts
export const sendMessageInputSchema = z.object({
  body: z.string().min(1),
  kind: z.enum(['note', 'review', 'question', 'answer', 'status']).default('note'),
  in_reply_to: z.string().optional(),                   // captain peer_message_id from current run
  files: z.array(z.string()).max(20).optional(),
  excerpts: z.array(z.object({
    file: z.string(),
    range: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
    text: z.string(),
  })).max(8).optional(),
  to: z.object({ kind: z.literal('captain') })
    .default({ kind: 'captain' })
    .describe('Reserved for v2 peer addressing; v1 only accepts captain'),
});

export interface SendMessageResult {
  msg_id: string;
  created_at: string;
  warnings: string[];                                   // body/excerpt truncation
}
```

**Schema notes:**
- `files` and `excerpts` are top-level (matches the captain skill body
  prose; the v1 plan previously nested these under `context`, which
  contradicted the skill).
- `to` is explicit and discriminated-union-ready: v1 callers pass
  `{kind: 'captain'}` (or omit; defaulted), v2 expands the union.
- `in_reply_to` references a `peer_message_id` from **THIS RUN's
  recent prompt records** (`state.json.prompts[].peer_messages[]`).
  Same-run only — workers can only reply to peer_messages the captain
  sent them. The captain inbox file's `in_reply_to` field stores
  this same reference verbatim (which is itself a captain peer_message_id).
  Cross-run / cross-repo lookups are refused with
  `in_reply_to_not_found` (no leak that the parent exists elsewhere).
  This is intentionally asymmetric with captain-side
  `peer_messages.in_reply_to_captain_inbox_msg`, which is repo-wide
  cross-run (the captain can forward any captain inbox msg as
  context); see §"`peer_messages` validation: ..." for the captain-side
  rule.

**Identity (server-stamped):** `from = { kind: 'run', run_id,
agent_id }` from the validated token. `repo_root_at_send` = sidecar's
`repo_root` (NOT worker's cwd).

**Validation errors:**

| Code | When |
|---|---|
| `worker_mode_required` | not running in restricted (worker) serve mode |
| `token_invalid` | env token doesn't match sidecar token |
| `token_revoked` | sidecar's `revoked === true` |
| `run_not_active` | sidecar's run has reached terminal+merged or terminal+discarded |
| `repo_root_mismatch` | sidecar's `repo_root` does not exist or no longer matches captain |
| `inbox_full` | captain inbox unread cap exceeded |
| `inbox_total_full` | captain inbox total cap exceeded |
| `in_reply_to_not_found` | referenced peer_message_id doesn't exist in this run's recent prompt records |

`in_reply_to` lookup: workers can only reply to peer_messages that the
captain sent THEM (i.e., recorded in this run's
`state.json.prompts[].peer_messages[].peer_message_id`). Cross-run
or cross-repo lookups refused.

### New tool: `check_captain_inbox` (captain-only)

```ts
export const checkCaptainInboxInputSchema = z.object({
  status: z.enum(['unread', 'read', 'dismissed', 'all']).default('unread'),
  limit: z.number().int().min(1).max(100).default(20),
  since: z.string().optional(),                         // ISO 8601
  from_run_id: z.string().optional(),                   // filter to one worker
});

export interface CheckCaptainInboxResult {
  messages: CaptainInboxMessage[];                      // up to `limit`
  total_unread: number;                                 // counts all unread, not just returned
  total_in_inbox: number;                               // counts all statuses
  oldest_unread_at?: string;
}
```

Read-only. To transition messages, captain calls `acknowledge_messages`.

### New tool: `acknowledge_messages` (captain-only)

```ts
export const acknowledgeMessagesInputSchema = z.object({
  msg_ids: z.array(z.string().min(1)).min(1).max(100),
  action: z.enum(['read', 'dismiss']),
});

export interface AcknowledgeMessagesResult {
  acknowledged: string[];                               // msg_ids that transitioned
  not_found: string[];                                  // msg_ids that don't exist
  already_in_target_state: string[];                    // msg_ids that were already 'read'/'dismissed'
}
```

Single tool for both transitions; explicit `action` keeps the surface
minimal (no separate `mark_read` / `dismiss`).

### Extended tool: `list_runs`

`list_runs` already returns repo-wide state; it's the right place for
a captain-inbox summary. Add:

```ts
interface ListRunsResult {
  // ... existing fields (runs: RunSummary[]) ...
  captain_inbox_summary: {
    total_unread: number;
    total_in_inbox: number;
    oldest_unread_at?: string;
  };
}
```

Always present (cheap; one directory walk + counts). v1 plan originally
placed this on `GetRunStatusResult` but `get_run_status` requires a
`run_id`, so single-run responses aren't the right home for repo-wide
inbox state.

### Extended tool: `get_run_status`

Add `peer_messages_count` to each prompt record returned in the
`prompts` view:

```ts
interface GetRunStatusResult {
  // ... existing fields ...
  prompts: Array<{
    // ... existing fields ...
    peer_messages_count?: number;
  }>;
}
```

Counts only; bodies remain in `state.json.prompts[].peer_messages[]`.

(`peer_messages_acked_count` was specified in v3-v4 but descoped in v5
along with ACK sentinels; see §"Round 4 review log".)

### Tools NOT added in v1

- `read_inbox` for individual run inboxes — there are no run inboxes
  in this design. Workers report directly to captain.
- Broadcast / fan-out — v2.
- Worker-callable `ack_inbox_message` — v2 (with cryptographic ACK).

### Install catalog parity (mode-aware)

`src/install/tool-catalog.ts` is currently a flat list mapping tool
names to skill-rendering metadata. v2 extends each entry with a
`mode: 'captain' | 'worker' | 'both'` field:

```ts
interface SkillTool {
  name: string;
  // ... existing fields ...
  mode?: 'captain' | 'worker' | 'both';   // default 'captain' for backward compat
}
```

Tool catalog entries:

| Tool | mode | Notes |
|---|---|---|
| `send_message` | `'worker'` | Only registered when restricted serve mode is active; never in captain mode |
| `check_captain_inbox` | `'captain'` | Captain reads inbox |
| `acknowledge_messages` | `'captain'` | Captain transitions inbox messages |
| `run_agent`, `continue_run`, `get_run_status`, etc. | `'captain'` | Existing tools stay captain-only |

**Captain skill body rendering**: filter to `mode in ['captain',
'both']`. `send_message` does NOT appear in the captain skill (the
captain doesn't call it).

**Verify** (`crew-mcp verify`): two checks now run:
- Captain-mode `crew-mcp serve` registers exactly the captain catalog
  entries.
- Worker-mode `crew-mcp serve` (started with valid env + sidecar in a
  test fixture) registers exactly the worker catalog entries (just
  `send_message`).

**Snapshot tests**: `test/install/tool-catalog.test.ts` updated to
include the `mode` field; one snapshot per mode.

## Trust boundary mechanics

### Threat model and fail-closed posture

v1's threat model: single-uid, single-machine; the user trusts their
own filesystem and the host CLI binaries they install. Cross-uid
attacks and malicious-binary attacks are out of scope. Inside that
scope, the trust boundary is concretely about: **a worker (an LLM
agent running inside a host CLI dispatched by the captain) MUST NOT
have access to captain-mode crew-mcp tools** (`merge_run`,
`discard_run`, `cancel_run`, `run_agent`, `continue_run`, `list_runs`,
`list_agents`). Today, every host CLI that has crew-mcp installed
exposes these tools to ANY agent running in it — including dispatched
workers. v1 closes that gap.

**Fail-closed default.** `crew-mcp serve`'s mode is determined at
startup. If the runtime cannot positively identify itself as captain
or worker, it refuses to start. There is NO mode where partial /
ambiguous state results in registering the captain tool surface.

### Token issuance at run dispatch (per-dispatch lifecycle)

Every dispatch — `run_agent` AND `continue_run` — issues a NEW token
and writes a fresh sidecar. This narrows the token's blast radius and
sidesteps the "token stays valid across continuations" complexity that
v1 originally had.

Steps at dispatch:

1. **Generate** `token` (32 bytes random, hex-encoded → 64 chars).
2. **Compute** `repo_hash = sha256(captain.repo_root).slice(0, 12)`.
3. **Write sidecar atomically** at `~/.crew/runs/<runId>/.auth.json`
   (mode 0600). Implementation:
   ```ts
   const tmp = `${path}.${pid}.${randomHex(8)}.tmp`;
   // 'wx' = O_CREAT|O_WRONLY|O_EXCL. Protects the TEMP path from
   // colliding with another pid+random tmp; does NOT protect the
   // final path (see pre-rename check below).
   const fd = await fs.open(tmp, 'wx', 0o600);
   try {
     await fd.write(JSON.stringify(sidecar));
     await fd.sync();                             // fsync
   } finally {
     await fd.close();
   }
   // Pre-rename existence check is path-dependent:
   //   - run_agent path: caller must verify no state.json exists for
   //     this runId (handled by dispatch transaction step 1), so no
   //     prior sidecar should exist either. If a sidecar IS present
   //     here, the dispatch transaction caught the state.json check
   //     earlier; this code path is unreachable. Defensive: throw
   //     `unexpected_sidecar_collision`.
   //   - continue_run path: the prior sidecar was just revoked in
   //     the previous transaction step (set `revoked: true`). The
   //     rename intentionally replaces the revoked sidecar with the
   //     freshly-issued one.
   try {
     await fs.access(path);
     // Final-path exists. Caller-driven semantics: run_agent rejects,
     // continue_run replaces.
     if (priorPathSemantics === 'run_agent_must_be_absent') {
       throw new Error('unexpected_sidecar_collision');
     }
     // else continue_run: fall through to rename (intentional replace).
   } catch (err) {
     if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
     // Final path didn't exist; nothing special, proceed to rename.
   }
   await fs.rename(tmp, path);                   // atomic on local fs
   const stat = await fs.stat(path);
   if ((stat.mode & 0o777) !== 0o600) {
     await fs.chmod(path, 0o600);                // umask fallback
     const recheck = await fs.stat(path);
     if ((recheck.mode & 0o777) !== 0o600) {
       throw new Error('sidecar_permission_unfixable');
     }
   }
   ```
   The `wx` flag (round-8 correction) only protects the TEMP path —
   the unique-pid-random tmp can't be hijacked by a concurrent writer
   on the same machine. The final rename is unconditional (POSIX
   rename replaces existing dest atomically), so v9 adds explicit
   pre-rename semantics: `run_agent` rejects a pre-existing sidecar
   (it's an invariant violation if step 1 passed); `continue_run`
   intentionally replaces (after step 2's prior-token revocation).
4. **Inject env** into the host CLI spawn (Phase 2 specifies the
   per-adapter mechanism — see §"Adapter compatibility matrix"):
   - `CREW_RUN_ID = <runId>`
   - `CREW_RUN_TOKEN = <token>`
5. The host CLI propagates env to its MCP child (the worker's
   `crew-mcp serve`).

If a continue_run call follows a prior dispatch on the same run:
**revoke the prior token first** (§"Token revocation"), then issue a
new token via the steps above. This closes the race where a stale
adapter from a prior dispatch is still running and could try to use
the old token.

### Restricted serve mode (fail-closed)

`crew-mcp serve` startup logic:

```ts
const runId = process.env.CREW_RUN_ID;
const runToken = process.env.CREW_RUN_TOKEN;

if (runId && runToken) {
  // ATTEMPT worker mode. Any failure -> refuse to start.
  const sidecar = await readSidecarFailClosed(runId, runToken);
  // readSidecarFailClosed:
  //   - opens ~/.crew/runs/<runId>/.auth.json
  //   - throws if missing or unreadable
  //   - throws if mode is NOT 0600 (sidecar_permission_invalid)
  //   - throws if !constantTimeEqual(sidecar.token, runToken) (token_invalid)
  //   - throws if sidecar.revoked === true
  //   - throws if sidecar.run_id !== runId or sidecar.repo_hash invalid
  //   - returns RunAuthSidecar on success
  registerOnly(['send_message']);
  // Handler closes over the validated identity.
  await writeWorkerReadyMarker(runId);            // see "Restricted serve verification"
} else if (runId || runToken) {
  // Partial env -> refuse to start (loud crash, no captain tools registered).
  throw new Error('crew-mcp: partial worker env (CREW_RUN_ID xor CREW_RUN_TOKEN); refusing to start');
} else {
  // Captain mode (no env). Register full surface.
  registerCaptainSurface();
}
```

**Key fail-closed properties:**
- Sidecar permission check is enforcement, not warning. Mode != 0600
  → refuse to start. (v1 originally said "warn and continue" — that
  was a bug; reviewers correctly flagged it.)
- Partial env → refuse to start. The host CLI sees a dead MCP subprocess
  and surfaces an error to the captain (loud failure).
- Token mismatch / revoked / missing sidecar → refuse to start.

**The remaining residual risk:** if env propagation fails entirely on
a host CLI (worker spawn ends up with NEITHER env var), the worker's
MCP starts in captain mode. This is the fail-open scenario the reviewers
flagged. v1 handles it via §"Restricted serve verification" + the
adapter compatibility matrix (adapters that fail env propagation are
descoped from `send_message`).

### Restricted serve verification (handshake, background)

Since v3 uses per-invocation argv/config injection (Tier 2), env
propagation is guaranteed by construction — the host CLI starts the
MCP child with an explicit `env` block. The historical "env might
silently not propagate" scenario doesn't apply to Tier 2 adapters.
Restricted serve fail-closes at startup (partial env / token
mismatch / sidecar mode != 0600 → refuse to start), so a Tier 2
worker either has the right env (worker mode engages) or crashes
loudly (host CLI surfaces MCP startup error to captain).

The handshake marker therefore plays a softer role in v3: it lets the
captain LAZILY confirm that the worker came up correctly, and surfaces
that signal in `get_run_status` / `check_captain_inbox` responses for
debugging. **The handshake does NOT block the dispatch hot path.**

**Worker side** (in restricted serve startup, after sidecar
validation): write `~/.crew/runs/<runId>/.worker-ready.json` with
mode 0600, content:

```json
{
  "schema_version": 1,
  "server_pid": <number>,
  "server_instance": "<ULID>",
  "started_at": "<ISO 8601>",
  "registered_tools": ["send_message"]
}
```

**Captain side**: a detached task (kicked off after
`dispatcher.start()` synchronously returns) polls for the marker
with timeout `CREW_WORKER_READY_TIMEOUT_MS` (default 10_000).
Result is written to `state.json.worker_ready`:

```ts
interface WorkerReadyStatus {
  status: 'pending' | 'ready' | 'timeout' | 'absent';
  marker_observed_at?: string;     // ISO 8601 when marker found
  marker_server_pid?: number;      // copied from marker
  marker_server_instance?: string; // copied from marker
}
```

- `pending`: dispatch happened; detached task hasn't completed yet.
- `ready`: marker found → worker is in restricted mode; MCP
  `send_message` available.
- `timeout`: marker didn't appear within 10s → likely a non-Tier-2
  adapter (no MCP child or env didn't engage) OR the host CLI
  lazy-spawns its MCP child (see below). Either way, `send_message`
  is unavailable for this run; findings come via terminal.summary.
- `absent`: an MCP-less adapter (generic / openai-compatible) — no
  marker is ever expected.

**Lazy MCP-child spawn caveat.** Some host CLIs may lazy-spawn their
MCP children (only on the agent's first tool call). For a Tier 2
adapter where the agent never calls an MCP tool (e.g., a worker that
just emits text and exits), the marker may never appear even though
restricted mode would have engaged correctly. v3 handles this by:

1. Treating `timeout` as advisory, not fatal: the captain inbox is
   still readable via `check_captain_inbox`; any messages that DID
   arrive are processed; the worker's `summary` (top-level field on
   `get_run_status` response) and `events_tail` remain available for
   findings.
2. Setting `worker_ready = 'ready'` opportunistically if any
   subsequent `send_message` call from that run succeeds (the call
   itself proves the marker would have been written).

**Surface in tool responses**: `get_run_status` returns
`worker_ready` in its envelope; `check_captain_inbox` includes
`worker_ready_breakdown: { ready: N, timeout: M, absent: K }` for
debugging panel runs.

**On run terminal**: detached handshake task is cancelled; marker
file deleted; `worker_ready` set to its terminal observed value.

### Token validation on every `send_message` call

Even though the sidecar was validated at startup, every send_message
call re-reads the sidecar to catch revocation:

```ts
async function validateForSend(): Promise<RunAuthSidecar> {
  const sidecar = await readSidecar(runId);                 // throws if missing
  const stat = await fs.stat(sidecarPath);
  if ((stat.mode & 0o777) !== 0o600) {
    throw new ToolError('sidecar_permission_invalid');
  }
  if (!constantTimeEqual(sidecar.token, runToken)) {
    throw new ToolError('token_invalid');
  }
  if (sidecar.revoked) {
    throw new ToolError('token_revoked');
  }
  // Closes the run-state vs token-revocation race.
  const runState = await readRunState(runId);
  if (runState.status === 'merged' || runState.status === 'discarded') {
    throw new ToolError('run_not_active');
  }
  return sidecar;
}
```

`constantTimeEqual` uses `crypto.timingSafeEqual` on equal-length
buffers.

### Token revocation

Revocation lifecycle (per-dispatch, fail-closed):

- **At each new dispatch** (run_agent / continue_run): if a sidecar
  exists, set `revoked: true`, `revoked_at: now()` BEFORE writing
  the new token. This invalidates any stale adapter still running
  from a prior dispatch. (Atomic: read sidecar, mutate, write via
  unique-tmp + rename.)
- **`merge_run` succeeds**: set `sidecar.revoked = true`,
  `revoked_at = now()`. Sidecar file persists for audit.
- **`discard_run` succeeds**: sidecar file deleted alongside the run
  dir.
- **`cancel_run` succeeds**: token NOT revoked (cancel is recoverable;
  next continue_run will revoke + re-issue).
- **Run reaches terminal status (success / partial / error / cancelled)
  WITHOUT explicit captain action**: token stays active. The adapter
  has exited so the live token is unreachable. Next continue_run
  revokes + re-issues. (Token's blast radius across this window is
  bounded by the worker process being already-dead.)

Audit: revocation events are logged in `events.log`.

### Adapter compatibility matrix

The 2026-05-10 spike (§"Adapter spike (2026-05-10)") established
empirically that **no host CLI propagates ambient env reliably**:

- Codex calls `env_clear()` before spawning MCP servers
  (`openai/codex/mcp-client.rs`); only a curated allowlist + the MCP
  spec's `env` block survive.
- Gemini sanitizes env names matching `/TOKEN/i`
  (`google-gemini/gemini-cli/environmentSanitization.ts`); even if
  `CREW_RUN_TOKEN` reached gemini's process, the name itself triggers
  the filter.
- Claude-code: ambient propagation unverified, but moot — its
  per-invocation `--mcp-config` path is documented and already
  plumbed.

**Tier 1 is dropped.** The only working primitive is per-invocation
injection through the host CLI's MCP server spec.

| Adapter | Tier | Mechanism | v4 status |
|---|---|---|---|
| `codex` | 2 | `codex exec ... -c mcp_servers.crew.env.CREW_RUN_ID="<id>" -c mcp_servers.crew.env.CREW_RUN_TOKEN="<token>"` | Argv-serializer primitive exists (`mcp-registration.ts:55`'s `toCodexConfigOverrides`); production wiring is NEW in Phase 2 |
| `claude-code` | 2 | `claude ... --mcp-config '{"mcpServers":{"crew":{"command":"crew-mcp","args":["serve"],"env":{"CREW_RUN_ID":"<id>","CREW_RUN_TOKEN":"<token>"}}}}' --strict-mcp-config` | JSON-serializer primitive exists (`mcp-registration.ts:100`'s `toClaudeMcpConfigJson`); production wiring is NEW in Phase 2 |
| `gemini-cli` | 3 | No per-invocation MCP env override. `send_message` MCP tool unavailable. Findings via `terminal.summary` only. | v5 descopes structured in-turn reporting; use `get_run_status` |
| `generic` | 3 | No MCP child. Findings via `terminal.summary` only. | Same |
| `openai-compatible` | 3 | No MCP child; response is one chunk. Findings via `terminal.summary` only. | Same |

**Tier 2 (per-invocation injection): real implementation work.**

Round-3 review correctly flagged that v3's "Already plumbed"
phrasing was misleading. Tracing the live code:

- `toCodexConfigOverrides` / `toClaudeMcpConfigJson` (the pure
  serializers in `mcp-registration.ts:55,100`) exist.
- `resolveCaptainConverter` (`mcp-registration.ts:160`) is consumed
  ONLY by the legacy `executeWithTools` (M3-8) tool-loop path
  (`codex.ts:984`, `claude-code.ts:845`) and by tests; there is no
  production caller in `src/`.
- The production dispatch path is `run-agent.ts:335` /
  `continue-run.ts` → `adapter.execute(task: Task)`. `Task`
  (`adapters/types.ts:195`) has NO `mcpRegistration` field.
  `CodexAdapter.execute()` (`codex.ts:394`) and
  `ClaudeCodeAdapter.execute()` (`claude-code.ts:454`) build argv
  from `task.constraints` only.

**Phase 2 work (NEW production wiring):**

1. Extend `Task` interface (`src/adapters/types.ts:195`) with:
   ```ts
   interface Task {
     // ... existing fields ...
     dispatchMcpEnv?: {
       CREW_RUN_ID: string;
       CREW_RUN_TOKEN: string;
     };
   }
   ```
2. `buildAdapterDispatchTask()` (the function that constructs Tasks
   for the dispatcher) sets `dispatchMcpEnv` from the per-dispatch
   sidecar at run time.
3. `CodexAdapter.execute()` argv builder (`codex.ts:399-451`)
   appends the codex per-invocation flags:
   ```ts
   if (task.dispatchMcpEnv) {
     args.push(
       '-c', `mcp_servers.crew.env.CREW_RUN_ID="${task.dispatchMcpEnv.CREW_RUN_ID}"`,
       '-c', `mcp_servers.crew.env.CREW_RUN_TOKEN="${task.dispatchMcpEnv.CREW_RUN_TOKEN}"`,
     );
   }
   ```
   (Reuse `toCodexConfigOverrides` if the per-server-name lookup
   warrants it; otherwise inline.)
4. `ClaudeCodeAdapter.execute()` argv builder (`claude-code.ts:456-463`)
   appends the inline JSON + strict flag:
   ```ts
   if (task.dispatchMcpEnv) {
     args.push(
       '--mcp-config', JSON.stringify({
         mcpServers: {
           crew: {
             command: 'crew-mcp',
             args: ['serve'],
             env: task.dispatchMcpEnv,
           },
         },
       }),
       '--strict-mcp-config',
     );
   }
   ```
5. Adapter integration tests assert the resulting argv (per
   `execa` call) contains the env block.

**Why not route through `resolveCaptainConverter`?** That helper is
oriented around the captain skill catalog (static install-time
config). Threading runtime per-dispatch env through it would require
significant refactor. Inline-in-execute is the smaller, more
explicit change for v1.

**The actual argv** (per `execa` call, not shell-quoted):
- Codex: `['-c', 'mcp_servers.crew.env.CREW_RUN_ID="<id>"', '-c', 'mcp_servers.crew.env.CREW_RUN_TOKEN="<token>"']`
  — two flag/value pairs, each value pre-wrapped in TOML basic-string
  quotes (`"..."`) per `toTomlString`. Sidecar tokens are 64-char hex
  so no quote/backslash escaping needed.
- Claude: `['--mcp-config', '<JSON-string>', '--strict-mcp-config']`
  — JSON value is a single argv element passed verbatim to execa.

**Non-Tier-2 adapters (gemini-cli, generic, openai-compatible) —
trust-boundary defense required.**

Round-5 review surfaced a real architectural gap: "no inbox tool
surface" is not the same as "no captain tool surface." For gemini
specifically, `crew-mcp install` writes a static crew-mcp MCP server
entry into `~/.gemini/settings.json` (`src/install/hosts/gemini.ts:38`).
When `GeminiCliAdapter.execute()` dispatches a gemini worker via
`gemini --output-format json` (`src/adapters/gemini-cli.ts:285`),
gemini loads the installed MCP servers — including crew-mcp. Without
defense, the worker's `crew-mcp serve` starts WITHOUT env vars
(gemini sanitizes `/TOKEN/i`), falls through to **captain mode**, and
registers the full captain tool surface (`run_agent`, `merge_run`,
`discard_run`, etc.). The worker can now misuse captain tools — the
exact failure round-1 raised about Tier 1's fail-open.

**v6 defense** (Phase 2): all non-Tier-2 adapter dispatches pass a
flag that excludes crew-mcp from the worker's loaded MCP servers.
Per-adapter:

- **gemini-cli**: emit exactly `['--allowed-mcp-server-names', '']`
  as two argv elements (a flag and an empty-string value).
  Round-6 review **empirically verified** against gemini-cli `0.40.1`
  that the parser preserves `""` as the allowlist `[""]` and only
  loads servers whose name is in the allowlist; since `""` is never
  an MCP server name, all servers (including crew-mcp) are denied.
  **Implementation site:** edit `GeminiCliAdapter.execute()`
  (`src/adapters/gemini-cli.ts:285`) directly, BEFORE the prompt
  argv. **Do NOT** route through the existing
  `buildGeminiResumeArgs(..., { allowedServerNames: [...] })` helper
  at `src/adapters/gemini-cli.ts:196` — that helper is consumed only
  by the legacy `executeWithTools` tool-loop and actively SUPPRESSES
  the flag when `allowedServerNames` is empty (test:
  `test/adapters/gemini-cli.mcp.test.ts:5-19`). The worker dispatch
  needs the OPPOSITE behavior (emit the flag with empty value).
  Phase 2 test: snapshot the actual argv string array emitted by
  `GeminiCliAdapter.execute()` for a worker dispatch and assert it
  contains `'--allowed-mcp-server-names'` followed by `''`.
- **generic**: typically doesn't host MCP children at all; no extra
  defense needed beyond the descoped non-Tier-2 classification, but
  confirm via integration test.
- **openai-compatible**: HTTP API client; no MCP child. No defense
  needed.

If a future gemini-cli version drops `--allowed-mcp-server-names` or
changes empty-allowlist semantics: Phase 2 integration test catches
the regression. If gemini cannot be safely dispatched as a worker,
mark it unsupported until a defense is found.

These adapters do not get the MCP `send_message` tool in v1. Their
workers report findings via the standard `terminal.summary` channel
(status quo). Captain reads via `get_run_status` after the run reaches
a continuable status. No structured in-turn messaging from these
adapters.

This is a deliberate v1 descope (see §"Round 4 review log"): an
output-stream parser fallback was specified through v2-v4 but kept
finding new implementation bugs each review round (raw output
substrate, rotation/cursor mechanics, partial-block handling,
per-adapter streaming behavior). Rather than ship an under-specified
parser, v5 keeps the trust boundary tight (MCP-only) and defers the
output-stream story to v2 once we have evidence the capability gap
is real.

**Adapter coverage summary**: codex and claude-code workers get the
MCP `send_message` tool with structured findings. Gemini, generic, and
openai-compatible workers report via `terminal.summary` only.

**Phase 2 deliverable**: per-adapter integration tests that assert
the constructed `execa` argv contains the expected env-block / defense
flag, plus a live env propagation probe (Tier 2) and a live no-MCP
probe (gemini). End-to-end `send_message` + captain inbox flow tests
land in Phase 3/4 / Phase 6 dogfood — Phase 2 isolates the
argv-assertion plus env-probe scope so it doesn't depend on tools
introduced later.

### Per-run dispatch transaction

Round-2 review flagged that v2's "wrap all RunStateStore mutations"
language was insufficient: today's `continue_run` reads status,
builds the task, appends the prompt, and starts the dispatcher in
SEPARATE steps (`serve.ts:380-440`), so two concurrent continuations
can both pass validation. v3 defines a per-run dispatch transaction
that wraps the full critical section:

```ts
// src/orchestrator/dispatch-transaction.ts
export interface DispatchTransactionContext {
  state: RunStateV1;
  turnNumber: number;
  token: string;                       // newly issued
  peerMessages?: PeerMessageRendered[];
}

export async function withDispatchTransaction<T>(
  options: { crewHome: string; runId: string },
  fn: (ctx: DispatchTransactionContext) => Promise<T>,
): Promise<T>;
```

The transaction (held under the state lock for the run, scope='state').
**Two distinct entry paths**:

**Task construction ordering (resolves chicken-and-egg).** Both paths
need `dispatchMcpEnv` populated on the `Task` (for Tier 2 argv
injection), but the env values come from the sidecar that's written
INSIDE the transaction. Resolution: `planRunAgent()` /
`planContinueRun()` (the existing planners at `run-agent.ts:209`,
`continue-run.ts:..`) are refactored to return a **task builder
closure** `(sidecar: RunAuthSidecar) => Task` rather than a fully-
constructed Task. The dispatch transaction calls the builder after
writing the sidecar (step 2 in run_agent / step 3 in continue_run),
threading the just-written `{CREW_RUN_ID, CREW_RUN_TOKEN}` into
`task.dispatchMcpEnv` before `dispatcher.start()`. **Phase 1 owns
this refactor** (the dispatch transaction depends on the closure
shape); Phase 2 separately implements the `dispatchMcpEnv` argv
consumption in `CodexAdapter.execute()` and
`ClaudeCodeAdapter.execute()`.

**`run_agent` path** (creating a fresh run):

1. Re-read run state for the proposed runId. If a state.json already
   exists, reject with `run_id_already_exists` (caller should pick a
   new runId or use `continue_run`). For a fresh runId, no prior
   sidecar to revoke.
2. Generate new token + write new sidecar (mode 0600, atomic). On
   failure: cleanup partial sidecar tmp file; cleanup any
   pre-allocated worktree via `worktreeManager.cleanupByRunId`;
   propagate error to caller. No state.json yet, nothing else to
   roll back.
3. Create initial state via `RunStateStore.create({initialPrompt,
   initialPeerMessages, status: 'running'})`. On failure: revoke
   the sidecar (write `revoked: true`); cleanup worktree; propagate
   error. No state.json was written, nothing else.
4. Build the Task via the planner's task-builder closure, threading
   the sidecar into `task.dispatchMcpEnv`.
5. Install dispatcher lifecycle listeners pre-start (run:start /
   run:stream / run:complete / run:failed / run:cancelled — the
   actual event set per `tool-dispatcher.ts:34-44`). MUST happen
   before `dispatcher.start()` because the dispatcher emits
   `run:start` synchronously inside its body
   (`tool-dispatcher.ts:71`).
6. Call `dispatcher.start(task)` synchronously. On throw: ROLLBACK
   (run_agent variant):
   - Dispose lifecycle listeners (via the `dispose` handle returned
     by the refactored `installRunLifecycleListeners`).
   - Delete the just-created state.json (run dir cleanup via
     existing run-dir-rmtree helper).
   - Revoke the sidecar (mark `revoked: true`) and remove the
     sidecar file.
   - Cleanup worktree via `worktreeManager.cleanupByRunId`.
   - Propagate error to caller.
7. Return success envelope.

**`continue_run` path** (existing run, new turn):

1. Re-read run state. Reject if status not in
   `{success, partial, error, cancelled}` with the existing
   continue_run rejection format (`continue_run.ts` currently uses
   per-status message strings; v7 keeps that wording but the
   transaction's rejection point is consolidated to step 1).
2. Revoke prior sidecar token (set `revoked: true`,
   `revoked_at: now()` via atomic rewrite). Stale subprocess can't
   reuse it. On failure: propagate error; no state changes yet.
3. Generate new token + write new sidecar (mode 0600, atomic). On
   failure: prior sidecar is already revoked (step 2); propagate
   error to caller. State.json untouched.
4. Append prompt record via `appendPrompt({userPrompt,
   peerMessages})`; capture `turnNumber`. **Note: `appendPrompt`
   today (run-state.ts:354-366) synchronously sets `status:
   'running'`, clears `completedAt`, and refreshes `serverPid` —
   step 4 covers all of these in one atomic state.json write.**
   Step 5 (separate "flip status" step) was removed in v7;
   `appendPrompt` IS the status flip + prompt append for
   continue_run. On failure: revoke the just-issued token;
   propagate error. State.json untouched (nothing was written).
5. Build the Task via the planner's task-builder closure, threading
   the new sidecar into `task.dispatchMcpEnv`.
6. Install dispatcher lifecycle listeners (run:start / run:stream /
   run:complete / run:failed / run:cancelled). Refactor
   `installRunLifecycleListeners` to return `{terminalPromise,
   dispose}` so the transaction can dispose on rollback.
7. Call `dispatcher.start(task)` synchronously. On throw (e.g.,
   `tool-dispatcher.ts:63` "already in-flight"): ROLLBACK
   (continue_run variant):
   - Dispose the lifecycle listeners installed in step 6.
   - Revert state via `RunStateStore.revertTurn(runId, {turnNumber,
     priorStateSnapshot})` — a NEW API added in Phase 1 that removes
     the prompt record whose `turn === turnNumber` (NOT
     `prompts[turnNumber]` — see API definition below;
     `PromptRecord.turn` is 1-based, `prompts[]` array index is
     0-based), and restores `status` / `completedAt` / `serverPid`
     from the snapshot.
   - Mark the new sidecar revoked.
   - Propagate error.
8. Return success envelope.

**`RunStateStore.revertTurn` API** (NEW, added in Phase 1):

```ts
interface RevertTurnOptions {
  turnNumber: number;                   // 1-based, matches PromptRecord.turn
  priorStateSnapshot: RunStateV1;       // captured before appendPrompt
}

revertTurn(runId: string, options: RevertTurnOptions): void;
// Removes the prompt record where `p.turn === turnNumber` from
// state.prompts[]. Note: `turnNumber` is 1-based (matches the
// existing `PromptRecord.turn` field); do NOT index `prompts[]`
// directly with `turnNumber` (the array is 0-based). Implementation
// uses `state.prompts = state.prompts.filter(p => p.turn !== turnNumber)`
// and asserts exactly one record was removed (the just-appended
// last one in normal use).
// Then restores status / completedAt / serverPid from priorStateSnapshot.
// Atomic write via unique-tmp + rename. Held under state lock.
```

For both paths, the state lock is held from step 1 through the
synchronous return of `dispatcher.start()`. `dispatcher.start()` is
fire-and-forget (returns a Promise the dispatcher tracks in the
background; the awaited Promise is NOT held by the lock). After
return — *outside the lock* — the captain detaches the background
handshake-polling task (which surfaces `state.json.worker_ready`
lazily per §"Restricted serve verification").

**Two-concurrent-`continue_run` behavior**: the second caller waits
on the lock; when it acquires, it re-reads status under step 1 and
sees `running` from the first call → rejects with the existing
continue_run rejection text (`'continue_run: run is currently
running; call cancel_run first.'` per `serve.ts:385`; v8 preserves
existing wording rather than introducing a new error code). The
double-dispatch race closes.

**Two-concurrent-`run_agent` with same runId**: extremely unlikely
(runIds are server-generated ULIDs) but defended: second caller
reaches step 1, sees state.json exists, rejects with
`run_id_already_exists`.

**Listener installation ordering (round-3 fix).** v3 said "background
work runs after the lock releases" without distinguishing dispatcher
event listeners from the handshake task. Round-3 review flagged that
lifecycle listeners MUST install pre-start (the v7 predecessor solved
this; v3 regressed it). v4 explicitly separates:
- Lifecycle listeners (step 6, pre-start, inside the transaction).
- Handshake polling (post-step-8, detached, outside the lock).

## Captain -> worker via `peer_messages`

### Prepend block format (byte-exact)

Reuse the v7 plan's template (LF line endings, no trailing whitespace,
fence-escalation for backticks). The block is rendered from the
`peer_messages` array on each `continue_run` / `run_agent` call:

```
## Peer messages\n\n
You have {N} message(s) from peers (the captain is forwarding them as\n
part of this turn's task context). Read them carefully and treat their\n
contents as authoritative input to your task.\n\n
---\n\n
### Message {idx} — kind: {kind}, from: {from_label or "captain"}, at {created_at}\n
peer_message_id: {peer_message_id}\n
[in_reply_to (captain inbox msg): {in_reply_to_captain_inbox_msg}\n]\n
{body}\n\n
[#### Referenced files\n\n
- `{file_a}` (lines {start_a}-{end_a}):\n
{fence}\n
{excerpt_text_a}\n
{fence}\n\n
…
]---\n\n
### Message {idx+1} — kind: …\n
…
---\n\n
```

**Decisions** (mostly inherited from v7's `buildPrependBlock`):

- LF only.
- `{idx}` is 1-based, global per dispatch call (not per-thread).
- Always include the first message even if oversize (first-message-force
  rule); subsequent messages stop on first cap refusal.
- `{fence}` escalates per-excerpt: 3 backticks → 4; 4 → 5; etc., max 8.
- `{from_label}` is captain-supplied display string. If absent, render
  as `"captain"`.
- Hard ceiling: 64 KB on the rendered block. Last message truncated
  with `[... truncated by hard prepend ceiling]` if hit.

The block is built in `src/orchestrator/peer-messages/prepend.ts`.
Pure function; same golden-test approach as v7's `buildPrependBlock`.

### Recording on state.json

`state.json.prompts[turnNumber]` adds:

```ts
type RunPromptRecord = {
  turn: number;
  prompt: string;                                       // user-supplied (raw)
  peer_messages?: PeerMessageRendered[];                // server-stamped peer_message_id, rendered_at, rendered_in_turn
  startedAt: string;
  completedAt?: string;
  summary?: string;
  // ... existing fields ...
};
```

The composed prompt (rendered prepend + userPrompt) is NOT stored —
it's reproducible from `peer_messages + userPrompt + buildPrependBlock`.

### `appendPrompt` and `RunStateStore.create()` signature changes

`appendPrompt` becomes options-based:

```ts
interface AppendPromptOptions {
  userPrompt: string;
  peerMessages?: PeerMessageRendered[];
}

appendPrompt(runId: string, options: AppendPromptOptions): {
  state: RunStateV1;
  turnNumber: number;
}
```

`RunStateStore.create()` is also extended so turn-1 peer_messages
(from `run_agent`) have an audit record:

```ts
interface CreateRunStateInit {
  // ... existing fields ...
  initialPrompt: string;
  initialPeerMessages?: PeerMessageRendered[];   // NEW: server-stamped at run_agent time
}

create(init: CreateRunStateInit): RunStateV1;
// Stores prompts[0] = { turn: 1, prompt: initialPrompt,
//                       peer_messages: initialPeerMessages, startedAt }.
```

Without this, `peer_messages` on `run_agent` would land in turn 1
without a prompt record, and `in_reply_to` validation against turn-1
messages on subsequent turns would have no source of truth (subsequent
worker `send_message` calls referencing a turn-1 peer_message_id
would fail `in_reply_to_not_found`). This was a v1-plan gap caught
by round-1 review.

### State lock scope expansion

The v7 plan introduced `withRunLock({crewHome, runId, scope: 'state'},
...)` only around `appendPrompt`. v2 expands this: ALL `RunStateStore`
mutating operations are wrapped, since they're all read-modify-write
on the same state.json file:

| Operation | Why locked |
|---|---|
| `create()` | Atomic with sidecar write at dispatch (run_agent path) |
| `appendPrompt()` | Existing; pre-existing read-modify-write race |
| `markTerminal()` | Race vs concurrent stale-run sweeper / dispatch transaction |
| `markMerged()` | Race vs concurrent `send_message` validation reads |
| `markMergeConflict()` | Same |
| `markDiscarded()` | Same |
| (cancellation: goes through `markTerminal('cancelled')` today; no separate `markCancelled` method exists) | Lock applies via `markTerminal` row |
| Stale-run sweeper (`run-state.ts:97-110`) | Existing; route through same lock |

This is a single-line change at most call sites (wrap in
`withRunLock`). The lock is mkdir-based, scope='state', per-run. It
does NOT serialize across runs.

**Async migration note.** `RunStateStore` mutations are currently
synchronous (`run-state.ts:228+`). Wrapping each call site in
`withRunLock` (which is async) means each call site becomes async.
This is a call-site sweep, not a behavior change. Phase 1 budget
includes the sweep for the ~5-10 mutation sites; Phase 2-6 callers
inherit the await.

## Worker ACK detection — DESCOPED to v2

v5 descopes ACK sentinels entirely. The dependency chain (ACK
sentinels → raw output capture → adapter-side `rawOutputSink`
callbacks → rotation/cursor/partial-block handling) accumulated
complexity faster than its value justified. The captain can verify
peer_messages were attended to by reading the agent's response in
events.log + terminal.summary; no automated counter.

§Future work captures the v2 path: when there's evidence ACK
signals would meaningfully change captain behavior (and we've
designed the raw output substrate properly), reintroduce.

## Captain skill changes

Append to `skills/crew-captain.body.md`:

```markdown
## Multi-agent messaging

You can pass structured peer context to a worker at dispatch time and
read worker findings from a consolidated inbox. Use these instead of
hand-copying outputs between runs.

### `peer_messages`: captain -> worker context

Both `run_agent` and `continue_run` accept an optional `peer_messages`
array. Each item is `{body, kind, files, excerpts, from_label,
in_reply_to_captain_inbox_msg}`. The dispatcher prepends a typed block
to the worker's prompt so the worker sees the messages as authoritative
task context.

Use cases:
- Forward run A's output to run B's review prompt.
- Forward synthesized panel review feedback back to the implementer.
- Forward a captain inbox message verbatim to a different run.

### `send_message`: worker -> captain (workers only)

Workers call `send_message({body, kind, files, excerpts, in_reply_to})`
to deliver structured findings to your inbox. Their output stream is
still captured in `events.log`, but `send_message` gives you a typed
record (sender-stamped, threaded) without scraping output.

You read these via `check_captain_inbox`. Workers cannot address peers.

### Pattern: implement-then-review (single reviewer)

1. `run_agent(implementer, "implement X")` -> run A.
2. Wait for A terminal.
3. `run_agent(reviewer, "review the diff from peer A. Use send_message
   to deliver your findings.", peer_messages: [{body: <A's diff +
   summary>, files: A's filesChanged, kind: 'review', from_label: "A
   (implementer)"}])` -> run B.
4. Wait for B terminal.
5. `check_captain_inbox()` -> read B's review message (kind: 'review').
6. If revisions needed: `continue_run(A, peer_messages: [{body: <B's
   findings>, from_label: "B (reviewer)", in_reply_to_captain_inbox_msg:
   <B's msg_id>}], prompt: "revise per these findings")`.

### Pattern: multi-panel review (3+ reviewers)

Tier-2-only flow (gets structured inbox messages from each
reviewer):

1. `run_agent(implementer, "implement X")` -> run A.
2. Wait for A terminal.
3. Dispatch Tier 2 reviewers in parallel:
   - `run_agent(codex, ..., peer_messages: [<A's diff>])` -> run B
   - `run_agent(claude-code, ..., peer_messages: [<A's diff>])` -> run C
4. Wait for all terminal (use `crew-wait` watchers, not blocking polls).
5. `check_captain_inbox()` -> read each reviewer's `send_message`.
6. Synthesize the findings yourself, then forward to A:
   `continue_run(A, peer_messages: [{body: <synthesis>}], prompt:
   "revise per these consolidated findings")`.

Mixed-tier flow (some reviewers are non-Tier-2, e.g., gemini-cli):

1-3. Same dispatch flow, including non-Tier-2 reviewers.
4. Wait for all terminal.
5. For Tier 2 reviewers: read their findings via `check_captain_inbox`.
   For non-Tier-2 reviewers: read their findings via
   `get_run_status({run_id})` (the top-level `summary` field on the
   response + `events_tail`). Non-Tier-2 reviewers can't
   `send_message`.
6. Synthesize all findings into one `peer_messages` block and
   `continue_run(A, ...)`.

### Worker prompt instructions

For Tier 2 adapters (codex, claude-code), when you dispatch a worker
that should report back via inbox, include in the prompt: "When you
have completed your review/task, call `send_message({body: <findings>,
kind: '<review|note|status>'})` to report back. Include relevant
`files` and `excerpts` in the message."

For non-Tier-2 adapters (gemini-cli, generic, openai-compatible), the
worker has no `send_message` tool. Findings come back via the
worker's terminal summary (surfaced as top-level `summary` on the
`get_run_status` response, already captured by crew-mcp); plan
prompts that ask the worker to produce a useful terminal summary
rather than rely on inbox reporting.

### Verifying the worker attended to peer_messages

There's no automated ACK signal in v1. To confirm the worker read
your peer_messages, read its response in events.log or the terminal
summary and look for substantive engagement with the message content.
If the response doesn't seem to address the peer_messages, consider
re-prompting with a stronger directive ("please address each peer
message I sent").

(ACK sentinels were specified through v3-v4 and descoped in v5; see
§Future work for the v2 path.)

### When NOT to use peer_messages or send_message

- Single-message captain-to-worker context that isn't structured: just
  put it in the prompt directly.
- One-shot worker output you'll only read once: terminal status +
  events.log is fine; don't ask the worker to call `send_message`.

Inbox is for STRUCTURED multi-agent flows where typed messages aid
synthesis or audit.

### Captain inbox housekeeping

`check_captain_inbox({status: 'unread'})` for the active queue.
`acknowledge_messages({msg_ids, action: 'read'})` after consuming.
`acknowledge_messages({msg_ids, action: 'dismiss'})` for messages you
won't act on. Read/dismissed messages auto-prune after 7 days.

### Don't let inbox-full block worker reports

`inbox_full` is raised on `send_message`, NOT on `run_agent` or
`continue_run` — captain dispatch is unaffected by inbox cap.
However, a worker that hits `inbox_full` will fail to deliver its
findings, leaving you with no typed inbox record (the worker's output
stream is still captured in events.log).

If you see `inbox_full` errors in worker output: drain the captain
inbox via `acknowledge_messages({msg_ids, action: 'read' or 'dismiss'})`.
Default unread cap is 200 per repo.

### `kind` is advisory

The `kind` enum (`note | review | question | answer | status` for
captain inbox; same set for `send_message`) is an advisory hint, not
a behavioral signal. Crew-mcp does NOT branch on `kind`. Use it to
filter or sort when reading the inbox; otherwise treat all bodies the
same.

### When the worker doesn't send_message

If you dispatched a worker expecting it to call `send_message` and
the inbox stays empty after terminal:

1. Check `get_run_status({run_id})` for the worker's terminal summary
   and `events_tail` — the findings may be in the output stream even
   if the worker didn't call `send_message`.
2. Check the adapter tier for that adapter. Tier 2 (codex,
   claude-code) supports MCP send_message. Non-Tier-2 (gemini-cli,
   generic, openai-compatible) does NOT — only `terminal.summary`
   reports findings.
3. If Tier 2 and the worker didn't call: the worker may have
   forgotten the instruction. Consider tightening the prompt next
   time (the auto-appended footer is generic; you can add specific
   "REQUIRED: call send_message before terminating" guidance).
```

## Worker skill / prompt instructions

Workers don't have a separate crew-mcp skill; they receive instructions
via the captain's prompt. crew-mcp auto-appends a footer to the
composed prompt at dispatch time — both `run_agent` and `continue_run`
— when the run's adapter is Tier 2 (per the §"Adapter compatibility
matrix"): `adapter_id in {'codex', 'claude-code'}`. For non-Tier-2
adapters, NO footer is appended; the captain should write prompts
that ask the worker to produce a useful terminal summary.

```
## Reporting back to the captain

You have access to the `send_message` tool. Use it to deliver
structured findings to the captain. Required: `body`. Optional:
`kind` (note / review / question / answer / status), `files`,
`excerpts`, `in_reply_to`.

Call `send_message` once you have a finalized result to deliver.
Do NOT call it for in-progress status updates unless the captain has
explicitly asked.
```

For non-Tier-2 adapters (gemini-cli, generic, openai-compatible),
the footer is NOT appended (no `send_message` tool is available).
Captain prompts should instead instruct these workers to produce a
useful terminal summary.

**Re-append on every dispatch** (correction from earlier drafts):
the Tier 2 footer is added by crew-mcp's dispatcher to every
`run_agent` and `continue_run` prompt where the adapter is Tier 2.
This is not guaranteed by agent memory across the
`adapter.execute()` path (continue_run isn't a reliable
conversational resume for every adapter; some adapters spawn fresh
subprocesses each turn). The footer must be present in every turn's
prompt where the captain expects send_message behavior.

The footer text itself lives in
`src/orchestrator/peer-messages/worker-footer.ts` and is selected by
adapter tier (Tier 2 → MCP footer; non-Tier-2 → no footer).

## Edge cases

### Captain serve dies before worker writes

Worker writes to disk regardless. On captain serve restart, captain's
next `check_captain_inbox` returns the queued messages. The captain
inbox is a durable store; serve liveness is irrelevant to write
delivery.

### Worker writes after run is merged

Refused with `run_not_active` (token-revoked). The worker's adapter
should have exited before merge in normal flow; this guards against
adapter zombies.

### Worker writes after run is discarded

The sidecar file is deleted with the run dir. Worker's
`readSidecar` throws → `token_invalid`. No write.

### Worker writes during run cancellation

`cancel_run` does NOT revoke the token (cancel is recoverable). If the
worker's adapter exits cleanly during cancel, `send_message` is moot.
If it manages to send a message before exit, the message lands in
captain inbox normally.

### Concurrent worker writes

Multiple workers writing to the same captain inbox. Lock is mkdir-based
(`~/.crew/captain-inbox/<repoHash>/.lock`). Each worker acquires the
lock for cap-check + write, releases. Microseconds of contention.

### Captain reads while worker writes

Captain's `check_captain_inbox` does a directory listing + per-file
read. No lock needed — reads are atomic per file (the worker writes
via tmp+rename). Worst case: captain's listing misses an in-flight
write or sees a stale state. Both are benign; next read picks it up.

### `peer_messages` validation: `in_reply_to_captain_inbox_msg` lookup

The validation path:
- **Same repo, any run**: ALLOWED. The primary use case is "captain
  forwards run B's review back to run A as `peer_messages` with
  `in_reply_to_captain_inbox_msg = <B's msg_id>`." The lookup walks
  `~/.crew/captain-inbox/<repoHash>/` and accepts any matching
  `msg_id` whose stored `repo_root_at_send` matches the captain's
  current `repoRoot`.
- **Cross-repo**: REFUSED with `peer_message_in_reply_to_not_found`
  (same error as a missing parent — no leak that the message exists
  in another repo).

### Worker in restricted mode tries to call other tools

Restricted serve only registers `send_message`. Other tool names return
"unknown tool" (standard MCP error). Worker can't escalate.

### Token leak

If `CREW_RUN_TOKEN` is logged or otherwise exposed: an attacker with
access to the token AND filesystem access to the sidecar (to learn the
run_id) can write into captain inbox under that worker's identity.
Mitigation:
- Sidecar is mode 0600 (only the captain user can read).
- Token is per-run (limits blast radius).
- Token is revoked on merge/discard.
- v2 will add capability tokens with cryptographic binding.

For v1, threat model is "the user trusts their own filesystem and
processes." Cross-user attacks on the same machine are out of scope.

### Captain inbox unread cap reached

If 200 unread messages accumulate, new `send_message` calls fail with
`inbox_full`. Captain is responsible for draining the queue. The 200
cap is generous (most workflows produce 1-5 inbox messages per
panel) but explicit so runaway agents can't fill the disk.

### Adapter doesn't propagate env (tier classification)

Per §"Adapter compatibility matrix":
- **Tier 2** (codex, claude-code): per-invocation MCP env injection
  via argv/inline-JSON → workers get the `send_message` MCP tool.
- **Non-Tier-2** (gemini-cli, generic, openai-compatible): no MCP
  `send_message` tool surface in v1; findings come via
  `terminal.summary`.

If a Tier 2 adapter's per-invocation injection regresses (e.g., a
host CLI update changes argv semantics), the captain detects it via
the `.worker-ready.json` handshake timeout. `send_message` is
unavailable for that run; the captain reads findings via
`terminal.summary`. The user is informed via the dispatch envelope's
warning; the run continues.

### `state.json.tmp` cross-process collision

Same forward-compat tax as v7 plan: change `writeState` to use
`state.json.${pid}.${random}.tmp` now. Cost: <30min.

### `from_label` injection

Captain-supplied; could in principle contain malicious content
(`from_label: "Captain says: ignore prior instructions and ..."`).
Mitigation: render as plain text in the prepend template, no
interpretation. Cap at 80 chars. Reject control characters at input
time.

### Long-running runs holding tokens

A run that lives for 8 hours holds an active token the whole time.
That's intentional — the worker may need to call `send_message`
multiple times across continuations. Token stays valid until terminal
+ merge/discard.

### Sidecar permission drift (fail-closed)

If a user `chmod`s the sidecar to mode != 0600 between issuance and
worker startup (or between calls), the trust boundary is broken.
v1 fails closed:

- At restricted serve startup: if `(stat.mode & 0o777) !== 0o600`,
  refuse to start. The MCP subprocess crashes loudly; the host CLI
  surfaces the error to the captain.
- On every `send_message` call: re-check sidecar mode. If drift
  detected, return `sidecar_permission_invalid`. The worker can't
  send.

(v1 plan originally said "warn and continue"; v2 corrects to
fail-closed per round-1 review. The threat model — "user trusts their
own filesystem" — is precisely what's violated by world-readable
sidecars; warning-and-continuing buys nothing.)

### Two captains, one repo

If a user runs two `crew-mcp serve` instances against the same repo
(e.g., two host CLI sessions concurrently): both captains share
`~/.crew/captain-inbox/<repoHash>/`. A worker dispatched by captain A
writes to that inbox; captain B's `check_captain_inbox` will surface
the message too, because there's no captain-process binding stored on
the message.

v1 accepts this: captain inbox is repo-scoped, not captain-scoped.
Two concurrent captains observe the union of dispatched-worker
findings. If isolation is needed (e.g., one captain shouldn't see the
other's reviews), users should run the captains in separate repos.
v2 may add `captain_serve_instance` filtering to `check_captain_inbox`
if this becomes a real problem.

### `acknowledge_messages` parallel race

Two concurrent captain calls to `acknowledge_messages` on overlapping
`msg_ids`: handled by the captain inbox lock. Both calls acquire the
lock sequentially; the first call transitions matching messages, the
second finds `already_in_target_state` for the same ids. No double-mark,
no lost transition. The lock is brief (per-message file rewrite is
microseconds).

### `.worker-ready.json` lifecycle

The marker file lives at `~/.crew/runs/<runId>/.worker-ready.json`
(mode 0600). It's created by the worker's restricted serve at startup
(after sidecar validation). It's deleted by the captain when the run
reaches terminal status (any). Stale markers from prior runs are
swept at captain serve startup as part of the existing stale-run
sweeper (`run-state.ts:97-110`).

If the captain serve crashes between dispatch and terminal: the
marker stays on disk. Next captain startup's sweeper deletes it
alongside resolving the stale run. Worker processes that read the
marker do not exist (workers don't read it; only the captain does).

### MCP tool dispatch for unknown tools

When a worker in restricted mode tries to call a captain-only tool
(say `merge_run`), the MCP layer returns "tool not found." Some host
CLIs may interpret this as a fatal MCP error and abort the agent's
turn; others log and continue. v2 spec: each host CLI's behavior is
documented in the Phase 2 compatibility report. If a CLI aborts on
unknown-tool, the captain sees the run end with an error containing
the unknown-tool name — that's a useful signal that the worker tried
to escalate.

### Captain handshake timeout

If `.worker-ready.json` doesn't appear within
`CREW_WORKER_READY_TIMEOUT_MS` (default 10_000), the captain
classifies the run as "send_message unavailable" for the dispatch.
The envelope's `worker_ready` field is set to `timeout`; findings
come via `terminal.summary` only. The run continues normally.

If the marker arrives AFTER the timeout (slow host CLI / late MCP
child spawn): the worker's `send_message` calls still succeed
(restricted serve is up), and messages land in the captain inbox
normally. The captain may then observe a `timeout` flag alongside
actual inbox messages — interpret as "took longer than expected,
but worked." `state.json.worker_ready` is opportunistically set to
`ready` on any successful send_message.

## Testing

### Unit tests

- `peer_messages` validation matrix (every error code).
- `peer_messages` rendering: golden test on prepend block bytes for
  zero / one / many messages, with and without files / excerpts /
  in_reply_to / from_label.
- `peer_messages` cap behavior: first-message-force, hard ceiling,
  fence escalation.
- `send_message` validation: token mismatch, revoked token, run not
  active, repo_root mismatch, in_reply_to_not_found.
- `peer_messages_count` per-prompt counter increments on dispatch
  (no automated ACK in v1; verify count alone).
- Token sidecar: write atomicity, mode 0600 enforcement, constant-time
  comparison.

### Integration tests

- Captain dispatches A with `peer_messages`; A receives prepend block
  (verify via prompt capture).
- Tier 2 worker calls `send_message`; message lands in captain inbox;
  captain reads via `check_captain_inbox`.
- Non-Tier-2 worker (gemini fixture): no `send_message` tool
  registered (defense via argv `['--allowed-mcp-server-names', '']`);
  findings appear via top-level `summary` on `get_run_status` only.
- Multi-panel (Tier 2): 2-3 codex/claude workers concurrently call
  `send_message`; captain reads all via `check_captain_inbox`.
- Token revocation on `merge_run`: subsequent `send_message` fails
  with `token_revoked`.
- Restricted serve refuses non-`send_message` tools (captain-only
  tools return "tool not found").
- Adapter env propagation (Tier 2): verify each adapter's MCP
  subprocess sees `CREW_RUN_ID` and `CREW_RUN_TOKEN` via fixture probe.
- Dispatch transaction rollback: simulate `dispatcher.start()` sync
  throw; verify state restored, listeners disposed, token revoked
  (run_agent: state.json deleted; continue_run: prompt record
  removed).

### Property tests

- Random valid `peer_messages` arrays render to byte-identical block
  given the same inputs.
- Random valid `send_message` calls land in captain inbox exactly once
  per call.

## Phasing

The spike (Phase 0, complete) established the adapter classification
empirically; phases reflect that result. Phase ordering matters: the
spike's findings drive Phase 2's tier-aware wiring, but Phase 1
(worker-side restricted serve, state lock expansion, dispatch
transaction, handshake marker) is tier-agnostic and can start in
parallel with Phase 2 once the spike is done.

### Phase 0 — adapter spike (complete, 2026-05-10)

Empirical classification of codex (Tier 2), claude-code (Tier 2),
gemini-cli (Tier 3) per §"Adapter spike (2026-05-10)". Findings
captured in this plan; no separate doc deliverable.

**Cost: 0d** (spike already run).

### Phase 1 — token + sidecar + restricted serve + dispatch transaction + state lock

- `src/orchestrator/auth/token.ts` — token generation, sidecar
  read/write/revoke (per-dispatch lifecycle).
- `src/orchestrator/auth/sidecar-schema.ts` — `RunAuthSidecar` types +
  Zod.
- `src/cli/commands/serve.ts` — fail-closed restricted mode; only
  `send_message` registered when env+sidecar valid (partial env →
  refuse; mode != 0600 → refuse).
- `src/orchestrator/dispatch-transaction.ts` — `withDispatchTransaction`
  wrapper per §"Per-run dispatch transaction" — two distinct entry
  paths (run_agent / continue_run) with per-step failure rollback.
  State lock held throughout. Includes
  `installRunLifecycleListeners` refactor to return `{terminalPromise,
  dispose}` so the transaction can dispose listeners on synchronous
  throw.
- `src/orchestrator/run-state.ts`:
  - `state.json.tmp` -> unique-named tmp.
  - State lock expansion to all `RunStateStore` mutations
    (markTerminal/markMerged/markMergeConflict/markDiscarded + sweeper +
    appendPrompt + create).
  - **`appendPrompt` signature migration to options form**
    (`appendPrompt(runId, {userPrompt, peerMessages})`) — moved
    from Phase 5 to Phase 1 because the dispatch transaction
    (Phase 1) consumes the new signature. Phase 1 implements the
    signature change + the ~5 call-site sweep. Phase 5 still owns
    the peer_messages SCHEMA + prepend builder; Phase 1 just owns
    the `appendPrompt` API shape.
  - **`RunStateStore.create()` options extension**
    (`create({initialPrompt, initialPeerMessages, ...})`) — moved
    from Phase 5 to Phase 1 for the same reason. `initialPeerMessages`
    is optional (Phase 1 callers pass `undefined`; Phase 5 wires
    actual peer_messages through).
  - **NEW `revertTurn(runId, {turnNumber, priorStateSnapshot})` API**
    for continue_run rollback: removes the prompt record with
    matching 1-based `turn` field (NOT `prompts[]` array index);
    restores `status`/`completedAt`/`serverPid` from the snapshot.
    Atomic write under state lock.
  - Lock-order documentation (state before worktree; never both held).
- **Planner refactor** (`run-agent.ts:209` + `continue-run.ts`):
  return a task-builder closure `(sidecar: RunAuthSidecar) => Task`
  instead of a fully-constructed Task. **Owned entirely by Phase 1**
  (the dispatch transaction depends on it). Phase 2 implements
  `dispatchMcpEnv` argv consumption in adapters — it does NOT
  re-touch the closure shape.
- **`Task.dispatchMcpEnv?` field declaration** in
  `src/adapters/types.ts` (v9: moved from Phase 2 to Phase 1 per
  round-8 finding — Phase 1's dispatch transaction needs the type
  to compile). Phase 2 still owns the adapter argv builders that
  CONSUME this field (codex / claude-code) and the gemini defense.
- **Minimal `PeerMessageRendered` type stub** in
  `src/orchestrator/peer-messages/schema.ts` (v9: moved from Phase 5
  to Phase 1 per round-8 finding — Phase 1's `appendPrompt` /
  `create` signatures reference it). Phase 1 ships just the type
  declaration (the persisted shape: `peer_message_id`, `body`,
  `kind`, `created_at`, `rendered_at`, `rendered_in_turn`, etc.).
  Phase 5 owns the Zod validator, prepend builder, kind enum and
  any field extensions.
- `.worker-ready.json` write at restricted-serve startup; detached
  handshake polling on captain side (NOT blocking dispatch return);
  cleanup at terminal hooks. **Worker-mode tool registry in Phase 1
  is empty** (`registered_tools: []` in the marker): the actual
  `send_message` tool is owned by Phase 3. Phase 1 ships the
  worker-mode INFRASTRUCTURE (fail-closed startup, sidecar
  validation, conditional tool registry) without the tool itself.
  Phase 3 fills in the registry entry; Phase 3 also updates the
  marker to write `registered_tools: ["send_message"]` once the tool
  exists.
- Tests: token atomicity, mode 0600 enforcement, partial-env refuse,
  state lock contention, dispatch transaction serializes concurrent
  continue_run, listener install ordering + rollback dispose on sync
  throw, run_agent rollback removes orphaned state.json + sidecar +
  worktree, continue_run rollback restores prior status via
  `revertTurn`, planner returns a task-builder closure, `Task.dispatchMcpEnv`
  type exists and is optional.

**Estimate:** 3.5 days. v6 was 2.5d; v7 was 3d; v8 bumped to 3.5d
absorbing `appendPrompt` / `create` signature migration. v9 adds
`Task.dispatchMcpEnv` field declaration + `PeerMessageRendered` type
stub but does not bump budget — both are ~10-line additions that
fit within v8's 3.5d allocation.

### Phase 2 — adapter per-invocation env injection

Adapter classification is FIXED by Phase 0 spike. Round-3 review
clarified that v3's "Already plumbed" framing was misleading: the
serializers exist as primitives (`toCodexConfigOverrides`,
`toClaudeMcpConfigJson` in `mcp-registration.ts`) but are only
consumed by the legacy `executeWithTools` path. The production
`adapter.execute(task)` path needs NEW wiring.

Phase 2 work (note: `Task.dispatchMcpEnv?` field declaration moved
to Phase 1 in v9; Phase 2 only consumes it):
- The planner closure (Phase 1) already threads the sidecar into
  `task.dispatchMcpEnv`. Phase 2 wires the consumers in each
  adapter's `execute()` argv builder.
- **CodexAdapter.execute() argv builder** (`src/adapters/codex.ts:399-451`):
  if `task.dispatchMcpEnv` set, append `-c
  mcp_servers.crew.env.CREW_RUN_ID="<id>"` and `-c
  mcp_servers.crew.env.CREW_RUN_TOKEN="<token>"` to the args array.
  TOML string quoting via `toTomlString`.
- **ClaudeCodeAdapter.execute() argv builder**
  (`src/adapters/claude-code.ts:456-463`): if `task.dispatchMcpEnv`
  set, append `--mcp-config <inline-JSON-with-env-block>` and
  `--strict-mcp-config` to args.
- **GeminiCliAdapter.execute()** (`src/adapters/gemini-cli.ts:285`,
  direct edit; do NOT route through `buildGeminiResumeArgs` which
  suppresses empty arrays): append the exact two argv elements
  `['--allowed-mcp-server-names', '']` to deny all MCP servers
  including the installed crew-mcp. Without this defense, gemini
  workers inherit captain tools (round-5 finding). Phase 2 deliverable
  includes an integration test asserting these two elements appear in
  the produced argv array, in that order.
- **GenericAdapter / OpenAiCompatibleAdapter**: no MCP child to
  defend; document explicitly that `send_message` is unavailable for
  these adapters (findings via top-level `summary` on get_run_status).
- Integration tests:
  - Tier 2: assert the actual `execa` argv array contains the
    per-run env block (per codex / claude-code).
  - Gemini: assert the dispatch argv array contains the two adjacent
    elements `'--allowed-mcp-server-names'` then `''` (defense holds).
  - Live integration (when binaries available): spawn `codex exec` /
    `claude` with the per-invocation env block; assert `crew-mcp
    serve` child receives env via fixture probe. Spawn `gemini`
    and verify the worker has NO crew-mcp tools loaded.

**Estimate:** 2 days (+ 0.25d for gemini defense + tests).

### Phase 3 — `send_message` tool + captain inbox storage

- `src/orchestrator/captain-inbox/schema.ts` — types + Zod.
- `src/orchestrator/captain-inbox/store.ts` — read/write/transition;
  mkdir lock; lock-covered cap-check + write + rename.
- `src/orchestrator/tools/send-message.ts` — restricted-mode tool;
  identity stamping from sidecar; cap checks; flat `files` /
  `excerpts` schema; `to` defaults to `{kind: 'captain'}`; `in_reply_to`
  same-run only.
- Install catalog `mode` field added (`SkillTool.mode: 'captain' |
  'worker' | 'both'`); `send_message` registered worker-only; captain
  skill rendering filters by mode.
- **Update `.worker-ready.json` marker** to write
  `registered_tools: ["send_message"]` (Phase 1 shipped the marker
  with empty `registered_tools: []`; Phase 3 fills in the entry once
  the tool exists).
- Tests: validation matrix, identity stamping, concurrent writes,
  token validation, install catalog mode snapshot, `send_message`
  hidden in captain mode, marker reflects `["send_message"]` after
  Phase 3 wiring.

**Estimate:** 1.5 days.

### Phase 4 — `check_captain_inbox` + `acknowledge_messages` + `list_runs` summary

- `src/orchestrator/tools/check-captain-inbox.ts` — read-only with
  status / limit / since / from_run_id filters.
- `src/orchestrator/tools/acknowledge-messages.ts` — `read`/`dismiss`
  transitions; parallel-call safe (covered by inbox lock).
- `src/orchestrator/captain-inbox/store.ts` — retention sweeper
  (read/dismissed > 7 days); sweep cooldown to avoid O(N²) on hot
  inboxes.
- `list_runs` adds `captain_inbox_summary` (NOT on `get_run_status`).
- `get_run_status` adds `peer_messages_count` per prompt record;
  `worker_ready` field surfaces the handshake result.
- Tests: status filters, limit + since pagination, transitions,
  retention sweep, parallel acknowledge race.

**Estimate:** 1 day.

### Phase 5 — `peer_messages` parameter + prepend builder

- `src/orchestrator/peer-messages/schema.ts` — types + Zod (5-kind
  enum aligned with send_message).
- `src/orchestrator/peer-messages/prepend.ts` — build prepend block;
  golden tests (byte-exact).
- `continue_run` and `run_agent` schema relaxation + dispatcher
  composedPrompt logic. The captain's tool handler now passes
  `peer_messages` into the planner closure (Phase 1 owns the closure
  shape; Phase 5 wires the actual peer_messages data through it).
- Wire `appendPrompt({userPrompt, peerMessages})` and
  `create({initialPrompt, initialPeerMessages})` callers in
  `run_agent` / `continue_run` to actually pass `peerMessages`.
  (Phase 1 already migrated the API signatures; Phase 5 just supplies
  the values from the new tool parameter.)
- Worker-prompt-footer auto-append on every dispatch for Tier 2
  adapters; no footer for non-Tier-2.
- Tests: golden bytes, validation, parameter caps, footer presence
  per adapter tier.

**Estimate:** 1 day. (v7 was 1.5d; -0.5d because the API signature
migration moved to Phase 1.)

### Phase 6 — captain skill + dogfood

- Update `skills/crew-captain.body.md` with the multi-agent messaging
  section (peer_messages patterns, send_message receiving for Tier 2
  adapters, multi-panel review, kind taxonomy, terminal.summary
  fallback for non-Tier-2).
- Update `crew-mcp install` for new captain-side tools
  (`check_captain_inbox`, `acknowledge_messages`).
- Verify (`crew-mcp verify`): captain mode registers expected captain
  catalog; worker mode (fixture) registers only `send_message`.
- Dogfood: 2 real implement-then-review tasks + 1 multi-panel review
  end-to-end (codex + claude-code).
- Update `docs/status/captain-flow-review-*.md`.

**Estimate:** 1 day.

**Total: ~10.25 days** (Phase 1: 3.5d [bumped from 3d to absorb
appendPrompt + create signature migration]; Phase 2: 2.25d; Phase 3:
1.5d; Phase 4: 1d; Phase 5: 1d [trimmed from 1.5d since signature
migration moved to Phase 1]; Phase 6: 1d). Trims to ~8-9d if Phase 1's
state lock expansion + dispatch transaction refactor + signature
migration turn out smaller than estimated; could grow to 11-12d if
adapter integration tests reveal Tier 2 quirks.

## Future work

### v2 — output-stream parser fallback (non-Tier-2 adapter findings)

Re-introduce structured worker-to-captain reporting for non-Tier-2
adapters via a `[CAPTAIN-MSG-OPEN]…[CAPTAIN-MSG-CLOSE]` block format
in worker output. v5 descoped this after rounds 2-4 surfaced
implementation gaps (raw output substrate, rotation/cursor mechanics,
partial-block handling, per-adapter streaming behavior). Bring back
when:
- Concrete evidence that the non-Tier-2 gap matters in real workflows.
- Raw output capture infrastructure is designed against actual
  adapter streaming behavior (Generic/Gemini empirical investigation
  done; not assumed).
- Parser cursor semantics designed for rotation from the start.

### v2 — ACK sentinels via raw output capture

Re-introduce `[INBOX-ACK <peer_message_id>]` sentinel parsing for
captain → worker direction. Captain gets a soft signal that the
worker attended to each peer_message. Depends on the same raw output
capture infrastructure as the output-stream parser. v2 may instead
implement cryptographic ACK via worker-callable `ack_inbox_message`
MCP tool (no parser needed).

### v2 — worker -> worker `send_message`

Expand `send_message`'s `to` field to accept `{kind: 'run', run_id}`.
Requires:
- Token-bound peer addressing (worker's token validates that it can
  send to a specific run, not just captain).
- Per-run inboxes (or a unified inbox keyed by run_id).
- Storage layer for run-targeted messages (analogous to v7's run
  inbox, but only built when actually needed for w2w).

### v2 — broadcast / `run_panel`

Tool that fans-out a `peer_messages` payload to N workers, OR a
captain-side `send_to_panel` that writes to a shared panel inbox.
Separate plan.

### v2 — auto-continue

Captain serve daemon that watches captain inbox; fires `continue_run`
on a recipient when a relevant message arrives. Per-recipient policy
+ loop guard + quota.

### v2 — cancel-then-steer (`steer_run`)

Atomic `cancel_run + continue_run` with a peer_messages payload.
Today this is two tool calls (cancel, then continue with steer).

### v2 — cryptographic ACK via worker-callable `ack_inbox_message`

Replaces sentinel parsing with a hard signal. Worker calls a tool to
confirm receipt; the tool validates the run's token and updates the
ACK metadata. Bundled with the v2 worker-to-worker trust boundary
work.

### v2 — captain reply via captain-inbox `in_reply_to` follow-ups

Allow captain to forward a chain (worker -> captain msg M1, captain
forwards to peer via peer_message that references M1, peer responds
via send_message that references the captain's peer_message_id).
Already partially supported (via `in_reply_to_captain_inbox_msg`); v2
adds threading visualization and audit.

### v2 — encrypted-at-rest sidecar / capability tokens

Replace plain-token sidecars with HMAC-signed capability tokens.
Trust no longer depends on filesystem permissions.

## Adapter spike (2026-05-10)

Empirical classification of host CLIs' MCP env-injection mechanisms.
Ran as Codex (xhigh, read-only) review against `mcp-registration.ts`,
each host installer, and upstream CLI sources/docs.

### codex — Tier 2 (high confidence)

**Ambient env propagation: NO.** Codex calls `env_clear()` before
spawning MCP servers (`openai/codex/codex-rs/mcp-client/src/mcp_client.rs`
lines 6, 27-30); only a curated allowlist plus the explicit `env`
block on the MCP server spec survives.

**Per-invocation injection: YES** via `-c mcp_servers.<name>.env.<key>=<value>`
argv flags. Documented at `developers.openai.com/codex/config-reference`
(lines 862-890) and `developers.openai.com/codex/cli/reference`
(lines 2407-2409). Already plumbed in crew-mcp:
- `src/orchestrator/mcp-registration.ts:55` serializes env overrides.
- `src/adapters/codex.ts:979` spreads per-session flags into `codex exec`.

**v1 invocation form:**
```
codex exec ... -c 'mcp_servers.crew.env.CREW_RUN_ID="<id>"' \
              -c 'mcp_servers.crew.env.CREW_RUN_TOKEN="<token>"'
```

### claude-code — Tier 2 (medium confidence)

**Per-invocation injection: YES** via `--mcp-config` (inline JSON or
file) + `--strict-mcp-config`. Documented at
`code.claude.com/docs/en/cli-reference` (lines 129, 149) and
`code.claude.com/docs/en/mcp`. Stdio server JSON accepts `env`;
`claude mcp add --env KEY=value` writes env. Already plumbed in
crew-mcp:
- `src/orchestrator/mcp-registration.ts:100` builds inline JSON with
  env block.
- `src/adapters/claude-code.ts:60` passes via `--mcp-config`.

**Ambient env propagation: UNKNOWN.** Docs silent; not empirically
inspected. Moot since per-invocation works.

**v1 invocation form:**
```
claude ... --mcp-config '{"mcpServers":{"crew":{
  "type":"stdio","command":"crew-mcp","args":["serve"],
  "env":{"CREW_RUN_ID":"<id>","CREW_RUN_TOKEN":"<token>"}
}}}' --strict-mcp-config
```

### gemini-cli — Tier 3 (high confidence)

**Ambient env propagation: NO.** Two stoppers:
1. Gemini sanitizes env names matching `/TOKEN/i`
   (`google-gemini/gemini-cli/packages/core/src/services/environmentSanitization.ts`).
   `CREW_RUN_TOKEN` would be filtered out by name.
2. Stdio MCP startup uses sanitized `process.env` then merges
   `mcpServerConfig.env`
   (`google-gemini/gemini-cli/packages/core/src/tools/mcp-client.ts`
   lines 69-71). Without an explicit `env` mapping in settings.json,
   nothing of ours reaches the MCP child.

**Per-invocation injection: NO.** Gemini's invocation-time MCP flag
is `--allowed-mcp-server-names` (selection only, not config
overrides). Source confirmed at `src/adapters/gemini-cli.ts:199`. No
mechanism to inject env per-invocation.

**Possible Tier 2 workaround (rejected for v1):** install-time write
of `~/.gemini/settings.json` `crew` MCP entry with
`env: {"CREW_RUN_ID":"${CREW_RUN_ID}","CREW_RUN_SECRET":"${CREW_RUN_SECRET}"}`
(renamed from `_TOKEN` to bypass sanitization), THEN inject ambient
env at dispatch. Risky: settings.json is a shared file; concurrent
dispatches have parallel-safety issues identical to the round-2
file-mutation rejection. Settled: gemini = Tier 3 in v1.

### Recommendation (superseded — historical snapshot at spike time)

**Note:** this recommendation reflected the design intent immediately
after the spike (when output-stream fallback was still in scope).
v5 descoped output-stream fallback and v6 added the gemini MCP
defense. The current authoritative design lives in §"Adapter
compatibility matrix" earlier in this document; the recommendation
below is preserved as historical context.

> v1 implements Tier 2 for codex + claude-code (existing primitives,
> no concurrency races); Tier 3 (output-stream fallback) for gemini-cli
> and generic; openai-compatible is N/A for incremental output (no
> `send_message`, no output-stream — terminal.summary only).

**Current (v5-v8) recommendation:** Tier 2 for codex + claude-code
unchanged; non-Tier-2 (gemini, generic, openai-compatible) workers
have NO `send_message` MCP tool — findings via top-level `summary`
on `get_run_status` response. Gemini additionally gets the
`--allowed-mcp-server-names`/`''` defense to prevent inheriting the
installed crew-mcp captain tools.

### Gaps / follow-ups for Phase 2

- Live integration test for codex + claude-code: spawn the host CLI
  with the per-invocation env block; assert crew-mcp serve child
  receives env via fixture probe (`/proc/<pid>/environ` on Linux;
  `ps eww <pid>` on macOS).
- Verify codex's argv `-c` overrides actually reach the MCP server
  spec at startup (codex parses these into its config struct at
  invocation time; check the resulting effective config).

## Round 2 review log (2026-05-10)

Two reviews (Codex xhigh + local code-architect) ran in parallel
against v2. **Both said NOT READY** with deeper findings than round 1
— v2's "fixes" were paper-deep and didn't survive contact with the
live codebase (events.log truncation, sync dispatcher event
listeners, shared host config files). v3 addresses every blocker; the
empirical Phase 0 spike materially simplifies the trust-boundary
design that round-2 challenged.

### Convergent concerns (both reviewers)

| Concern | Resolution in v3 |
|---|---|
| **Tier 2 host-config mutation breaks parallel dispatch.** Both reviewers showed that mutating `~/.codex/config.toml` etc. at dispatch races concurrent dispatches; primary use case (multi-panel review) is exactly the racing scenario. | **Tier 2 redefined.** Per-invocation argv/config injection via `-c mcp_servers.crew.env.X=Y` (codex) and `--mcp-config <inline-JSON>` (claude). Already plumbed in `mcp-registration.ts:55,100`. No shared file mutation. v3's §"Adapter compatibility matrix" rewrites the mechanism. |
| **Output-stream parser dies against events.log truncation.** `serve.ts:1070` caps lines at 240 chars; codex/claude collapse text into `message:` previews. A 16KB JSON block can't survive. | **Raw output capture (new infra).** v3 adds `~/.crew/runs/<runId>/raw-output.log` written BEFORE truncation/prefixing. ACK parser and output-stream parser both scan it. §"Raw output capture" specifies framing, size budget, rotation. |
| **State lock insufficient for full dispatch transaction.** "Wrap all RunStateStore mutations" misses that `continue_run` reads status, builds task, appends prompt, and starts dispatcher in separate steps; two concurrent continuations still pass validation. | **Per-run dispatch transaction.** v3 §"Per-run dispatch transaction" defines `withDispatchTransaction` wrapping the full critical section: status check → revoke → sidecar → append/create → mark-running → dispatcher.start. State lock held throughout. |
| **`send_message.in_reply_to` self-contradiction.** v2's schema notes said cross-run-within-repo allowed; the lookup section said same-run only. | **Pinned to same-run only.** v3 §"`send_message`" schema notes now say "**same-run only** — workers can only reply to peer_messages the captain sent them." Asymmetric with captain's `peer_messages.in_reply_to_captain_inbox_msg` (repo-wide cross-run by design). Documented in both places. |

### Codex-specific catches

| Concern | Resolution in v3 |
|---|---|
| Restricted serve still fail-open: handshake detects fail-over AFTER spawn; worker may already have captain tools. | With Tier 2 per-invocation injection, env propagation is guaranteed by construction. Restricted serve fail-closes at startup. v3 §"Restricted serve verification (handshake, background)" repositions the handshake as soft verification, not fail-open detection. |
| ACK parser regex `^\[INBOX-ACK ...\]\s*$` won't match `message: [INBOX-ACK ...]` collapsed lines. | ACK parser scans `raw-output.log` (untruncated, unprefixed). v3 §"Sentinel format" updated. |
| Worker footer regresses in Phase 6 phasing — design says every dispatch but phase 6 says only when peer_messages supplied. | Phase 5 explicitly: "footer auto-append on EVERY dispatch (run_agent + continue_run); adapter-tier-aware footer text." Phase 6 no longer carries footer plumbing. |
| Budget 13-16d (under v2 file-mutation assumption). | v3 with Tier 2 per-invocation injection drops to ~10-11d total. |

### Code-architect-specific catches

| Concern | Resolution in v3 |
|---|---|
| Handshake polling on dispatch hot path violates captain non-blocking contract. | v3 §"Restricted serve verification (handshake, background)" — detached task; result stored on `state.json.worker_ready`; lazy evaluation at first read. Dispatch return is non-blocking. |
| Phase ordering: Phase 1 captain-side handshake depends on Phase 2 classification. | Phase 0 (spike) is now complete; Phase 1 implements worker side + dispatch transaction + raw output capture; Phase 2 wires per-invocation injection for the two Tier 2 adapters. Captain-side handshake (background) is in Phase 1; tier-awareness is data-driven (Phase 0 outputs) not code-conditional. |
| `kind` enum cardinality inconsistency (peer_messages 4 vs send_message 5). | Aligned: both use the 5-kind enum (`note | review | question | answer | status`). `peerMessageInputSchema` updated. |
| Output-stream parser missing dedup / multi-line / prefix / schema specs. | v3 §"Tier 3 (output-stream fallback): how it works" specifies: cursor on `state.json.output_stream_cursor`; multi-line regex `/\[CAPTAIN-MSG-OPEN\]\s*(\{[\s\S]*?\})\s*\[CAPTAIN-MSG-CLOSE\]/g`; raw-output.log avoids the prefix problem; malformed-JSON skip with warning. |
| `delivery_via` referenced but not in schema. | Added to `CaptainInboxMessage` schema: `delivery_via: 'mcp' \| 'output-stream'`. |
| Phase 6 underbudgets dogfood (multi-panel wall-clock + Tier 2 debugging). | Rebudgeted to 1.25-1.5d. |
| Round-1 review log misrepresented `in_reply_to` cross-run resolution. | v3 keeps round-1 log verbatim (historical record) but adds explicit asymmetry callout in §"`send_message`" schema notes and §"`peer_messages` validation". |

### Disagreements + resolutions

None. Round-2 reviewers agreed on every architectural finding. The
spike (which neither reviewer prescribed but I proposed in response
to round-2's "Phase 2 budget is unrealistic" framing) ended up
collapsing the round-2 critical blocker about Tier 2 file mutation
— the existing argv/JSON paths are sufficient, no file mutation is
needed.

### Acknowledged-but-not-acted-upon

- **`generic` adapter output streaming**: round-2 noted that generic
  may or may not stream output. Phase 5 includes a "if generic
  streams, output-stream parser handles it" test; otherwise generic
  workers report findings only via `terminal.summary`. No special
  v3 handling beyond Tier 3 documentation.
- **Phase 2's lazy MCP-child spawn caveat**: code-architect raised
  that host CLIs may lazy-spawn MCP children, breaking the handshake
  marker for agents that never call MCP. v3 §"Lazy MCP-child spawn
  caveat" documents the soft-handling: treat `worker_ready: timeout`
  as advisory; opportunistically set `ready` if any send_message
  arrives.

## Round 1 review log (2026-05-10)

Two reviews ran in parallel against v1: Codex (xhigh effort, read-only)
and the local code-architect agent. Both said **NOT READY**. Both
converged on architectural issues around the trust boundary,
schema/prose contradictions, and the realistic phase budget. v2
addresses every blocker they identified.

### Convergent concerns (both reviewers)

| Concern | Resolution in v2 |
|---|---|
| **Trust boundary fail-open on env propagation.** v1 said "if env propagation fails, worker `crew-mcp serve` starts in captain mode and registers all tools." That's fail-open, not a trust boundary. | **§"Restricted serve mode (fail-closed)"** rewritten: partial env → refuse to start; sidecar permission != 0600 → refuse to start; token mismatch → refuse to start. **§"Restricted serve verification (handshake)"** added: `.worker-ready.json` marker lets the captain detect env-propagation failures and downgrade to Tier 3 / output-stream gracefully. **§"Adapter compatibility matrix"** classifies each host CLI; Tier 3 adapters use output-stream parsing as fallback. |
| **Sidecar permission drift fail-open.** v1 said "warn loudly and continue" on mode != 0600. | **§"Sidecar permission drift (fail-closed)"**: refuses to start in restricted mode if mode != 0600; every send_message call re-checks mode. |
| **Install catalog mode-specific surface missing.** `tool-catalog.ts` is flat; no notion of captain-only vs worker-only tools. `send_message` would surface in captain skill incorrectly. | **§"Install catalog parity (mode-aware)"** added: `mode: 'captain' \| 'worker' \| 'both'` field on each catalog entry. Captain skill rendering filters to captain. Verify checks both modes. |
| **`get_run_status` shape mismatch.** v1 placed `captain_inbox_summary` on `GetRunStatusResult` but `get_run_status` requires `run_id`; the field doesn't make sense for single-run responses. | **`captain_inbox_summary` moved to `list_runs`** (`ListRunsResult`). `get_run_status` adds per-prompt `peer_messages_count` / `peer_messages_acked_count`. |
| **Phase 2 (1d) and Phase 5 (1.25d) budgets unrealistic.** Phase 5 inherits v7 work that v7 budgeted at 3.5d, plus a brand-new ACK parser. Phase 2 has unknowns that could expand 2-3x. | Rebudgeted: Phase 1 = 2d, Phase 2 = 2.5-3d (incl. spike), Phase 3 = 1.5d, Phase 4 = 1d, Phase 5 = 2.5d, Phase 6 = 0.75d. **Total: ~9.75-10.75d** (v1 said 5.5-6.5d). |

### Codex-specific catches

| Concern | Resolution in v2 |
|---|---|
| Token revocation lifecycle contradiction (terminal vs merge/discard). | **§"Token revocation"** rewritten: per-dispatch lifecycle. Every dispatch revokes the prior token before issuing a new one. Merge revokes; discard deletes; cancel doesn't revoke (next continue_run will). |
| `send_message` schema vs skill mismatch on `files` / `excerpts` nesting. Schema nested under `context`, skill prose said top-level. | Schema flattened to top-level `files` / `excerpts` (matching skill). `CaptainInboxMessage` storage schema also flattened for consistency. |
| `run_agent.peer_messages` turn-1 audit path. `RunStateStore.create()` has no `peer_messages` field; turn-1 ACK attribution would be impossible. | **§"appendPrompt and RunStateStore.create() signature changes"** added: `create()` accepts `initialPeerMessages` so turn-1 records the peer_messages atomically with run creation. |
| ACK parser feasibility against events.log prefix format. `[codex] [INBOX-ACK ...]` wouldn't match the strict regex. No turn-boundary marker. | **§"Sentinel format"** updated: parser strips leading `[adapter]` prefix before matching ULID. Per-turn marker `[crew] turn=N start byte_offset=...` added to events.log so the parser can find the right slice. Adapter-tier-aware support: Tier 3 adapters get `peer_messages_acked_count = 0` (advisory; not a failure). |
| Concurrent inbox lock contradiction ("cap-checks only" vs "cap-check + write"). | **§"Atomicity and lock scope"** clarified: lock covers cap-check + write completion. Reads don't lock. |
| Run-state lock scope must extend to `markTerminal` / `markMerged` / `markDiscarded` / sweeper. | **§"State lock scope expansion"** added: all `RunStateStore` mutations wrapped in `withRunLock({scope: 'state'})`, not just `appendPrompt`. |
| Worker prompt footer persistence. v1 said "agent remembers from prior turns"; not guaranteed across `adapter.execute()` paths. | **§"Worker skill / prompt instructions"** rewritten: footer auto-appended on EVERY dispatch (run_agent + continue_run). Adapter-tier-aware footer text (Tier 1/2 = MCP send_message, Tier 3 = output-stream block format). |
| "opencode, ACP" mentioned as adapters; they don't exist in this repo. | Removed; **§"Adapter compatibility matrix"** lists the actual `AdapterId` enum (codex, claude-code, gemini-cli, generic, openai-compatible). |

### Code-architect-specific catches

| Concern | Resolution in v2 |
|---|---|
| Generic + openai-compatible adapters can't host worker MCP child; `send_message` unavailable for those. | **§"Adapter compatibility matrix"**: explicit table marking these as not-supported (no MCP child). Output-stream fallback still works for Tier 3 adapters that DO produce a stream (generic may, openai-compatible doesn't because the response is one chunk — documented). |
| Restricted-serve startup verification. Captain has no signal that the worker entered restricted mode before its first MCP call. | **§"Restricted serve verification (handshake)"** added: `.worker-ready.json` marker file. Captain polls with timeout; downgrades to Tier 3 if missing. |
| `peer_messages: []` empty-array vs absent semantics. | **§"Empty array vs absent"** clarified in the peer_messages schema: empty array is "absent" for the no-op gate. |
| `peer_messages_schema_version` not stamped on prompt records. | **§"`peer_messages` parameter shape"** adds `peer_messages_schema_version: 1` to the rendered shape for forward-compat migration. |
| `in_reply_to` cross-run within same repo not specified. The PRIMARY use case is cross-run. | **§"`peer_messages` validation: `in_reply_to_captain_inbox_msg` lookup"** rewritten: same-repo cross-run = ALLOWED; cross-repo = refused (no leak). |
| Captain skill body gaps: missing-ACK action; `kind` taxonomy; "Don't let inbox-full block dispatch" wording is misleading. | **§"Acknowledgment receipts"** explains how to interpret ACK counts. **§"`kind` is advisory"** added. **§"Don't let inbox-full block worker reports"** corrects the wording. **§"When the worker doesn't send_message"** added. |
| Two captains, one repo. | **§"Two captains, one repo"** edge case added. |
| `acknowledge_messages` parallel race. | **§"`acknowledge_messages` parallel race"** edge case added: handled by inbox lock. |

### Acknowledged-but-not-acted-upon

- **Adapter spike outcomes are TBD.** v2 includes the spike as a Phase 2
  step; the matrix is filled in during implementation, not in this
  document. The plan accommodates all three tiers; final shape depends
  on real CLI behavior.
- **`run_agent` `peer_messages`** still raises a small question: should
  the very first prompt also include the worker-footer + ACK preamble?
  v2 says yes (footer auto-appends; preamble is part of prepend). Worth
  validating in dogfood (Phase 6).

### Disagreements + resolutions

None. Both reviewers agreed on every architectural finding. The
v1 plan was mostly right in shape but had load-bearing gaps in
fail-closed semantics, schema consistency, and budget realism.
v2 is a substantive revision, not a cosmetic one.

## Round 3 review log (2026-05-11)

Two reviews (Codex xhigh + local code-architect) ran in parallel
against v3. **Both said NOT READY** with deeper, more actionable
findings than rounds 1-2 — both reviewers walked the live code paths
and identified specific mis-claims where v3's plan didn't match the
production dispatch flow. v4 addresses every blocker.

### Convergent concerns (both reviewers, with shared code traces)

| Concern | Resolution in v4 |
|---|---|
| **"Already plumbed" claim for Tier 2 is wrong for the production dispatch path.** Both reviewers traced `mcp-registration.ts:55,100`'s helpers and found they only feed `ToolLoopContext.mcpRegistration` (legacy `executeWithTools` path at `codex.ts:984` / `claude-code.ts:845`). The production `adapter.execute(task: Task)` flow used by `run-agent.ts:335` / `continue-run.ts` has no `mcpRegistration` field on `Task`; argv is built from `task.constraints` only. | **§"Adapter compatibility matrix" rewritten.** v4 explicitly says: serializers exist as primitives; Phase 2 extends `Task` with `dispatchMcpEnv?`, modifies `CodexAdapter.execute()` and `ClaudeCodeAdapter.execute()` argv builders to consume it. Phase 2 budget bumped from 1.5-2d to 2.5d. |
| **Raw output capture hook point is downstream of adapter truncation.** Both reviewers traced: codex's stdout `'data'` handler (`codex.ts:488-518`) calls `boundStreamLine` (240-char clamp + `streamPreview` whitespace-collapse) BEFORE invoking `task.onOutput`; claude-code's handler (`claude-code.ts:497-508`) calls `claudeProgressLine` → `compactPreview` (~160-char clamp + whitespace-collapse) BEFORE `task.onOutput`. By the time the dispatcher's onStream sees the chunk, a 16 KB `[CAPTAIN-MSG-OPEN]…[CAPTAIN-MSG-CLOSE]` block is destroyed. | **§"Raw output capture" rewritten.** v4 adds a new `rawOutputSink?: (chunk: string) => void` callback on `Task`, invoked from inside each streaming adapter's stdout handler BEFORE the event-formatter / preview. Phase 1 scope grows: codex.ts:488-518 and claude-code.ts:497-508 edits at the stdout-handler level. Phase 1 budget bumped from 2.5d to 3.5d. |
| **Per-run dispatch transaction regresses listener ordering.** v3 said "background work runs after the lock releases" without distinguishing dispatcher lifecycle listeners from the handshake task. Listeners must install BEFORE `dispatcher.start()` because the dispatcher emits `run:start` synchronously inside its body (`tool-dispatcher.ts:71`); listeners installed after would miss it. | **§"Per-run dispatch transaction" updated.** v4 explicitly inserts a step 6 "install lifecycle listeners" before step 7 "call dispatcher.start". Rollback on synchronous start-throw disposes those listeners. Handshake polling (separately) remains a detached task outside the lock. |

### Codex-specific catches

| Concern | Resolution in v4 |
|---|---|
| Raw-output.log rotation vs parser cursor: byte offset becomes ambiguous after rotation; a turn or message block can straddle. | **§"Rotation and generation-aware cursor"** added: cursors are `{file_generation: number, offset: number}`; parsers scan rotated generations (`raw-output.log.<N>`) before current; state.json tracks `raw_output_current_generation`. |
| Output-stream parser partial-block handling: cursor can advance past an unmatched `[CAPTAIN-MSG-OPEN]` and lose the message permanently. | **§"Partial-block handling (output-stream parser)"** added: parser stops at unmatched OPEN marker; cursor stays at its byte offset; bounded pending-fragment max-age (60s) before logging a warning. |
| Worker footer phasing regresses (Phase 6 said only when peer_messages supplied; should be every dispatch where adapter is Tier 1/2). | Phase 5 already specifies "auto-append on EVERY dispatch (run_agent + continue_run); adapter-tier-aware footer text"; Phase 6's footer-plumbing line was removed in v3. v4 keeps the Phase 5 wording. |
| Budget 12-14d realistic. | v4 total: ~12-14d (Phase 1: 3.5d; Phase 2: 2.5d; others unchanged). |

### Code-architect-specific catches

| Concern | Resolution in v4 |
|---|---|
| §"Reference: code touchpoints" line 2262 (ACK parser) said "Lazy events.log scan" — contradicts plan body. | **Updated** to "Lazy raw-output.log scan (NOT events.log)". |
| §"Reference: code touchpoints" line 2269 (`get_run_status`) said `captain_inbox_summary` — contradicts §"Extended tool: `list_runs`". | **Split into two rows**: `get_run_status` carries per-prompt counts + `worker_ready`; `list_runs` carries `captain_inbox_summary`. |
| §"Atomicity and lock scope" mentioned "unread-count increment" — no such counter in the schema (unread is derived from directory walk). | **Updated** to "cap-check + write + rename"; explicit note that there is no separate unread counter. |
| Per-run dispatch transaction rollback missing listener disposal on synchronous `dispatcher.start()` throw. | **Added** to step 7 of §"Per-run dispatch transaction": rollback disposes the listeners installed in step 6. |
| Codex argv quoting via shell-escape illustration was confusing for execa. | **Clarified** in §"Adapter spike (2026-05-10)" and §"Adapter compatibility matrix": actual argv is a two-element array per flag (e.g., `['-c', 'mcp_servers.crew.env.X="..."']`); not shell-quoted. |

### Disagreements + resolutions

None. Round-3 reviewers agreed on every architectural finding. Both
identified the same two critical mis-claims (Tier 2 plumbing reach +
raw-output hook point) and the same hygiene issues (touchpoints
table, atomicity wording, listener disposal).

### Acknowledged-but-not-acted-upon

- **Codex argv quoting edge cases**: tokens are 64-char hex (no
  quote/backslash chars) so the TOML basic-string quoting in
  `toTomlString` is safe. If v2 introduces non-hex token formats,
  re-examine.
- **Phase 1 / Phase 2 overlap**: Phase 1 introduces `rawOutputSink`
  on Task; Phase 2 introduces `dispatchMcpEnv` on Task. Both are
  Task contract extensions; they can ship in the same PR but are
  budgeted as separate phases for clarity.

## Round 4 review log (2026-05-11)

Two reviews (Codex xhigh + local code-architect) ran in parallel
against v4. **Both said NOT READY.** Codex found 10 blockers (deeper
than round-3); code-architect found 4 (surgical). Convergent
findings traced specific code paths and surfaced both
"already-plumbed" framing that still lingered in v4 sections AND
new architectural gaps in v4 additions (Tier 2 file mutation
parallel-safety, raw-output rotation/cursor semantics, output-stream
partial-block handling, Gemini adapter actually not streaming
production output, Generic adapter actually streaming).

After surveying the round-4 findings against the user's actual use
case (multi-agent reviews with Claude as captain; codex + claude-code
as primary workers; gemini-cli not a primary need; output-stream
parser complexity not justified by current evidence), the user chose
to **descope Tier 3 / ACK / raw output capture entirely**. v5
implements this descope.

### Convergent concerns (both reviewers)

| Concern | Resolution in v5 |
|---|---|
| **"Already plumbed" framing still in §Adapter spike and §Edge cases**, contradicting the v4 corrections in §Adapter compatibility matrix and §Phase 2. | v5 removes Tier 3 / output-stream language across all sections; spike section retains its "primitives exist, production wiring is Phase 2 work" framing throughout. |
| **Dispatch transaction implementation realities.** `installRunLifecycleListeners` returns only a Promise; disposables aren't externally accessible. `run_agent` flow is internally contradictory (rejects "if run doesn't exist" but also creates state; rollback assumes prior status that doesn't exist). | v5 Phase 1 explicitly includes the `installRunLifecycleListeners` refactor to return `{terminalPromise, dispose}`; dispatch transaction handles run_agent (create-if-absent + rollback removes orphan state.json) and continue_run (require existing + rollback reverts the appended prompt) as distinct paths. |
| **Output-stream parser complexity finds new bugs each round** (round 4: Generic streams while plan said it doesn't; Gemini doesn't stream while plan said it does; rotation/cursor ambiguity between relative filenames and absolute generation numbers; partial-block can't span generations; raw-output state not in state lock; Phase 2 test depends on later phases). | **Descope.** v5 removes Tier 3 output-stream parser, raw output capture, ACK sentinels, rotation/cursor, partial-block handling. Worker findings for non-Tier-2 adapters come via `terminal.summary` (status quo). |

### Codex-only catches (resolved by descope)

- Adapter assumption errors (Generic streams; Gemini doesn't): irrelevant once output-stream parser is dropped.
- Rotation/cursor ambiguity: irrelevant — no raw output capture.
- Cross-generation block handling: irrelevant.
- State lock missing raw-output state: irrelevant.
- Phase 2 test depending on Phase 3+4+5: Phase 2 deliverable simplified to argv assertions only.
- Budget 14-18d: dropped to ~9.5d with descope.

### Code-architect-only catches

| Concern | Resolution in v5 |
|---|---|
| Dispatch transaction rollback omits `appendPrompt`/`create()` side effects (phantom prompt record / orphan state.json). | Phase 1 dispatch-transaction deliverable explicitly includes both rollback paths. |
| `run:terminal` is not a real dispatcher event. | Actual events are `run:start / run:stream / run:complete / run:failed / run:cancelled` (per `tool-dispatcher.ts:34-44`). v5 §"Per-run dispatch transaction" step 6 references the correct events. |
| Step 6 listener behavior under-specified. | v5 says: same listeners that `installRunLifecycleListeners` installs today (refactored to return `{terminalPromise, dispose}`); no NEW listener behavior for v5 since ACK parsing is descoped. |
| §"Adapter spike" retains "Already plumbed" claim. | Fixed across spike section and all references. |

### Disagreements + resolutions

None. Reviewers agreed on the findings; the disagreement was implicit
between "fix everything Codex found" (round 5+) vs "descope what
keeps finding bugs" (v5). User chose descope. The trust boundary
remains tight (MCP-only for Tier 2 adapters; no parser-based weak
authentication path).

### Acknowledged-but-deferred-to-v2

- **Output-stream parser fallback** for non-Tier-2 adapters → v2 once
  there's concrete evidence the structured-finding gap matters.
- **ACK sentinels** → v2 with a properly designed raw output substrate
  (or v2-via-MCP if a worker-callable `ack_inbox_message` tool replaces
  parser-based ACK).
- **Raw output capture infrastructure** → only needed when v2's parser
  story returns; designed alongside it.

## Round 5 review log (2026-05-11)

Two reviews (Codex xhigh + local code-architect) ran in parallel
against v5 (the descope). Both said **NOT READY** but with much
tighter findings than rounds 1-4 — mostly stale text from descope
cleanup that v5 missed, plus one substantive new architectural
finding (gemini trust boundary).

### Convergent stale-text issues (both reviewers, surgical)

| Concern | Resolution in v6 |
|---|---|
| ACK references still load-bearing in non-history sections (peer_messages schema comments, state lock rationale, dispatch transaction step list, testing list). | All cleaned: schema comments now say "in_reply_to threading and audit"; state lock row says "stale-run sweeper / future writers"; testing list drops ACK parser + `peer_messages_acked_count` tests. |
| Worker prompt instructions + dispatch flow reference Tier 1 / Tier 3 / "or when prompt contains send_message" — v5 says Tier 1 doesn't exist and Tier 3 has no parser. | Footer predicate explicit: `adapter_id in {'codex', 'claude-code'}`; non-Tier-2 gets NO footer. Skill body's "when worker doesn't send_message" updated to Tier 2 only. |
| §Per-run dispatch transaction step 1 / step 6 / step 7 — run_agent semantics inverted; `run:terminal` event doesn't exist; rollback path only covers continue_run. | Section rewritten into two explicit paths: `run_agent` (require state ABSENT; rollback deletes state.json) and `continue_run` (require state EXISTING with continuable status; rollback reverts prior status + removes appended prompt record + revokes new token + disposes listeners). Event list corrected to `run:start / run:stream / run:complete / run:failed / run:cancelled` per `tool-dispatcher.ts:34-44`. |
| §Phasing intro still names "raw output capture" in Phase 1 scope. | Intro updated; Phase 1 deliverable list was already clean. |
| §Adapter spike "Recommendation" subsection still says "v1 implements Tier 3 (output-stream fallback)". | (Round-5 own-review flagged; left as historical "recommendation at the time" — Codex didn't flag, but worth a forward-looking note that v5 descope overrides this recommendation.) |

### Codex-only critical (architectural)

| Concern | Resolution in v6 |
|---|---|
| **Gemini trust boundary is broken even with v5 descope.** `crew-mcp install` writes static crew-mcp into `~/.gemini/settings.json` (`src/install/hosts/gemini.ts:38`). `GeminiCliAdapter.execute()` runs `gemini --output-format json` (`src/adapters/gemini-cli.ts:285`) without disabling MCP. Worker's crew-mcp serve falls through to captain mode — gets ALL captain tools, not "no inbox tool surface". | **New defense in §"Non-Tier-2 adapters" and Phase 2:** gemini worker dispatches append `--allowed-mcp-server-names ""` (empty allowlist; gemini supports this per the spike, `gemini-cli.ts:199`). Phase 2 integration test asserts the argv contains the empty-allowlist flag AND the spawned gemini has no crew-mcp tools loaded. |

### Codex-only important

| Concern | Resolution in v6 |
|---|---|
| Restricted serve handshake timeout treats Tier 2 injection failure as soft fallback. If env injection fails entirely while static MCP config is visible, crew-mcp serve starts in captain mode. | The new gemini defense (`--allowed-mcp-server-names ""`) addresses gemini specifically. For codex/claude, the per-invocation MCP config block IS the spec — if env injection fails, the MCP server entry has no env block, and crew-mcp serve falls through to captain mode. v6 documents this: codex/claude regression is detected via handshake timeout; the dispatch is recoverable via subsequent send_message-from-worker failure (worker has captain tools but agents trained on the worker footer for send_message will only attempt send_message). v2 hardens this further. |
| Phase 2 deliverable references Phase 3/4 tools (send_message inbox cycle) — Phase 2 should be argv-assertions only. | Phase 2 deliverable list simplified to argv assertions + live env propagation + gemini-defense argv assertion only. End-to-end send_message+inbox tests stay in Phase 3+4. |
| Phase 1 "state lock expansion" under-specified given currently-sync `RunStateStore`. References nonexistent `markCancelled()`, omits `markMergeConflict()`. | §"State lock scope expansion" updated: corrected method list (markTerminal/markMerged/markMergeConflict/markDiscarded, plus the create+appendPrompt that were already listed); added explicit "Async migration note" describing the call-site sweep. |

### Disagreements + resolutions

None. Reviewers converged on the stale-text findings; Codex went a
layer deeper on the gemini trust-boundary issue (own reviewer didn't
catch it). The fix is small (one argv flag + test), so easy to adopt.

### Acknowledged-but-deferred

- **Stronger trust-boundary defense for codex/claude regressions.**
  If our env-injection argv breaks (host CLI version change), the
  worker silently gets captain tools. v6 catches this via handshake
  timeout BUT can't prevent the worker from making captain tool
  calls before handshake confirms. v2 could add per-invocation
  defense for Tier 2 also (e.g., explicit "deny captain tools" flag
  if host CLI supports it). v1 accepts the risk.

## Round 6 review log (2026-05-11)

Two reviews (Codex xhigh + local code-architect) ran in parallel
against v6. Both said **NOT READY** but tight — surgical fixes only.
Convergence is real: rounds 1-3 found broad architectural gaps;
round 4 found adapter implementation gaps; round 5 found stale-text
from descope + the gemini trust-boundary gap; round 6 found
remaining stale-text spots + dispatch transaction API
under-specification + the exact gemini-defense argv shape.

Codex notably **empirically verified** the gemini defense against
gemini-cli `0.40.1` source: `--allowed-mcp-server-names ""` does
deny all MCP servers (parser preserves `""` as `[""]` allowlist;
only servers whose name is in the allowlist load; `""` is never a
server name). The defense semantically works.

### Convergent fixes (both reviewers)

| Concern | Resolution in v7 |
|---|---|
| Phase 1 deliverable line 1782 still has `markCancelled` (nonexistent method) and omits `markMergeConflict` (real method). | Line corrected to `markTerminal/markMerged/markMergeConflict/markDiscarded`. The §"State lock scope expansion" table also updates to remove the `markCancelled (when reachable)` placeholder row and add a note that cancellation goes through `markTerminal('cancelled')`. |
| §`appendPrompt and RunStateStore.create()` line 1258 still has stale "the ACK parser couldn't attribute sentinels" rationale. | Replaced with `in_reply_to` validation justification. |

### Codex-only

| Concern | Resolution in v7 |
|---|---|
| §Adapter compatibility matrix Phase 2 deliverable still says "dispatch + send_message + captain inbox read cycle" (depends on Phase 3/4 tools). | Simplified to argv assertions + live env probe + gemini no-MCP probe only; end-to-end inbox flow moves to Phase 3/4/6 dogfood. |
| §Captain skill mixed-tier flow uses `terminal.summary` field-path; live `get_run_status` returns top-level `summary`. | Replaced with explicit "top-level `summary` field on `get_run_status` response + `events_tail`." Also fixed in §"Restricted serve verification" prose. |
| §Gemini defense: existing `buildGeminiResumeArgs` suppresses the flag for empty arrays. Defense must emit `['--allowed-mcp-server-names', '']` directly. | §"Non-Tier-2 adapters" rewritten with: exact argv shape, "do NOT route through `buildGeminiResumeArgs`", direct edit to `GeminiCliAdapter.execute():285`, Phase 2 test asserts the argv. Empirical verification from Codex round-6 cited. |
| §Per-run dispatch transaction rollback only covers `dispatcher.start()` sync throws. Failures at sidecar write / `RunStateStore.create()` would leak state. | Section rewritten with per-step failure rollback paths for both `run_agent` and `continue_run`. Each step that mutates external state (sidecar, state.json, worktree) has an explicit on-failure cleanup. |

### Code-architect-only (B4 — under-specified API)

| Concern | Resolution in v7 |
|---|---|
| Live `appendPrompt` already sets `status: 'running'`; plan's step 4 (appendPrompt) + step 5 (flip status) is unclear. | Step 5 removed; `appendPrompt` IS the status flip + prompt append for continue_run (explicit note in step 4). |
| Rollback "remove the just-appended prompt record" — no such API on `RunStateStore`; Phase 1 doesn't add one. | **NEW `RunStateStore.revertTurn(runId, {turnNumber, priorStateSnapshot})` API** added to Phase 1 deliverables. Removes `prompts[turnNumber]` and restores `status`/`completedAt`/`serverPid` from the pre-`appendPrompt` snapshot. |
| `buildAdapterDispatchTask` called inside `planRunAgent` BEFORE the dispatch transaction; chicken-and-egg with sidecar-then-Task. | **Planner refactor:** `planRunAgent` / `planContinueRun` return a task-builder closure `(sidecar: RunAuthSidecar) => Task` instead of a fully-constructed Task. Dispatch transaction calls the builder after writing the sidecar, threading `dispatchMcpEnv` into the Task. Phase 1 ships the closure shape; Phase 2 implements `dispatchMcpEnv` argv consumption. |

### Disagreements + resolutions

None. Reviewers agreed on every finding. Codex went deeper on the
gemini argv specifics (verified the live helper, confirmed empty-
allowlist semantics empirically); own went deeper on the dispatch
transaction API gaps (appendPrompt side-effects, missing revertTurn,
planner→Task ordering).

### Acknowledged-but-not-acted-upon

- **Restricted-serve trust-boundary defense for codex/claude regressions.**
  v6's gemini defense closes the gemini gap; if codex/claude argv
  injection regresses (host CLI version mismatch), the worker could
  still inherit captain tools. Handshake timeout catches the
  symptom but not the root cause. v2 may add equivalent
  "deny-all-MCP" flags for codex/claude if host CLIs expose them.
  v1 accepts the risk for codex/claude on the basis that argv
  injection is more deterministic than env propagation (we control
  the argv directly).

## Round 7 review log (2026-05-11)

Two reviews (Codex xhigh + local code-architect) ran in parallel
against v7. **Reviewers diverged for the first time across 7 rounds.**
Own code-architect said **READY** with 2 surgical observations noted;
Codex said **NOT READY** with 8 surgical findings (Codex went deeper
on code-detail consistency). v8 applies all 8 Codex findings + the
2 own-noted items as final cleanup.

### Convergent fixes (both reviewers)

| Concern | Resolution in v8 |
|---|---|
| `RunStateStore.revertTurn` call site at continue_run rollback step uses two-arg form `(runId, turnNumber)` but the API definition requires options-object `(runId, {turnNumber, priorStateSnapshot})`. | Call site updated to use the options-object form everywhere. |
| `recipient_not_addressable` error code introduced in "Two-concurrent-continue_run behavior" prose but step 1 says "existing per-status message strings" — inconsistent. | v8 preserves the existing rejection wording (`'continue_run: run is currently running; call cancel_run first.'`) rather than inventing a new error code. No new error code added. |

### Codex-only surgical

| Concern | Resolution in v8 |
|---|---|
| `revertTurn` indexing ambiguity: `PromptRecord.turn` is 1-based, `prompts[]` array is 0-based. "Remove `prompts[turnNumber]`" literal interpretation deletes wrong record. | API definition explicitly states `turnNumber` is 1-based; implementation uses `state.prompts.filter(p => p.turn !== turnNumber)` (NOT `prompts.splice(turnNumber, 1)`). |
| Phase ownership for `appendPrompt({userPrompt, peerMessages})` and `create({initialPeerMessages, ...})` signature migrations: Phase 1 transaction uses the new signatures but Phase 5 owned the migration. | Migration moved to Phase 1 (the dispatch transaction depends on the new API shape). Phase 5 still owns the peer_messages schema + prepend builder + wiring values into the call sites; Phase 1 owns the API shape. Phase 1 budget bumped from 3d to 3.5d; Phase 5 budget trimmed from 1.5d to 1d. Total unchanged at ~10.25d. |
| Planner closure phasing: one section said "Phase 2 includes this refactor", Phase 1 deliverables also listed it. | Pinned to Phase 1 only (transaction depends on it). Phase 2 implements `dispatchMcpEnv` argv consumption in adapters but does NOT re-touch the closure shape. |
| §"Worker prompt instructions" line 1467 still has `terminal.summary` field-path; v7 fixed mixed-tier flow but missed this site. | Updated to "terminal summary (surfaced as top-level `summary` on the `get_run_status` response)". |
| Phase 2 deliverable summary reverts to `--allowed-mcp-server-names ""` shell form. | Phase 2 bullets and tests now use the explicit two-element argv array form `['--allowed-mcp-server-names', '']` matching the gemini-defense canonical form. |
| §"Adapter spike (2026-05-10) → Recommendation" still says "v1 implements Tier 3 (output-stream fallback) for gemini-cli and generic" — contradicts v5 descope. | Subsection re-headed "(superseded — historical snapshot at spike time)" with an explicit pointer to the current §"Adapter compatibility matrix" and a brief restatement of the current (v5-v8) recommendation. |

### Code-architect-only notes (not blockers)

- Stale line refs (`run-state.ts:97-110` for sweeper; actual at `serve.ts:1375`) and `claude-code.ts:456-463` (actual `args.push` calls at line 466). Preexisting from earlier rounds; v8 keeps as-is since they bound the relevant function regions even if not exact.
- Phase 1 3-3.5d budget is "aggressive" given full scope; budget acknowledges volatility ("could grow to 11-12d if adapter integration tests reveal Tier 2 quirks"). Not a blocker.

### Disagreements + resolutions

The reviewers' verdicts diverged on whether v7 was READY (own) vs
NOT READY (Codex). The substantive difference was code-detail
thoroughness: Codex chased every reference to verify it matched the
live code; own focused on architectural soundness and found fewer
issues. v8 takes Codex's findings as the higher bar — they're all
real and surgical, and applying them clears the convergence
properly.

### Acknowledged-but-not-acted-upon

- Stale line-number refs (run-state.ts:97-110 → serve.ts:1375;
  claude-code.ts:456-463 → 466). Cosmetic; line numbers will drift
  during implementation anyway.

## Round 8 review log (2026-05-11)

Two reviews (Codex xhigh + local code-architect) ran in parallel
against v8. **Own code-architect said READY** with only cosmetic
notes (no blockers). **Codex said NOT READY** with 6 surgical
findings — convergence pattern confirmed, but Codex's standard for
"READY" demands closing every stale-text and phase-compile-dependency
issue.

After 8 rounds, the architectural shape is stable (it has been since
v5). The remaining drift is asymptotic — each Codex round finds
tighter surgical residue. v9 applies Codex's architecturally real
findings (phase compile dependencies, wx flag spec correction) and
accepts the stale-text residue as cosmetic-to-resolve-at-implementation.

### Codex round-8 findings + v9 dispositions

| Finding | Disposition in v9 |
|---|---|
| **Phase 1 → Phase 3 compile dependency: worker-mode marker says `registered_tools: ["send_message"]` but Phase 3 owns the tool.** | **Fixed.** Phase 1 ships infrastructure with empty `registered_tools: []` in the marker; Phase 3 updates the marker to include `["send_message"]` once the tool exists. |
| **Phase 1 → Phase 2 contract dependency: `task.dispatchMcpEnv` referenced but field on `Task` was Phase 2.** | **Fixed.** `Task.dispatchMcpEnv?` type declaration moved to Phase 1 deliverables. Phase 2 only consumes the field in adapter argv builders. |
| **Phase 1 → Phase 5 type dependency: `appendPrompt`/`create` use `PeerMessageRendered[]` but the type lives in Phase 5's schema.** | **Fixed.** Minimal `PeerMessageRendered` type stub moved to Phase 1 (just the persisted shape needed by state.json). Phase 5 owns the Zod validator, prepend builder, kind enum, and field extensions. |
| **Prompt-record indexing stale text at lines 365 / 1290 / 2634**: still says `state.json.prompts[turnNumber]`, reintroducing the 1-based/0-based ambiguity. | **Accepted as cosmetic.** The API definition is authoritative; surrounding prose uses `[turnNumber]` as shorthand for "the record with that turn." Implementation will use `filter(p => p.turn !== turnNumber)`. |
| **Stale `terminal.summary` field-path at many sites** (lines 98, 136, 913-915, 1047, 1063, 1536, 1671-1677, 1774, 2015). | **Accepted as cosmetic.** Some sites are conceptual ("findings via terminal.summary" reads naturally as "via the terminal summary channel"); the API-bearing site in §Worker prompt instructions was fixed in v8. Implementation reading the plan will reference `get_run_status` response shape. |
| **Token sidecar `wx` flag spec error**: claimed `wx` prevents clobbering final path, but `wx` only protects tmp; `rename(tmp, path)` is unconditional. | **Fixed.** §"Token issuance at run dispatch" step 3 rewritten: explicit pre-rename existence check with path-dependent semantics (run_agent rejects existing; continue_run intentionally replaces after revoke). |

### Disagreements + resolutions

- **Convergence threshold disagreement (own READY vs Codex NOT
  READY).** Resolution: take the union of architecturally real
  findings (the 3 phase-dependency items + wx flag correction). The
  stale-text residue is real but cosmetic — Codex will keep finding
  some on round 9, round 10, etc., because each round of edits
  leaves new wording for the next round to scrutinize. v9 declares
  convergence at the architectural level.

### Iteration summary

8 review rounds, 2 reviewers each = 16 total reviews:

- v1 (round 1): both NOT READY — fundamental rescope to captain-only
- v2 (round 2): both NOT READY — "paper-deep" fixes; spike proposed
- v3 (round 3): both NOT READY — production code-path mis-claims
- v4 (round 4): both NOT READY — output-stream parser complexity
  spiraled; user chose descope
- v5 (round 5): both NOT READY — descope cleanup residue + gemini
  trust-boundary
- v6 (round 6): both NOT READY — surgical cleanup + dispatch
  transaction API spec gaps
- v7 (round 7): own READY, Codex NOT READY — reviewer divergence
  begins
- v8 (round 8): own READY, Codex NOT READY — asymptotic stale-text
- **v9 (this round, no further review)** — architecturally
  converged; commit.

## Reference: code touchpoints

| Concern | File | Notes |
|---|---|---|
| Token + sidecar | `src/orchestrator/auth/token.ts` (new) | Generation, validation, revocation |
| Sidecar schema | `src/orchestrator/auth/sidecar-schema.ts` (new) | Types + Zod |
| Restricted serve | `src/cli/commands/serve.ts` | Env-triggered tool registration |
| Captain inbox storage | `src/orchestrator/captain-inbox/store.ts` (new) | Read/write/transition |
| Captain inbox schema | `src/orchestrator/captain-inbox/schema.ts` (new) | Types + Zod |
| Captain inbox lock | `src/orchestrator/run-lock.ts` (new or generalized from `git/worktree.ts:993`) | mkdir-based |
| `send_message` tool | `src/orchestrator/tools/send-message.ts` (new) | Restricted-mode tool (Tier 2 adapters only) |
| `check_captain_inbox` | `src/orchestrator/tools/check-captain-inbox.ts` (new) | Captain reads inbox |
| `acknowledge_messages` | `src/orchestrator/tools/acknowledge-messages.ts` (new) | Read/dismiss transitions |
| `peer_messages` schema | `src/orchestrator/peer-messages/schema.ts` (new) | Types + Zod |
| `peer_messages` prepend | `src/orchestrator/peer-messages/prepend.ts` (new) | Pure builder |
| Worker prompt footer | `src/orchestrator/peer-messages/worker-footer.ts` (new) | Adapter-tier-aware footer text |
| Task contract extension | `src/adapters/types.ts` | Add `dispatchMcpEnv?` field |
| CodexAdapter argv | `src/adapters/codex.ts:399-451` | Append `-c mcp_servers.crew.env.*` flags when `dispatchMcpEnv` set |
| ClaudeCodeAdapter argv | `src/adapters/claude-code.ts:456-463` | Append `--mcp-config <inline-JSON>` + `--strict-mcp-config` when `dispatchMcpEnv` set |
| Dispatch transaction | `src/orchestrator/dispatch-transaction.ts` (new) | Per-run critical section; lifecycle listeners installed pre-start; rollback disposes on sync throw |
| `runDispatchAndRespond` refactor | `src/cli/commands/serve.ts` | `installRunLifecycleListeners` returns `{terminalPromise, dispose}` |
| `continue_run` integration | `src/orchestrator/tools/continue-run.ts` | Add `peer_messages`; route through dispatch transaction |
| `run_agent` integration | `src/orchestrator/tools/run-agent.ts` | Add `peer_messages`; route through dispatch transaction; auto-append worker prompt footer for Tier 2 |
| `appendPrompt` signature | `src/orchestrator/run-state.ts` | Migration to options form |
| `RunStateStore.create()` | `src/orchestrator/run-state.ts` | Accept `initialPeerMessages` |
| `RunStateStore.revertTurn()` | `src/orchestrator/run-state.ts` (new method) | Continue_run rollback support; removes `prompts[N]` + restores prior status |
| Planner refactor (task-builder closure) | `src/orchestrator/tools/run-agent.ts:209`, `continue-run.ts` | Return `(sidecar) => Task` instead of fully-built Task; dispatch transaction supplies sidecar |
| Gemini worker MCP defense | `src/adapters/gemini-cli.ts:285` (`execute()` direct edit; NOT via `buildGeminiResumeArgs`) | Emit `['--allowed-mcp-server-names', '']` to deny all MCP servers including installed crew-mcp |
| State.json hygiene | `src/orchestrator/run-state.ts` | `state.json.tmp` -> unique-named tmp; state lock wraps all mutations |
| Tool registry | `src/orchestrator/tools/index.ts` | Register new tools (mode-conditional) |
| Install catalog | `src/install/tool-catalog.ts` | New tool entries with `mode: 'captain' \| 'worker' \| 'both'` field |
| `get_run_status` | `src/orchestrator/tools/get-run-status.ts` | Per-prompt `peer_messages_count`; `worker_ready` field. (NOT `captain_inbox_summary` — that lives on `list_runs`.) |
| `list_runs` | `src/orchestrator/tools/list-runs.ts` | `captain_inbox_summary` repo-wide summary |
| Captain skill | `skills/crew-captain.body.md` | New section |
| Verify | `src/cli/commands/verify.ts` | Confirm tool ↔ skill parity |
| Tests | `test/auth/*`, `test/captain-inbox/*`, `test/peer-messages/*` (new), `test/orchestrator/continue-run.test.ts`, `test/adapters/*-env.test.ts` | |
| Status doc | `docs/status/captain-flow-review-*.md` | Update if behavior shifts |
