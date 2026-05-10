# Competitive analysis: MCO and CAO vs crew-mcp

> Date: 2026-05-10. Sources: shallow clones of `mco-org/mco` (HEAD `1d4a568`) and
> `awslabs/cli-agent-orchestrator` (HEAD `86f5878`), plus a fresh audit of
> crew-mcp's current architecture. This file is meant to be expanded as we pick
> features to adopt — start with section 5 ("Adoption shortlist").

## 1. Why this exists

A web search surfaced several orchestration tools we hadn't been tracking. Two
of them — **MCO** (mco-org/mco, 336★) and **CAO** (awslabs/cli-agent-orchestrator,
559★) — overlap significantly with crew-mcp's product description. AWS Labs is
shipping CAO; MCO ships on both npm and PyPI with a daily release cadence. We
need an honest read on what they're doing well and what's worth borrowing.

## 2. Side-by-side architectural shape

| Dimension | crew-mcp | MCO | CAO |
|---|---|---|---|
| Runtime | TS, MCP-only (no CLI mode for runs) | Python CLI primary; MCP server is a thin 5-tool slice | Python FastAPI server + 2 MCP servers (in-session, ops) |
| Worker spawn | `execa` headless CLI subprocess | `subprocess.Popen` headless + file-redirected I/O | `libtmux` session/window with full PTY |
| Dispatch model | Async-first, captain returns instantly | Wait-all parallel via `ThreadPoolExecutor`; chain mode optional | `handoff` (sync, blocks supervisor) + `assign` (async) |
| Isolation | Per-run **git worktree** | None (shared cwd, races possible) | tmux session only (shared filesystem, races possible) |
| Inter-agent comms | None (captain mediates everything) | None (single supervisor, fan-out only) | **`send_message` + inbox + idle-delivery watchdog** |
| Cross-provider | 5 adapters | 6 adapters + custom + Ollama | 8 adapters |
| Aggregation | None (sequential review pattern) | **Consensus engine + debate + divide-files/dimensions** | None (pairwise handoff only) |
| Human attach mid-run | tail file (read-only) | tail file (read-only) | **`tmux attach` or browser PTY (read-write)** |
| Survives orchestrator crash | No (orphan subprocess) | No | **Yes (tmux is the durable layer)** |
| Receipts/observability | events.log + state.json | per-provider + per-run JSON, error taxonomy enum, SARIF, markdown-PR | SQLite DB, plugin event bus, per-terminal log |
| Captain skill | One ~350-line markdown | One CLI-discovery skill | Supervisor profile + protocol skill |
| Stars / activity | (private) | 336★, v0.9.1, daily commits | 559★, AWS Labs, daily commits |

## 3. CAO's tmux model — what's actually transferable

**Why CAO uses tmux** isn't really "isolation" — it's that every CLI they
support (Claude Code, Kiro, Codex, Gemini) is a TUI that misbehaves without a
real PTY, and they want **human attach mid-run** + **survival across server
restarts**.

We don't share their first problem. crew-mcp invokes Claude/Codex/Gemini in
their headless modes (`claude -p`, `codex exec`, `gemini -o stream-json`) —
there's no TUI to render and no PTY requirement. So adopting tmux **wholesale**
would be high cost for low value: we'd be retrofitting infrastructure to solve
a problem we don't have.

But the two side benefits are real and currently unmet:

1. **Crash survival.** Today, if `crew-mcp serve` dies, every in-flight `execa`
   child becomes an orphan with no recovery path. CAO's design — tmux daemon
   owns the worker, server is stateless and reconstructs from DB — is durable.
   See `clients/cli-agent-orchestrator/providers/manager.py:142-163` (lazy
   rehydrate from SQLite).
2. **Human attach mid-run.** Today, `crew-tail://` opens a *read-only* tail. A
   user who notices a worker going off the rails has no recourse but to cancel
   + restart. CAO lets you `tmux attach`, type `Ctrl-C`, type a follow-up,
   type `Esc` to interrupt — full live steering.

### CAO tmux details worth knowing if/when we adopt selectively

