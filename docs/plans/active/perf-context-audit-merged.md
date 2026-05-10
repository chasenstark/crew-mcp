# Perf + context audit — merged & prioritized (2026-05-09; revalidated 2026-05-10)

Synthesis of the two parallel audits:
- `docs/plans/active/perf-context-audit-claude.md` (Claude, max effort)
- `docs/plans/active/perf-context-audit-codex.md` (Codex, xhigh effort)

**Revalidation note (2026-05-10).** After `docs/plans/completed/non-blocking-captain.md` shipped in full, both auditors (Codex xhigh + Claude code-architect) re-ran against the live tree at `main @ 3a28d1f`. Status annotations + new Tier 5 (non-blocking-captain–introduced findings) added below; bundle and ratings adjusted where consensus moved. See "Revalidation summary (2026-05-10)" for the audit trail.

**Shipped note (2026-05-10).** Tier 3 #13 shipped in this change: Codex and Claude Code adapters now emit unprefixed semantic progress chunks; `crew-mcp serve` owns the single `[agent]` prefix for progress notifications and `events.log` / `events_tail`. Remaining open items in this plan are unchanged.

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
- **Status (2026-05-10 revalidation):** 🟢 valid as written | 🟡 partial (some shipped via non-blocking-captain) | 🔵 newly-questionable (assumption shifted) | 🟠 stale refs (finding holds, file/line moved) | 🔴 superseded (already done)
- **Completed:** ✅ shipped (with commit SHA) | blank = not yet

---

## Tier 1 — Both agreed, small effort

| # | Task | Eff | Imp | Status | Done | Source |
|---|------|-----|-----|--------|------|--------|
| 1 | **Cache `list_agents` healthchecks (TTL, e.g. 30s).** Adapter `--version` / Claude auth probe spawns 3+ subprocesses per call today; ~300ms–1s redundant cost. Forced refresh via flag. Refs: `serve.ts:251–266`, `claude-code.ts:1165–1241`, `codex.ts:1312–1316`, `gemini-cli.ts:424–427`. | S | H | 🟢 | ✅ `7a4f400` | Claude §2.5 / Codex S1 |
| 2 | **Drop `git worktree prune` from the dispatch hot path.** Move to startup / periodic / on-demand. Saves 50–200ms per dispatch. Ref: `git/worktree.ts:299` (`createRunWorktree`). Other call sites at `:125` (legacy) and `:251` (`cleanupAll`) are not hot. | S | H | 🟢 | ✅ `591a637` | Claude §2.4 / Codex S2 |
| 3 | **Avoid the second `state.json` parse after long-poll wait.** On terminal-only timeout, reuse the entry-snapshot; or maintain in-memory state cache populated by `update`/`markTerminal`. Refs: `serve.ts:567` (entry read), `:629` (post-wait re-read). | S | L | 🔵 | ✅ `02b5112` | Claude §2.2 / Codex S6 |
| 4 | **Trim dispatch envelope.** 5 path/URL fields in `RunEnvelope` collapse to 2 (`run_id`, `tail_url`); rest opt-in. Markdown side already collapsed by non-blocking-captain. Refs: `serve.ts:127–186` (`RunEnvelope`), `:799–810` (population), `:831–855` (`renderDispatchMarkdown` — done). Caveat: `docs/captain-context-backlog.md:43–55` parks the markdown collapse; only the structured envelope remains in scope here. | S | M | 🟡 | ✅ `02b5112` | Claude §3.2 / Codex C3 |
| 5 | **Tighten `GET_RUN_STATUS_DESCRIPTION` and peers (incl. new `LIST_RUNS_DESCRIPTION`).** Description was rewritten by non-blocking-captain (now ~1.1K chars, down from ~1.4K) but still long; new tools added. Audit `MERGE_RUN_DESCRIPTION` (`merge-run.ts:57`), `RUN_AGENT_DESCRIPTION` (`run-agent.ts:84`), `LIST_RUNS_DESCRIPTION` (`list-runs.ts:49`), and `GET_RUN_STATUS_DESCRIPTION` (`get-run-status.ts:93–94`). Target ~3 sentences each, drop overlap with the now-larger skill body. Note: `tool-catalog.ts:15–24` correctly imports — no double-edit. | S | M | 🟡 | ✅ `a1dcdaf` | Claude §3.4 / Codex C1 |
| 6 | **Parallelize independent git calls in `merge_run`.** Two `rev-parse` → one. Worktree status + host status → `Promise.all`. ~200–400ms off the merge. Refs: `git/worktree.ts:458, 461, 472, 486–487, 492`. | S | M | 🟢 | ✅ `591a637` | Claude §2.8 / Codex S10 |
| 7 | **Drop the per-chunk `mkdirSync` in `appendEvent`.** Run dir is invariant by the time chunks arrive. Trivially eliminates one syscall per stream chunk. Ref: `run-state.ts:406–410`. | S | L | 🟢 | ✅ `a1dcdaf` | Claude §2.3 / Codex S4 (sub) |

