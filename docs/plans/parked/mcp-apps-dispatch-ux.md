> **PARKED 2026-05-06.** Three rounds of codex architecture review
> (runs `31fe58a5`, `abe8fa74`, `325c38af` — all discarded)
> converged on a load-bearing problem: this plan was optimizing for
> token reduction (~3 captain inferences/run), but the user's
> actual goal is **insight into what dispatched agents are doing**.
> Token reduction was a constraint, not the objective.
>
> Why parked, not killed:
> - Insight delivery via iframe is **conditional on host MCP Apps
>   support** (Claude web/desktop, VS Code, Goose, Postman, MCPJam,
>   ChatGPT, Cursor — all confirmed; Claude Code CLI and Codex CLI
>   are unverified or absent from the matrix). For non-app hosts,
>   this plan delivers nothing the user can see.
> - The token-reduction claim ("~3 inferences/30-min run") was
>   wrong even on app hosts: the captain still wakes on every
>   `wait_for_change_ms` timeout, just with empty `events_tail`.
>   That's a per-token win, not a per-inference win.
> - Codex's round-1 finding "per-adapter event parsing should not
>   be killed globally — keep for non-app hosts" is now the
>   load-bearing direction. See
>   `docs/plans/completed/per-adapter-event-parsing.md`.
>
> **Revisit if**: a future need surfaces for rich, host-rendered
> live UI specifically (interactive controls, live charts, dense
> dashboards) that captain text can't deliver — and the user's
> primary host is on the supported MCP Apps client matrix.
>
> The plan body below is preserved verbatim as the architectural
> record + reference for the spec details we validated. Sections
> on protocol shape, capability negotiation, and the codex 60s
> collision are still useful inputs to other plans.

---

# MCP Apps for dispatch UX

**Status:** Proposed 2026-05-06; revised twice (v2 after codex run
`31fe58a5`, v3 after codex run `abe8fa74`). **Parked 2026-05-06**
after round-3 review (run `325c38af`) revealed the cost model was
wrong. Superseded by `docs/plans/completed/per-adapter-event-parsing.md`.
**Anchor commits:** `c697efb` (Phase 1 of long-poll-cost-tuning —
markdown initial response + prefixed/folded progress chunks);
`cc3bb09` (async-first dispatch).
**Related plan:** `long-poll-cost-tuning.md`. This plan supersedes
its sections 2 + 3 if the spike passes; section 4
(`wait_for_terminal_only`) is **promoted to Phase 2** here as a
load-bearing first-class server feature; section 1 is independent
and stays parked under its original criteria.
**Status-doc reconciliation:** if implemented, update
`docs/status/captain-flow-review-2026-04-29.md` (per AGENTS.md
rule that captain-flow changes reconcile that doc).

## Why this plan exists

After Phase 1 of `long-poll-cost-tuning` shipped, we still have a
concrete UX gap: during a dispatched run, the user's host
(Claude Code, codex CLI, etc.) shows the captain's terse narration
("Watching." / "Still working, no new output yet.") and not much
else. The captain isn't being lazy — it's reading raw subprocess
chunks from `events_tail` and paraphrasing per the skill body.

Two paths to richer visibility were on the table:

- **Per-adapter event parsing** — server parses codex /
  claude-code / gemini stream events into structured records;
  captain narrates them verbatim per poll. Linear token cost in
  run length: a 30-min run = ~30 captain inferences spent on
  orchestration relay, not judgment.
- **Host-rendered surface** — the host displays progress directly,
  bypassing the captain. Zero captain orchestration cost; tokens
  stay reserved for judgment moments (dispatch, merge decisions,
  summarization).

The user's stated constraint: **keep captain tokens for judgment,
not orchestration.** That rules out path 1 as a primary surface
*for app-capable hosts*. Path 2 via MCP Apps is the architecture
this plan pursues. Path 1 stays viable as a separate plan for
**non-app hosts** (Codex CLI today; possibly others) and is not
killed by this plan.

## v2 → v3 changelog (after second codex review)

The v2 plan got the protocol shape right (descriptor `_meta`,
static template, MIME, capability negotiation) but had five
load-bearing semantic issues codex flagged in run `abe8fa74`. All
five validated against the live spec + repo code; v3 addresses
each. Changes:

- **App-origin detection: switched from "ext-apps tags
  app-initiated calls" to dedicated app-only tools.** The spec
  doesn't expose an iframe-origin tag on `tools/call`;
  `app.callServerTool` is a transparent proxy. v2's
  "isAppInitiatedCall(extra)" was wishful thinking. **v3 adds
  two explicit app-only tools** registered with
  `_meta.ui.visibility: 'app-only'` (or the analogous spec-correct
  field — finalize during Spike A): `dashboard_poll` (returns
  run state + advances the heartbeat) and `dashboard_heartbeat`
  (lightweight ping, used between polls if the iframe wants to
  signal liveness without re-fetching). The captain doesn't see
  these tools; the iframe is the only caller. Origin = identity
  by construction.
- **`run_dashboard_active` is now a TTL'd timestamp, not a
  sticky boolean.** v2 set it on first iframe poll and left it
  on; if the iframe closed, the captain stayed quiet
  incorrectly. **v3 stores `lastDashboardHeartbeatAt: ISO-8601`
  on `RunStateV1`.** A run is "dashboard-active" when
  `now - lastDashboardHeartbeatAt < DASHBOARD_TTL_MS` (default
  60s; 2× expected poll interval). Captain reads this fresh from
  state on every `get_run_status` response. If iframe disappears,
  the timestamp goes stale within TTL and the captain reverts to
  narration. Also handle `ui/resource-teardown` if the host
  surfaces it (Spike A confirms).
- **`wait_for_terminal_only` no longer wakes on cursor-backlog.**
  v2 specified the long-poll would still return early if events
  past the cursor existed — defeating the cost goal because a
  captain behind cursor receives stream backlog and re-polls.
  **v3 specifies `wait_for_terminal_only=true` ignores
  cursor-backlog entirely**: the response's `events_tail` is
  always empty; `next_event_line` advances to the current head;
  the wait only resolves on a terminal event or the timeout.
- **`continue_run` does NOT attach `_meta.ui`.** v2's "latest
  invocation wins" mitigation isn't implementable since UI is
  descriptor-level, not per-result. **v3 attaches `_meta.ui` only
  to `run_agent`.** The original iframe persists across
  `continue_run` calls (it polls `dashboard_poll` with the same
  `run_id`); subsequent continues just advance run state, which
  the iframe sees on its next poll. Fresh `run_agent` calls
  spawn fresh iframes per run.
- **Codex 60s collision: hard fix, not soft mitigation.** v2
  pseudocode still had `wait_for_change_ms=60000` despite the
  collision. **v3 lowers `MAX_LONG_POLL_MS` from 60_000 to
  50_000** (10s buffer below Codex's 60s `tool_timeout_sec`
  default per [Codex MCP docs](https://developers.openai.com/codex/mcp))
  AND uses 30000 globally in the captain skill body. Even an
  errant captain explicitly passing 60000 gets clamped under
  Codex's deadline. Users who want longer polls raise their
  local `tool_timeout_sec` and tweak `CREW_MAX_LONG_POLL_MS`
  (env override added in Phase 2).
- **`host_supports_mcp_apps` checks MIME, not just key presence.**
  Spec example shows the client capability declares
  `mimeTypes: ["text/html;profile=mcp-app"]`. **v3 detection**:
  `caps?.extensions?.['io.modelcontextprotocol/ui']?.mimeTypes
  ?.includes('text/html;profile=mcp-app') === true`.
- **Boot stale-run scan uses persisted server epoch.** v2
  mentioned pid checks but `RunStateV1` has no pid field
  (`run-state.ts:52`). **v3 adds a `serverEpoch: string` field**
  to `RunStateV1` (uuid generated when `RunStateStore` is
  constructed) and persists it on each run. On boot, any run
  with status `running` and a `serverEpoch` != current is marked
  `error` with `"server restarted before run completed"`. No
  false-error of live runs (the epoch only changes on actual
  server restart).
- **`continue_run` while `running` is now blocked.** v2 didn't
  address this; codex correctly noted that two dispatches against
  the same `run_id` write to the same `events.log`. **v3 adds a
  guard at `serve.ts:269`-equivalent**: `continue_run` returns
  an error if the run's status is `running` (clear message:
  "wait for the current turn to terminate, or call cancel_run").
  This is a behavior change beyond dashboard concerns; flagged in
  Phase 1 with a note for tests that may exercise this state.
- **Iframe lifecycle in dashboard implementation: register
  `app.ontoolresult` before `app.connect()`.** Per the build
  guide, one-shot notifications can be missed if handlers attach
  after connect. v3 documents this in the Phase 4 dashboard
  spec.
- **Per-adapter event parsing fallback is now concrete.** v2 said
  "spin off as separate future plan if Spike A fails." **v3
  names the plan**: `docs/plans/completed/per-adapter-event-parsing.md`
  (to be created if Spike A fails) covering adapter event
  normalization (codex JSON event lines → structured records;
  claude-code stream-json similarly), captain narration rules,
  and tests.
- **Phase sizing rebased again** to reflect actual scope of
  app-only tools, TTL semantics, terminal-only backlog
  suppression, server-epoch model, and HTML bundling. v2 said
  ~6-7 days; v3 estimate ~9-10 days post-spike.

Discrepancies / nuances we flagged back to codex on round 2 and
their resolutions in v3:
- v2 added one finding codex didn't flag in round 1 (capability
  detection should be per-connection, not per-server). v3 keeps
  this — `host_supports_mcp_apps` is read off
  `client.getClientCapabilities()` per-connection.
