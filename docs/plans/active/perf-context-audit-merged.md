# Perf + context audit — merged & prioritized (2026-05-09)

Synthesis of the two parallel audits:
- `docs/plans/active/perf-context-audit-claude.md` (Claude, max effort)
- `docs/plans/active/perf-context-audit-codex.md` (Codex, xhigh effort)

## Priority rule

Tasks are ordered lexicographically by:

1. **Agreement** — both auditors flagged it > only one did.
2. **Feasibility** — low effort > medium > high (high feasibility = easy to do).
3. **Impact** — high > medium > low.

So an "agreed-upon, easy, low-impact" task ranks above an "agreed-upon, hard, high-impact" one. The point is to bias toward tasks where consensus + cheapness make them safe wins, even when the gain is modest.

Within each agreement tier, items are sorted by effort, then impact.

## Legend

- **Agreement:** ✅ Both | 🅒 Claude only | 🅧 Codex only
- **Effort:** S = small (hours), M = medium (a day or two), L = large (multi-day refactor)
- **Impact:** H = high | M = medium | L = low

---

## Tier 1 — Both agreed, small effort

| # | Task | Eff | Imp | Source |
|---|------|-----|-----|--------|
| 1 | **Cache `list_agents` healthchecks (TTL, e.g. 30s).** Adapter `--version` / Claude auth probe spawns 3+ subprocesses per call today; ~300ms–1s redundant cost. Forced refresh via flag. | S | H | Claude §2.5 / Codex S1 |
| 2 | **Drop `git worktree prune` from the dispatch hot path.** Move to startup / periodic / on-demand. Saves 50–200ms per dispatch. | S | H | Claude §2.4 / Codex S2 |
| 3 | **Avoid the second `state.json` parse after long-poll wait.** On terminal-only timeout, reuse the entry-snapshot; or maintain in-memory state cache populated by `update`/`markTerminal`. | S | M | Claude §2.2 / Codex S6 |
| 4 | **Trim dispatch envelope + markdown.** 5 path/URL fields collapse to 2 (`run_id`, `tail_url`); markdown becomes one compact line. Skill already tells captain to relay one line — surface should match. | S | M | Claude §3.2 / Codex C3 |
| 5 | **Tighten `GET_RUN_STATUS_DESCRIPTION` (and peer tool descriptions).** ~1.4K-char paragraph today; mostly duplicates skill body coaching. Target ~3 sentences of wire-shape doc. | S | M | Claude §3.4 / Codex C1 |
| 6 | **Parallelize independent git calls in `merge_run`.** Two `rev-parse` → one. Worktree status + host status → `Promise.all`. ~200–400ms off the merge. | S | M | Claude §2.8 / Codex S10 |
| 7 | **Drop the per-chunk `mkdirSync` in `appendEvent`.** Run dir is invariant by the time chunks arrive. Trivially eliminates one syscall per stream chunk. | S | L | Claude §2.3 / Codex S4 (sub) |

## Tier 2 — Both agreed, medium effort

| # | Task | Eff | Imp | Source |
|---|------|-----|-----|--------|
| 8 | **Incremental `events.log` reads.** Cache `{lineCount, byteOffset}` per run; "no new events past cursor" becomes O(1) instead of O(file size). Tail-from-end for terminal payload. Eliminates ~95% of per-poll IO on long runs. | M | H | Claude §2.1 / Codex S5 |
| 9 | **Cut the captain skill body (`skills/crew-captain.body.md`).** 419 lines / ~3.8K tokens today; substantial intra-doc overlap. Target ~180 lines by collapsing decision-order + default-flow, dropping the worked-shape trace, moving reference material (effort mapping, read-only caveats) into tool descriptions. Keep hard rules verbatim. | M | H | Claude §3.1 / Codex C4 |
| 10 | **Cap terminal `summary` at the wire boundary.** ~12K-char p99 today, top-level on every terminal poll. Cap to ~4K with `summary_truncated: true` + opt-in env var; lower default `events_tail` from 10→3. | M | M-H | Claude §3.3 / Codex C5 |
| 11 | **Lazy-load adapter modules and non-`serve` CLI commands.** Cold-start parses every adapter + every Commander subcommand before subcommand is selected. Dynamic `import()` per subcommand action; lazy adapter construction in registry. ~100–300ms off serve startup. | M | M | Claude §2.6 / Codex S7 |

## Tier 3 — Claude-only