**Tier 1 status notes.** #3 demoted M→L: the long-poll path is now the deprecated/legacy flow per `get-run-status.ts:93–94`; default captain flow ends turn after dispatch (`crew-captain.body.md:222–244`), so this saving accrues only to opt-in `wait_for_terminal_only` callers. #4 narrowed: only the structured envelope remains — `renderDispatchMarkdown` already emits one compact tail line. #5 line refs corrected: `GET_RUN_STATUS_DESCRIPTION` lives in `get-run-status.ts:93–94`, not `tool-catalog.ts`.

**Tier 1 shipped 2026-05-10.** All 7 items merged via 4 parallel codex runs (B `1ca9cff4`, D `f008cacb`, A `8804a4e2`, C `98258c4c`); merge commits `591a637`, `a1dcdaf`, `7a4f400`, `02b5112`. Full test suite: 780 passed, 3 skipped.

## Tier 2 — Both agreed, medium effort

| # | Task | Eff | Imp | Status | Done | Source |
|---|------|-----|-----|--------|------|--------|
| 8 | **Incremental `events.log` reads + tail-from-end for terminal payload.** Cache `{lineCount, byteOffset}` per run; "no new events past cursor" becomes O(1) instead of O(file size). Tail-from-end for the 10-event terminal slice. Refs: `run-state.ts:436–446` (`readEventsSince`), `:464–470` (`readSignalEventsSince`), `serve.ts:1229` (terminal full-log read). Per-poll long-poll IO mostly went away (default flow yields after dispatch), but **terminal `get_run_status` calls still read the full file to slice the tail** — and those now happen on every synthetic-turn surfacing (Claude Code) or per-turn pending-run check (Codex/Gemini). The tail-from-end fix is the load-bearing half post-non-blocking-captain; the cursor cache is the parked half. | M | M-H | 🟡 |  | Claude §2.1 / Codex S5 |
| 9 | **Cut the captain skill body (`skills/crew-captain.body.md`).** Now **509 lines / ~24.5K bytes** (was 419 — non-blocking-captain added 8 sections: Dispatch lifecycle, Background watcher overlay, Foreground crew-wait opt-in, Synthetic-turn handling, Spawn-failure path, Checking pending runs at turn start, Multiple-terminations-don't-batch, updated Worked shape). **The added sections ARE the chat-availability workflow — they're load-bearing, not bloat.** Target a careful condensation, not a 180-line slash: collapse "Dispatch lifecycle" / "Step 1 dispatch confirmation" / "Worked shape" / "How users follow progress" overlap; preserve `{{CREW_WAIT_COMMAND}}` template variable (`skill-renderer.ts:46–62`); preserve **non-blocking workflow guidance verbatim** (chat-stays-available, watcher overlay, synthetic-turn handling, turn-start pending-run check, multi-terminations-don't-batch); preserve ask/dispatch guardrails (`docs/captain-context-backlog.md:28–41`). Realistic target ~300–350 lines, not 180. Validate via behavior tests (chat-availability holds, parallel dispatch still works, /clear recovery works), not blind line-count target. | M | H | 🟠 |  | Claude §3.1 / Codex C4 |
| 10 | **Cap terminal `summary` at the wire boundary** *(parked unless real compaction evidence)*. Wire savings already shipped: default `events_tail` is 10 (`get-run-status.ts:37`), terminal prompts omit verbatim prompt + per-turn summary (`serve.ts:1171–1180`), discarded runs skip tail building (`:1213–1216`). Top-level summary remains uncapped (`run-state.ts:300–317`, ~12K p99) with explicit rationale against truncation in `docs/captain-context-backlog.md:106–119`. Don't ship a cap until backed by evidence; treat as parked-conditional. | M | M | 🟡 |  | Claude §3.3 / Codex C5 |
| 11 | **Lazy-load adapter modules and non-`serve` CLI commands.** Cold-start parses every adapter + every Commander subcommand before subcommand is selected. Dynamic `import()` per subcommand action; lazy adapter construction in registry. Refs: `src/index.ts:2–8`, `serve.ts:29`, `adapters/registry.ts:1–6`. **Measured 128ms → 38ms (~70% cut) for `serve --help` and `install --help`.** | M | M | 🟢 | ✅ `68255fa` | Claude §2.6 / Codex S7 |

## Tier 3 — Claude-only

| # | Task | Eff | Imp | Status | Done | Source |
|---|------|-----|-----|--------|------|--------|
| 12 | **Replace `existsSync`+`readFileSync` with try/catch ENOENT.** Removes one syscall per `RunStateStore.read`. Refs: `run-state.ts:238–240, 419–421, 441–442`. Couples with #3 (now lower-impact). | S | L | 🟢 | ✅ `720578b` | Claude §2.11 |
| 13 | **Strip vestigial adapter-side progress prefix.** `[codex] [codex] command: …` double-prefixing wastes ~10 chars per progress line. Refs: `claude-code.ts:50` (`CLAUDE_PROGRESS_PREFIX`), `codex.ts:81` (`CODEX_STREAM_PREFIX`), `serve.ts:1011`. With async-first dispatch, inline progress is no longer the default UX (`crew-captain.body.md:347–365` — tail is the path); this is cosmetic-only now. **Resolution: server is now the single prefix authority; adapters emit unprefixed semantic chunks.** | S | L (cosmetic) | 🟢 | ✅ `16c1b92` | Claude §2.9 |
| 14 | **Cap `RunStateV1.prompts[].prompt` storage.** Verbatim user prompts retained on disk forever; truncate at e.g. 16KB with marker. Refs: `run-state.ts:165–195` (`create`), `:286–298` (`appendPrompt`). Wire payloads now elide prompt text but disk growth + parse cost remain. | S | L | 🟢 |  | Claude §3.6 |
| 15 | **Index dispatcher events by `runId`.** Per-runId `EventEmitter` map instead of single broadcaster + per-listener filter. Refs: `tool-dispatcher.ts:57–58, 77–83, 138–168`; listeners at `serve.ts:943–977, 1425–1438`. Architectural smell more than perf bug today. | M | L | 🟢 |  | Claude §2.7 |
| 16 | **Split `state.json` disk schema from wire schema.** Force every new field to opt into wire visibility explicitly. **Higher value than originally framed:** `state.json` is now a documented public contract (`docs/architecture/run-state-contract.md`) and gained `serverPid` + `repoRoot` fields (load-bearing for the sweeper). Split must preserve atomic-write, terminal-status, schema-stability, and `repoRoot`/`serverPid` guarantees. Current ad-hoc projection sites: `serve.ts:1267–1289` (`get_run_status`), `list-runs.ts:99–110` (`list_runs`). | M | M | 🔵 |  | Claude §4.1 |

## Tier 4 — Codex-only

| # | Task | Eff | Imp | Status | Done | Source |
|---|------|-----|-----|--------|------|--------|
| 17 | **Fix doc drift: "6-tool surface" → 8** *(was 7 — `list_runs` joined the surface)*. `orchestrator/index.ts:8` comment now off by 2; `serve.ts:6–16` lists eight (`list_agents`, `list_runs`, `run_agent`, `continue_run`, `merge_run`, `discard_run`, `get_run_status`, `cancel_run`). | S | L (doc) | 🟠 |  | Codex X2 |
| 18 | **Skip post-run `git status` for adapters that report file-changes reliably.** Adapter capability flag; keep fallback for unreliable sources. Refs: `adapters/types.ts:240–244` (`TaskResult.filesModified`), `run-agent.ts:368–380` (always merges). | S | L-M | 🟢 |  | Codex S9 |
| 19 | **Compact MCP `content` text — stop pretty-printing structured payloads.** `jsonContent` ships pretty JSON in `content[0].text` AND the same object in `structuredContent`. Hosts that retain text in transcript pay 2× context. **Impact bumped M-H → H:** envelope grew (`tail_url`, `tail_command_url`, `worktree_path` all duplicated). Refs: `serve.ts:1456–1462` (`jsonContent`), `:262, :278` (`list_agents` / `list_runs`). | M | H | 🟢 |  | Codex C2 |
| 20 | **Buffered/batched event-log writes.** Replace per-chunk `appendFileSync` with a per-run write queue or `fs.createWriteStream`; flush on terminal/cancel. Companion to #7. Ref: `run-state.ts:406–410`. | M | M | 🟢 |  | Codex S4 (sub) |
| 21 | **Stop double-parsing adapter streams.** Codex/Claude Code parse JSONL during streaming for progress, then re-parse buffered stdout post-exit. Refs: `codex.ts:482–512` (stream), `:566–567` (re-parse), also `:736, :1035`. Claude: `claude-code.ts:490–503` (stream), `:567–576` (re-parse). | M | M | 🟢 |  | Codex S8 |
| 22 | **Async + concurrent uncommitted-state mirror.** Sync `existsSync`/`statSync`/`copyFileSync` loop blocks the event loop; switch to async with bounded concurrency. Refs: `git/worktree.ts:382–431` (`syncUncommittedToWorktree`); called from `:317` (`createRunWorktree`) and `serve.ts:402` (`continue_run`). | M | M | 🟢 |  | Codex S3 |
| 23 | **Move tool-use input previews out of progress events / event tails.** Codex terminal-tail filtering of low-signal command receipts is **done** (`events-filter.ts:37–58`, `serve.ts:1224–1229`). Remaining scope: Claude tool-use previews (`claude-code.ts:340–345`), raw `events.log`, and live progress-line previews (`serve.ts:1006–1024` — only truncates at 240 chars, no semantic filter). | M | M | 🟡 |  | Codex C7 |
| 24 | **Reduce schema duplication in adapter prompts.** Claude Code passes `--json-schema` AND embeds the schema in the prompt (`claude-code.ts:626–642`); OpenAI-compatible embeds in prompt instead of using native `response_format` (`openai-compatible.ts:101–122`). | M | M | 🟢 |  | Codex C8 |
| 25 | **Compact tool-loop transcript replay (adapter-as-captain path).** Transcript windowing + per-message char limit + skip-tool-catalog-when-system-msg already shipped (`tool-loop/transcript.ts:13–32, 75–83`, `tool-loop/constants.ts:1–3`). **Remaining work:** (a) hoist response-format envelope block (`transcript.ts:87–109` — rebuilt every turn) into a stable system message; (b) project `JSON.stringify(toolResult.output)` to compact captain-relevant fields. Refs: `tool-loop/controller.ts:160–164`, `claude-code.ts:996–1024`, `codex.ts:1134–1161`. **Caveat unchanged:** dormant for host-as-captain flow today. | L | H (when active) | 🟡 |  | Codex C6 |

## Tier 5 — Introduced or amplified by non-blocking-captain (new, 2026-05-10)

These costs were **created or made worse** by the non-blocking-captain rollout. Both auditors independently flagged N1–N3; Claude additionally flagged N4–N8.

| # | Task | Eff | Imp | Done | Source |
|---|------|-----|-----|------|--------|
| N1 | **Cache `list_runs` repoRoot resolution + cap result scan.** `list-runs.ts:71–110` walks every directory under `<crewHome>/runs/`, reads + JSON-parses each `state.json`, calls `realpathSync` on each `repoRoot` for filtering. With `/clear`-recovery driving accumulation, this is O(historical runs × disk read + parse) on every captain turn that calls it. **Resolution:** process-local repoRoot realpath cache (current-repoRoot resolved once per call) + state.json parse cache keyed by run_id with mtime invalidation. | S | M | ✅ `71a22d6` | ✅ Both |
| N2 | **Defer / scope the stale-run sweeper at server startup.** `serve.ts:222–230, :1304–1367` (`markAbandonedRunningRuns`) walks all of `<crewHome>/runs/` synchronously on every `crew-mcp serve` boot before pid + repo + status filtering. **Resolution: option (a)** — sweeper deferred via `setImmediate` after `buildCrewMcpServer` returns; module-local single-flight via `scheduleStaleRunSweep()` / `getStaleRunSweep()`; errors caught + logged. Brief race: `list_runs` may see stale `running` records between server-ready and sweep completion (tens-to-hundreds of ms). | S | L-M | ✅ `da0f025` | ✅ Both |
| N3 | **`crew-wait` per-watched-run polling cost.** New Node process spawned for every Claude Code dispatch; polls `state.json` every 1s (`cli/wait.ts:8, :77–98, :124–132`). Accepted trade for chat-availability. **Parallel dispatch is now an actively-encouraged pattern** (e.g., dispatching multiple reviewers / multiple model implementations side-by-side), so this scales linearly with how the workflow is actually being used. Possible fix: one multi-run watcher binary that the captain registers run_ids with; or coalesce poll cycles via a shared lock-file. Re-rate impact upward if usage data shows ≥4 concurrent watchers becoming common. | M | L-M |  | ✅ Both |
| N4 | **Skill body context cost grew ~22% (419 → 509 lines, ~4.6K extra tokens per Claude Code session).** Already folded into #9, listed here for completeness. | — | — |  | 🅒 Claude |
| N5 | **New tool-catalog descriptions add ~330 chars (`LIST_RUNS_DESCRIPTION`) + amplify existing per-tool descriptions on every MCP tool-list call.** Total tool-catalog text ~3–4K chars. Folded into #5 scope. | — | — | ✅ `a1dcdaf` (with #5) | 🅒 Claude |
| N6 | **`state.json` schema gained `serverPid` + `repoRoot` (load-bearing for sweeper).** Strengthens the case for #16: any new disk field risks silently leaking into the wire shape via `serve.ts:1267–1289` (`get_run_status` projection) or `list-runs.ts:99–110` (`list_runs` mapping). Couples with #16. | — | — |  | 🅒 Claude |
| N7 | **`crew-wait` reads + JSON-parses `state.json` synchronously every 1s per backgrounded run.** On N parallel dispatches, that's N file-read+parse cycles/sec. Probably fine; worth measuring on long-running parallel dispatches before bundling with N3. | — | — |  | 🅒 Claude |
| N8 | **Sweeper `realpathSync` per record in current-repo loop.** `serve.ts:1339` calls `resolveComparableRepoRoot(state.repoRoot)` for every running record. Current-repoRoot is already cached at `:1310`; cache per-record realpath if same paths repeat. Trivially eliminable; couples with N1. *(Out of scope for N2's option (a) implementation; pick up if sweeper body work resumes.)* | — | — |  | 🅒 Claude |

---

## Suggested first bundle (revised 2026-05-10)

Original bundle was #1 + #2 + #3 + #5 + #7. Revalidation drops #3 (now legacy/low-impact) and adds N1 (cheap `list_runs` cache wins, now on the captain hot path):

**Revised first bundle: #1 + #2 + #5 + #7 + N1** — five small, agreed-upon wins covering per-dispatch latency, captain-context, per-stream-chunk IO, and the new `list_runs` hot path. Optionally fold in #19 (compact MCP `content` text) since the dispatch-envelope grew and the duplication cost is now more painful than the audit estimated.

Then tackle #8 and #9 as standalone medium-effort PRs (each has isolated risk + needs careful validation). #10's summary cap stays parked unless behavioral evidence justifies it.

## Out of scope (per source reports)

- Background-wakeup / cron-style optimizations to the long-poll path. Already considered and rejected (`docs/plans/parked/long-poll-cost-tuning.md`).
- **Cost optimization for the legacy `wait_for_terminal_only` long-poll path.** Default captain flow no longer uses it (non-blocking-captain shipped). Findings #3, #8, #12 still apply for opt-in / back-compat callers but at lower priority.
- Adapter-internal latency (model wall time inside claude-code / codex / gemini-cli).
- MCP SDK transport overhead — different audit.
- Benchmark harness — neither auditor measured numbers; impact estimates are file-size + spawn-count grounded but not stopwatched. Tier-1 wins are obvious enough to act on without; Tier-2/3 should land alongside a benchmark before/after.
- **Captain-side per-turn inference cost increase from non-blocking workflow.** The new flow trades long-poll-blocking for: (a) one synthetic captain turn per `crew-wait` exit (Claude Code), (b) per-turn `get_run_status` calls for known pending runs, (c) `list_runs` recovery after `/clear`. These are extra Anthropic-API turns + tokens, not crew-server cost — out of scope for this audit but worth tracking separately if costs balloon.

## Revalidation summary (2026-05-10)

After non-blocking-captain shipped in full, both auditors (Codex xhigh + Claude code-architect) re-ran independently against `main @ 3a28d1f`. Strong consensus on every rating below.

**Status distribution:**
- 🟢 Still valid as written: #1, #2, #6, #7, #11, #12, #13, #14, #15, #18, #19, #20, #21, #22, #24
- 🟡 Partial / superseded in part: #4 (markdown done, envelope unchanged), #5 (description shrank but still long, plus new `LIST_RUNS_DESCRIPTION`), #8 (long-poll no longer default), #9 (skill body grew 419→509), #10 (much shipped, summary cap parked), #23 (Codex tail filtering done, Claude/raw still in scope), #25 (transcript window done, projection + protocol-hoist remain)
- 🔵 Newly questionable (assumption shifted): #3 (legacy path now), #16 (state.json now public contract — bigger value)
- 🟠 Stale refs (rating intact, target moved): #9 (line count 419→509), #17 (count 7→8)
- 🔴 Fully superseded: none

**New (Tier 5) findings added:** N1–N3 by both, N4–N8 by Claude only.

**Tier 1 implementation (later same day, 2026-05-10).** All 7 Tier 1 items shipped via 4 parallel codex runs. Merge commits: `591a637` (#2 + #6), `a1dcdaf` (#5 + #7 + N5), `7a4f400` (#1), `02b5112` (#3 + #4). Full test suite: 780 passed, 3 skipped post-merge.

**Second batch shipped (also 2026-05-10).** Five more items via 5 parallel codex runs: `71a22d6` (N1 list_runs cache), `720578b` (#12 ENOENT), `da0f025` (N2 sweeper deferred — option (a)), `16c1b92` (#13 progress-prefix authority), `68255fa` (#11 lazy CLI/adapter loading — measured 128ms → 38ms cold-start). Full test suite: 791 passed, 3 skipped post-merge.

**Bundle change:** #3 dropped (legacy), N1 added, #4 narrowed to envelope-only.

**Re-weights:** #3 M→L; #8 H→M-H; #19 M-H→H; #16 framing strengthened (now backed by public contract).
