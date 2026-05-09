# Perf + context audit — crew-mcp (Claude, 2026-05-09)

A whole-codebase, code-architect-level read of `src/`, the captain skill body, and the
adapter surfaces, looking for (1) latency anywhere in the dispatch / poll / merge
lifecycle, and (2) tokens we make our captain or dispatched subagents pay for.

**Constraint respected throughout:** the captain holds its turn through long-polls
by design (`docs/plans/parked/long-poll-cost-tuning.md`). No "wake up later" or
side-channel polling proposals here.

**Not a refactor PR.** Everything below is a finding + a proposed fix; the
captain decides which to take.

---

## 1. Executive summary

Top findings, ordered by leverage:

| # | Finding | Impact | Effort | Section |
|---|---------|--------|--------|---------|
| S1 | `get_run_status` re-reads the entire `events.log` from disk on **every** long-poll cycle (2× per cycle in non-terminal-only mode). On long runs this is the dominant per-poll latency. | high | medium | §2.1 |
| S2 | `state.json` is `existsSync`+`readFileSync`+`JSON.parse`'d twice per long-poll cycle — once on entry, once after `waitForRunChange`. | medium | low | §2.2 |
| S3 | `appendEvent` calls `mkdirSync(dirname(path), {recursive:true})` for every stream chunk, syscall-per-line, even though the directory was created on `RunStateStore.create()`. | medium | low | §2.3 |
| S4 | `createRunWorktree` runs `git worktree prune` synchronously **before every dispatch**, adding 50–200ms of extra child-process latency for the common no-op case. | medium | low | §2.4 |
| S5 | `list_agents` healthchecks every adapter (3× `<bin> --version` subprocess spawns) on every call with **no cache** — repeated captain calls pay full cost each time. | medium | low | §2.5 |
| S6 | Cold-start eagerly loads all 5 adapter modules + `simple-git` + `execa` in `createBuiltinRegistry`, even though a typical session uses 1–2 adapters. | low–medium | medium | §2.6 |
| C1 | The captain skill body (`skills/crew-captain.body.md`) is **419 lines / ~3.8K tokens**, loaded on every "crew" trigger; large overlap between Decision Order, Default Flow, Polling Lifecycle. | high | medium | §3.1 |
| C2 | The dispatch envelope ships **5 path/URL fields for 2 underlying paths** (events_log_path / tail_command_path / tail_command_url / tail_url + worktree_path) in both the markdown text and `structuredContent`. | medium | low | §3.2 |
| C3 | `get_run_status` terminal response ships an uncapped `summary` (p99=9.9K, max=12K chars per the existing comment) **plus** a per-turn `prompts[]` array **plus** `events_tail` — three overlapping synthesis surfaces. | medium | low | §3.3 |
| C4 | `GET_RUN_STATUS_DESCRIPTION` is a single ~1.4K-character paragraph permanently in the captain's tool list; mentions superseded behavior and noise-filter internals it doesn't need to. | low | low | §3.4 |

---

## 2. Speed findings

### 2.1 (S1) `get_run_status` re-reads the full events.log per long-poll, twice

**Where**
- `src/orchestrator/run-state.ts:398-408` — `readEventsSince` reads the **entire** file via `readFileSync`, splits on `\n`, then slices `[sinceLine:]`. Cursor advances by line count, but the read does not seek.
- `src/orchestrator/run-state.ts:426-432` — `readSignalEventsSince` calls `readEventsSince` again and filters.
- `src/cli/commands/serve.ts:564` — long-poll fast-return calls `readSignalEventsSince` (one full read).
- `src/cli/commands/serve.ts:1169` — `buildGetRunStatusResponse` then calls `readEventsSince` (a **second** full read) just to compute `nextLine`. The lines themselves are discarded for non-terminal poll-returns (running poll-return forces `events_tail: []`).
- `src/cli/commands/serve.ts:1189` — terminal branch calls `readEventsSince(runId, 0)` *and then* `filterEventsTailNoise` over the full thing.

**Why it costs**
A typical adapter emits one chunk per assistant turn / tool result / command-receipt — easily hundreds of lines per minute for codex, plus `[codex] command: started ...` receipts. After ~10 minutes of run-time, `events.log` is comfortably 100–500 KB; after an hour, multi-MB. Each long-poll wake (every ≤60s) reads, splits, filters, slices the **entire file** twice. Two `readFileSync` syscalls + two full-file UTF-8 decodes + two `String.split('\n')` allocations per poll.

For a 30-minute run with a 60s wait cap, that's ~30 cycles × 2 reads = 60 full-file reads. Cumulative ~30–500ms of pure file-IO + CPU per long run, but more importantly it **scales linearly with run length × poll count** — exactly the wrong direction.

