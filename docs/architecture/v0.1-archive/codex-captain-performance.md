# Codex captain performance — findings + remediation plan

**Date:** 2026-04-20
**Context:** M5 smoke-matrix exit gate surfaced codex as a captain being
~5× slower than claude-code on the simplest possible prompt
("hey is this working?"). This document captures the root-cause
analysis + the options we're tracking to close the gap.

## Observed latencies

From `.crew/logs/run-2026-04-20T02-35-18-715Z.log`:

| Stage | Time |
|---|---|
| Turn 1: `codex exec` with full M3 system prompt | 19.2s |
| Fallback: `executeWithSchema` (OpenAI structured-output) | 6.1s |
| **Total** | **~25s** |

Claude Code on the same prompt: **~5s end-to-end** (log:
`run-2026-04-20T02-08-35-465Z.log`).

## Root-cause ladder

### 1. Subprocess-per-inner-turn (largest factor)

Every call to `this.captain.executeWithTools` in the codex adapter
spawns a fresh `codex exec` subprocess. Per-turn overhead:

- Node.js wrapper load: ~100–300 ms
- Codex binary cold-start: ~500 ms – 1 s
- Fresh OpenAI API connection handshake: ~100–500 ms
- No streaming — the subprocess buffers all JSONL output until the API
  response completes, then exits

Claude Code keeps **one** subprocess alive via
`claude --input-format stream-json --output-format stream-json` and
streams many turns over stdio. Same LLM latency per turn, but the
cold-start costs amortize over the whole session. Codex has no
equivalent mode in the current CLI surface.

### 2. Codex's built-in system preamble dominates token count

Direct-terminal smoke test:

```
$ codex exec --json --skip-git-repo-check "Say hi."
{"type":"thread.started",...}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hi."}}
{"type":"turn.completed","usage":{"input_tokens":80346,"cached_input_tokens":3456,"output_tokens":33}}
```

**80,346 input tokens for a 1-character prompt.** Codex's built-in
coding-agent system prompt is prepended to everything we send. OpenAI
processes all 80k+ tokens on every call. After the first turn, codex's
cached-prompt path kicks in (3,456 cached_input_tokens, ~3× smaller
billed input) — but the wallclock is mostly API compute, not
network/cache.

Translation: our captain-system prompt (~3 KB) is a rounding error
compared to what codex is already shipping on every call. Shrinking
our prompt won't move the needle.

### 3. JSON-envelope fallback doubles turn time on non-conforming responses

The tool-loop adapter expects the captain to emit a JSON envelope
(`{"type":"tool_call", ...}`). When codex instead returns plain text
("Yes."), the parser rejects, the adapter falls back to
`executeWithSchema` — a **second** subprocess spawn, a **second**
OpenAI call (this one uses `response_format` to force the shape).

Claude Code empirically follows the envelope instructions reliably.
Codex does not — likely because the captain-role framing at the top
of the system prompt dominates its attention over the adapter-protocol
instructions appended at the bottom.

### 4. Our previous hang was unrelated to latency

The 90+ second hang that surfaced during M5 smoke-matrix was a
separate bug chain (MCP placeholder + stdin='pipe'). Both fixed in
`5b618b5` and `4b9ab06`. Once those landed, codex just behaves
*structurally slow* — not hung.

## Remediation options, ordered by payoff-per-effort

### A. Make `executeWithSchema` the primary codex path (shipped)

Skip the envelope round-trip. Every turn forces OpenAI's
structured-output `response_format` to return valid JSON matching
`ToolLoopDecisionSchema`. No envelope-parse-fail fallback.

- **Saves:** the ~6s fallback round-trip on every turn where the
  captain's natural-language response would have tripped the parser.
- **Effort:** 1–2 hours, adapter-local change.
- **Trade-off:** one subprocess per turn remains; we don't fix the
  structural issue, just the fallback tax.
- **Status:** shipped in `4b3dd20`. Unlocked a cascade of three OpenAI
  strict-mode schema rejections (`propertyNames`,
  `additionalProperties must have type`, `required must list every
  property`) each fixed in sequence in `f862fcc`, `5986f7f`, `46c1817`.

### A.2. Thread codex inner turns via `exec resume <id>` (shipped)

After option A landed, empirical latency was ~30s per inner turn
because every `codex exec` call was a fresh thread — codex's
server-side prefix cache never hit across inner turns. Observed
first-turn latency dominated by the ~80k-token built-in preamble plus
our captain-system prompt.

Fix: codex-private `executeDecisionTurn` helper that:
- Uses `codex exec resume <thread_id>` on follow-up inner turns.
- Extracts the thread id from the JSONL event stream.
- Threads it into the next `decide` callback.
- Logs decision-start / -end at INFO with promptPreview,
  decisionType, tool, reasoningPreview, outputPreview, elapsedMs,
  threadId — previously only raw duration was surfaced, so "captain
  stuck in a loop" was invisible without parsing events.log.

- **Saves:** follow-up inner turns drop from ~30s to ~5–10s once the
  thread cache is warm. First turn remains ~15–20s.
- **Effort:** ~2 hours.
- **Status:** shipped in `7050ca4`.