| # | Task | Eff | Imp | Source |
|---|------|-----|-----|--------|
| 12 | **Replace `existsSync`+`readFileSync` with try/catch ENOENT.** Removes one syscall per `RunStateStore.read`. Couples with #3. | S | L | Claude §2.11 |
| 13 | **Strip vestigial adapter-side progress prefix.** `[codex] [codex] command: …` double-prefixing wastes ~10 chars per progress line in hosts that render `notifications/progress`. | S | L (cosmetic) | Claude §2.9 |
| 14 | **Cap `RunStateV1.prompts[].prompt` storage.** Verbatim user prompts retained on disk forever; truncate at e.g. 16KB with marker. | S | L | Claude §3.6 |
| 15 | **Index dispatcher events by `runId`.** Per-runId `EventEmitter` map instead of single broadcaster + per-listener filter. Architectural smell more than perf bug today. | M | L | Claude §2.7 |
| 16 | **Split `state.json` disk schema from wire schema.** Force every new field to opt into wire visibility explicitly. Catches future bloat at the type level. | M | M | Claude §4.1 |

## Tier 4 — Codex-only

| # | Task | Eff | Imp | Source |
|---|------|-----|-----|--------|
| 17 | **Fix doc drift: "6-tool surface" → 7.** `src/orchestrator/index.ts` comment outdated; live server exposes 7 tools incl. `cancel_run`. | S | L (doc) | Codex X2 |
| 18 | **Skip post-run `git status` for adapters that report file-changes reliably.** Adapter capability flag; keep fallback for unreliable sources. | S | L-M | Codex S9 |
| 19 | **Compact MCP `content` text — stop pretty-printing structured payloads.** `jsonContent` ships pretty JSON in `content[0].text` AND the same object in `structuredContent`. Hosts that retain text in transcript pay 2× context. Move to compact JSON or short human line. | M | M-H | Codex C2 |
| 20 | **Buffered/batched event-log writes.** Replace per-chunk `appendFileSync` with a per-run write queue or `fs.createWriteStream`; flush on terminal/cancel. Companion to #7. | M | M | Codex S4 (sub) |
| 21 | **Stop double-parsing adapter streams.** Codex/Claude Code parse JSONL during streaming for progress, then re-parse buffered stdout post-exit. Use streaming parser as source of truth; bound stdout buffer. | M | M | Codex S8 |
| 22 | **Async + concurrent uncommitted-state mirror.** Sync `existsSync`/`statSync`/`copyFileSync` loop blocks the event loop; switch to async with bounded concurrency. Big win on dirty repos. | M | M | Codex S3 |
| 23 | **Move tool-use input previews out of progress events / event tails.** Tool args (paths, JSON, prompt fragments) bloat tails with low-signal content. Show tool name + one-line action; route raw previews to a separate trace if kept. | M | M | Codex C7 |
| 24 | **Reduce schema duplication in adapter prompts.** Claude Code passes `--json-schema` AND embeds the schema in the prompt; OpenAI-compatible embeds in prompt instead of using native `response_format`. | M | M | Codex C8 |
| 25 | **Compact tool-loop transcript replay (adapter-as-captain path).** Tool-loop replays full `JSON.stringify(toolResult.output)` every turn; the response-format block is repeated each turn. Project tool results to compact captain-relevant fields; move stable protocol into a system message. **Caveat:** only matters when an adapter is itself the captain — dormant for crew's host-as-captain flow today, but the largest captain-context win whenever that path goes live. | L | H (when active) | Codex C6 |

---

## Suggested first bundle

If you ship one PR off this plan, the minimal "no-cross-dependency, broad-surface" bundle is **#1 + #2 + #3 + #5 + #7** — five small, agreed-upon wins covering the three different cost surfaces (per-poll IO, per-dispatch latency, captain context). Then tackle #8 and #9 as standalone medium-effort PRs since they each have isolated risk.

## Out of scope (per source reports)

- Background-wakeup / cron-style optimizations to the long-poll path. Already considered and rejected (`docs/plans/parked/long-poll-cost-tuning.md`).
- Adapter-internal latency (model wall time inside claude-code / codex / gemini-cli).
- MCP SDK transport overhead — different audit.
- Benchmark harness — neither auditor measured numbers; impact estimates are file-size + spawn-count grounded but not stopwatched. Tier-1 wins are obvious enough to act on without; Tier-2/3 should land alongside a benchmark before/after.