**Proposed fix**
1. Cache `{lineCount, byteOffset}` per run in `RunStateStore` (in-memory, alongside the worktree manager). On `appendEvent`, increment `lineCount` and remember the new file size.
2. `readEventsSince(sinceLine)` then becomes: if `sinceLine >= lineCount` → `{lines: [], nextLine: lineCount}` with **zero IO**. Otherwise, `read` from a tracked byte offset (or from offset of line `sinceLine` if cached — keep a sparse cursor index to avoid rescans).
3. For the terminal-only "tail of full log" use-case (serve.ts:1189): also cap the read at the last N KB by streaming from the end, since `max_events_tail` is bounded (default 10, max 500 lines). `readLastNBytes(path, ~max_events_tail * 200B)` is enough for the intended payload.
4. Eliminate the second read in `buildGetRunStatusResponse` — once the long-poll fast-return has read the file, thread `{lines, nextLine}` through instead of re-reading.

**Expected gain**
- The "no new events past cursor" path becomes O(1) instead of O(file size). On 30-min runs, eliminates 95% of the per-poll IO.
- 50–200ms reclaimed per long-poll cycle on long runs; multiplied across ~30 cycles that's seconds of freed wall-time the captain spent in syscall.

**Risks / breakage**
- The in-memory line counter must stay coherent across crashes. On serve restart, scan once on first read for that run (`wc -l` semantics) and cache. Not great if a serve dies mid-poll, but no worse than today.
- If anything else tails `events.log` and prepends/truncates (no current writer does), the cache desyncs. Mitigation: `fstat` on entry; if `mtime`/`size` regressed, invalidate.

**Prerequisite**
- None. All within `RunStateStore` + `serve.ts` long-poll path.

---

### 2.2 (S2) `state.json` is read twice per long-poll cycle

**Where**
- `src/cli/commands/serve.ts:529` — `runStateStore.read(args.run_id)` on entry to `get_run_status`.
- `src/cli/commands/serve.ts:591` — `runStateStore.read(args.run_id) ?? state` after the long wait completes.
- `src/orchestrator/run-state.ts:219-243` — each `read()` does `existsSync` + `readFileSync` + `JSON.parse`.

**Why it costs**
state.json grows with `prompts[]` (one per turn, with a 12K-max `summary` field). For a 5-turn run it's 50–60 KB. Two `readFileSync` + `JSON.parse` roundtrips per long-poll cycle = ~10–30ms of unnecessary work per poll. Across ~30 polls per long run, ~300–900ms reclaimed — small per cycle, but cheap to eliminate.

**Proposed fix**
- The post-wait re-read is only needed because `markTerminal` writes to disk inside the lifecycle listener and we want to observe it. Instead: have `installRunLifecycleListeners` set an in-memory "latest state snapshot" on the dispatcher (or a `Map<runId, RunStateV1>` on `RunStateStore`) when it writes. `get_run_status` then reads that map first and falls back to disk when cold.
- Or, more conservative: on entry, snapshot `state` once. After `waitForRunChange`, if `timedOut === true` and the run was running on entry, **don't re-read** — surface the pre-wait snapshot. Only re-read when the wait was woken by an event.

**Expected gain**
- Halves `read()` calls on the running-poll path. Compounding with §2.1: a "no new events, no new state" wake becomes a few-microsecond in-memory check.

**Risks / breakage**
- An in-memory cache must be invalidated whenever `update()` writes — easy. Any `read()` from outside the long-poll path (tests, future tools) must also hit the cache. Wrap `update` and `markTerminal` to populate.
- The `?? state` fallback at serve.ts:591 hides a real bug: `read` returning `undefined` after the wait would mean state.json was deleted mid-run, which we silently paper over. Worth surfacing via an assertion.

**Prerequisite**
- None.

---

### 2.3 (S3) `appendEvent` mkdir-syscalls per stream chunk

**Where**
- `src/orchestrator/run-state.ts:368-372` — `appendEvent` runs `mkdirSync(dirname(path), {recursive:true})` then `appendFileSync` for every line.

**Why it costs**
The directory is guaranteed to exist by the time the first chunk arrives — `RunStateStore.create()` (run-state.ts:148) and `WorktreeManager.createRunWorktree` both ensure the run directory before dispatch. `mkdirSync(..., {recursive:true})` short-circuits to a stat when the dir exists, but that's still a syscall per chunk. Codex emits dozens to hundreds of chunks per minute; that's N userland→kernel transitions for nothing.

**Proposed fix**
- Drop the `mkdirSync` from `appendEvent`. If callers create the run dir (they do), it's invariant by the time we append. As a belt-and-suspenders, let `appendFileSync` ENOENT propagate to a one-shot mkdir-and-retry inside the catch — pay it on the rare failure, not the hot path.

**Expected gain**
- Removes one syscall per stream chunk. On a chatty 10-min codex run (~3000 chunks), that's ~3000 fewer syscalls — measurable in `strace` but only a few ms cumulatively. Worth fixing because it's tiny and obvious.

