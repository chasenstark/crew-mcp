# Inbox + `send_message` — design plan

**Status:** Draft v7 2026-05-10 (post round-6 review).
**Predecessor / context:** `docs/plans/active/competitive-analysis-mco-cao.md` §5.1.
**Inspiration:** CAO's `send_message` + watchdog inbox model
(`/tmp/competitive-cao/src/cli_agent_orchestrator/services/inbox_service.py`,
`mcp_server/server.py`).

> **Round 1** converged on a major rescope: v1 is captain-only.
>
> **Round 2** caught a delivery transaction race (lock released too
> early → double-delivery), a contradictory state.json prompt-record
> format, an under-specified prepend block, and a cross-run threading
> bug. v3 fixed these via a `claimed` lease, concrete `appendPrompt`
> API, explicit prepend template, and global parent lookup.
>
> **Round 3** found tightness issues with v3's lease (cap arithmetic,
> status check outside state lock, muddy delivery_outcome, hand-wavy
> rollback boundary, byte-determinism). v4 added `undeliverable`,
> tightened the cap, scoped parent lookup, pinned rollback to
> dispatcher events, and made prepend bytes-exact.
>
> **Round 4** found a load-bearing bug in v4's lifecycle pattern:
> `dispatcher.start()` emits `run:start` synchronously BEFORE
> returning (`tool-dispatcher.ts:71`), so v4's "install listeners
> after dispatcher.start" sequence missed the event entirely.
> Worse, even with listeners installed pre-start, `run:start` is
> NOT a prompt-accepted ack — it means "dispatcher accepted the
> task into in-flight," which is before the adapter spawns. v5
> resolves this by **explicitly documenting "delivered" as
> "dispatcher accepted the task"** (not "agent read the message"),
> installing inbox lifecycle hooks via the existing
> `runDispatchAndRespond` callback path (which already orders
> listeners correctly), and downgrading the rollback guarantee to
> match. See review logs for full change lists.

## Goal

Let the captain queue structured messages into a run's inbox so the
captain doesn't have to hand-copy output from agent A's run into agent
B's `continue_run` prompt. The captain still drives the loop (decides
when to call `continue_run`); the *postman* role moves into crew-mcp.

The smallest unlock: "have Claude review what Codex just wrote" becomes a
two-tool flow:

```
send_message({ to: { run_id: B }, body: <A's diff + summary>, ... })
continue_run({ run_id: B, flush_inbox: true })
```

instead of the captain reading A's stream, mentally summarizing it, and
composing a fresh review prompt for B. The composed message is verbatim,
attaches structured context (files, excerpts), and creates an audit
trail.

## Non-goals (v1)

- **Worker-initiated `send_message`.** Workers cannot call the tool in
  v1. The captain calls it. (See §"Round 1 review log" — the trust
  boundary, identity, and restricted-serve plumbing required to safely
  let workers call this is its own design block, tracked as v2.)
- **`read_inbox` tool.** v1 surfaces only the four status counts
  (`pending` / `claimed` / `delivered` / `undeliverable`) via
  `get_run_status`. Body retrieval (and any associated body
  truncation policy) is v2 once we know we need it.
- **Auto-continue.** When a message arrives, crew-mcp does NOT
  automatically trigger `continue_run` on the recipient. The captain
  decides when to flush. v2 design exists in §Future work.
- **Captain inbox.** Workers messaging the captain stays out of scope —
  the v1 schema is forward-compatible (recipient is a tagged union) so
  this can be added later without breaking changes.
- **Cross-machine messaging.** Inbox is local-disk only.
- **Sync sub-dispatch (`request_review`).** Different shape — a worker
  calling a tool that synchronously spawns a peer, blocks, and returns
  the peer's output. Tracked as v2.
- **Broadcast / channels.** Send-to-many is v2 with `panel_id` /
  `conversation_id` per the `run_panel` plan.

## Open design questions

### Q1: Aggregate prepend cap

When `continue_run` flushes the inbox, the dispatcher prepends pending
messages to the agent's prompt. With body cap 16 KB × max 50 pending,
that's 800 KB of prepend in the worst case — definitely not OK.

**Recommendation:** add an aggregate prepend cap (default 32 KB).
Deliver oldest messages until the cumulative size hits the cap; any
remaining pending messages stay queued and surface as
`undelivered_remaining` in the dispatch envelope. Captain can call
`continue_run({run_id, flush_inbox: true})` again to flush more.

Override: `CREW_INBOX_AGGREGATE_PREPEND_CAP_CHARS`.

### Q2: Pending messages on `merge_run`

When the recipient is merged, the run becomes terminal. Pending
messages are stranded.

**Recommendation:** keep them on disk, marked with `delivery_outcome:
"recipient_merged_undelivered"`. They show up in audit reads but never
get prepended. `send_message` to a merged run already refuses with
`recipient_not_addressable`.

### Q3: Pending messages on `discard_run`

`discard_run` deletes the worktree. Should it also wipe the inbox?

**Recommendation:** **wipe.** Discard means "this run is forgotten."
Keeping the inbox dir would leak messages from a context the user
explicitly threw away. The state.json + events.log audit trail is
preserved (existing behavior); the inbox dir is removed alongside the
worktree.

### Q4: `flush_inbox: true` semantics — empty or combined prompt?

Should `continue_run({run_id, flush_inbox: true, prompt: <X>})` be
allowed (combined: flush AND new prompt), or only one or the other?

**Recommendation:** allow both. Captain often wants to say "flush
pending peer messages, AND here's a follow-up instruction." The
prompt is appended after the prepended inbox block. If neither
`prompt` nor `flush_inbox: true` is set, reject with
`continue_run_no_op`.

### Q5: Skill "ask first" gate wording

Per memory note `feedback_skill_ask_user_enforcement`, the skill's
"ask the user" gates should be strengthened, not loose-phrased. What's
the exact rule for cross-agent messaging?