- **`pipe-pane` for log capture, `capture-pane` for state checks** (`clients/tmux.py:533`, `:390`). Two separate paths because TUIs paint frames the raw byte stream doesn't reflect. Their primary correctness-fragility category is regex-anchored idle detection (`providers/claude_code.py:293-385` has 90 lines of comments on the `❯` prompt race).
- **Bracketed-paste `send-keys`** with 300ms post-paste sleep (`tmux.py:207-281`). Non-obvious and hard-won. Plain `send-keys` was too slow and Ink-based TUIs swallow Enter sent too fast. `paste_enter_count` per provider varies — base default is 2.
- **One window per worker, one session per "logical session"** — clean model, no split-pane complexity.
- **`CAO_TERMINAL_ID` env var as the only routing key.** Every MCP tool reads it to identify caller. Elegant.
- **Browser PTY bridge** (`api/main.py:740-855`) — `pty.openpty()` + `tmux attach` + WebSocket. Cool but localhost-only and adds significant surface area.
- **`CLAUDE*`/`CODEX_` env strip** (`tmux.py:132-145`) before spawning, to prevent nested-session detection refusing to start. We may need similar hygiene; MCO does the same with `CLAUDECODE`.
- **Explicit 220x50 size override** (`tmux.py:155`) to dodge a kiro-cli 2.1.x TUI v2 blank-on-resize bug (issue #216).

## 4. MCO highlights worth knowing

### Aggregation engine (the part we don't have)

- **Findings dedup key**: `sha256(category||title||file||line||symbol)` with whitespace collapse + lowercase (`review_engine.py:958-971`). Identical findings across providers collapse with `detected_by = sorted set`.
- **Consensus scoring** (`:981-1013`):
  - `agreement_ratio = detected_by_count / total_providers_ran`
  - `consensus_score = round(agreement_ratio * max_confidence, 4)`
  - `consensus_level`: `unverified` if 1 detector, `confirmed` if ratio ≥ 0.5, else `needs-verification`.
- **Debate mode** (`--debate`): every provider gets a prompt listing all merged findings and votes `AGREE | DISAGREE | REFINE` per finding. Votes parsed via regex, applied to findings before final ranking.
- **Divide modes** (mutually exclusive with debate):
  - `files` — round-robin distribute discovered files across providers; each provider sees "review only these assigned files" prompt prefix.
  - `dimensions` — fixed list `("security", "performance", "maintainability", "correctness", "error-handling")` assigned by index.
- **Synthesis pass** (`--synthesize`): picks one provider, gives it JSON of all provider summaries (truncated to 1200 chars each) plus top-40 merged findings, asks for markdown with exactly three headings: `## Consensus`, `## Divergence`, `## Recommended Next Steps`. Capped at 220 words.

### Idle-byte stall detection

`review_engine.py:1631-1645`: each poll snapshots `(stdout_size, stderr_size)`;
if unchanged for `provider_stall_timeout` seconds, cancel via `os.killpg(SIGTERM)`
then `SIGKILL` 200ms later. README brand: "Progress-driven timeouts — agents
run freely until completion; cancel only when output goes idle." This is
strictly better than wall-clock or no-timeout.

### Error taxonomy

`runtime/errors.py` enum drives the retry policy: `RETRYABLE_TIMEOUT`,
`RETRYABLE_RATE_LIMIT`, `RETRYABLE_TRANSIENT_NETWORK`, `NORMALIZATION_ERROR`,
`NON_RETRYABLE_*`. Used everywhere. State machine in `runtime/orchestrator.py:18-37`:
DRAFT→QUEUED→DISPATCHED→RUNNING→{RETRYING|AGGREGATING|FAILED|CANCELLED|EXPIRED|PARTIAL_SUCCESS}→COMPLETED|PARTIAL_SUCCESS|FAILED.

### Receipts

Per task: `summary.md`, `decision.md`, `findings.json`, `run.json`, plus
per-provider `<provider>.json` capturing `{provider, task_id, run_id, pid,
command, started_at, completed_at, exit_code, success, error_kind, warnings,
stdout_path, stderr_path}`. Strict-contract gate: exit codes 0=PASS, 2=FAIL,
3=INCONCLUSIVE.

### ACP transport (alternative protocol)

`runtime/acp/adapter.py` speaks JSON-RPC over stdio with agents that support
`--acp` (Claude Code, Codex, Gemini). Bidirectional — agents can call back to
read/write files and run terminal commands. Higher fidelity than stdout parsing.

## 5. Adoption shortlist (prioritized)

### Tier 1 — High value, well-scoped

#### 5.1 `send_message` + inbox model (from CAO)

**Why:** A captain-mediated comm graph is fine for trees, but ugly for
"Claude, ask Codex what it thinks of your output and respond." Adding direct
worker-to-worker comms unlocks more interesting playbooks.

**Sketch:**
- New tool: `send_message({target_run_id, message, from_run_id?})` queues
  message into recipient's inbox.
- New sidecar dir: `~/.crew/runs/<runId>/inbox/<msgId>.json`.
- Delivery: next time recipient calls `continue_run`, prepend pending inbox
  messages to the prompt (or surface as a separate stanza).
- No tmux needed (we're not delivering into a live TUI).

**Estimate:** 1-2 days.

**Open questions:**
- Should the captain be aware of inter-worker messages? (probably yes, via
  events.log)
- Cycle prevention?
- Schema for the inbox message (sender, timestamp, kind=question|answer|broadcast)?

#### 5.2 Idle-byte stall timeout (from MCO)

**Why:** Currently no smart timeout. Wall-clock timeouts are crude; idle-byte
keeps slow-but-progressing runs alive while killing actually-stuck ones.

**Sketch:**
- During a run, sample the events.log size every N seconds.
- If unchanged for `stall_timeout` seconds (default 120?), abort via existing
  AbortSignal path.
- Surface as warning in run state.

**Estimate:** ½ day.

**Open questions:**
- Default timeout per provider? (Claude tends to think longer than Codex)
- Should idle-byte be configurable per `run_agent` call?

#### 5.3 Structured receipts (from MCO)

**Why:** Today we have events.log + state.json. MCO's per-task `summary.md`,
`decision.md`, `findings.json`, `run.json` is more useful for CI gating,
replay, and handoff to external tooling.

**Sketch:**
- On terminal, write structured artifacts alongside the existing files.
- `summary.md` = run summary in markdown.
- `findings.json` = parsed structured findings (only for review-style runs).
- `run.json` = receipt with timing, command, exit code, error_kind.

**Estimate:** 1 day for schema + writers; another day if we add a
`crew-mcp report <run_id>` command.

#### 5.4 `run_panel` with consensus/debate/divide (from MCO)

**Why:** "Panel review" is currently sequential `run_agent` + `continue_run`.
MCO's parallel fan-out + dedup + scoring is genuinely better for parallel
multi-agent code review.

**Sketch:**
- New tool: `run_panel({agents: [...], prompt, mode: 'consensus'|'debate'|'divide-files'|'divide-dimensions', synthesize_with?})`.
- Spawn all agents in parallel (each in its own worktree).
- Aggregation logic per mode (port MCO's dedup + scoring; debate as a
  follow-up `continue_run` per agent).
- Optional synthesis pass via a designated agent.

**Estimate:** 4-6 days. Aggregation is mechanical but scoring tuning matters.

**Open questions:**
- Worktree story for panel runs — N worktrees off the same base?
- How do panel results merge? (Probably they don't — panels are review/eval,
  not implementers.)
- Findings schema needs to be a real type, not just text.

### Tier 2 — Higher cost, real but optional

#### 5.5 Optional `interactive: true` mode that runs the worker in tmux

**Why:** Crash survival + live human steering. Both are currently unmet, both
matter for long-running work.

**Sketch:**
- `run_agent({..., interactive: true})` spawns the CLI in interactive mode
  inside a tmux session named `crew-<runId>`.
- `pipe-pane` to events.log preserves the current contract.
- New CLI: `crew-mcp attach <run_id>` → `tmux attach -t crew-<runId>`.
- Worker survives `crew-mcp serve` restart; on serve startup, reconstruct
  in-flight runs from disk + tmux session enumeration.

**Estimate:** 1-2 weeks (the serve-startup recovery pass is its own work item).

**Caveats:**
- Only payoff if the recovery pass exists too. Half the feature isn't useful.
- Adds tmux as a runtime dependency for the optional path.
- macOS + Linux only initially (Windows = WSL).

#### 5.6 Error taxonomy enum + retry policy

**Why:** Foundation for retries we don't have. Also makes failure modes
inspectable for users.

**Sketch:**
- Enum: `RETRYABLE_TIMEOUT`, `RETRYABLE_RATE_LIMIT`,
  `RETRYABLE_TRANSIENT_NETWORK`, `NON_RETRYABLE_AUTH`, `NON_RETRYABLE_OTHER`.
- Adapters classify failures using their CLI's known error patterns.
- Retry policy uses the classification.

**Estimate:** 2-3 days for the enum + adapter classification; retry policy
is additional.

#### 5.7 ACP transport for adapters that support it

**Why:** Higher fidelity than stdout parsing; bidirectional callbacks; no
need to maintain regex parsers for evolving CLI output formats.

**Sketch:** Per-adapter migration. `claude code --transport stdio`,
`codex --acp`, `gemini --acp`. Each adapter gets a parallel ACP path.

**Estimate:** 1 week per adapter.

### Tier 3 — Defer

- Wholesale tmux-as-runtime — our CLIs don't need it.
- Browser-based PTY attach — heavyweight, niche.
- Plugin event bus — no ecosystem demand yet.

## 6. What crew-mcp uniquely has (don't lose this in the borrow-fest)

- **Per-run git worktrees with explicit `merge_run` / `discard_run`.** MCO has
  shared cwd; CAO has shared cwd. Both can race. crew-mcp is the only one with
  real isolation and a merge contract.
- **Async-first dispatch with the captain returning to the conversation
  immediately.** MCO blocks the caller in `as_completed`; CAO's `handoff`
  blocks the supervisor's MCP thread. Captain-stays-chat-available is
  genuinely differentiated (and there's already a memory note enforcing it).
- **Headless-first design.** MCO and CAO both fight TUI rendering (or don't
  and have race-conditioned regexes). Headless invocation is simpler and more
  robust for the "review/implement and return" use case.

## 7. Strategic stance

The earlier read ("the layer thesis is dead because hyperscalers shipped it")
was too pessimistic. AWS Labs and MCO are clearly ahead on different axes —
MCO on **aggregation sophistication**, CAO on **runtime durability and live
steering** — but neither is doing what crew-mcp uniquely does (worktree
isolation + merge contract + async-first captain). The competitive
differentiation is real; we just need to close the obvious feature gaps.

Recommended order of attack:

1. `send_message` + inbox (1-2 days) — small, unlocks new playbooks
2. Idle-byte stall (½ day) — small, fixes a real correctness gap
3. Structured receipts (1 day) — small, foundation for #4
4. `run_panel` with consensus/debate (4-6 days) — biggest user-visible win
5. Then evaluate optional tmux interactive mode against real user demand

## 8. Reference: file locations of interest

### MCO (`/tmp/competitive-mco`, HEAD `1d4a568`)
- `runtime/cli.py:803-1014` — full CLI subcommand list
- `runtime/mcp_server.py:253-339` — 5 MCP tools
- `runtime/adapters/shim.py:118-147` — subprocess spawn
- `runtime/adapters/shim.py:230-256` — stall-detect kill
- `runtime/review_engine.py:746-749, 805-824` — parallel `as_completed` driver
- `runtime/review_engine.py:958-1044` — findings dedup + consensus
- `runtime/review_engine.py:1128-1394` — debate
- `runtime/review_engine.py:165-218` — divide modes
- `runtime/review_engine.py:1631-1645` — idle-byte stall sampler
- `runtime/orchestrator.py:11-108` — error taxonomy + retry
- `runtime/acp/adapter.py:61-305` — ACP transport
- `runtime/session/daemon.py:30-63` — session daemon
- `skills/mco-cli/SKILL.md` — captain skill

### CAO (`/tmp/competitive-cao`, HEAD `86f5878`)
- `src/cli_agent_orchestrator/clients/tmux.py` — entire tmux integration (566 lines)
- `src/cli_agent_orchestrator/clients/tmux.py:155` — session creation w/ explicit size
- `src/cli_agent_orchestrator/clients/tmux.py:207-281` — bracketed-paste send-keys
- `src/cli_agent_orchestrator/clients/tmux.py:533` — pipe-pane wrapper
- `src/cli_agent_orchestrator/clients/tmux.py:390` — capture-pane wrapper
- `src/cli_agent_orchestrator/services/terminal_service.py:194-196` — pipe-pane wiring
- `src/cli_agent_orchestrator/services/inbox_service.py:47-61` — log-tail idle fast-path
- `src/cli_agent_orchestrator/mcp_server/server.py` — handoff/assign/send_message/load_skill
- `src/cli_agent_orchestrator/api/main.py:740-855` — WebSocket-PTY bridge
- `src/cli_agent_orchestrator/providers/manager.py:142-163` — lazy rehydrate from DB
- `src/cli_agent_orchestrator/providers/claude_code.py:293-385` — idle-prompt detection
- `src/cli_agent_orchestrator/providers/base.py:99` — `paste_enter_count` default
- `skills/cao-supervisor-protocols/SKILL.md` — supervisor protocol skill
- `agent_store/code_supervisor.md` — supervisor profile

### crew-mcp (this repo, HEAD `9268804`)
- `src/orchestrator/tools/*.ts` — 8 MCP tools (~600 LOC)
- `src/orchestrator/tool-dispatcher.ts:20-82` — async dispatch + emitter
- `src/orchestrator/run-state.ts:56-110` — state.json schema
- `src/orchestrator/run-state.ts:361-411` — `markTerminal`
- `src/git/worktree.ts:74-160` — worktree allocation
- `src/git/merge.ts` — merge_run logic
- `src/adapters/{claude-code,codex,gemini-cli,generic,openai-compatible}.ts`
- `src/adapters/registry.ts:56-95` — adapter registration
- `src/cli/commands/install-tail-handler.ts` — macOS crew-tail:// handler
- `skills/crew-captain.body.md` — captain skill (~350 lines)