**Risks / breakage**
- If a future caller `appendEvent`s before `create()` (test path?), today's auto-mkdir hides it. Tests cover the `create() → appendEvent` ordering, so this should be safe.

---

### 2.4 (S4) `git worktree prune` runs synchronously before every dispatch

**Where**
- `src/git/worktree.ts:299` (`createRunWorktree`) and `src/git/worktree.ts:125` (legacy `createWorktree`) both call `await this.git.raw(['worktree', 'prune'])` before `worktree add`.

**Why it costs**
`git worktree prune` is cheap when there's nothing to prune (no I/O scans — it walks `.git/worktrees/*`), but it's still a child process spawn → exec → exit cycle on every dispatch. Measured ~50–200ms on a healthy repo, more on a slow filesystem. It's serially in front of the `worktree add` which is itself ~300–800ms. Together they constitute most of the dispatch's pre-adapter latency.

**Proposed fix**
- Move `prune` off the hot path. Three options:
  1. **Lazy/conditional:** only prune if `existsSync(<crewHome>/runs/.meta)` reports a stale record (the metadata files we wrote). Skip when no stale records exist.
  2. **Background/debounced:** kick off a `git worktree prune` after dispatch completes (or every Nth dispatch), not before.
  3. **On-demand only:** skip prune entirely on `createRunWorktree`. The `resolveExistingRunWorktree` path already validates with `git status` and self-heals; let prune run on the periodic cleanup path (cleanupAll). Worktree-add will fail with a recoverable collision the retry loop already handles.

**Expected gain**
- 50–200ms shaved off every dispatch's pre-stream latency. Captain's spinner-to-first-event window drops correspondingly.