**Recommendation:** the skill's new section uses this rule (subject
to user approval): "If the user asked for a single one-shot review,
do not introduce inbox messaging — just dispatch the reviewer with the
target's output baked into the prompt. If the user asked for a
multi-round exchange ('have X and Y go back and forth a couple
times'), confirm the round count and rough quota cost before kicking
off."

## Data model

### Inbox storage layout

```
~/.crew/runs/<runId>/inbox/
  <msgId>.json         # one file per message; msg_id is ULID for time-sort
  .lock/               # ephemeral mkdir-based lock for cap-check +
                       # delivery transitions; pattern from
                       # src/git/worktree.ts:993
```

Single-server, single-process v1 means real concurrency is bounded to
the Node event loop. The mkdir lock is deliberately overengineered for
v1, but it's the same pattern v2 needs — cheap to do now.

**Atomicity of message-file writes:** every write goes via
`<msgId>.json.${pid}.${random}.tmp` then atomic rename to
`<msgId>.json`. Same pattern as the state.json fix in §Edge cases —
unique temp names, no fixed-temp collisions even when v2 introduces
multiple writers.

**Sweeper sibling on serve startup.** Sweep `claimed` messages whose
`claimed_pid` is not live → revert to `pending`. Runs alongside the
existing stale-run sweeper (run-state.ts:97-110).

No `index.json`. The 50-pending cap means a directory walk is
microseconds.

### Message schema

```ts
// src/orchestrator/inbox/schema.ts
export const INBOX_SCHEMA_VERSION = 1;

export type InboxMessageKind = 'note' | 'question' | 'answer';

export type InboxMessageStatus =
  | 'pending'        // queued, eligible for next flush
  | 'claimed'        // selected by an in-flight flush; will become 'delivered' on dispatcher-acceptance or 'pending' on rollback
  | 'delivered'      // dispatcher accepted the task carrying this message; see semantics note below
  | 'undeliverable'; // terminal failure; recipient became non-addressable before delivery
                     // (i.e., merged or discarded — see §Edge cases for delivery_outcome semantics)

// SEMANTICS NOTE: "delivered" means "the dispatcher accepted the task that
// carries this message's prepended body" — NOT "the agent read it." If the
// adapter fails to spawn after the dispatcher accepted the task, the run
// errors but the inbox messages stay 'delivered'. This is at-most-once at
// the dispatcher boundary, by design (v1). Stronger semantics — finalize
// only after the adapter acks the prompt — would require a new dispatcher
// lifecycle event and per-adapter changes; tracked in v2 §Future work.
// Captains should interpret 'delivered' as "the message left the queue
// and is now the run's responsibility," not "the agent definitely saw it."

// Forward-compatible recipient/sender tagged unions.
// v1 `from` is always { kind: 'captain' }; `to.kind` is always 'run'.
// v2 will add { kind: 'run', run_id, agent_id } for `from` and
// { kind: 'captain' } for `to`.
export type InboxAddress =
  | { kind: 'captain' }
  | { kind: 'run'; run_id: string; agent_id?: string };

export interface InboxMessage {
  inbox_schema_version: 1;
  msg_id: string;                    // ULID
  to: InboxAddress;                  // v1: always { kind: 'run' }
  from: InboxAddress;                // v1: always { kind: 'captain' }
  kind: InboxMessageKind;
  body: string;                       // capped per §Caps
  body_truncated?: {                  // present iff body was truncated
    original_length: number;
  };
  in_reply_to?: string;              // msg_id; required for kind='answer'
  thread_id: string;                 // SERVER-derived (root msg_id)
  thread_depth: number;              // SERVER-derived (1 + parent.thread_depth)
  context?: {
    files?: string[];                // recipient may or may not have these paths
    excerpts?: Array<{
      file: string;
      range: [number, number];       // 1-indexed, inclusive [startLine, endLine]
      text: string;                  // capped per §Caps
    }>;
  };
  status: InboxMessageStatus;        // mutated in-place by dispatcher only
  recipient_agent_id_at_send: string; // audit only (consumed by future tools/exports)
  recipient_repo_root_at_send: string; // snapshot, repo-scope check
  created_at: string;                // ISO 8601
  claimed_at?: string;               // ISO 8601; set when transitioning to 'claimed'
  claimed_pid?: number;              // server PID holding the claim (PID + age + instance ID give crash recovery)
  claimed_server_instance?: string;  // ULID generated at serve startup; stored alongside PID
  claim_token?: string;              // groups msgs claimed in the same flush batch
  delivered_at?: string;             // ISO 8601
  delivered_to_turn?: number;        // continue_run turn number
  // delivery_outcome explains WHY status === 'undeliverable'.
  // Set ONLY when status flips to 'undeliverable'. Always paired.
  delivery_outcome?:
    | 'recipient_merged_undelivered'
    | 'recipient_discarded';        // (note: discard wipes the file, so this value rarely persists; kept for completeness)
}
```

### Caps

| Item | Default | Override |
|---|---|---|
| Body size | 16 KB | `CREW_INBOX_BODY_CAP_CHARS` |
| Excerpt size per item | 4 KB | `CREW_INBOX_EXCERPT_CAP_CHARS` |
| Excerpts per message | 8 | `CREW_INBOX_MAX_EXCERPTS` |
| **Active messages per recipient (pending + claimed)** | 50 | `CREW_INBOX_MAX_PENDING` |
| Thread depth | 5 | `CREW_INBOX_MAX_THREAD_DEPTH` |
| Total inbox files per recipient (all 4 statuses) | 500 | `CREW_INBOX_MAX_TOTAL` |
| **Aggregate prepend on flush** | **32 KB** | **`CREW_INBOX_AGGREGATE_PREPEND_CAP_CHARS`** |

Body and excerpt overflow truncates with marker `[... truncated for
inbox; original was N chars]` and `body_truncated` set. Active count
(`pending + claimed`), thread depth, and total inbox count overflow
refuses the send.

**Why pending + claimed for the active cap:** a flush in flight has
already chosen N messages and marked them `claimed`. If
`send_message` only counted `pending`, a new send during the flush
would pass; if the flush rolls back, you'd suddenly have
`pending_before + N_claimed_rolled_back + 1_new = pending_before +
N + 1` pending — silently exceeding the cap. Counting both buckets
fixes this.

**Hard ceiling on aggregate prepend** (regardless of env overrides):
the composed prepend block is capped at **64 KB absolute** before
adding `userPrompt`. Even with `CREW_INBOX_BODY_CAP_CHARS` and
`CREW_INBOX_AGGREGATE_PREPEND_CAP_CHARS` raised arbitrarily, the
hard ceiling guards against unbounded prompt blow-up. Hard-ceiling
overflow truncates the LAST message in the block (not the
first-message-force one) with a clear marker. Configurable via
`CREW_INBOX_HARD_PREPEND_CEILING` for power users; default is the
right answer.

## Tool surface

### New tool: `send_message`

```ts
// src/orchestrator/tools/send-message.ts
export const sendMessageInputSchema = z.object({
  to: z.object({
    run_id: z.string().min(1),
    // v1: kind is implicit ('run'); future-proof by leaving the
    // tagged-union shape latent in the type but not the input schema.
    // Adding kind: 'captain' later is a backward-compatible expansion.
  }),
  body: z.string().min(1),
  kind: z.enum(['note', 'question', 'answer']).default('note'),
  in_reply_to: z.string().optional(),       // msg_id
  context: z.object({
    files: z.array(z.string()).max(20).optional(),
    excerpts: z.array(z.object({
      file: z.string(),
      range: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
      text: z.string(),
    })).max(8).optional(),
  }).optional(),
});

export interface SendMessageResult {
  msg_id: string;
  thread_id: string;        // server-derived
  thread_depth: number;     // server-derived
  to_run_id: string;        // echo for convenience
  to_run_status: string;    // recipient's status at queue time
  created_at: string;       // ISO 8601, matches schema's `created_at`
  pending_count: number;    // recipient's pending count after queue
  warnings: string[];       // body/excerpt truncation
}
```

**Identity (v1):** `from` is always `{ kind: 'captain' }`. The captain
is the only caller. v2 will gate the `from` stamp on a per-run token
the captain hands the worker at dispatch time (see §Future work).

**`thread_id` / `thread_depth`:** server-derived from `in_reply_to`. If
`in_reply_to` is absent, this message is a thread root: `thread_id =
msg_id`, `thread_depth = 1`. Otherwise look up the parent message,
inherit `thread_id`, set `thread_depth = parent.thread_depth + 1`.
Caller cannot supply these.

**Parent lookup is global across runs IN THE CURRENT REPO.** A reply
to msg M1 may live in a different inbox than the new message's
recipient — e.g., captain sends M1 to B, B reads it, captain composes
a reply to A referencing M1 (`in_reply_to: M1.msg_id`); M1 is in B's
inbox, M2 goes to A's inbox. Lookup walks
`~/.crew/runs/*/inbox/<msg_id>.json` and filters to messages whose
`recipient_repo_root_at_send` equals the captain's current `repoRoot`.
Repo-scope: bounded by the captain's repo's run count and 500 msgs
per run; fast enough for v1. **Cross-repo `in_reply_to` is refused**
with `in_reply_to_not_found` (same error as a missing parent — we
don't leak that the parent exists in another repo). (Future
optimization: per-repo index, only if profiling shows a bottleneck.)

**Validation errors:**

| Code | When |
|---|---|
| `recipient_not_found` | `to.run_id` doesn't exist |
| `recipient_not_addressable` | recipient status not in continue_run's allowed set (see §Edge cases) |
| `recipient_not_owned` | recipient's `repoRoot` ≠ captain's `repoRoot` |
| `inbox_full` | active count (pending + claimed) would exceed cap |
| `inbox_total_full` | total inbox count (all statuses) would exceed cap |
| `thread_too_deep` | thread_depth would exceed cap |
| `in_reply_to_not_found` | parent msg_id doesn't exist (or is in a different repo) |
| `inbox_disabled` | global kill-switch (`CREW_INBOX_DISABLED=1`) |

(`cannot_message_self` is reserved for v2 worker-initiated sends; in
v1, the captain is the only caller so it can never fire.)

### Modified tool: `continue_run`

Add field:

```ts
export const continueRunInputSchema = z.object({
  run_id: z.string().min(1),
  prompt: z.string().default(''),               // CHANGED: was min(1)
  flush_inbox: z.boolean().default(false),       // NEW
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});
```

**Validation:**
- If both `prompt === ''` and `flush_inbox === false`: reject with
  `continue_run_no_op`.
- If `flush_inbox === true` and the recipient has no `pending`
  messages: reject with `inbox_empty` (the "no-op spin" guard).

**Behavior when `flush_inbox: true`:** see §"Dispatcher integration"
for the full transactional flow. Summary: the dispatcher claims pending
messages under the inbox lock (status: `pending → claimed`), composes
the prompt, dispatches, then transitions `claimed → delivered` once
`dispatcher.start()` synchronously returns without throwing — see the
schema NOTE on `InboxMessageStatus` for the precise "delivered"
semantics. The agent's prompt is `<prepend block><prompt-or-empty>`
where `<prepend block>` already terminates with `---\n\n` (no extra
separator). The response envelope includes `inbox_delivered_count`
and `undelivered_remaining_count`.

If `flush_inbox: false` (default), inbox is untouched even if there
are pending messages. This is deliberate — flush is opt-in.

### Extended tool: `get_run_status`

Add a `counts` field, **counts only**, no bodies:

```ts
interface GetRunStatusResult {
  // ... existing fields ...
  inbox_counts: {
    pending: number;          // eligible for next flush
    claimed: number;          // in-flight to delivery (will resolve to delivered or pending)
    delivered: number;
    undeliverable: number;    // terminal failure; will never deliver
  };
}
```

**Always present** in every `get_run_status` response — including the
running snapshot, the `wait_for_terminal_only` timeout response, and
the terminal payload. Cheap (directory walk; counts only). No
opt-in/opt-out flag — keep the surface lean. If the captain wants
bodies, that's v2's `read_inbox`.

### Tools NOT added in v1

- `read_inbox` — deferred. Bodies are 16 KB × 50 = 800 KB worst-case;
  not a fit for typical "let me peek" flows. Captain reads counts; if
  it wants to inspect a queued body before flushing, that's a v2
  feature. (Earlier draft argued "just flush — reversible via
  `cancel_run`"; that argument is wrong because by the time the
  message is `delivered`, cancelling the run doesn't unmark anything.
  Just defer the feature; don't pretend cancel is a peek-by-rollback.)
- `cancel_message` — deferred to v2.

## Captain skill changes

Per memory note `feedback_skill_body_sync`, this lands in the same
change. Append to `skills/crew-captain.body.md`:

```markdown
## Inter-agent messaging via inbox

You can use `send_message` to queue a structured message into another
run's inbox. The recipient sees it on the next `continue_run` if you
pass `flush_inbox: true`. Use this instead of hand-copying agent A's
output into agent B's prompt — the message is verbatim, attaches
structured context (files, excerpts), and creates an audit trail.

### Pattern: implement-then-review

When the user asks for "implement X then have <other agent> review":

1. Dispatch implementer (run A) with `run_agent`.
2. After A reports terminal status (`success` / `partial`), dispatch
   the reviewer (run B) with `run_agent`. B's prompt should explain
   that a review request is coming via inbox.
3. Call `send_message({to: {run_id: B}, kind: "note",
   body: "[review request from captain]\n<summary of A's diff + the
   user's review focus>", context: {files: [...A's filesChanged...]}})`.
   (v1 `kind` enum is `note | question | answer`; the
   review-request semantics are encoded in the body, not the kind.)
4. Call `continue_run({run_id: B, flush_inbox: true})`. B sees A's
   summary verbatim and reviews.
5. If B's review needs back-and-forth, send B's findings to A:
   `send_message({to: {run_id: A}, kind: "answer", in_reply_to:
   <M1.msg_id from step 3>, body: <B's findings>})` then
   `continue_run({run_id: A, flush_inbox: true})`. (`in_reply_to`
   accepts a msg_id from any inbox — parent lookup is global. M1 is
   in B's inbox; the reply goes to A's inbox; the thread links them.)

### When NOT to use inbox

- One-shot review (single round): just dispatch B with A's output baked
  into the prompt. The inbox machinery is overhead if there's only one
  round trip.
- Multi-agent panel review: use `run_panel` (when shipped).

### Ask first

If the user asked for a single one-shot review, do not introduce inbox
messaging — just dispatch the reviewer with the target's output baked
into the prompt. If the user asked for a multi-round exchange ("have
X and Y go back and forth a couple times"), confirm the round count
and rough quota cost before kicking off.

### Don't message terminal runs

`send_message` will refuse if the recipient's status is in {running,
merged, discarded, merge_conflict}. (Mirrors `continue_run`'s allowed
set — see `src/cli/commands/serve.ts:380-410`.)

For `success`, `partial`, `error`, and `cancelled`, send_message is
allowed because `continue_run` is allowed for those statuses and the
captain may want to flush a queued message on the next continuation.

### Threading caps

`send_message` enforces a max thread depth (default 5) — if a
conversation goes deeper, you'll get `thread_too_deep`. To continue
the discussion: send a fresh root message (`kind: "note"`, no
`in_reply_to`). The original thread stays in audit; the new thread
starts at depth 1.

### Threads break across discard

If you `discard_run` a recipient, that run's inbox is wiped — including
any messages the captain (or an earlier flush) sent to it. Threads
rooted in those messages can no longer be replied to: an `in_reply_to`
referencing a wiped parent will fail with `in_reply_to_not_found`.
Plan accordingly: don't discard a run mid-conversation if you'll need
to thread off its messages later.

### At-least-once delivery

If `crew-mcp serve` crashes during the small window between
`dispatcher.start()` synchronously returning and the inbox FINALIZE
write completing, the next serve startup's sweeper reverts the
messages to `pending` (their `claimed` state had a now-dead PID /
mismatched server-instance). The next `continue_run({flush_inbox:
true})` re-delivers them. Worst case, the captain runs both flushes
to completion and the agent sees the same body twice. This is
at-least-once delivery, not exactly-once.

When composing message bodies, prefer wording an agent can read twice
without harm (i.e., declarative facts and requests, not imperative
side-effects like "increment counter X").
```

## Plumbing details

### What v1 does NOT need

The previous draft had a "Phase 6 plumbing" section with worker-spawned
`crew-mcp serve` processes, `CREW_RUN_ID` env var, identity stamping
via env, and cross-process atomic-rename arguments. **All deleted.** v1
is single-process: only the captain's serve writes inbox files.

### Per-run lock

Generalize the atomic `mkdir`-lock pattern from `src/git/worktree.ts:993`
into a small utility. The API takes an explicit options object so
`crewHome` ownership is unambiguous (no implicit module-level state):

```ts
// src/orchestrator/run-lock.ts
export interface WithRunLockOptions {
  crewHome: string;             // resolved by caller (typically from RunStateStore)
  runId: string;
  scope: 'inbox' | 'state';
  // Optional retry tuning; defaults are fine for v1.
  retryIntervalMs?: number;     // default 50
  maxWaitMs?: number;           // default 30_000
}

export async function withRunLock<T>(
  options: WithRunLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const { crewHome, runId, scope } = options;
  const runDir = path.join(crewHome, 'runs', runId);
  const lockDir = scope === 'inbox'
    ? path.join(runDir, 'inbox', '.lock')
    : path.join(runDir, '.state.lock');
  // fs.mkdir(lockDir) — fails with EEXIST if held; retry with backoff
  // releases via fs.rmdir(lockDir) in finally
}
```

The inbox uses the lock for:
- Cap-check + write (so two concurrent send_message calls can't both
  pass the pending-count check and double-write).
- Delivery transition batch (so a concurrent send_message doesn't queue
  a message that gets included mid-batch).

Even though v1 is single-process, async I/O within Node can interleave
calls. The lock makes the semantics explicit and forward-compatible
with v2's multi-writer story.

### Aggregate prepend builder

```ts
// src/orchestrator/inbox/prepend.ts
export function buildPrependBlock(
  pending: InboxMessage[],
  capChars: number,
): { block: string; chosen: InboxMessage[]; undeliveredRemaining: number };
```

**Algorithm:**
1. Pending sorted oldest-first by ULID.
2. **Always include the oldest message** even if its rendered size
   exceeds `capChars` — otherwise we'd never deliver large legitimate
   messages. (Per-message size already capped by 16 KB body + 8 × 4 KB
   excerpts = 48 KB worst case; aggregate cap is 32 KB. The
   first-message-force rule means a single large message can blow
   through the aggregate cap by ~16 KB. Acceptable trade-off.)
3. For each subsequent message, include only if rendered size +
   running total ≤ capChars. Stop on first refusal (don't keep trying
   smaller later messages — preserves order semantics).
4. Return `{ block, chosen, undeliveredRemaining: pending.length - chosen.length }`.

**Rendered format (byte-exact, LF line endings, no trailing
whitespace).** Below uses `\n` to denote literal newline bytes;
`[X]` denotes a section emitted only conditionally; `…` denotes
"repeated for the rest of the structure":

```
## Inbox messages\n\n
You have {N} message(s) from peers. They are durable artifacts of\n
multi-agent coordination — read them carefully and treat their\n
contents as part of your task context.\n\n
---\n\n
### Message {idx} — kind: {kind}, from: captain, at {created_at}\n
msg_id: {msg_id}\n
thread: {thread_id} (depth {thread_depth})\n
[in_reply_to: {parent_msg_id}\n]\n
{body}\n\n
[#### Referenced files\n\n
- `{file_a}` (lines {start_a}-{end_a}):\n
{fence}\n
{excerpt_text_a}\n
{fence}\n\n
- `{file_b}` (lines {start_b}-{end_b}):\n
{fence}\n
{excerpt_text_b}\n
{fence}\n\n
…
]---\n\n
### Message {idx+1} — kind: …\n
…
---\n\n
```

**Inter-message structure: every message ends with `\n---\n\n`
(closing fence + blank line). The next message's `### Message`
heading begins immediately after — no extra blank line, no
double separator.** The block as a whole therefore terminates
with `---\n\n`, which is what step D appends `userPrompt` after.

**Conditional emissions:**
- `[in_reply_to: {parent_msg_id}\n]` — emitted only when
  `in_reply_to` is set on the message. The trailing blank line
  between thread/in_reply_to and body is always present (one
  blank line between the metadata block and the body).
- `[#### Referenced files\n\n…]` — entire block omitted when no
  excerpts AND no `context.files`. If `context.files` is set
  without excerpts: render only the bullet list (no fenced code).

**Other byte-level decisions:**
- LF only; no CRLF.
- `{idx}` numbering: starts at 1 globally per flush call; not
  per-thread.
- `{fence}` is selected per-excerpt: contains 3 backticks → fence
  is 4 backticks; contains 4 → fence is 5; etc. Maximum recursion
  depth: 8 (then truncate excerpt with marker). Never escape
  backticks inline.
- `{thread_id}` is a ULID; `{thread_depth}` is a positive integer.
- `{created_at}` is ISO 8601 with second precision (no fractional
  seconds — keeps the rendering deterministic and readable).
- No trailing whitespace on any line.

**Concrete decisions:**
- All line endings are `\n` (LF). No CRLF.
- `{idx}` numbering starts at 1 globally per flush call (not
  per-thread).
- The block ends with `---\n\n` (terminator + blank line). The
  captain's `userPrompt` is appended verbatim after; do NOT add
  another `\n\n---\n\n` separator (the v3 draft did, producing a
  double terminator). If `userPrompt === ''`, the block ends with
  `---\n\n` and nothing follows.
- `{fence}` is selected per-excerpt: if the excerpt body contains
  `\`\`\`` (3 backticks), `{fence}` is `\`\`\`\`` (4 backticks); if
  it contains 4, escalate to 5; etc. Never escape backticks inline.
- `[in_reply_to: ...]\n` line is emitted only if `in_reply_to` is
  present on the message. The square-bracket markers in the template
  above are illustrative; the brackets themselves are NOT in the
  output bytes.
- `{thread_id}` is a ULID; `{thread_depth}` is a positive integer.
- `context.files` (file paths only, no excerpts) is rendered as a
  bullet list under `#### Referenced files` with no fenced code
  block beneath each file.
- Framing overhead per message: ~200-400 bytes (depends on whether
  `in_reply_to` and `Referenced files` are present). Counted toward
  the cap.

**Cap math:**
- For each message, `rendered_size = len(framing) + len(body) +
  Σ (len(excerpt_framing) + len(excerpt_text))`.
- Builder picks message[0] always (first-message-force).
- Builder picks message[1] only if `accumulated + message[1].rendered_size ≤ capChars`. Stop on first refusal.
- After all messages chosen: if `total_rendered > HARD_CEILING`
  (default 64 KB), truncate the LAST message's body with
  `[... truncated by hard prepend ceiling; message preserved
  in inbox]` so the audit trail keeps the full original.

**Worst-case prepend size:** body 16 KB + 8 × 4 KB excerpts +
~400 B framing = ~48.4 KB for a single oversize first message;
the hard ceiling at 64 KB leaves ~15 KB of headroom for additional
small messages even on a worst-case first.

**Determinism for tests:** there's a golden test in Phase 1 that
pins the exact byte output for: (i) zero-message block (impossible
— builder isn't called when no pending), (ii) single-message no
in_reply_to no excerpts, (iii) two-message thread with reply +
excerpt with 3-backtick body, (iv) hard-ceiling truncation case.

Reproducibility: `buildPrependBlock` is pure (given `pending` and
`capChars`). State.json stores `userPrompt + inbox_delivered:
[msg_ids]`; fetching the bodies from `inbox/<msg_id>.json` and
re-running the builder reproduces what the agent saw.

### Dispatcher integration (transactional with `claimed` lease)

This section had three iterations. v3 introduced the `claimed` lease.
v4 tried to pin rollback to dispatcher lifecycle events but mis-read
the dispatcher's emit-before-return seam (`tool-dispatcher.ts:71` —
`run:start` is emitted synchronously inside `start()` before it
returns). v5 corrects this by going through the existing
`runDispatchAndRespond` machinery, which already installs listeners
in the right order, and by **explicitly downgrading the "delivered"
semantic to "dispatcher accepted the task"** (see schema NOTE).

**The `delivered` semantic.** Round 4 showed that even with listeners
installed pre-start, `run:start` is not "adapter received the prompt"
— it's "dispatcher accepted the task into `inFlight`." The adapter's
spawn happens inside `task.run()` AFTER `run:start`. Stronger
semantics ("delivered = adapter acked the prompt") would require a
new dispatcher event (`run:promptAccepted`) plumbed through every
adapter — tracked in v2. v1 accepts the weaker boundary and documents
it. ROLLBACK is therefore narrow: only fires if `dispatcher.start()`
itself throws synchronously, or if the F-step compare-and-set
rejects.

**Pin the seam:** v5 reuses `runDispatchAndRespond` at
`src/cli/commands/serve.ts:828` rather than inventing a parallel
dispatch path. That function already (a) installs lifecycle listeners,
(b) calls `dispatcher.start()`, and (c) returns the async envelope.
v1 extends it with optional `inboxOnDispatcherAccepted` and
`inboxOnSyncDispatchFailure` callbacks invoked at the right moments
(see step H below). Continue_run's handler
(`serve.ts:380-410`) constructs the composedPrompt and calls into
`runDispatchAndRespond` with the inbox callbacks attached.

**Lock acquisition order (mandatory):** `inbox` before `state`. Never
hold both simultaneously — `continue_run` acquires inbox briefly,
releases, then acquires state. This rule prevents future deadlock if
new code accidentally needs both.

```
continue_run({run_id, prompt, flush_inbox}) flow (v5):

A. Validate input (no locks)
   - If !prompt && !flush_inbox → reject `continue_run_no_op`
   - If flush_inbox && CREW_INBOX_DISABLED=1 → reject `inbox_disabled`

B. Initial run-state read (no lock; advisory)
   - Reject early if run_id doesn't exist or status visibly terminal
     (avoids acquiring locks for obviously bad calls).

C. If flush_inbox:
   1. Acquire INBOX lock (`withRunLock({crewHome, runId, scope: 'inbox'}, ...)`).
   2. Walk inbox dir; collect status === 'pending' (oldest-first ULID).
   3. If empty → release lock, reject `inbox_empty`.
   4. claimToken = ulid()
      buildPrependBlock(pending, capChars) → { block, chosen[],
                                               undeliveredRemaining }
   5. For each msg in chosen:
        rewrite file with status='claimed', claimed_at=now,
          claimed_pid=process.pid,
          claimed_server_instance=SERVER_INSTANCE_ID,
          claim_token=claimToken (atomic tmp+rename).
   6. Release inbox lock.
   (After this: no other flush can re-pick these messages.)

D. Compose composedPrompt:
     userPrompt = input.prompt ?? ''
     composedPrompt = block
       ? block + userPrompt           // block already ends with `---\n\n`
       : userPrompt                    // no flush; just user prompt
   (See §"Aggregate prepend builder" for exact framing — block already
    includes its trailing `---\n\n`; do NOT add another separator.)

E. Acquire STATE lock (`withRunLock({crewHome, runId, scope: 'state'}, ...)`).

F. Re-read run state UNDER LOCK (compare-and-set):
   - If status now in {running, merged, discarded, merge_conflict}:
     release state lock, run ROLLBACK path R, reject with
     `recipient_not_addressable`.
   - This closes the v3 race: status is checked again under the same
     lock that flips it to `running`.

G. appendPrompt({
     runId,
     userPrompt,
     inboxDelivered: chosen.map(m => m.msg_id),
     claimToken
   }):
   - Records prompts[].prompt = userPrompt (raw captain intent).
   - Records prompts[].inbox_delivered = [msg_ids].
   - Records prompts[].claim_token = claimToken (audit; rollback key).
   - Atomically writes state.json with status='running'; serverPid =
     process.pid (existing behavior, run-state.ts:213).
   - Returns turnNumber for use by ROLLBACK / FINALIZE paths.

H. Call runDispatchAndRespond(...) with extended options:
     {
       ...standard dispatch options,
       inboxOnSyncDispatchFailure: () => ROLLBACK_FROM_DISPATCH_THROW(),
                                                   // see step R.1
       inboxOnDispatcherAccepted:  () => FINALIZE(),
                                                   // see step J
     }

   runDispatchAndRespond's internal sequence (today, serve.ts:828)
   already does: (a) install lifecycle listeners, (b) call
   dispatcher.start, (c) return envelope. v1 extends it: BEFORE
   step (b), if `inboxOnDispatcherAccepted` is provided, install
   a "fire on dispatcher.start synchronous return" hook (no
   listener race — this is just a callback invoked after the
   sync-return of dispatcher.start). If dispatcher.start throws
   synchronously, `inboxOnSyncDispatchFailure` fires instead.

I. Release STATE lock (after runDispatchAndRespond returns).

J. FINALIZE (called from inside runDispatchAndRespond after
   dispatcher.start has synchronously returned without throwing):
   1. Acquire inbox lock briefly.
   2. For each msg with claim_token === claimToken:
        transition 'claimed' → 'delivered'
        set delivered_at, delivered_to_turn = turnNumber.
   3. Release lock.
   "Delivered" means: dispatcher accepted the task. The adapter has
   not necessarily spawned yet. See semantics NOTE on InboxMessageStatus.

R. ROLLBACK (called from one of three triggers):
   R.0 — F's compare-and-set rejection (status no longer addressable)
   R.1 — dispatcher.start threw synchronously
         (inboxOnSyncDispatchFailure callback)
   R.2 — F rejected before E was acquired (no state.json change yet)
         — same as R.0 path, just covers the variant
   In all cases:
     1. Acquire inbox lock briefly.
     2. For each msg with claim_token === claimToken:
          transition 'claimed' → 'pending'
          clear claimed_at, claimed_pid, claimed_server_instance,
                 claim_token.
     3. Release inbox lock.
     4. If we passed step G (state.json was updated):
          Acquire state lock.
          Update prompts[turnNumber].inbox_delivered = [].
          Set status to whatever the failure mapped to (typically
            'error' on dispatch throw).
          Release state lock.
     5. Surface the original error to the captain.

Z. Return envelope (post-step-I, success path):
     { run_id, status: 'running', tail_url, ...,
       inbox_delivered_count: chosen.length,
       undelivered_remaining_count: pending.length - chosen.length }
```

**Why no `run:start` / `run:failed` listeners.** v4 tried to use
these and tripped on two issues: (1) `run:start` is emitted
synchronously inside `dispatcher.start()` before it returns, so
post-start listeners miss it; (2) even with pre-start listeners,
`run:start` doesn't mean "adapter received the prompt" — it means
"dispatcher accepted the task." v5 sidesteps both by treating
"dispatcher accepted the task (i.e., dispatcher.start synchronously
returned without throwing)" as the FINALIZE trigger. This is
strictly equivalent to listening for `run:start` from a pre-start
listener, but doesn't depend on event-emit ordering. ROLLBACK is
narrow: only synchronous throws or compare-and-set rejection. Later
adapter spawn failures map to `run:failed` events that flow through
the existing run-state machinery (the run errors; the inbox
messages stay `delivered` per the documented semantics).

**State lock duration.** The lock is held from step E to step I —
through compare-and-set, `appendPrompt`, the synchronous body of
`runDispatchAndRespond` (including `dispatcher.start`), AND the
awaited FINALIZE callback (which acquires the inbox lock and
writes). Today that whole sequence is milliseconds. `task.run()` is
called immediately inside `dispatcher.start()`, executes
synchronously up to its first `await`, and returns a promise that
the dispatcher tracks in the background; the state lock is NOT held
across that awaited adapter run. Concurrent flushes serialize on this
lock, exactly the desired behavior for a single run.

**`cancel_run` interaction.** Today's `cancel_run` triggers via
dispatcher lifecycle (an AbortController fires `run:cancelled`).
Under v6's semantics ("delivered" = dispatcher accepted the task)
and the dispatcher integration flow above:

- **The common path**: by the time the captain (or anything else)
  could call `cancel_run`, the state lock has been released, which
  means FINALIZE has already awaited and completed. Messages are
  `delivered`. `cancel_run` does NOT touch the inbox; the run errors
  but the inbox accurately reflects "the dispatcher took these
  messages."
- **The narrow interleave**: in principle, between step H (`dispatcher.start`
  synchronously returning) and step J's awaited inbox-lock
  acquisition completing, control yields to the event loop. Some
  other async handler (e.g., a different MCP request thread) could
  in theory invoke `cancel_run`. The window is microseconds in
  practice. If `cancel_run` does interleave: it does NOT roll back
  the inbox; FINALIZE proceeds when its await resolves and writes
  `delivered`. Cancel just kills the adapter; the inbox correctly
  records that the dispatcher had accepted those messages before
  cancel arrived.
- **The crash case**: serve dies between F (claim) and J (finalize
  write). On serve restart, the sweeper sees orphaned `claimed`
  messages with dead-PID / mismatched-instance / aged-out — reverts
  to `pending`. The captain can re-flush. (Standard at-least-once.)

In short: **`cancel_run` does NOT need a special inbox hook in v1.**
The "delivered = dispatcher accepted" semantic + sweeper crash
recovery covers all three cases without extra mechanism.

**Crash recovery (sweep on serve startup).** Lives in
`src/orchestrator/inbox/store.ts` (NOT bolted into RunStateStore — the
sweeper is part of the inbox subsystem, invoked from the same startup
hook as the existing stale-run sweeper but as a sibling). For each
`claimed` message, revert to `pending` if any of:
- `claimed_pid` is not in the live process table, OR
- `claimed_server_instance` ≠ current `SERVER_INSTANCE_ID`, OR
- `claimed_at` is older than `CREW_INBOX_CLAIM_MAX_AGE_MS` (default
  5 minutes).

The age fallback handles PID recycling on the same host. The instance
ID handles serve-restart-without-PID-change (rare but possible on
constrained environments). PID alive + instance match + recent age =
real in-flight claim, leave alone.

**At-least-once semantics.** If serve dies AFTER the adapter received
the prompt but BEFORE step J finalized delivery, the next serve
startup reverts the messages to `pending`, and the next
`continue_run({flush_inbox: true})` will deliver them again. The
agent may see the same body twice across the crash boundary. This
is at-least-once delivery, not exactly-once. Document this in the
captain skill: "if serve crashed mid-flush, an agent may see a queued
message twice on retry; idempotent message bodies (or bodies that
acknowledge potential repetition) are the recommendation."

**Why two lock scopes (recap).** `inbox` for inbox file mutations
(claim, delivered transitions, send_message cap+write). `state` for
state.json writes (`appendPrompt`, status flips, prompt-record
updates). Separate so `send_message`'s cap-check doesn't fight
`continue_run`'s state update. Both per-run so independent runs
don't contend.

### state.json.prompts recording — concrete API

The plan extends `appendPrompt` from a single-string call to a
structured options call. Today (run-state.ts:354):

```ts
appendPrompt(runId: string, prompt: string): RunStateV1
```

Becomes:

```ts
type RunPromptRecord = {
  turn: number;
  prompt: string;                 // user-supplied (raw captain intent); '' allowed
  inbox_delivered?: string[];     // msg_ids delivered on this turn
                                  // (set initially under inbox lock; cleared on rollback)
  claim_token?: string;           // ULID; matches inbox files' claim_token field;
                                  // used by ROLLBACK to find the claimed batch
                                  // and by audit/replay
  startedAt: string;
  completedAt?: string;
  summary?: string;
};

interface AppendPromptOptions {
  userPrompt: string;             // stored as prompts[].prompt
  inboxDelivered?: string[];      // stored as prompts[].inbox_delivered
  claimToken?: string;            // stored as prompts[].claim_token
}

appendPrompt(runId: string, options: AppendPromptOptions): {
  state: RunStateV1;
  turnNumber: number;             // index into prompts[] for this new record
}
```

**Decisions:**
- `prompts[].prompt` records the **user-supplied string only**, NOT
  the composed prompt-with-prepend. This preserves captain's raw
  intent for audit; the composed prompt is reproducible (see
  §"Aggregate prepend builder").
- `prompts[].inbox_delivered` is the list of msg_ids whose bodies
  were prepended on this turn. Cleared to `[]` only by ROLLBACK
  (compare-and-set rejection or synchronous `dispatcher.start()`
  throw — see §"Dispatcher integration"). Post-acceptance adapter
  spawn failures do NOT clear it; under v6 semantics those messages
  remain `delivered`.
- The composed prompt is **NOT** persisted to state.json or
  events.log. events.log carries adapter stream chunks, which is
  what the adapter actually emits — not the prompt input. (The
  earlier draft incorrectly said "events.log carries the synthesized
  prepend block" — that's not how the adapter pipeline works.)
- `truncatePromptForStorage` (run-state.ts:150) is applied to
  `userPrompt`. Empty strings pass through unchanged (`''.length === 0
  < cap`).
- All `appendPrompt` calls go inside `withRunLock({crewHome, runId,
  scope: 'state'}, ...)` to fix the pre-existing read-modify-write
  race at run-state.ts:335.

**Signature migration (breaking change to existing callers).** The
single-string form is removed; ~5 existing call sites (e.g.,
`serve.ts:440`'s `runStateStore.appendPrompt(args.run_id, args.prompt)`)
update to the options form: `appendPrompt(args.run_id, { userPrompt:
args.prompt })`. Phase 1 includes the call-site sweep; tests in the
same change confirm the migration.

**Callback contract for `inboxOnDispatcherAccepted` /
`inboxOnSyncDispatchFailure`** (used in step H of §"Dispatcher
integration"):
- Both are typed `() => Promise<void>` and **awaited** by
  `runDispatchAndRespond` before the envelope return path completes.
  This is what closes the cancel_run interleave window to "narrow"
  rather than "wide."
- If the callback itself throws or rejects: `runDispatchAndRespond`
  catches and logs; messages stay `claimed`; the next sweeper pass
  reverts them to `pending`. Same shape as a serve crash. The
  failure is also returned to the captain as a warning in the
  envelope (`inbox_finalize_failed: true` plus a synthetic warning
  string), so the captain doesn't silently miss it.

## Edge cases

### `merge_run` interaction

- `send_message` to a merged run: refused with `recipient_not_addressable`.
- Pending messages at merge time: **transition `pending → undeliverable`**,
  set `delivery_outcome: 'recipient_merged_undelivered'`. They show up
  in `inbox_counts.undeliverable` (not `pending`); future flushes will
  not pick them up; v2 `read_inbox` can still read them for audit.
- Claimed messages at merge time: would be unusual (claimed implies a
  flush in flight, but flush can only happen on a non-merged run).
  If it happens via crash recovery + race: leave the rollback path to
  revert to `pending`, then the merge transition picks them up and
  marks `undeliverable`.

### `discard_run` interaction

- `send_message` to a discarded run: refused.
- Pending messages at discard time: **wiped.** Discard is "this run
  is forgotten." Audit-only state.json + events.log remain as today.
- **Read-only runs**: read-only runs have no worktree allocation, so
  there's nothing for `discard_run` to delete on the worktree side.
  But they CAN have an inbox (the captain may queue messages targeted
  at the read-only run). On discard for a read-only run: still wipe
  inbox/, set status to discarded. Same wipe semantics — discard means
  forgotten regardless of read-only-ness.

### `cancel_run` interaction

- `send_message` to a `cancelled` run: allowed (cancelled is a valid
  status for `continue_run`).
- Pending messages at cancel time: stay `pending`. The captain can
  retry by `continue_run({run_id, flush_inbox: true})` later.
- `claimed` messages at cancel time: see §"Dispatcher integration"
  → `cancel_run` interaction. Summary: under v6's "delivered =
  dispatcher accepted" semantics, the common case is FINALIZE has
  already completed by the time cancel could fire (messages
  `delivered`); the narrow interleave case lets FINALIZE finish
  writing `delivered` (cancel does not roll back); only a serve
  crash leaves `claimed` messages, which the sweeper recovers to
  `pending`. There is no special cancel-triggered rollback path.

### `read_only` runs

- `send_message` to a read-only run is allowed.
- Read-only contract is enforced by sandbox + working_directory, not by
  inbox. The prepended block is part of the prompt; the agent treats it
  as instructions but is still bound by read-only.

### Stale-run sweeper

The sweeper (today's behavior, run-state.ts:97-110) marks abandoned
runs terminal with `error`. `error` is in `continue_run`'s allowed set,
so `send_message` is allowed afterwards. If the user re-attaches and
calls `continue_run({flush_inbox: true})`, queued messages flush.

A second sweeper pass (added by this plan) reverts orphaned `claimed`
inbox messages to `pending` — runs at serve startup, scoped to all
runs, checks `claimed_pid` against the live process table.

### `merge_conflict` interaction

- `send_message` to a `merge_conflict` run: refused with
  `recipient_not_addressable` (matches `continue_run`'s refusal).
- Pending messages at merge_conflict time: stay `pending`. The user
  resolves the conflict manually and either `merge_run` succeeds (then
  `send_message` is permanently refused; pending messages get
  `delivery_outcome: 'recipient_merged_undelivered'`) or `discard_run`
  succeeds (inbox is wiped). No special handling at the `merge_conflict`
  transition itself.

### Concurrent `continue_run` for the same run_id

This is a pre-existing issue: today's `appendPrompt` is
read-modify-write without a per-run lock (run-state.ts:335). The plan
doesn't make it worse, but the inbox flush adds a second mutation
(`status: pending → claimed → delivered`) to the per-turn cycle. Use
the state lock here too — `withRunLock({crewHome, runId, scope:
'state'}, ...)` around the appendPrompt + status update batch.

This is a small extension of the plan's scope: introduce the run-state
lock now, even though it's not strictly inbox-only. The lock acquired
here is `withRunLock({crewHome, runId, scope: 'state'}, ...)`. Cost:
<0.5d.

### `send_message` racing with recipient status transition

A captain calls `send_message` while some other process (the dispatcher,
or a hypothetical sweeper) transitions the recipient to a terminal
status. Read-then-write race.

Mitigation: write inside the inbox lock; re-read recipient state after
acquiring the lock; if status moved to non-addressable, refuse with
`recipient_not_addressable` (no message file written).

### Empty-but-not-pending inbox flush

`continue_run({flush_inbox: true})` with no pending messages → reject
with `inbox_empty`. Captain saw counts before calling; this is a
captain bug, surface it loudly.

### `body_truncated` audit

When body or excerpt is truncated, we record original length in
`body_truncated` and emit a warning. Future `read_inbox` (v2) returns
the truncated body verbatim — no "view full" recovery. This is a
trade-off worth flagging.

### `state.json.tmp` cross-process collision (called out by Codex)

`run-state.ts:659` writes via fixed temp path `state.json.tmp`. In
single-process v1 this is fine. **But** if/when v2 introduces
worker-spawned serves, this is a real race. **Action:** change
`writeState` to use `state.json.${pid}.${random}.tmp` now, even though
v1 doesn't expose the bug. Cost: <30min. Forward-compat tax we should
pay.

### `inbox_disabled` kill switch — read paths

`CREW_INBOX_DISABLED=1` is checked in:
- `send_message` — refuses every send with `inbox_disabled`.
- `continue_run({flush_inbox: true})` — refuses with `inbox_disabled`.
  Pending messages remain queued; flushing resumes once the env var
  is cleared and serve is restarted.
- `get_run_status` — still returns `inbox_counts` (counts are read
  from disk; the kill switch only stops mutations).

### `from` schema invariant in v1

`InboxMessage.from` is typed as `InboxAddress` (tagged union covering
both `captain` and `run`), but v1 always stamps `{kind: 'captain'}`.
Add a runtime assertion in `inbox/store.ts` write path: stored
`from.kind === 'captain'` always; reject otherwise. Tests in Phase 1
exercise the assertion. v2 will drop the assertion when worker-initiated
sends ship.

## Testing

### Unit tests

- `send_message` validation matrix (every error code).
- `thread_id` / `thread_depth` derivation: root, reply, deep reply.
- Body / excerpt truncation paths.
- Aggregate prepend cap: small messages all fit, large messages stop
  early, undelivered_remaining_count correct.
- `continue_run` validator: empty + flush=false rejects, empty +
  flush=true + empty inbox rejects, prompt + flush=true delivers.
- Per-run lock contention: two concurrent send_message calls don't
  both pass cap check.

### Integration tests

- Captain dispatches A and B (live adapters or mocked).
- After A terminal: send_message(B, summary) → continue_run(B,
  flush_inbox=true) → B sees prepend block, mark delivered.
- Multi-message: 3 messages queued; all 3 delivered in order on next
  flush; aggregate cap respected when bodies are big.
- Recipient status transitions during send: cancel B mid-send_message;
  refuses cleanly.
- discard_run wipes inbox; merge_run preserves with delivery_outcome.

### Property tests

- Generate random valid send_message inputs; assert each msg delivered
  exactly once across any sequence of flush calls.

## Phasing

### Phase 1 — schema + storage + locks

- `src/orchestrator/inbox/schema.ts` — types + zod validators.
- `src/orchestrator/inbox/store.ts` — read/write/transition with
  inbox lock; per-message tmp+rename with unique temp names.
- `src/orchestrator/run-lock.ts` — generalized
  `withRunLock({crewHome, runId, scope: 'inbox' | 'state'}, fn)` —
  mkdir-based, generalized from `src/git/worktree.ts:993`. Options
  object so caller passes `crewHome` explicitly (no implicit module
  state).
- Switch `state.json.tmp` to `state.json.${pid}.${random}.tmp` —
  forward-compat tax.
- Wrap existing `appendPrompt` callers in
  `withRunLock({crewHome, runId, scope: 'state'}, ...)` — fixes the
  pre-existing read-modify-write race at run-state.ts:335.
- Extend `appendPrompt` signature to options form (see §"state.json.prompts
  recording — concrete API"). Update existing callers.
- Tests: storage layer, lock contention, claim/release rollback paths.

**Estimate:** 1.5 days (was 1d in v2; +0.5d for the appendPrompt
signature change + state-lock rollout to existing callers).

### Phase 2 — `send_message` tool

- `src/orchestrator/tools/send-message.ts`.
- Wire into tool registry (`src/orchestrator/tools/index.ts`).
- **Install catalog parity** (per repo convention): update
  `src/install/tool-catalog.ts` to register `send_message` so
  `crew-mcp install` adds it to per-host config; update
  `test/install/tool-catalog.test.ts` snapshot.
- Identity stamping: always `from = { kind: 'captain' }` in v1.
- Server-derived `thread_id` / `thread_depth`.
- Repo-scope check (`recipient_not_owned`).
- Tests: validation matrix, identity stamping, thread derivation,
  install catalog snapshot.

**Estimate:** 1.25 days (was 1d in v3; +0.25d for install catalog
parity work).

### Phase 3 — `continue_run` integration

- Update `continue_run` schema (relax prompt, add `flush_inbox`).
- Implement `buildPrependBlock` in `src/orchestrator/inbox/prepend.ts`
  with first-message-force, hard ceiling, byte-exact deterministic
  format. Golden tests pin the bytes.
- Dispatcher prepend + claim + FINALIZE / ROLLBACK logic in
  `src/cli/commands/serve.ts` `continue_run` handler (transactional
  flow per §"Dispatcher integration"). **No `run:start` / `run:failed`
  event listeners.** v6 invokes FINALIZE inline as an
  `inboxOnDispatcherAccepted` callback awaited inside an extended
  `runDispatchAndRespond`; ROLLBACK is `inboxOnSyncDispatchFailure`,
  fired when `dispatcher.start()` throws synchronously.
- Extend `runDispatchAndRespond` (`serve.ts:828`) with optional
  `inboxOnDispatcherAccepted` and `inboxOnSyncDispatchFailure`
  callback options. Both `() => Promise<void>`, both awaited.
- Crash-recovery sweeper in `src/orchestrator/inbox/store.ts`
  (PID + instance ID + age) invoked on serve startup.
- **No `cancel_run` listener** — the documented "delivered =
  dispatcher accepted" semantic plus sweeper crash recovery covers
  the cancel cases without extra mechanism (see §"Dispatcher
  integration" → cancel_run interaction).
- Tests: concurrent flush doesn't double-deliver; sync dispatch
  failure rolls back; FINALIZE callback throws → messages stay
  `claimed` and sweeper recovers; PID-reuse + age fallback.

**Estimate:** 2 days (was 1.5d in v3; +0.5d for the v6 callback
extension + sweeper relocation; cancel_run hook removed reduces
some scope).

### Phase 4 — `get_run_status` extension

- Add `inbox_counts` field, present by default.
- Tests.

**Estimate:** 0.25 day.

### Phase 5 — captain skill update + verify

- Update `skills/crew-captain.body.md` with the new section.
- Run `crew-mcp verify` to confirm tool ↔ skill parity.
- Update any tool-count headers (`docs/plans/active/perf-context-audit-merged.md`
  references count of 8; will be 9).

**Estimate:** 0.5 day.

### Phase 6 — lifecycle integrations

(Not to be confused with the earlier draft's "Phase 6" worker-MCP
plumbing — that one was deleted in round-1 rescope. This is a
different phase, scoped to `merge_run` and `discard_run` hooks only.
`cancel_run` does NOT need an inbox hook in v6 — see §"Dispatcher
integration" → cancel_run interaction.)

- `merge_run`: transition all `pending` messages to `undeliverable`
  with `delivery_outcome: 'recipient_merged_undelivered'`. Done
  under inbox lock.
- `discard_run`: rm -rf inbox/ alongside worktree (both edit and
  read-only runs).
- Tests for each.

**Estimate:** 0.5 day.

### Phase 7 — dogfood + iterate

- Two real implement-then-review tasks end to end on Claude Code.
- Note rough edges in skill prose.
- Adjust prepend format if agents misread it.
- Update `docs/status/captain-flow-review-*` if changes affect the
  status baseline (per repo convention).

**Estimate:** 1 day spread over a few days of normal use.

**Total: ~6.75-7.75 days of focused work.** (Was 6.5-7.5d in v4;
+0.25d for v5: install catalog parity in Phase 2, plus minor Phase 3
adjustment for the runDispatchAndRespond callback extension.)

## Future work

### v2 — worker-initiated `send_message`

Workers calling the tool requires a real trust boundary. Sketch:

- Captain dispatch generates a per-run token, stored in
  `~/.crew/runs/<runId>/.auth.json` (mode 0600).
- Worker's MCP config includes `CREW_RUN_ID=<id>` and
  `CREW_RUN_TOKEN=<token>` in env (per-worker).
- Worker's MCP server is invoked with `crew-mcp serve --worker-run
  <id> --token <token>` — a restricted serve mode that:
  - Only registers `send_message` and (maybe) `read_inbox` for
    own-run.
  - Validates `CREW_RUN_TOKEN` against the on-disk sidecar.
  - Refuses every other tool (`merge_run`, `discard_run`,
    `cancel_run`, `run_agent`, `continue_run`, `list_runs`,
    `list_agents`, `get_run_status` for other runs).
- Worker's `from` is stamped from the validated token, NOT from env
  alone. (Token → run_id mapping; env can claim anything but the token
  is the proof.)
- Repo-scope check: token is bound to the captain's repo; cross-repo
  send refused.

This is a substantial design block. Likely 3-5 days of v2 work.

### v2 — `read_inbox`

Captain inspects bodies before flushing. Pagination, body cap, maybe
streaming for large inboxes. Workers can call `read_inbox` for their
own run only.

### v2 — `cancel_message`

Captain unqueues a pending message before delivery. Useful when the
captain realizes the message is wrong before the next continue_run.

### v2 — auto-continue

Daemon in captain's serve watches inbox dirs; auto-triggers
`continue_run({run_id, flush_inbox: true})` when a message arrives at
an idle recipient. Per-recipient policy. Loop guard. User-visible
audit. Quota.

### v2 — captain inbox

Workers messaging the captain. The v1 `to` schema already supports
`{kind: 'captain'}` as a tagged union; v2 just enables it.

### v2 — `run_panel` integration

Multi-agent fan-out + aggregation (separate plan, competitive analysis
§5.4). Inbox composes naturally; `run_panel` adds `panel_id` /
`conversation_id` for grouping.

### v2 — sync sub-dispatch (`request_review` or similar)

Worker calls a tool that synchronously spawns a peer, blocks until
peer terminates, returns peer's output. CAO-style `handoff`.

## Open questions for you (after round-1 review)

1. **Q1 aggregate cap default**: 32 KB feels right (≈8-10 messages of
   typical size). Comfortable with that, or different?
2. **Q3 discard policy**: wipe inbox on discard, or preserve for
   audit? I argued wipe; you may disagree.
3. **Q4 flush + new prompt**: allow combined? I argued yes; cleanest
   semantics IMO but "flush_inbox=true forces empty prompt" is
   defensible.
4. **The "ask first" wording in §Q5**: is that strong enough, or do
   you want a hard-stop "always confirm any cross-agent send"?
5. **`inbox_disabled` global kill switch**: ship in v1 or defer? I
   added it because Codex flagged it; if you don't want a kill switch
   you don't, drop it.

## Round 1 review log (2026-05-10)

Two reviews (Claude code-architect + Codex on xhigh effort) ran in
parallel against the v1 draft. Both converged on a major rescope:
**v1 must be captain-only.** Worker-initiated `send_message`,
identity stamping via `CREW_RUN_ID`, and per-worker `crew-mcp serve`
plumbing all moved to v2.

### Convergent concerns (both reviewers)

| Concern | Resolution |
|---|---|
| Worker-initiated send is too risky for v1 (identity, restricted MCP surface, plumbing complexity) | **Re-scoped: captain-only v1.** v2 sketch in §Future work. |
| `CREW_RUN_ID` env-based identity is spoofable | **Removed.** v2 uses per-run token (0600 sidecar). |
| Phase 6 (worker-MCP plumbing) atomic-rename argument is wrong (cross-process races) | **Worker-MCP-plumbing phase deleted.** v1 is single-writer. v2 will use real per-run locks + token validation. (Confusion alert: the new plan reuses "Phase 6" for unrelated lifecycle integrations. See §Phasing.) |
| Aggregate prepend cap missing (50 × 16KB = MBs) | **Added** (`CREW_INBOX_AGGREGATE_PREPEND_CAP_CHARS`, default 32 KB). Builder picks oldest-first, returns `undelivered_remaining_count`. |
| `broadcast` in `kind` enum contradicts non-goal | **Dropped.** v1 enum: `note | question | answer`. |
| Phase 6 (old plumbing) can't run parallel to Phase 2 | **N/A** — old worker-plumbing phase deleted. |
| Phasing too optimistic | **Rebuilt:** 5-6 days for captain-only v1 (was 4-5d for the bigger draft; new estimate accounts for lock + temp-path fix). |
| `get_run_status include_inbox: true` default is wrong | **Changed:** counts only, always present. No opt-in flag. |
| Empty-prompt magic on `continue_run` is risky | **Replaced** with explicit `flush_inbox: boolean` flag. |
| Pending-on-merge/discard handling missing | **Specified:** merge keeps with `delivery_outcome`; discard wipes. |
| Concurrent `continue_run` race | **Per-run lock** introduced (`withRunLock`); generalized from `WorktreeManager`'s mkdir pattern. |

### Codex-specific catches

| Concern | Resolution |
|---|---|
| BUG: `InboxMessageStatus` defined but `InboxMessage` didn't include `status` | **Fixed** — `status` is now in the schema. |
| `thread_id` / `thread_depth` should be server-derived, not caller-supplied (security) | **Done** — caller cannot supply either. |
| Missing `delivered_to_turn`, truncation metadata, `recipient_agent_id` snapshot | **Added** (`delivered_to_turn`, `body_truncated`, `recipient_agent_id_at_send`). |
| `state.json.tmp` fixed temp path is unsafe across processes | **Forward-compat fix** — switch to `state.json.${pid}.${random}.tmp` in Phase 1 even though v1 doesn't expose the bug. |
| WorktreeManager has atomic-mkdir lock pattern (`src/git/worktree.ts:993`) — generalize | **Done** — `withRunLock` in `src/orchestrator/run-lock.ts`. |
| Per-run token (0600 sidecar) for identity | **v2 design** — captured in §Future work. |
| Repo scope validation | **Done** — `recipient_not_owned` error in v1. |
| Update durable status baseline per repo instructions | **Phase 7 task** — `docs/status/captain-flow-review-*`. |

### Claude code-architect-specific catches

| Concern | Resolution |
|---|---|
| `to_run_id` vs existing `run_id` naming inconsistency; forward-compat: rename to `to: { run_id }` for tagged-union future | **Done** — `to: { run_id }` shape; v2 expands to `to: { kind: 'captain' \| 'run' }`. |
| Drop `thread_id` OR `thread_depth` (one redundant) | **Kept both** — both server-derived, denormalized for fast reads (per Codex's "server-derive thread_id" recommendation). |
| Drop `index.json` from layout | **Done.** |
| `read_inbox` should be deferred | **Done** — v2. |
| Empty-prompt-only-delivered messages = no-op spin (validator should reject) | **Done** — `inbox_empty` error code. |
| Missing errors: `inbox_disabled`, `recipient_not_owned` | **Done.** |
| `failed_at` / `failed` status feels gold-plated | **Removed.** v1 has only `pending` / `delivered`. Replaced with `delivery_outcome` for runs that became terminal before delivery. |

### Disagreements + resolutions

- **`read_inbox` in v1?** Claude said defer, Codex said ship-but-restrict.
  **Defer (Claude).** Captain only needs counts; bodies are noise.
  Pre-flush peek is rare; "just flush — flush is reversible by
  cancel_run" is a fine v1 stance.
- **Drop `thread_depth` (Claude) vs server-derive both (Codex)?**
  **Server-derive both (Codex).** Denormalized fields with server-side
  derivation are cheap and useful for cap enforcement.

## Round 2 review log (2026-05-10)

Two reviews (Codex on xhigh effort + Claude code-architect) ran
in parallel against the v2 draft. Both converged on a serious
delivery-transaction bug plus several smaller issues. The biggest
change in v3: introduce a `claimed` lease status to fix the
double-delivery race; pin the dispatcher seam to `serve.ts`; specify
the prepend block format and `appendPrompt` API concretely.

### Convergent concerns (both reviewers)

| Concern | Resolution in v3 |
|---|---|
| **Lock-release timing allowed concurrent flushes to double-deliver.** v2 released the inbox lock between picking pending and marking delivered post-spawn. | **Introduce `claimed` lease status.** Pick + claim happens atomically under the inbox lock; lock released; post-spawn `claimed→delivered` (success) or `claimed→pending` (rollback). Crash recovery via `claimed_pid` sweep on serve startup. |
| **state.json prompt-record format was contradictory.** v2 had `appendPrompt(runId, finalPrompt)` while §"state.json.prompts recording" said prompts[].prompt is user-supplied + `inbox_delivered` carries msg_ids. Plus "events.log carries the synthesized prepend block" was wrong. | **Concrete `appendPrompt` API** in §"state.json.prompts recording — concrete API". Stores user-supplied prompt only; composed prompt is reproducible from `userPrompt + inbox_delivered + buildPrependBlock`. events.log clarification: it carries adapter chunks, not prompt input. |
| **Prepend block format unspecified.** Cap math depends on framing bytes; agent reads it verbatim. | **Explicit template** in §"Aggregate prepend builder" with first-message-force rule (single oversize message always included; subsequent messages stop on first cap refusal). |
| **Cross-run `in_reply_to` threading was broken in skill example.** M1 in B's inbox; reply M2 to A's inbox; `in_reply_to: M1` couldn't resolve in A's inbox. | **Global parent lookup** across `~/.crew/runs/*/inbox/`. Documented in §"send_message" identity section. Skill example clarified. |
| **Phase 6 naming clash.** v2 deleted "Phase 6 worker plumbing" but introduced a new "Phase 6 lifecycle integrations". The Round 1 log read confusingly. | **Disambiguated** in Phase 6 section + Round 1 log entries. |
| **`get_run_status inbox_counts?:` was optional in type but "always present" in prose.** | **Required field**, present in running snapshot, timeout response, and terminal. Counts now include `claimed` too. |
| **Phasing too optimistic for v2's scope.** | **Rebuilt:** 6-7 days for v3 (was 5-6d in v2 due to claim/rollback transaction + appendPrompt signature change). |
| **`recipient_cancelled_undelivered` in schema enum was unused.** | **Removed** — cancel leaves messages pending; no terminal-outcome tag fires. |

### Codex-specific catches

| Concern | Resolution in v3 |
|---|---|
| Skill example used `kind: "review_request"` which isn't in the v1 enum (`note | question | answer`) | Skill example uses `kind: "note"` with `[review request from captain]` body prefix |
| Single message can exceed 32 KB cap (16 KB body + 8 × 4 KB excerpts = 48 KB possible); "stop before exceeding cap" can pick zero messages | **First-message-force** rule documented in §"Aggregate prepend builder". |
| `merge_conflict` pending-message handling not specified | Added to §Edge cases — refuses send; pending stays pending; resolves at eventual merge or discard. |
| Discard for read-only runs ambiguous (no worktree to delete; what about inbox?) | Specified — inbox is wiped regardless of read-only-ness. |
| Dispatcher seam too vague (`tool-dispatcher.ts or serve.ts`) | **Pinned** to `continue_run` handler in `src/cli/commands/serve.ts` (lines ~380-410), before `buildAdapterDispatchTask`. |
| Wrong rationale for `read_inbox` deferral (`flush is reversible by cancel_run`) — by the time messages are `delivered`, cancel doesn't unmark | Replaced rationale: just defer; don't pretend cancel rolls back delivered messages. |
| `recipient_agent_id_at_send` recorded but unused — call it audit-only or remove | Documented as audit-only (consumed by future tools/exports). |
| `inbox_disabled` kill switch read paths unspecified | Specified — checked in `send_message` AND `continue_run({flush_inbox: true})`. `get_run_status` still returns counts. |

### Claude-code-architect-specific catches

| Concern | Resolution in v3 |
|---|---|
| `queued_at` in `SendMessageResult` vs `created_at` in schema — name drift | Unified to `created_at` everywhere. |
| `recipient_agent_id_at_send` purpose unclear | Documented as audit-only. |
| `inbox_delivered` set in state.json before subprocess spawn = divergence on spawn failure | Rollback path now explicit: spawn failure clears `inbox_delivered` to `[]` AND reverts `claimed → pending`. |
| `thread_too_deep` UX missing — captain doesn't know how to start a new root | Added to skill body — "send a fresh root message (no in_reply_to)". |
| `recipient_not_addressable` mitigation should re-read recipient state inside the lock to catch transitions during the call | §"send_message racing with recipient status transition" already says this; called out explicitly in v3. |
| Storage atomicity for `<msgId>.json` writes unspecified | Specified — same `<file>.${pid}.${random}.tmp` + rename pattern as state.json fix. |
| `from` schema invariant test for v1 | Added — runtime assertion + Phase 1 test. |

### Disagreements + resolutions

- **Lock fix shape: hold the lock through spawn (Claude option-a) vs intermediate `claimed` status (both reviewers' option-b).** **Chose `claimed` lease.** Spawn can be slow; holding the lock that long would serialize concurrent `send_message` calls unnecessarily. Lease has explicit rollback semantics + crash recovery via PID check.
- **Drop `delivering` intermediate state vs introduce `claimed`.** Both names mean the same thing; chose `claimed` because it's clearer ("this message has been claimed by an in-flight flush") and shorter.

### Acknowledged-but-not-acted-upon

- **`recipient_agent_id_at_send` could be dropped entirely** (Agent code-architect suggestion). Kept for audit; cost is one field × ~50 messages × ~30 bytes = ~1.5 KB worst case. Cheap enough to keep.
- **`thread_id` and `thread_depth` could be derived rather than denormalized** (Claude code-architect suggestion in round 1). Kept denormalized per Codex round-1; no change in v3.

## Round 3 review log (2026-05-10)

Two reviews (Codex on xhigh + Claude code-architect) ran in parallel
against v3. Both verified that the round-2 lease pattern is correct
in shape, but found tightness gaps that would have surfaced as bugs
in implementation. v4 closes these. Highlights:

### Convergent concerns (both reviewers)

| Concern | Resolution in v4 |
|---|---|
| **Cap check counted only `pending`, not `pending + claimed`.** Flush could claim 50, send_message lands while still claimed (cap check passes, sees 0 pending), flush rolls back, suddenly 51 pending — silent cap overflow. | Cap renamed to "active messages (pending + claimed)" with explicit rationale in §Caps. |
| **PID recycling could leave `claimed` stuck.** Recovered process happens to take old PID; sweeper sees "live" and never reverts. | Added `claimed_at` age threshold (`CREW_INBOX_CLAIM_MAX_AGE_MS`, default 5 min) AND `claimed_server_instance` ULID. Sweep reverts on ANY of: dead PID, instance mismatch, age exceeded. |
| **Rollback boundary was hand-wavy.** v3 said "spawn fail" without naming a seam; `dispatcher.start()` is fire-and-forget. | Pinned to dispatcher lifecycle events: `run:failed` BEFORE `run:start` triggers rollback; sync throw in step H also rollbacks; `run:start` triggers FINALIZE. Explicit one-shot listener installation in step I. |
| **Prepend block had a double `---` separator.** Block ended with `---\n\n` and step D added `\n\n---\n\n` again. | Fixed: block ends with `---\n\n` (terminator + blank line); step D appends userPrompt verbatim with no extra separator. |
| **Discard breaks threads rooted in discarded run** with no captain warning. | Added §"Threads break across discard" to skill body. |

### Codex-specific catches

| Concern | Resolution in v4 |
|---|---|
| **Status check race for double-dispatch.** Two concurrent flushes both pass the not-running check before either flips status; double-dispatch (worktree + adapter) of the same run. | State lock held through: compare-and-set (step F) → appendPrompt (step G; flips status to running) → runDispatchAndRespond synchronous body (step H). Released after dispatcher.start synchronously returns. (v4 originally said the lock was held through dispatcher.start; v5 narrows the claim — see v5's §"State lock duration".) |
| `cancel_run` rollback decision was too broad — if prompt already delivered, agent saw bodies; reverting status is wrong. | Cancel listener checks claim-token's messages: still `claimed` → rollback; already `delivered` → leave alone. Explicit in §"Dispatcher integration" cancel_run paragraph. |
| **`delivery_outcome` model muddy** — with statuses `pending | claimed | delivered`, what's a merged-undelivered message? If it stays `pending`, counts lie. | Added 4th status `undeliverable`. `inbox_counts` now exposes all four. Flush filter skips `undeliverable`. `delivery_outcome` paired only with `undeliverable`. |
| At-least-once semantics not documented; agent may see duplicate prompts after crash recovery. | Documented in §"At-least-once delivery" in skill body. Recommendation: prefer idempotent message bodies. |
| First-message-force unbounded if env overrides raise body/excerpt caps arbitrarily. | Added `CREW_INBOX_HARD_PREPEND_CEILING` (default 64 KB) — absolute cap regardless of overrides. Last message in block truncated if hit. |
| Repo scope on parent lookup missing — global walk could thread across repos. | `in_reply_to` lookup filters by `recipient_repo_root_at_send === captain.repoRoot`. Cross-repo parent returns `in_reply_to_not_found` (no leak). |
| Excerpt escaping for triple backticks unspecified. | Specified — fence escalates to 4+ backticks if excerpt body contains 3 (and so on). No inline backtick escape. |
| `appendPrompt` rollback must target the captured turn, not "last prompt." | Step G returns `turnNumber`; rollback step R uses it explicitly. |

### Claude-code-architect-specific catches

| Concern | Resolution in v4 |
|---|---|
| Lock acquisition order unspecified — footgun for v2. | Added explicit rule in §"Dispatcher integration": inbox before state, never both held simultaneously. |
| Sweeper logic should live in `inbox/store.ts`, not bolted into RunStateStore. | Sweeper relocated to `src/orchestrator/inbox/store.ts`; invoked from same startup hook as the existing stale-run sweeper but as a sibling. |
| `inbox_empty` rejection path when claimed-but-not-pending should be called out explicitly. | Added to step C narration: claimed messages are filtered out at step C.2; a flush with all messages already claimed by another flush hits `inbox_empty`. |
| Prepend numbering reset per flush ambiguous. | Specified: `{idx}` numbering starts at 1 globally per flush call. |

### Disagreements + resolutions

- **Hold lock through dispatcher.start (Codex's stronger position) vs release inbox lock briefly (v3's stance).** v4 takes the middle: STATE lock held through dispatcher.start (microseconds, fixes the status race); INBOX lock acquired briefly twice (claim, then later finalize/rollback). Best of both.
- **At-least-once vs exactly-once delivery.** Codex flagged that crash between adapter-received-prompt and FINALIZE is unrecoverable without an adapter-level "prompt accepted" ack. v4 accepts at-least-once, documents it, and recommends idempotent message bodies. Exactly-once is deferred — would need protocol-level changes per adapter.

### Acknowledged-but-not-acted-upon

- **Thread tombstone/index for discarded runs** (Codex suggestion). Tracked as v2 if discard-breaks-threads becomes a real pain point. v1 just warns the captain.

## Round 4 review log (2026-05-10)

Two reviews (Codex on xhigh + Claude code-architect) ran in parallel
against v4. **Both said NOT READY.** Both caught the same load-bearing
bug: v4's lifecycle listener pattern races with the dispatcher's
synchronous `run:start` emission. Codex went deeper: even with
correct ordering, `run:start` doesn't mean "adapter received the
prompt" — it means "dispatcher accepted the task into in-flight."
Stronger semantics would require a new dispatcher event, which v5
defers to v2.

### Convergent concerns (both reviewers)

| Concern | Resolution in v5 |
|---|---|
| **Listener installation races `run:start`.** v4 installed the one-shot lifecycle listeners AFTER `dispatcher.start()` (step I), but `run:start` is emitted synchronously inside `start()` BEFORE it returns (`tool-dispatcher.ts:71`). FINALIZE would never fire on the happy path. | **Removed the listener pattern entirely.** v5 invokes FINALIZE inline as a callback fired by `runDispatchAndRespond` after `dispatcher.start()` synchronously returns without throwing. No event subscription, no race. |
| **`run:start` ≠ "adapter received the prompt."** Even with pre-start listeners, `run:start` only means "dispatcher accepted the task." Adapter spawn happens later inside `task.run()`. | **Documented "delivered" as "dispatcher accepted the task."** Schema NOTE on `InboxMessageStatus` makes this explicit. Stronger semantics deferred to v2 (would need `run:promptAccepted` event + per-adapter changes). |
| **Phase 3 needs concrete refactor boundary.** v4 said "use lifecycle listeners" without naming where. `runDispatchAndRespond` (`serve.ts:828`) already owns listener installation + dispatcher.start. | **Extend `runDispatchAndRespond`** with optional `inboxOnDispatcherAccepted` and `inboxOnSyncDispatchFailure` callbacks. continue_run's handler passes these in. No parallel dispatch path. |
| State lock duration claim was inaccurate (v4: "released before subprocess starts"; reality: held through synchronous body of `task.run()` until first await). | **Narrowed claim in v5:** "released in milliseconds; not held across `task.run()`'s async work." Honest. |

### Codex-specific catches

| Concern | Resolution in v5 |
|---|---|
| `claim_token` was used in step G but missing from concrete `RunPromptRecord` / `appendPrompt` API. | **Added** to `RunPromptRecord` and `AppendPromptOptions`. |
| `withRunLock(runId, scope, fn)` lacked crewHome ownership resolution. | **Pinned API:** `withRunLock({crewHome, runId, scope}, fn)` with explicit options object. |
| Phase 2 omitted install catalog parity work (`src/install/tool-catalog.ts` and snapshot test) required by repo conventions. | **Added to Phase 2.** +0.25d. |
| Stale "pending/delivered/failed" counts in non-goals didn't match the 4-status model. | (Verified: non-goals section in v5 doesn't reference status-by-name; nothing to fix.) |
| Round 3 review log table claimed state lock held through "re-read status → claim → appendPrompt" but detailed flow had inbox first. | **Corrected table entry** to match the detailed flow (inbox first, release, then state). |
| `run:cancelled` listener wasn't fully specified in v4. | **Removed** in v5 — under "delivered = dispatcher accepted" semantics, FINALIZE always runs synchronously at dispatcher.start return, so cancel never sees `claimed` messages from the same continue_run call. Sweeper handles serve-crash case. |

### Claude-code-architect-specific catches

| Concern | Resolution in v5 |
|---|---|
| `run:start` can't be observed by post-start listeners (race with synchronous emit). | **Sidestepped** — v5 doesn't use lifecycle listeners. |
| Inter-message separator bytes inconsistent in template (`---\n` vs `---\n\n`). | **Pinned** — every message terminates with `\n---\n\n`; next message's `### Message` heading begins immediately after. Block as a whole ends with `---\n\n`. |
| Listener leak if dispatcher hangs (one-shot listeners never disposed). | **N/A** — no listeners in v5. Hang behavior: messages are already `delivered` at dispatcher.start return; if the adapter hangs, the run errors but the inbox is correct. |
| Listeners scoped per (runId, claim_token) ambiguity. | **N/A** — no listeners. The inline callback closes over claim_token directly. |
| `cannot_message_self` dangling in v1 error table. | **Moved out** of the v1 error table; noted as v2 reservation. |
| `undeliverable` not threaded through 500-total cap. | **Specified** — the 500-cap counts all four statuses. Noted in §Caps. |

### Disagreements + resolutions

- **Adapter-level "prompt accepted" ack vs documented-as-such (Codex's preference vs the simpler v5 path).** v5 takes the simpler path: document the dispatcher-acceptance boundary; don't change the dispatcher contract. The adapter-ack option is captured in v2 §Future work, with a note that it would tighten the "delivered" semantic from "task accepted" to "agent has the prompt." Trade-off: the simpler path means a run that errors immediately after dispatcher acceptance leaves inbox messages `delivered` despite the agent never reading them. Acceptable for v1 because (a) such failures show up as errored runs the captain can see, (b) the captain can interpret `delivered` per the documented semantics, (c) at-most-once delivery is how a lot of message systems work and isn't surprising.
- **Refactor `runDispatchAndRespond` vs new continue-specific dispatch path (Codex offered both options).** v5 picks the refactor — adds two optional callbacks. Less code change than a parallel path, doesn't fork the lifecycle handling.

### Acknowledged-but-not-acted-upon

- **`run:promptAccepted` adapter-level event.** Tracked as v2 future work for stronger delivery semantics. Would touch all 5 adapters.

## Round 5 review log (2026-05-10)

Two reviews (Codex on xhigh + Claude code-architect) ran in parallel
against v5. **Both said NOT READY** with strong convergence on prose
inconsistencies. No new architectural issues — all blockers were
stale text from earlier drafts that hadn't been updated to match
v5's design (notably: Phase 3 still mentioned `run:start` /
`run:failed` listeners that v5 had removed). v6 is a pure cleanup
pass.

### Convergent concerns (both reviewers)

| Concern | Resolution in v6 |
|---|---|
| Phase 3 still listed "one-shot lifecycle listeners for FINALIZE and ROLLBACK on `run:start` / `run:failed` events" — directly contradicted v5's main flow, which removed listeners entirely. | **Phase 3 rewritten** to match v5's callback design. Explicit "No `run:start` / `run:failed` event listeners" note. |
| Phase 6 said `cancel_run` hookup lived "in Phase 3 with the dispatcher lifecycle listeners" — both stale concepts. | **Phase 6 rewritten** — scoped to merge/discard only. Explicit "cancel_run does NOT need an inbox hook" note tied back to the dispatcher integration section. |
| "Delivered" semantics inconsistent — schema said dispatcher-accepted but `continue_run` behavior section said "after the subprocess has spawned"; skill body said crash "after the adapter received a prompt." | **Audited every "delivered" mention.** continue_run behavior section now refers to §"Dispatcher integration" for the precise transition; skill body's at-least-once paragraph rewritten to describe the dispatcher-acceptance crash window. |
| Callback timing/await/throw contract not pinned. | **Specified:** both callbacks are `() => Promise<void>`, both awaited inside `runDispatchAndRespond`, callback throws result in `claimed` messages staying for sweeper recovery + a warning surfaced in the envelope. |
| State lock duration paragraph mentioned only `dispatcher.start`, not the awaited FINALIZE inbox-lock window. | **Updated** §"State lock duration" — lock held through compare-and-set + appendPrompt + sync `runDispatchAndRespond` body + awaited FINALIZE callback (still milliseconds). |

### Codex-specific catches

| Concern | Resolution in v6 |
|---|---|
| `continue_run` behavior section had stale `<prepend block>\n\n---\n\n<prompt>` (double separator) — contradicted "block already ends with `---\n\n`; do not add another separator." | **Replaced** with reference to §"Dispatcher integration" + clarifying note: agent's prompt is `<prepend block><prompt-or-empty>` with no extra separator. |
| Callback name drift: one paragraph said `inboxPreStart`, later flow said `inboxOnDispatcherAccepted`. | **Unified** to `inboxOnDispatcherAccepted` and `inboxOnSyncDispatchFailure` everywhere. |
| Stale `withRunLock(runId, 'state', ...)` examples in flow text (didn't match the options-object API). | **Updated** all in-line examples to `withRunLock({crewHome, runId, scope: 'state'}, ...)`. |
| "task.run() scheduled async via .then(...)" wording was incorrect — `task.run()` is called immediately; async functions execute synchronously up to first `await`. | **Corrected** §"State lock duration" — accurate description of the synchronous body + first-await yield. |
| `appendPrompt` called "backward compatibility" when it's a breaking signature change. | **Renamed** to "Signature migration" with explicit note about ~5 call-site sweep. |

### Claude-code-architect-specific catches

| Concern | Resolution in v6 |
|---|---|
| cancel_run "FINALIZE always runs … before cancel_run can possibly be called" was too strong — FINALIZE itself is async. | **Softened.** Now describes three cases: common (FINALIZE done before cancel could fire), narrow interleave (microsecond window where cancel could land between dispatcher.start return and FINALIZE awaited inbox lock — semantics: FINALIZE proceeds, cancel only kills the adapter), crash (sweeper recovery). |
| `inboxOnDispatcherAccepted` await/non-await ambiguity. | **Pinned** — awaited; if the callback throws, `runDispatchAndRespond` catches+logs, messages stay claimed, sweeper recovers, captain sees a warning. |

### Disagreements + resolutions

None. Round-5 reviewers agreed across the board; v5 had no architectural disputes — just precision gaps.

### Acknowledged-but-not-acted-upon

- **Stronger "delivered" semantic via adapter-level prompt-accepted ack.** Round 4 future-work item; still v2.

## Round 6 review log (2026-05-10)

Two reviews (Codex on xhigh + Claude code-architect) ran in parallel
against v6. **Both said NOT READY**, but both confirmed all
architectural changes from rounds 1-5 had landed cleanly. The only
remaining issues were 4-5 localized prose contradictions that the
v6 cleanup pass had missed. v7 fixes them.

### Both reviewers verified clean

- Phase 3 no longer references `run:start` / `run:failed` listeners.
- Phase 6 is merge/discard only; cancel_run scope-out is consistent.
- `inboxPreStart` removed from all sections.
- Callback names unified to `inboxOnDispatcherAccepted` and
  `inboxOnSyncDispatchFailure`.
- Callback contract pinned (`() => Promise<void>`, awaited, throw
  → catches+logs+sweeper recovers+envelope warning).
- "Delivered" semantics consistent across schema NOTE,
  `continue_run` behavior section, skill body, and edge cases.
- `appendPrompt` change correctly framed as "Signature migration"
  (breaking change), not "backward compat".
- `withRunLock` canonical API + Phase 1 use the
  `{crewHome, runId, scope}` options form.
- Cancel_run interaction softened to common/narrow/crash cases.

### Convergent localized contradictions (both reviewers)

| Concern | Resolution in v7 |
|---|---|
| `withRunLock(runId, 'state', ...)` single-arg form lingered at one site (§"Concurrent `continue_run`"). | **Fixed** — replaced with `withRunLock({crewHome, runId, scope: 'state'}, ...)`. |
| Two flow-pseudocode examples in §"Dispatcher integration" used `withRunLock({runId, scope: ...})` — options form but missing `crewHome`. | **Fixed** — both step C.1 and step E now include `crewHome` in the options. |

### Codex-specific catches

| Concern | Resolution in v7 |
|---|---|
| `cancel_run` interaction edge-case bullet still said `claimed → pending` rollback "same as spawn failure" — directly contradicted v6's "no cancel-triggered rollback" design. | **Replaced** with reference to §"Dispatcher integration" → cancel_run interaction (common/narrow/crash cases); no cancel-triggered rollback. |
| §"state.json.prompts recording" bullet said `prompts[].inbox_delivered` clears "on spawn failure" — contradicted v6's narrowed ROLLBACK trigger. | **Replaced** — clears only on compare-and-set rejection or sync `dispatcher.start()` throw; post-acceptance spawn failures leave messages `delivered`. |
| Non-goals §`read_inbox` deferral text mentioned `pending`/`delivered`/`failed` — old 3-status model. | **Updated** to the 4-status set (`pending` / `claimed` / `delivered` / `undeliverable`). The round-5 log row that said "nothing to fix" turned out to be wrong; the text WAS there, just in non-goals rather than where the round-5 log searched. |

### Disagreements + resolutions

None. Both reviewers agreed the architecture is sound and only listed the prose fixes above.

## Reference: code touchpoints

| Concern | File | Notes |
|---|---|---|
| Schema | `src/orchestrator/inbox/schema.ts` (new) | Types + Zod |
| Storage | `src/orchestrator/inbox/store.ts` (new) | Read/write/transition |
| Per-run lock | `src/orchestrator/run-lock.ts` (new) | Generalized from `git/worktree.ts:993` |
| Prepend builder | `src/orchestrator/inbox/prepend.ts` (new) | Aggregate cap respecter |
| `send_message` tool | `src/orchestrator/tools/send-message.ts` (new) | |
| `continue_run` integration | `src/orchestrator/tools/continue-run.ts` | `flush_inbox` flag |
| Dispatcher seam | `src/orchestrator/tool-dispatcher.ts` or `src/cli/commands/serve.ts` | Prepend block injection |
| State.json hygiene | `src/orchestrator/run-state.ts` | `state.json.tmp` → `state.json.${pid}.${random}.tmp`; `inbox_delivered` in prompts |
| Tool registry | `src/orchestrator/tools/index.ts` | Register new tool |
| `get_run_status` | `src/orchestrator/tools/get-run-status.ts` | `inbox_counts` field |
| `merge_run` integration | `src/orchestrator/tools/merge-run.ts` | Set delivery_outcome |
| `discard_run` integration | `src/orchestrator/tools/discard-run.ts` | rm -rf inbox/ |
| Captain skill | `skills/crew-captain.body.md` | New section |
| Verify | `src/cli/commands/verify.ts` | Confirm parity |
| Tests | `test/inbox/*` (new), `test/orchestrator/continue-run.test.ts` | |
| Status doc | `docs/status/captain-flow-review-*.md` | Update if behavior shifts noted there |