### A.3. Short-circuit the envelope-finish round-trip

Surfaced by the `7050ca4` log: even for a trivial "hey is this
working?" question, codex produces TWO adapter inner turns:

1. `tool_call` for `mcp__crew__finish` (~15–20s)
2. Envelope `finish` response after the tool result (~5–10s)

The SessionLoop's `done` flag is set synchronously inside the finish
tool handler (`dispatchFinish` → `loop.requestExit`). The adapter's
inner loop doesn't know this — it sends the finish tool's result
back to codex and asks for another decision, which codex correctly
answers with `{type:'finish'}` to end the adapter turn.

Optimization: when `onToolCall` returns a result from the `finish`
tool (or more generally, when the tool handler wants to signal "no
more inner turns needed"), short-circuit the adapter loop. Saves one
full codex call per workflow completion.

- **Saves:** ~5–10s per completed workflow (one codex call).
- **Effort:** ~2–3 hours. Needs a new signal in the `ToolResult`
  shape (e.g., `terminal: true`) that the adapter's controller
  respects. Also needs to be propagated through the tool-loop
  controller shared by all three adapters, so claude-code and gemini
  benefit from the same short-circuit.
- **Status:** parked. Worth doing when option C isn't on the table
  for a release, or first in any case — it's small, generic, and
  benefits every adapter.

### B. Preflight warm-up

Run `codex --version` during preflight (we already do — it's the
healthCheck) but also spawn a silent no-op `codex exec "ok"` in the
background while the UI boots. By the time the user's first prompt
lands, the codex binary is hot in the OS filesystem cache.

- **Saves:** ~200–500 ms of cold-start on turn 1 only.
- **Effort:** ~1 hour.
- **Status:** parked as low-priority; one-time-per-session win is small
  relative to per-turn API latency.

### C. Build a real `crew-mcp` stdio server (the right answer)

A tiny MCP server that:

1. Listens on stdin for MCP protocol messages from codex.
2. Receives `tools/call` requests.
3. Forwards them back to the main crew process via a local socket
   (UNIX-domain `.crew/captain/mcp.sock` or similar).
4. The main process routes to `onToolCall` in-process.
5. Returns results via the server → codex.

Put the server back into `ToolCatalog.toMcpServers()`. Codex then uses
its **native** tool-use events — no JSON envelope in assistant text,
no parser fallback, full threaded resume via `codex exec resume`.

- **Saves:** eliminates the JSON-envelope dance entirely. Turns become
  "one subprocess with a real tool call, exit." First-turn latency
  still ~15s (dominated by codex's preamble + OpenAI compute), but
  follow-up turns on the same thread should be ~5–10s.
- **Effort:** ~1–2 days. MCP protocol isn't complex but a proper
  stdio server with error handling, the forward channel, and
  lifecycle management (spawn on captain start, kill on finish) is
  non-trivial.
- **Status:** deferred — worth doing before a public v1.0 release.

### D. Long-running codex driver

If/when codex gains a `--stdin-json` style mode analogous to claude's
stream-json, switch to a long-running subprocess model. This would
bring codex's first-turn latency down to ~claude-code levels.

- **Saves:** the subprocess cold-start per turn.
- **Effort:** several days, and only practical once the CLI supports
  it.
- **Status:** blocked on upstream. Re-evaluate every few codex
  releases.

## What NOT to do

- **Shrink the captain system prompt further.** Codex's 80k-token
  built-in preamble dominates. Our 3 KB is noise.
- **Disable the captain-role framing for codex.** The M5-8 smoke
  scenarios depend on the preset system seeing the agent inventory
  + hint sections. Dropping them to "help codex follow the envelope"
  would break the whole preset contract.
- **Switch codex to a faster model.** The slow part is the API
  round-trip + codex's preamble, not the model's forward pass. Using
  a cheaper model just degrades quality without measurably changing
  latency.

## Current disposition

- **Shipped (M5 exit gate):** options A, A.2 (thread continuity via
  `exec resume`), plus the three OpenAI schema-strict fixes
  (`f862fcc`, `5986f7f`, `46c1817`) that option A unblocked. Total
  work in the M5 exit-gate chain: 8 commits, ~4 hours of debugging,
  dropped codex first-turn latency from indefinite-hang to ~20s with
  ~5–10s follow-ups.
- **Parked (next):** A.3 short-circuit, C crew-mcp. A.3 is small and
  adapter-agnostic; worth doing before the next milestone starts. C
  is the real structural fix and the only option that gets codex to
  Claude-parity latency; escalate if smoke-matrix runs show codex
  dragging a whole run past some acceptable budget.
- **Parked (low-priority):** B warmup, D long-running driver. B is
  measurable but tiny; D is blocked on upstream.

## Exit criteria for "codex captain performance is acceptable"

After options A + A.2:
- Turn 1 ≤ 20s for a trivial prompt (no `run_agent` dispatch). ✅
- Turn 2+ on the same thread ≤ 10s. ✅ (empirically ~5–10s).
- No envelope-parse fallback hits per turn under normal operation. ✅
  (schema-enforced path is primary).

Exit criteria MET. Codex is now usable as a captain. Claude-parity
latency remains a separate concern tracked via option C.