**Risks / breakage**
- If a dispatched worktree got removed externally (user rm -rf'd the dir) and the repo still has a stale registration, `worktree add` may fail with "already registered." The retry loop handles this via the existing `isRecoverableCreateCollision` path. Confirm by running tests with prune disabled.

**Prerequisite**
- Audit `cleanupRecordedWorktree` paths; ensure prune happens at least sometimes (e.g., on serve start, or on cleanupAll).

---

### 2.5 (S5) `list_agents` healthchecks adapters every call, no cache

**Where**
- `src/orchestrator/tools/list-agents.ts:117` — `Promise.all(adapters.map(a => a.healthCheck()))` per call.
- `src/adapters/codex.ts:1310-1340`, `src/adapters/claude-code.ts:1165` — each healthCheck spawns the adapter binary with `--version`, 10s timeout, `reject:false`.
- Captain calls `list_agents` once at session start AND any time it forgets the adapter list (per the skill, before each dispatch decision).

**Why it costs**
3 concurrent subprocess spawns × ~80–300ms each = **300ms** typical, **~1s worst case** on a cold cache. Captain that re-checks on every "should I dispatch?" decision (or after a missing-tool error) pays full cost again.

**Proposed fix**
- TTL cache the per-adapter healthcheck inside the registry (e.g., 30s), keyed by `adapter.name`. The healthcheck is a binary-presence + version probe — those don't change per-second. Bust the cache on `serve` startup so a `crew-mcp install` between sessions takes effect.
- Optionally surface a `force_refresh: true` arg on `list_agents` for the rare case the captain wants a fresh probe.

**Expected gain**
- First call: unchanged. Subsequent calls within 30s: ~0ms. Saves 300ms-1s per redundant `list_agents` invocation.

**Risks / breakage**
- A user who `brew install`s codex mid-session won't see it until the cache expires. Acceptable for a 30s TTL; mention in the description.
- Tests that drive `listAgents` in tight succession may need to flush the cache; expose a `clearHealthCache()` test seam.

---

### 2.6 (S6) Cold-start eagerly loads all adapter modules

**Where**
- `src/adapters/registry.ts:190-196` — `createBuiltinRegistry` instantiates `ClaudeCodeAdapter`, `CodexAdapter`, `GeminiCliAdapter` (not `Generic`/`OpenAiCompatible`, which are only used via `createRegistryFromConfig`).
- `src/cli/commands/serve.ts:217` — called unconditionally on every `buildCrewMcpServer`.
- Adapter modules pull in heavy transitive deps: `execa`, `simple-git`, `zod`, `tool-loop/*`, large constant tables.

**Why it costs**
~98K LOC across the three adapters + their tool-loop helpers + zod schemas all parsed and graph-resolved at serve-start, even though a session typically uses one adapter. On a cold node startup that's hundreds of ms; cumulative with execa's own startup.

**Proposed fix**
- Lazy-instantiate adapters via dynamic `import()` on first `registry.get(name)` or `listAvailable()` call. Keep a `Map<adapterName, () => Promise<AgentAdapter>>` of factories.
- Or, less invasive: keep eager construction but avoid pulling in adapter-specific `tool-loop` modules until the adapter is actually used (move `import { executePromptToolLoop } from './tool-loop/controller.js'` inside the `executeAsCaptain` method behind a dynamic import). The captain-facing surface (`execute`, `healthCheck`) is small.
- Skip the `listAvailable` healthcheck loop until a `list_agents` call actually arrives.

**Expected gain**
- 100–300ms shaved off the time between `crew serve` spawn and first `tools/list` MCP response. User-perceived as "the server appearing in their CLI."

**Risks / breakage**
- Dynamic import breaks tree-shaking assumptions in tsup; verify the bundle still works. A measured midpoint is to keep eager imports but defer construction.

**Prerequisite**
- Measure baseline cold-start with `node --prof dist/index.js serve`; without numbers this is "probably worth it" not "definitely worth it."

---

### 2.7 (other) The dispatcher EventEmitter fans out per-listener filtering

**Where**
- `src/orchestrator/tool-dispatcher.ts:58` — single `EventEmitter` for all in-flight runs.
- `src/cli/commands/serve.ts:904-937` — `installRunLifecycleListeners` adds 4 listeners per run.
- `src/cli/commands/serve.ts:1300-1316` — `waitForRunChange` adds 1–4 listeners per long-poll cycle.

**Why it costs**
Every emit broadcasts to every listener; each listener's first line is `if (info.toolCallId !== args.toolCallId) return;`. With N concurrent runs each having 4 lifecycle + 4 wait-listeners, every `run:stream` chunk runs 8N comparisons. Today N ≤ a handful, so this is fine. The dispatcher will start showing up in profiles only if someone dispatches 20+ concurrent runs.

**Proposed fix (low priority)**
- Per-runId emitter map: `Map<runId, EventEmitter>`. `emit('run:stream', {runId, ...})` looks up and only fans out to the right listeners.
- Or: index listeners by `runId` and fan out manually.

**Expected gain**
- Negligible at current scale. Worth noting because the architecture invites the bug if concurrency grows.

---

### 2.8 (other) `merge_run` runs git commands serially when several are independent

**Where**
- `src/git/worktree.ts:457-515` — `mergeRunWorktree` runs `wGit.status()`, then `wGit.add('.')` if dirty, then `wGit.commit`, then `this.git.status()`, then `wGit.revparse(['HEAD'])`, then `this.git.revparse([target])`, then `this.git.checkout`, then `this.git.merge`.

**Why it costs**
Each `simple-git` call is its own child process. ~9 spawns serial = ~500–900ms of pure git overhead before the actual merge work. The two `revparse` calls are independent — `git rev-parse HEAD <target>` would do both in one spawn. The two `status` calls (worktree + main) are also independent.

**Proposed fix**
- Use `git.raw(['rev-parse', 'HEAD', target])` and parse two SHAs from one output.
- Run worktree status + main status concurrently (`Promise.all`). simple-git's underlying execa supports independent child processes fine.

**Expected gain**
- 200–400ms on the merge call. User-perceived because the merge is a synchronous tool call from the captain's perspective.

---

### 2.9 (other) Adapter progress chunks get double-prefixed for hosts that render notifications/progress

**Where**
- `src/adapters/codex.ts:81` — `CODEX_STREAM_PREFIX = '[codex] '` injected by `codexStreamLine`.
- `src/adapters/claude-code.ts:50` — `CLAUDE_PROGRESS_PREFIX = '[claude-code] '` injected by `claudeProgressLine`.
- `src/cli/commands/serve.ts:967-985` — `formatProgressLines` then prepends `[<agentName>] ` to each line **again** before sending the notification.

**Why it costs**
A codex chunk like `[codex] command: started npm test` becomes `[codex] [codex] command: started npm test` in the host UI's progress notification. Doesn't hit the captain's context (notifications don't), but wastes ~10 chars × 240-char budget = ~4% of the per-line budget that could carry actual content. Also occasionally truncates something that would otherwise have fit.

**Proposed fix**
- Detect and strip a leading `[<agentName>] ` (or any `[<word>] `) before reapplying. Or: drop the adapter-side prefix entirely now that the server adds one — the adapter prefix predates the server's, so it's vestigial.

**Expected gain**
- Cosmetic + a few extra chars per progress line in the host UI.

---

### 2.10 (other) `tail.command` helper rewritten on every `create()`