- Codex's round-2 finding on `_meta.ui.visibility` is treated as
  spec-supported pending Spike A confirmation. If the spike shows
  visibility scoping isn't supported in our target host, fall
  back to per-run token approach (token in result `_meta`, not
  result content, validated by the app-only tool).

## What we learned during research

The research is documented in chat history; the load-bearing
findings (now updated to reflect validation):

1. **Claude Code does NOT render `notifications/progress`.**
   Confirmed via [Issue #4157](https://github.com/anthropics/claude-code/issues/4157)
   and [Issue #3174](https://github.com/anthropics/claude-code/issues/3174).
   Both closed-not-planned. Phase 1's #5 work (rich progress
   payloads) is invisible in Claude Code; ships but doesn't move
   the UX needle there. Other hosts (Cursor, raw MCP debug
   clients) may render. We keep the work; we don't double down.

2. **MCP Apps standardized 2026-01-26** as the host-rendered UI
   surface MCP defines. Mechanism:
   - Server registers a `ui://` resource containing self-contained
     HTML+JS+CSS, MIME `text/html;profile=mcp-app`.
   - Server registers tools with `_meta.ui.resourceUri` in the
     tool *descriptor* (config object on `server.registerTool`,
     not in the tool's return value).
   - Server declares
     `capabilities.extensions["io.modelcontextprotocol/ui"]` in
     the `initialize` response. Client-side declares the same
     extension with `mimeTypes: ["text/html;profile=mcp-app"]`.
   - Host fetches the HTML and renders inline in a sandboxed
     iframe.
   - Bidirectional: iframe ↔ host via JSON-RPC over `postMessage`.
     iframe receives the tool result via `app.ontoolresult`,
     can call MCP tools via `app.callServerTool({ name, arguments })`,
     send messages, update model context.
   - Hosts that don't support apps fall back to `content[]` text
     — backward compatible by spec design.

3. **Supported clients** (per [client-matrix](https://modelcontextprotocol.io/extensions/client-matrix)):
   Claude (web), Claude Desktop, VS Code GitHub Copilot, Goose,
   Postman, MCPJam, ChatGPT, Cursor. **Claude Code (CLI) is NOT
   listed.** This remains the single biggest unknown gating this
   plan. Spike A confirms or refutes.

4. **Codex CLI is NOT on the supported list.** Per
   [Codex MCP docs](https://developers.openai.com/codex/mcp),
   transports are STDIO and Streamable HTTP. Tool timeout default:
   60s. Apps / progress / resources support is not documented
   either way — assume graceful fallback to text content per
   the spec, but Spike B confirms.

## Proposed architecture

### Tool descriptors

`run_agent` gets `_meta.ui.resourceUri` in its `server.registerTool`
config. **`continue_run` does NOT** — the original `run_agent`'s
iframe persists and the same `run_id` polls for state; new
continues just advance state for that iframe to render.

```ts
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE }
  from '@modelcontextprotocol/ext-apps/server';

registerAppTool(server, 'run_agent', {
  title: 'Dispatch a subagent',
  description: RUN_AGENT_DESCRIPTION,
  inputSchema: runAgentInputSchema.shape,
  _meta: { ui: { resourceUri: 'ui://crew/run-dashboard' } },
}, async (args, extra) => { /* existing handler body */ });
```

### App-only tools (the iframe's API surface)

Two new tools registered with `_meta.ui` so they appear in the
app's tool catalog but not in the captain's `tools/list` (subject
to spec-confirmation in Spike A):

- `dashboard_poll(run_id, since_event_line?)` — returns the
  same payload as `get_run_status` but with two side effects:
  (1) updates `lastDashboardHeartbeatAt` on the run; (2) bumps
  the heartbeat regardless of whether new events arrived. The
  iframe calls this in a tight loop.
- `dashboard_heartbeat(run_id)` — lightweight ping when the
  iframe wants to signal liveness without a full poll (e.g., on
  user focus events). Returns `{ ok: true }`.

Internally both share the same heartbeat-update path; the split
is purely for poll-payload reasons.

If Spike A reveals that visibility scoping isn't host-supported
in our target host, fall back to **per-run token**: the iframe
receives a `dashboard_token` in the initial tool result's
`_meta` field (NOT in `content`, so it doesn't enter the
captain's model context); the iframe includes the token in
`dashboard_poll` arguments; the server validates token-to-run
mapping. This is more code but robust against visibility
ambiguity.

### The `ui://crew/run-dashboard` resource

A self-contained HTML page registered once. Bundled JS+CSS via
`vite-plugin-singlefile` (per the official build guide); zero
external fetches at runtime so default deny-by-default CSP works
without `_meta.ui.csp` config. Behavior:

- **Critical ordering**: register `app.ontoolresult` BEFORE
  calling `app.connect()`, per the build guide warning that
  one-shot notifications can be missed otherwise.
- On `app.ontoolresult`: extract `run_id`, `agent_id`,
  `worktree_path` from the tool result.
- Self-polls `dashboard_poll` (NOT `get_run_status` — that's the
  captain's tool) at ~10s intervals. Each call advances the
  heartbeat AND returns events.
- Renders in a fixed inline panel:
  - Header: agent id (from envelope), run id (short), worktree
    path, elapsed time, terminal status banner.
  - Live event list: `events_tail` lines as they arrive,
    prefixed client-side with `[${agent_id}]` (since events.log
    itself stays raw).
  - Files-changed list (on terminal).
  - Final summary block (on terminal).
  - Cancel button (calls `cancel_run` via `app.callServerTool` —
    `cancel_run` is a captain-visible tool; this is fine because
    the captain may also want it. It's NOT app-only.).

### Server-side capability negotiation

In `buildCrewMcpServer` at `serve.ts:190`:

```ts
const server = new McpServer(
  { name: 'crew', version: SERVE_VERSION },
  {
    capabilities: {
      // Existing capabilities...
      extensions: {
        'io.modelcontextprotocol/ui': {},  // server side declares support
      },
    },
  },
);
```

After session init, per-connection capability detection:

```ts
const caps = server.server.getClientCapabilities();
const uiCap = caps?.extensions?.['io.modelcontextprotocol/ui'];
const hostSupportsMcpApps =
  uiCap?.mimeTypes?.includes('text/html;profile=mcp-app') === true;
```

This is a per-connection static fact (not per-server). It's
separate from `run_dashboard_active`, which is the per-run
heartbeat below.

### Per-run dashboard heartbeat (TTL'd)

- `RunStateV1` gains `lastDashboardHeartbeatAt?: string`
  (ISO-8601 timestamp). Optional; absent when no iframe ever
  polled.
- On every `dashboard_poll` and `dashboard_heartbeat` call:
  `runStateStore.touchDashboard(run_id)` writes
  `lastDashboardHeartbeatAt = new Date().toISOString()`.
- On every `get_run_status` response (the captain's call), the
  server computes:

  ```ts
  const last = state.lastDashboardHeartbeatAt;
  const run_dashboard_active =
    last !== undefined &&
    Date.now() - new Date(last).getTime() < DASHBOARD_TTL_MS;
  ```

  with `DASHBOARD_TTL_MS = 60_000` (2× the iframe's 30s poll
  interval — adjust based on Spike A measured cadence).
- On terminal status: clear `lastDashboardHeartbeatAt` so a
  resumed run starts fresh.
- If the host surfaces `ui/resource-teardown` (TBD per Spike A),
  the iframe explicitly tells the host on close; we'd add a
  `dashboard_close` tool the iframe calls in its teardown
  handler. Falls back to TTL if not.

### `wait_for_terminal_only` (first-class server feature)

Added to `getRunStatusInputSchema` at `get-run-status.ts:25`:

```ts
wait_for_terminal_only: z.boolean().optional().describe(
  'When true, the long-poll only wakes on terminal events. ' +
  'Stream events do not wake the call. Cursor-backlog is ' +
  'ignored — events_tail is always empty in the response and ' +
  'next_event_line advances to the current head. Used by hosts ' +
  'with an out-of-band progress channel (MCP Apps iframe) and ' +
  'only need to know *when* the run finishes.',
),
```

In `serve.ts` long-poll path (~497-516), when
`wait_for_terminal_only === true`:

1. Skip the "already-have-data" check at `serve.ts:497-501`.
   That check exists to short-circuit the long-poll on backlog;
   under terminal-only, backlog is irrelevant.
2. Register only the three terminal listeners in
   `waitForRunChange`, not the `run:stream` listener.
3. After resolution: build response with `events_tail: []` and
   `next_event_line: <current head>` regardless of the input
   cursor.

Tests: long-poll with `wait_for_terminal_only` does not wake on
stream events; does wake on terminal events; does NOT wake on
fresh-events-past-cursor; advances cursor to head.

### `MAX_LONG_POLL_MS` cap lowered + env override

- `serve.ts:74`: `MAX_LONG_POLL_MS` lowered from `60_000` to
  `50_000` to give 10s margin under Codex CLI's 60s
  `tool_timeout_sec` default.
- New env var `CREW_MAX_LONG_POLL_MS` overrides the default if
  set. Users with a higher local Codex `tool_timeout_sec` can
  match it.
- Skill body uses `wait_for_change_ms=30000` everywhere (no
  60000 anywhere). Even errant 60000 calls clamp to 50000 < 60s.

### `continue_run` while `running`: blocked

Add a guard in the `continue_run` handler at `serve.ts:269`-equivalent:

```ts
if (state.status === 'running') {
  return errorContent(
    `Run "${args.run_id}" is currently running (turn in flight). ` +
    'Wait for the current turn to reach a terminal state, or call ' +
    'cancel_run, before continuing.',
  );
}
```

This is a behavior change beyond dashboard concerns; flagged
explicitly. Existing tests that may dispatch a `continue_run`
without waiting need to be updated to poll terminal first
(matches today's skill body which already requires that).

### Captain skill body update

```
Dispatch.

If get_run_status returns run_dashboard_active === true:
  Long-poll get_run_status with wait_for_terminal_only=true,
  wait_for_change_ms=30000. Stay quiet during the wait —
  the iframe is the visible UX. On terminal: write a short
  summary (latest prompt's summary).

Else:
  Today's behavior. Long-poll wait_for_change_ms=30000,
  render events_tail per poll-return. Skill-body wording
  unchanged.
```

The captain reads `run_dashboard_active`, which is computed
fresh per response from the TTL'd heartbeat — not a sticky
boolean. Iframe closes → heartbeat goes stale within TTL →
captain reverts to narration. Bias toward visibility on
ambiguity.

### Token cost analysis

| Host | Inferences/30-min run | Notes |
|---|---|---|
| App host with active dashboard | ~3 | dispatch + terminal poll + summary |
| App host (capability present, dashboard didn't load or closed) | ~30 (status quo) | TTL stale; falls through to narrate branch |
| Codex CLI (no apps) | ~30 (status quo) | no change |

The Codex CLI case stays where it is today; we don't make it
worse. The app-host case improves dramatically when the iframe
is actually rendering and polling.

## What this drops from prior plans

If the spike passes:

- **Per-adapter event parsing** is **kept on the table for
  non-app hosts** as a separate future plan
  (`docs/plans/completed/per-adapter-event-parsing.md`, to be
  created if and only if Spike A fails or Codex CLI users
  surface a need). Scope: codex JSON event lines → structured
  records; claude-code stream-json similarly; gemini
  best-effort; captain narration rules; tests. Not deferred
  indefinitely; not killed.
- **#2 (skill-body nudge to stay quiet)** from
  `long-poll-cost-tuning.md` is **subsumed by this plan's skill
  body update** and ships as part of it. It becomes
  per-run-conditional rather than blanket.
- **#3 (`host_streams_progress` diagnostic)** from the same plan
  is **renamed and split into `host_supports_mcp_apps` (per-conn
  capability) + `run_dashboard_active` (per-run TTL'd heartbeat)**;
  ships as part of this plan.
- **#4 (`wait_for_terminal_only`)** from the same plan is
  **promoted to a load-bearing first-class server feature** and
  ships in Phase 2 of this plan with backlog-suppression
  semantics specified.
- **#5 (rich progress payload)** that we shipped in c697efb is
  retained for non-app hosts that DO render
  `notifications/progress` (uncertain which hosts beyond Cursor;
  verify if anyone reports). Not removed; not extended.

## Risks and unknowns

| Risk | Severity | Mitigation |
|---|---|---|
| Claude Code CLI not on official client matrix; iframe rendering unverified | **High — gating** | Spike A. If fails, fall back to per-adapter parsing + skill body for everyone (separate plan). |
| `_meta.ui.visibility` (or analogous app-only tool scoping) not supported in target host | **High** | Spike A includes a probe. Fallback: per-run dashboard token (in result `_meta`, not content). |
| Codex CLI 60s `tool_timeout_sec` deadline | **High** | `MAX_LONG_POLL_MS` lowered to 50s; skill body uses 30s; env override for users on raised timeouts. |
| iframe not actually rendering despite `host_supports_mcp_apps` | Medium | TTL'd `run_dashboard_active` reverts captain to narration if heartbeat stale within 60s. |
| Iframe close without `ui/resource-teardown` signal | Medium | TTL handles this gracefully; explicit `dashboard_close` tool added if spike confirms teardown signal exists. |
| Server restart leaves persisted runs stuck `running` | Medium | `serverEpoch` field on `RunStateV1`; boot-time scan marks epoch-mismatched `running` runs as `error`. |
| `continue_run` while `running` writes to same events.log | **Resolved in v3** | Server-side guard rejects continue_run on `running` status. |
| postMessage stream pollution / lifecycle handling | Low | Use `@modelcontextprotocol/ext-apps`'s `App` class on iframe side — hardening already implemented. |
| CSP `frameDomains` ignored ([#40](https://github.com/anthropics/claude-ai-mcp/issues/40)) | Low | Self-contained iframe (singlefile bundle); no external fetches. |
| postMessage auth pollution ([#47](https://github.com/anthropics/claude-ai-mcp/issues/47)) | Low | `App` class handles. |
| Multi-iframe fan-out (multi-agent dispatch) | Low | Each run has its own listeners; `dashboard_poll` from each iframe touches its own heartbeat. No interference. |
| Multiple host connections (HTTP/SSE arrives later; today stdio is 1:1) | Low | `host_supports_mcp_apps` is per-connection from day one. `run_dashboard_active` is per-run timestamp, connection-agnostic. |
| Status-doc reconciliation per AGENTS.md | Nit | Update `docs/status/captain-flow-review-2026-04-29.md` as part of Phase 6. |

## Implementation plan

Sized in days assuming one engineer; rough order-of-magnitude.
v3 numbers reflect codex's round-2 sizing pushback.

### Phase 0 — spike (~1 day, gating)

**Spike A — app-initiated tools/call from a Claude Code CLI
iframe.** Throwaway server using
`@modelcontextprotocol/ext-apps/server`. Register one tool
(`hello_world`) with `_meta.ui.resourceUri` on the descriptor.
Register one resource at `ui://hello/world` with
`text/html;profile=mcp-app`, serving a tiny HTML page that:

1. Calls `app.connect()` (after registering `app.ontoolresult`)
   and verifies the tool result is delivered to the iframe.
2. Calls `app.callServerTool({ name: 'hello_world', arguments:
   {} })` on a button click. Verify the host proxies the call.
3. Calls the same in `setInterval` 5x to verify repeated polling
   works without per-call host approval prompts.
4. Probes `app.getHostCapabilities()?.serverTools` to confirm
   how the host exposes server-tool inventory to the iframe.
5. Registers a second tool with `_meta.ui.visibility: 'app-only'`
   (or analogous spec-correct field). Verify it appears in app's
   tool list but NOT in `tools/list` for the captain's
   connection.
6. Tears down the iframe (close the conversation or whatever
   surfaces "this iframe is gone"). Verify whether the host
   sends a `ui/resource-teardown` message or equivalent that the
   server can listen for.
7. Stream-events vs terminal-only test: inside the spike,
   simulate a long-poll where stream events fire before terminal.
   Prove app polling sees them and captain `wait_for_terminal_only`
   polling does not wake or receive backlog.

Verify, in this order:
1. Tool registration with `_meta.ui` succeeds.
2. Server declares
   `capabilities.extensions['io.modelcontextprotocol/ui']`
   without errors.
3. Client capability includes `mimeTypes: ['text/html;profile=mcp-app']`.
4. Iframe renders inline.
5. `app.ontoolresult` fires.
6. `app.callServerTool` round-trips.
7. Repeated polling works without host friction.
8. App-only tool visibility scoping works (or doesn't — informs
   token fallback).
9. Teardown signal exists or doesn't (informs `dashboard_close`
   vs TTL-only).
10. Terminal-only semantics produce the expected behavior in a
    full proxy round-trip.

**Spike B — Codex CLI graceful fallback.** Same throwaway
server. Run codex CLI as captain. Verify:
1. Tool result with descriptor `_meta.ui.resourceUri` doesn't
   error.
2. Markdown text in `content[]` displays as today.
3. App-only tools (if defined via visibility) are not exposed
   to codex's captain (they shouldn't be; visibility scoping
   should hide them).
4. Codex's `tool_timeout_sec` is respected when our long-poll
   uses 30s vs 50s clamp.

**Decision gate:**
- All Spike A boxes ticked → proceed to Phase 1.
- App-only visibility doesn't work but iframe + `app.callServerTool`
  do → switch to per-run token approach in Phase 1.
- Iframe renders but `app.callServerTool` doesn't proxy → re-scope
  to a non-polling iframe that shows static state from
  `app.ontoolresult` only (much smaller win, but still a win).
- Iframe doesn't render at all → abandon this plan, fall back to
  per-adapter event parsing + skill body for everyone (write
  `per-adapter-event-parsing.md`).

### Phase 1 — capability + descriptor wiring (~2 days, gated on Spike A)

- Add `@modelcontextprotocol/ext-apps` to `package.json`. Pin to
  the version we spiked on.
- Update `McpServer` construction at `serve.ts:190` to declare
  `extensions: { 'io.modelcontextprotocol/ui': {} }`.
- Use `registerAppTool` for `run_agent` at `serve.ts:214`.
  **Do NOT add `_meta.ui` to `continue_run`** — the original
  iframe persists.
- Register `dashboard_poll` and `dashboard_heartbeat` as app-only
  tools (or with token validation, depending on Spike A
  outcome).
- Register `ui://crew/run-dashboard` as a resource via
  `registerAppResource`. Resource handler reads the bundled HTML
  from disk and returns it with MIME `text/html;profile=mcp-app`.
- Add `continue_run` guard: error when run is `running`.
- Tests: serve.test.ts for the new resource registration,
  capability declaration, descriptor `_meta` shape, MIME-aware
  detection helper, app-tool visibility (or token validation),
  continue_run-while-running rejection.

### Phase 2 — `wait_for_terminal_only` + cap lowering (~2 days)

- Add `wait_for_terminal_only: z.boolean().optional()` to
  `getRunStatusInputSchema` at `get-run-status.ts:25`.
- In `serve.ts` long-poll path:
  - Skip the "already-have-data" check when `wait_for_terminal_only`.
  - Register only the three terminal listeners in
    `waitForRunChange`, not the `run:stream` listener.
  - After resolution: build response with `events_tail: []` and
    `next_event_line: <current head>`.
- Lower `MAX_LONG_POLL_MS` from 60_000 to 50_000 at `serve.ts:74`.
- Add `CREW_MAX_LONG_POLL_MS` env override.
- Tests:
  - Long-poll with `wait_for_terminal_only` does not wake on
    stream events.
  - Wakes on terminal events.
  - Does NOT wake on fresh-events-past-cursor.
  - Returns empty `events_tail` and head cursor.
  - Cap lowering doesn't regress existing tests.
  - Env override applies.

### Phase 3 — host detection + heartbeat with TTL (~2 days)

- Read `client.getClientCapabilities().extensions['io.modelcontextprotocol/ui']`
  with MIME-aware check.
- Set per-connection `hostSupportsMcpApps`.
- `RunStateV1` gains `lastDashboardHeartbeatAt?: string` and
  `serverEpoch: string`.
- `RunStateStore.touchDashboard(run_id)` writes the timestamp.
- `get_run_status` response computes `run_dashboard_active`
  fresh from the TTL.
- `dashboard_poll` and `dashboard_heartbeat` handlers (or token
  validation logic) call `touchDashboard`.
- Boot-time epoch scan marks epoch-mismatched `running` runs
  as `error`.
- Optional: `dashboard_close` tool if Spike A confirmed teardown
  signal availability.
- Tests:
  - Capability detection both directions; MIME-aware.
  - Heartbeat sets/clears with TTL; stale within 60s.
  - `serverEpoch` mismatch produces `error` status on boot.
  - `dashboard_poll` advances heartbeat AND returns events.
  - `continue_run` against an active dashboard inherits state.
  - Multiple iframes (multi-agent fan-out) don't interfere.

### Phase 4 — HTML dashboard + bundling (~1.5 days)

- Add a tiny build step using `vite-plugin-singlefile` per the
  build guide. Source under `src/dashboard/`; output to
  `dist/dashboard/run-dashboard.html`.
- HTML+JS+CSS rendering the panel described under "The
  `ui://crew/run-dashboard` resource". Targeting < 100 KB
  bundled.
- Critical: `app.ontoolresult` registered BEFORE `app.connect()`.
- Cancel button calling `cancel_run`.
- Manual QA in Claude Code CLI: verify rendering, polling,
  terminal banner, cancel, teardown.

### Phase 5 — captain skill body (~half-day)

- Update `skills/crew-captain.body.md` polling lifecycle section
  to branch on `run_dashboard_active`.
- For `true` branch: drop per-poll `events_tail` rendering;
  long-poll with `wait_for_terminal_only=true,
  wait_for_change_ms=30000`; narrate only on terminal.
- For `false` branch: today's behavior unchanged, also using
  `wait_for_change_ms=30000` (no 60000 anywhere).
- Update existing skill-body tests if any cover the dispatch
  lifecycle text.

### Phase 6 — cleanup, plan re-anchor, status doc reconciliation (~half-day)

- Update `long-poll-cost-tuning.md` to mark sections 2 + 3 + 4
  as superseded by this plan. Section 1 stays parked under
  original criteria.
- Update `docs/status/captain-flow-review-2026-04-29.md` per
  AGENTS.md rule.
- Surface `events.log` path in `RunEnvelope` for power users on
  any host who want to `tail -f` directly. (Independent of MCP
  Apps; cheap; ships in this plan since it's the same diff
  area.)

**Total realistic effort: ~9-10 days post-spike.**

## Decision criteria when we revisit

This plan's go/no-go is set entirely by Spike A:

- **All boxes ticked** → ship Phases 1–6.
- **App-only visibility doesn't work** → switch to token approach
  in Phase 1; rest of plan unchanged.
- **iframe renders but app-initiated calls don't proxy** →
  re-scope to a static-result iframe (much smaller win); defer
  full plan.
- **iframe doesn't render at all** → drop this plan. Create
  `per-adapter-event-parsing.md` for non-app hosts.

## Out of scope

- Per-adapter event parsing for non-app hosts. Tracked as a
  named future plan (`per-adapter-event-parsing.md`); created
  if and only if needed.
- An embedded HTTP server / browser dashboard. MCP Apps covers
  the same use case if the spike passes; if it doesn't, we
  evaluate separately rather than building parallel surfaces.
- A general MCP server-push channel for hosts that don't expose
  one. Resources, progress notifications, and apps are the
  protocol primitives; we work within those.
- Refactoring `RunEnvelope` shape beyond the optional
  `events.log`-path addition. Existing fields stay; backward
  compat preserved.
- Replacing the long-poll `get_run_status` primitive with
  something else. The long-poll model is the durable
  architecture; this plan layers on top.

## Sources

Primary spec (verified verbatim during validation, rounds 1 and 2):

- [MCP Apps Overview](https://modelcontextprotocol.io/extensions/apps/overview)
- [MCP Apps Build Guide](https://modelcontextprotocol.io/extensions/apps/build)
- [MCP Extensions Overview (capability negotiation)](https://modelcontextprotocol.io/extensions/overview)
- [Extension Support Matrix (clients)](https://modelcontextprotocol.io/extensions/client-matrix)
- [MCP Apps blog post — 2026-01-26](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)

Known issues:

- [Claude.ai MCP — Issue #40 (CSP frameDomains ignored)](https://github.com/anthropics/claude-ai-mcp/issues/40)
- [Claude.ai MCP — Issue #47 (postMessage auth injection)](https://github.com/anthropics/claude-ai-mcp/issues/47)
- [Claude Code — Issue #4157 (progress notifications)](https://github.com/anthropics/claude-code/issues/4157)
- [Claude Code — Issue #3174 (notifications/message)](https://github.com/anthropics/claude-code/issues/3174)

Codex CLI:

- [Codex CLI MCP docs](https://developers.openai.com/codex/mcp)
- [Codex — Issue #4956 (Expose MCP resources to Codex agents)](https://github.com/openai/codex/issues/4956)

Reviews and prior plans:

- Codex review of v1 (run `31fe58a5`, 2026-05-06; discarded).
- Codex review of v2 (run `abe8fa74`, 2026-05-06; discarded).
- `docs/plans/parked/long-poll-cost-tuning.md`