**Where**
- `src/orchestrator/run-state.ts:176-211` — `writeTailCommandHelper` runs on every `create()` even for a `runId` that already exists (it doesn't, since `runId = randomUUID`, but the cost is paid for runs the user never tails).

**Why it costs**
`mkdirSync` + `writeFileSync` + `chmodSync` ≈ 3 syscalls per dispatch, ~1–2ms. Negligible per dispatch but pure waste for runs where the user never opens the helper.

**Proposed fix**
- Generate lazily on the first `tailCommandPath()` *read* — but the dispatch envelope always includes the path, so the call site assumes existence. Easier: leave it. Or move to a single template + `O_EXCL` so the second call is a no-op error (free).

**Expected gain**
- Marginal. Listed for completeness.

---

### 2.11 (other) `stat` storms inside `RunStateStore.read` via `existsSync`

**Where**
- `src/orchestrator/run-state.ts:221`, `:382`, `:403` — `existsSync` precedes every `readFileSync` / `appendFileSync`.

**Why it costs**
`existsSync` is a `stat`. Then the read does its own `open` (which would have surfaced ENOENT). Two syscalls where one would do.

**Proposed fix**
- `try { readFileSync } catch (err) { if (err.code === 'ENOENT') return undefined; throw }`. Same for the events path. Removes one syscall per `read`.

**Expected gain**
- Couples with §2.2: the in-memory state cache eliminates most reads anyway. Worth doing as part of the same pass.

---

## 3. Context-usage findings

### 3.1 (C1) Skill body is 419 lines / ~3.8K tokens, with substantial intra-document overlap

**Where**
- `skills/crew-captain.body.md` — 419 lines, loaded into the captain's context on every "crew" trigger via `renderSkill` + per-host template wrapper.
- The SKILL_DESCRIPTION (`src/install/skill-renderer.ts:39`) is also ~80 tokens, loaded on every session.

**Why it costs**
Every dispatch session that loads the skill pays the tax once. Some of the largest contributors:
- Lines 17–77: framing + "escape hatch" + "dispatch-vs-inline" + "decision order spine" — three different ways to say "decide whether to dispatch, default inline."
- Lines 78–106: "default flow — code → review → iterate → merge" overlaps the decision-order spine and the polling-lifecycle section.
- Lines 144–178: the "when to ask the user" rubric is 5 numbered items + a 2-paragraph epilogue + an exception clause. Same idea could be 4 lines.
- Lines 180–308: polling-lifecycle is 130 lines, with a worked-shape example (lines 285–308) that re-asserts the contract a third time.
- Lines 319–419: tools list intro + operating guardrails (8 sub-bulleted rules averaging 8 lines each, with repeat references to `read_only` / `effort` / `model`).

The body grew incrementally — every plan that landed added a paragraph. The intra-document overlap is now the dominant inefficiency.

**Proposed fix**
1. **Collapse "decision order" + "default flow" into a single 6-line procedure.** The current redundancy is "spine" (5 steps) followed by "default flow" (5 steps) covering the same ordering with different prose.
2. **Polling-lifecycle: keep "the polling loop" + "cancellation"; drop "worked shape"** (lines 285–308). The prose contract is sufficient; the verbatim trace is illustrative but expensive.
3. **Trim "how users follow progress (not your problem)"** (lines 263–283): one sentence — "The user has independent progress channels (`tail_url` on macOS, MCP `notifications/progress` on supporting hosts); don't duplicate them."
4. **Operating guardrails:** the `effort` block (lines 392–411) is ~120 lines including the rough mapping. Move the mapping to the per-`run_agent` description (it's reference, not behavior). Keep one sentence in the body.
5. **`read_only` block** (lines 366–391) — same: move the caveats list into the `run_agent` description; keep the one-line "Pass `read_only: true` for review/triage" rule in the body.
6. **Strip the "when to ask the user" rubric epilogue** (lines 168–178): the rubric items themselves carry the gating; the "skip when none hold" caveat plus the "if user already answered" caveat plus the "trivial asks shouldn't be ceremonious" caveat are three negative-space restatements of the same idea.

Realistic target: 419 → ~180 lines (~1.5–1.8K tokens), a 50–60% cut without losing the load-bearing rules.

**Expected gain**
- ~2K tokens off every captain session that loads the skill. For users running multiple sessions per day, accumulates fast.

**Risks / breakage**
- The skill body has had several rewrites driven by real captain failure modes (the "stay in same turn" hard rule, the "always pass commit_title" guidance, the read-only sticky-bit behavior). Cutting too aggressively risks regressing those behaviors.
- Mitigation: keep the *rules* verbatim, cut the *justifications* and *worked examples*. The captain doesn't need to be persuaded; it needs to be told.

**Prerequisite**
- Coordinate with the existing `docs/plans/completed/skill-body-strengthen-polling.md` and the parked `long-poll-cost-tuning.md` so we don't regress the silent-polling discipline added there.

---

### 3.2 (C2) Dispatch envelope ships 5 path/URL fields for 2 underlying paths

**Where**
- `src/cli/commands/serve.ts:761-772` — `RunEnvelope` populated with `worktree_path`, `events_log_path`, `tail_command_path`, `tail_command_url`, `tail_url`.
- `src/cli/commands/serve.ts:793-815` — `renderDispatchMarkdown` then renders 4 of those 5 inline (worktree, tail link, manual tail, follow-with).
- Captain stores both the markdown text and the structured envelope in its conversation history.

**Why it costs**
`tail_url`, `tail_command_url`, `tail_command_path` are three encodings of the same concept (open Terminal on `events.log`). `events_log_path` and `worktree_path` are two more paths the captain sees once and almost never re-uses programmatically (it has the run_id; everything else is derivable on the server). On Claude Code the structured payload is JSON-serialized in the tool result; on hosts that cache tool calls in context, this is sticky.

The skill body even tells the captain to relay only ONE path (lines 226–236): the inline `tail_url` markdown link. Yet the envelope ships all 5.

**Proposed fix**
1. Drop `tail_command_path` and `tail_command_url` from the envelope. The shell helper still gets generated (it's cheap), but the URL is only needed when the macOS handler isn't installed — and the markdown's `tail -F <path>` line already covers that case via the literal path.
2. Drop `events_log_path` from the envelope (or keep it and drop `tail_url` — pick one). The captain doesn't read events.log directly; only the user does, via `tail -F`.
3. The dispatch markdown's "Worktree:" line is rarely actionable for the captain (it has the run_id). Keep it for one more cycle, then consider moving it under a "verbose:true" flag.
4. **Backward compat:** these fields are documented as part of `RunEnvelope` and consumers exist. Mark deprecated for one minor; remove in v0.3. Or keep on `structuredContent` and remove from the markdown.

**Expected gain**
- ~150–250 chars per dispatch, sticky across the whole conversation. Across a 5-dispatch session, ~1K context tokens reclaimed.
- Markdown becomes ~3 lines instead of 6.

**Risks / breakage**
- Any host or captain code that programmatically reads `tail_command_url` (vs. `tail_url`) — the long-poll plan calls this out as "preserved on the envelope for back-compat structured consumers." Audit before removing.

---

### 3.3 (C3) Terminal `get_run_status` ships three overlapping synthesis surfaces

**Where**
- `src/cli/commands/serve.ts:1235-1248` — terminal payload includes `summary` (top-level, last turn's adapter output, **uncapped**), `prompts: TerminalPromptRecord[]` (one record per turn with `{turn, startedAt, completedAt}`), and `events_tail` (default 10 lines, capped 500).
- `src/orchestrator/run-state.ts:282-293` — comments document that summary is intentionally uncapped (p99=9.9K, max=12K chars).

**Why it costs**
The three fields overlap in purpose:
- `summary` = the agent's final output. Authoritative.
- `events_tail` = the last N events.log lines. Often contains the same final assistant message + a bunch of per-tool receipts.
- `prompts` = per-turn metadata; for terminal poll, only the last turn matters (timestamps for prior turns are derivable from the captain's prior tool returns or from state.json on demand).

In a real terminal poll the captain receives:
- 9.9K-char `summary` (p99)
- 10 lines of `events_tail` (~1–3K chars typically), often duplicating the tail of `summary`
- N×40 chars of `prompts` metadata
- `filesChanged` (small, useful)

Total payload: 12–15K chars / ~3–4K tokens per terminal poll, when the captain only needs `summary` + `filesChanged` + maybe a 2–3 line evidence tail to write its synthesis.

**Proposed fix**
1. **Drop `prompts[]` from terminal poll-return.** The captain has the run_id and can call back if it needs turn-history. This is pure metadata it almost never reads.
2. **Lower `DEFAULT_MAX_EVENTS_TAIL` from 10 to 3.** The skill body even says "synthesize, don't dump" (line 257). 3 lines is enough evidence; captains needing more can opt up via `max_events_tail`.
3. **Cap `summary` at the wire boundary** to e.g. 4000 chars with a `summary_truncated: true` flag and a hint to call back with `since_event_line: 0` for the full thing. The run-state.ts comment already flags this as a future option; the multi-turn case has been mitigated, the long-single-turn case has not. p99 is 9.9K, so this caps the worst 1% of runs.
4. **Replace the "(N more events skipped)" sentinel inside `events_tail`** (serve.ts:1198) with the existing `events_tail_skipped` separate field (already shipped at serve.ts:1246). The sentinel inside the array makes the payload self-documenting at the cost of bloating it; the field is the cleaner path.

**Expected gain**
- Terminal poll-return drops from ~12K chars to ~5–6K chars typical, ~7–8K worst case. Per-dispatch savings: ~2K tokens, sticky in captain context until compaction.

**Risks / breakage**
- Capping `summary` is a wire-shape change. Mitigation: `summary` stays uncapped by default, but ship a server-side env-var `CREW_MAX_SUMMARY_CHARS` for power users; flip default in v0.3.
- Dropping `prompts` is a wire-shape change too. Older captains who learned to read it (none today, since the field is recent) would lose access; the skill body never mentions it.
- The skipped-marker change is a presentation-only diff but anyone parsing `events_tail` sees a behavior change. Likely no consumers.

---

### 3.4 (C4) `GET_RUN_STATUS_DESCRIPTION` is a dense ~1.4K-character paragraph

**Where**
- `src/orchestrator/tools/get-run-status.ts:91-92` — single paragraph, ~1400 chars, ~350 tokens.
- Loaded into the captain's tool list once per session (sticky in prompt cache, but still in-context).

**Why it costs**
The paragraph mixes:
- Recommended-default coaching (which lives in the skill body too)
- An explanation of which events count as "signal" (dispatch internals — codex receipts vs item.* — that the captain has no levers over)
- A rationale for why snapshot polls are bad ("create tight polling loops — avoid")
- Wire-shape documentation (terminal vs running response, default tail size, max cap)

The wire-shape doc is essential. The coaching duplicates skill-body content. The internals-rationale doesn't belong in a tool description.

**Proposed fix**
- Tighten to ~3 short sentences:
  > "Poll a run by run_id. Pass `wait_for_change_ms: 30000`, `wait_for_terminal_only: true`, and the prior `next_event_line` as `since_event_line`. While running: `{status, next_event_line}` (or `{status:"running", timed_out:true}` on terminal-only timeout). Terminal: adds `summary`, `filesChanged`, and recent `events_tail` (cap via `max_events_tail`, default 10, max 500)."
- Move the codex-receipt-as-noise explanation to a docs note. The captain doesn't need it.
- Trim `RUN_AGENT_DESCRIPTION` similarly (`src/orchestrator/tools/run-agent.ts:82` is shorter but could mention `read_only` more tersely).

**Expected gain**
- ~250 tokens off the captain's tool-list once per session. Cumulative across the 6 tool descriptions if all get a similar pass, ~500–800 tokens.

**Risks**
- Tool descriptions are how captains learn to call the tool when the skill body isn't loaded (fresh session before the trigger fires). Don't strip *required* coaching — only duplicated coaching.

---

### 3.5 (other) Skill body's `Operating guardrails` re-explains tool semantics

**Where**
- `skills/crew-captain.body.md:328-419` — bullets about `merge_run`/`discard_run`/`agent_id`/aliases/`available:false`/`strengths`/`model`/uncommitted-state/`read_only`/`effort`/persistence.

Most of these are *references* (what each field means) rather than *behaviors* (when to do what). They duplicate the tool descriptions and the `list_agents` schema.

**Proposed fix**
- Move references into `LIST_AGENTS_DESCRIPTION` (currently a 1-liner — could expand modestly), `RUN_AGENT_DESCRIPTION`, etc., where they live next to the tool the captain is invoking.
- Keep behavior rules in the skill body. "Skip agents where `available: false`" stays. "`continue_run` does NOT take `agent_id`" — move to `CONTINUE_RUN_DESCRIPTION`.

**Expected gain**
- Reinforces the C1 cut. Tool descriptions are loaded once into the prompt cache and stay there; the skill body is loaded on trigger. Pushing reference material to descriptions is strictly better for cache reuse.

---

### 3.6 (other) `RunStateV1.prompts[].prompt` retains verbatim user prompts forever

**Where**
- `src/orchestrator/run-state.ts:42` — every turn's `prompt` text is durable in state.json.
- `get_run_status` projects a slimmed `TerminalPromptRecord` that omits `prompt` and `summary`, so this doesn't leak to the captain. Good.
- But the on-disk file grows with prompt size × turn count; for very long (multi-thousand-line) prompts this matters for the §2.2 read cost.

**Proposed fix**
- Optional: cap prompt storage at e.g. 16KB with truncation marker. Captain rarely reads back its own historical prompts; users who want full history can grep events.log.
- Lower priority than §2.2 itself.

---

### 3.7 (other) Adapter `output` text in `summary` is also persisted in `events.log`

**Where**
- Stream chunks containing the agent's final message are appended to `events.log` (serve.ts:920) AND end up in `summary` via `markTerminal` (serve.ts:874).

So the captain's terminal poll-return potentially has the same final paragraph from both `summary` and `events_tail`.

**Proposed fix**
- The §3.3 cuts (lower default `events_tail` to 3) substantially mitigate this. A more aggressive option: dedupe `events_tail` lines that are a substring of `summary` server-side. Probably not worth the complexity.

---

## 4. Cross-cutting observations

### 4.1 Architecture: state.json is the cache of truth, but it's also the wire payload

The same shape used for durable on-disk persistence is what `get_run_status` projects to the captain. That means schema growth on disk grows the wire payload by default — see how `prompts[].summary` was the multi-turn bloat that the M3 cut at serve.ts:1226 had to specifically avoid. Future fields will repeat the pattern.

**Suggestion:** make the disk schema and the wire schema two distinct types. Keep the ergonomics ("read state, return mostly the same fields"), but force every new field to opt into wire visibility explicitly. Catches the bloat at the type level instead of the next perf audit.

### 4.2 Adapter event semantics are unstandardized

Each adapter formats its own progress lines (`[codex] turn: ...`, `[claude-code] message: ...`, gemini emits a single block at the end with no streaming). The result:
- Noise filtering is codex-only (events-filter.ts comments confirm this).
- Gemini gives the user zero progress feedback (gemini-cli.ts:334 emits one chunk on completion).
- The skill body has to coach captains around per-host quirks ("known: codex CLI 0.128.0 omits the token").

A common adapter event protocol — even just `{kind: 'thinking'|'tool'|'message'|'error', text: string}` — would let event filtering, progress prefixing, and `events_tail` synthesis become shared infrastructure. This is a bigger refactor than the speed/context findings above, but it's the single largest cross-cutting smell.

### 4.3 `simple-git` cost vs. raw `execa` calls

`simple-git` is convenient but every call is a child process spawn. For the merge path (§2.8) and the worktree path (§2.4), enough git calls happen per dispatch that the spawn overhead is measurable. For the worktree-status probe (worktree.ts:386), porting to `execa` directly with `git status --porcelain=v1` would cut the JS-side parsing too. Reconsider whether the simple-git dependency carries its weight.

### 4.4 The dispatcher's per-emit broadcast model

§2.7 noted this as a perf finding; it's also an architectural smell. The dispatcher exposes `onEvent('run:stream', ...)` rather than `onEvent(runId, 'run:stream', ...)`. As more lifecycle code subscribes (state writer, progress notifier, long-poll waiter, hypothetical metrics emitter), each emit fans out broader. Per-runId emitters or an indexed pub-sub would scale better and would let `cancel_run`-style lookups become O(1) without `listInFlight().find(...)` (serve.ts:617).

### 4.5 Test seams confirm the right invariants but don't test the perf path

`buildCrewMcpServer` accepts pre-built registry / worktree manager / crew-home — good for hermetic tests. But there's no benchmark harness for the long-poll loop, the dispatch hot path, or the `events.log` read pattern. Adding a "synthetic run with N stream chunks, measure long-poll wakeup latency" benchmark would let this perf work be tracked over time instead of one-shot.

### 4.6 The skill body and the tool descriptions are evolving in parallel

There's no enforced consistency check between the skill body's coaching and the tool descriptions (e.g., the skill says "always pass commit_title" and `MERGE_RUN_DESCRIPTION` says "Pass commit_title (and optional commit_body)" — agree, but not by construction). A test that diffs key claims would catch drift. Marginal value, probably not worth the framework.

---

## 5. Out of scope / didn't investigate

- **Adapter-internal latency.** I didn't profile what claude-code / codex / gemini-cli spend inside their own subprocess. The crew-mcp side bills ~2–5% of total wall time on a typical dispatch; the rest is the agent's own model latency, which we can't speed up from this side.
- **MCP SDK overhead.** I didn't measure how much time `@modelcontextprotocol/sdk`'s stdio framer adds per request. The framing protocol is light; if it shows up in profiles, that's a different audit.
- **Install command performance.** `crew-mcp install` runs once per host setup; not in the hot path. Skipped.
- **Tail-handler app.** Out of process, runs on the user's machine independent of crew-serve. Skipped.
- **`workflow/` and `agent-prefs/` modules.** Read enough to understand the call sites used by the hot path; didn't audit `config-codec` / `config-validation` / `config-repository` for their own internal optimizations because they're loaded once at startup and never on the dispatch path.
- **Tests under `test/`.** I read the structure but didn't run them. Any change above would need a vitest pass; I trust the existing coverage to surface contract breakage.
- **Token-cost numbers.** I quote rough char-counts (419 lines / ~3.8K tokens at ~9 chars/token). Real per-model tokenizer counts may shift these by 10–20%. The relative magnitudes are correct.
- **Whether the captain actually calls `list_agents` more than once per session.** Suspect it does (the skill encourages re-checking on missing-tool errors), but didn't trace real captain transcripts. If `list_agents` is in fact called once and never again, S5 is moot.
- **`onProviderSession` / tool-loop adapter paths.** Used only when the adapter is the *captain*, not when it's a dispatched subagent. Crew today is host-as-captain, so this path is dormant for the audited use case.
- **Whether `git worktree add` itself can be sped up.** It's the dominant pre-dispatch cost (~300–800ms) but it's git's cost, not ours. A `--no-checkout` option followed by lazy-checkout-of-needed-files would matter for very large repos but is a deep change.

---

## Appendix: rough impact stack-rank if you only do 5 things

1. **§2.1 incremental events.log reads** — biggest single per-poll win on long runs.
2. **§3.1 skill body cut** — single biggest captain-context win.
3. **§3.3 trim terminal poll-return** — biggest per-dispatch context win.
4. **§2.4 drop `git worktree prune` from hot path** — biggest dispatch-latency win.
5. **§2.5 cache list_agents healthcheck** — biggest repeated-call win.

Bundle 1 + 2 + 4 first: those are independent, have no cross-dependencies, and together address the three different cost surfaces (per-poll IO, per-session context, per-dispatch latency).
