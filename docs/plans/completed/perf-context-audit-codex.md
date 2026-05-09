**Status:** Superseded 2026-05-09. Findings folded into `docs/plans/active/perf-context-audit-merged.md`, which prioritizes by agreement → feasibility → impact across this report and the Claude parallel audit. Kept here for the original prose, file:line references, and rationale.

---

# Performance and Context Audit - Codex

Date: 2026-05-09

Scope: `crew-mcp` MCP server dispatch, polling, merge, adapter, run-state, install-time skill, and prompt surfaces. This is an audit report only; it does not propose this branch as an implementation PR.

Notes:
- The repository has no `src/mcp/` tree in this checkout. The live MCP server and tool handlers are in `src/cli/commands/serve.ts`, with tool definitions under `src/orchestrator/tools/`.
- The requested `docs/plans/active/long-poll-cost-tuning.md` path does not exist. The current plan is `docs/plans/parked/long-poll-cost-tuning.md`; I treated that parked plan as authoritative.
- `docs/status/captain-flow-review-2026-04-29.md` remains the durable status baseline. This audit does not materially change its runtime claims, so I did not update it.

## 1. Executive summary

1. Cache or split `list_agents` health checks: a single inventory call currently spawns every provider CLI and Claude Code can perform a real auth probe (`src/orchestrator/tools/list-agents.ts:111`, `src/adapters/claude-code.ts:1165`); impact high, cost low/medium.
2. Move `git worktree prune` off the dispatch hot path: every write-mode `run_agent` pays a prune before creating a brand-new UUID worktree (`src/git/worktree.ts:297`); impact high, cost low.
3. Replace synchronous per-chunk event-log writes plus full-file status reads with a buffered append path and indexed tail reads (`src/orchestrator/run-state.ts:368`, `src/orchestrator/run-state.ts:398`, `src/cli/commands/serve.ts:1169`); impact medium/high, cost medium.
4. Split hot run status from full run archive: `get_run_status` repeatedly parses full `state.json`, which stores prompts and terminal summaries even when a running poll only needs status (`src/cli/commands/serve.ts:529`, `src/orchestrator/run-state.ts:219`); impact medium, cost medium.
5. Lazy-load non-serve CLI command modules so `crew-mcp serve` does not import install/status/verify stacks before command dispatch (`src/index.ts:1`, `src/cli/commands/install.ts:21`); impact medium, cost low.
6. Shorten `GET_RUN_STATUS_DESCRIPTION` and the rendered skill tool list: the long polling contract is duplicated in the MCP descriptor, static catalog, and skill body (`src/orchestrator/tools/get-run-status.ts:91`, `src/install/skill-renderer.ts:143`, `skills/crew-captain.body.md:180`); impact high, cost low.
7. Stop pretty-printing full structured payloads into MCP `content` when `structuredContent` carries the same object (`src/cli/commands/serve.ts:1321`); impact medium/high, cost medium.
8. Cap or side-channel terminal summaries: stored adapter summaries are known to reach p99 9.9K chars and are shipped as top-level `summary` on terminal polls (`src/orchestrator/run-state.ts:281`, `src/cli/commands/serve.ts:1231`); impact medium/high, cost medium.
9. Compact tool-loop prompts and tool-result transcripts: adapter captain loops replay full JSON tool outputs and a verbose response schema into later prompts (`src/adapters/tool-loop/transcript.ts:87`, `src/adapters/claude-code.ts:996`, `src/adapters/openai-compatible.ts:198`); impact high, cost medium/high.
10. Avoid double parsing adapter streams that were already parsed for progress, especially Codex and Claude Code JSONL (`src/adapters/codex.ts:482`, `src/adapters/codex.ts:565`, `src/adapters/claude-code.ts:490`, `src/adapters/claude-code.ts:567`); impact medium, cost medium.

## 2. Speed findings

### S1. `list_agents` performs heavyweight live health checks on every call

What it is:
- The MCP `list_agents` handler reads agent prefs and calls `listAgents` every time (`src/cli/commands/serve.ts:242` through `src/cli/commands/serve.ts:255`).
- `listAgents` calls `adapter.healthCheck()` for each adapter concurrently (`src/orchestrator/tools/list-agents.ts:111` through `src/orchestrator/tools/list-agents.ts:168`).
- Claude Code health check does both `claude --version` and a real prompt invocation, `claude -p 'respond with OK' --output-format json --max-turns 1`, with a 30s timeout (`src/adapters/claude-code.ts:1165` through `src/adapters/claude-code.ts:1241`).
- Codex and Gemini still spawn their CLIs for `--version` (`src/adapters/codex.ts:1310`, `src/adapters/gemini-cli.ts:422`).

Why it costs:
- The skill says the default dispatch flow obtains `agent_id` from `list_agents` (`skills/crew-captain.body.md:80` through `skills/crew-captain.body.md:82`) and guardrails emphasize using the returned health fields (`skills/crew-captain.body.md:332` through `skills/crew-captain.body.md:347`).
- In practice, a captain can pay several process spawns before every dispatch. Claude's auth probe is especially expensive because it can allocate a model turn or wait on auth/network behavior.

Proposed fix:
- Add an in-process health cache in `serve.ts` or `AgentRegistry` keyed by adapter id, binary path/version, and relevant preference fields. Use a short TTL for failures, longer TTL for successes (for example 30s failure, 5m success).
- Split inventory from deep health: keep `list_agents` cheap by default, and add optional `include_health: "fresh"` or a future `check_agents` tool for forced probes.
- For Claude Code, make the real prompt probe opt-in. Default health can be binary/version plus cached "last auth ok" from a previous dispatch or explicit fresh check.

Expected gain:
- Removes 2-4 CLI spawns from common dispatches and avoids a Claude model/auth probe in the hot path. Rough impact is high for cold or auth-slow machines and medium for already-warm local CLIs.

Risks / breakage:
- Public structured fields can remain unchanged, but values may be cached/stale. Include a `health_checked_at` or `health_stale` field only if additive fields are acceptable.
- If no new field is added, document that `available` is cached inside the skill/body. A user might fix auth and need one forced refresh.

Prerequisite work:
- Add tests around cached health, stale failure refresh, and forced refresh.
- Update `skills/crew-captain.body.md` so the captain does not assume `list_agents` is a fresh live probe on every call.

### S2. Worktree allocation prunes every dispatch and performs redundant existence resolution

What it is:
- `createRunWorktree` calls `git worktree prune` for every write-mode run (`src/git/worktree.ts:297` through `src/git/worktree.ts:300`).
- Immediately after pruning, it calls `resolveExistingRunWorktree` for the new UUID run id (`src/git/worktree.ts:301` through `src/git/worktree.ts:304`).
- `planRunAgent` generates a fresh UUID and waits for `createRunWorktree` before `run_agent` can return the async-first envelope (`src/orchestrator/tools/run-agent.ts:174` through `src/orchestrator/tools/run-agent.ts:187`).

Why it costs:
- `git worktree prune` scans worktree metadata and can touch the filesystem broadly. It is cleanup work, not required for a fresh UUID allocation.
- `resolveExistingRunWorktree` is useful for idempotent recovery, but a cryptographically fresh run id should not need the same work before the common path can proceed.

Proposed fix:
- Remove `git worktree prune` from the dispatch hot path. Run it on explicit cleanup, server startup with throttling, or a periodic best-effort maintenance path outside `run_agent`.
- Skip `resolveExistingRunWorktree` for freshly generated run ids, or make it debug/assertion-only behind a collision recovery branch.
- Preserve lock acquisition; the lock is still the correctness guard for concurrent operations (`src/git/worktree.ts:950` through `src/git/worktree.ts:989`).

Expected gain:
- Saves at least one Git subprocess from every write dispatch, plus filesystem scanning. On large repos or machines with many stale worktrees, this can be hundreds of milliseconds to seconds.

Risks / breakage:
- Stale worktree cleanup becomes less eager. Add a bounded startup/maintenance prune or leave cleanup to `discard_run`/`merge_run`.
- If a UUID collision ever happened, skipping existing resolution would surface as a failed `git worktree add`; handle that by retrying a new id.

Prerequisite work:
- Tests for stale worktree behavior and cleanup command coverage.
- A metric/log line for maintenance prune duration would make future regressions visible.

### S3. Uncommitted-state mirroring is synchronous and repeats on create and continue

What it is:
- Worktree creation always calls `syncUncommittedToWorktree` after `git worktree add` (`src/git/worktree.ts:317`).
- `continue_run` also calls `syncUncommittedToRunWorktree` before dispatching a follow-up (`src/cli/commands/serve.ts:368` through `src/cli/commands/serve.ts:370`).
- `syncUncommittedToWorktree` runs `git status`, then copies/removes each path with synchronous filesystem operations (`src/git/worktree.ts:382` through `src/git/worktree.ts:430`).

Why it costs:
- This is the right product behavior, but it is a serial hot-path step. Large untracked files, generated assets, or many modified files block `run_agent`/`continue_run` before the agent process starts.
- The code uses synchronous `existsSync`, `statSync`, `mkdirSync`, `copyFileSync`, and `rmSync` inside the path loop (`src/git/worktree.ts:397` through `src/git/worktree.ts:425`).

Proposed fix:
- Keep the behavior but optimize the implementation: use `git status --porcelain=v1 -z --untracked-files=normal` directly, then async copy with a small concurrency limit.
- Cache a host repo status fingerprint between create and immediate continue only when the repo did not change. Do not skip resync on blind trust; the skill promises user edits between turns flow through (`skills/crew-captain.body.md:358` through `skills/crew-captain.body.md:365`).
- Add size/path count logging for sync so future "dispatch feels slow" reports identify whether this is the cause.

Expected gain:
- Low for clean repos, medium/high for dirty repos with many files. The biggest gain is reducing event-loop blocking.

Risks / breakage:
- Async parallel copy must preserve delete/copy ordering for renames and deleted tracked files.
- `git status` parsing must retain current behavior around ignored files and rename targets.

Prerequisite work:
- Regression tests for modified, untracked, deleted, and renamed files.
- Optional instrumentation around copied byte count and duration.

### S4. Event logging blocks the server per stream chunk

What it is:
- The run lifecycle listener appends every formatted stream chunk into `events.log` (`src/cli/commands/serve.ts:917` through `src/cli/commands/serve.ts:935`).
- `RunStateStore.appendEvent` calls `mkdirSync(dirname(path), { recursive: true })` and `appendFileSync` for every chunk (`src/orchestrator/run-state.ts:368` through `src/orchestrator/run-state.ts:372`).

Why it costs:
- Chatty adapters can emit many small chunks. Each chunk performs a directory check and a synchronous append on the MCP server event loop.
- This competes directly with MCP request handling, long-poll wakeups, progress notifications, and cancel handling.

Proposed fix:
- Create the run directory once in `create` and remove the per-chunk `mkdirSync`.
- Replace per-chunk `appendFileSync` with a per-run append queue or `fs.createWriteStream` that batches writes per tick. Flush on terminal/cancel before reporting terminal state.
- Consider source-side noise suppression for receipt-only Codex events, but treat that as a product choice. The parked noise plan already notes that suppressing receipts from the adapter changes `events.log` chronology (`docs/plans/parked/noise-filter-at-source.md:120` through `docs/plans/parked/noise-filter-at-source.md:145`).

Expected gain:
- Medium/high on long or chatty Codex/Claude runs. Low on quiet adapters. The main gain is event-loop responsiveness, not just wall-clock runtime.

Risks / breakage:
- Buffered writes must not lose terminal events on crash. Current writes are synchronous but not fsynced; moving to a stream is not a major durability downgrade if terminal flush is explicit.
- Tests that assume immediate event visibility need deterministic flush hooks.

Prerequisite work:
- Add a small `RunEventWriter` abstraction with tests for ordering, terminal flush, and cancellation.
- Keep tail behavior intact for users running `tail -F`.

### S5. `get_run_status` reads full event logs, and terminal status can read the same file twice

What it is:
- `buildGetRunStatusResponse` always calls `store.readEventsSince(runId, sinceLine)` to calculate `next_event_line` (`src/cli/commands/serve.ts:1169`).
- For terminal statuses, it then calls `store.readEventsSince(runId, 0).lines` to get the full log for terminal tail construction (`src/cli/commands/serve.ts:1189`).
- `readEventsSince` reads the entire `events.log`, splits it into all lines, and slices (`src/orchestrator/run-state.ts:398` through `src/orchestrator/run-state.ts:408`).
- Non-terminal-only fast-return checks call `readSignalEventsSince`, which delegates to the same full-file reader (`src/orchestrator/run-state.ts:426` through `src/orchestrator/run-state.ts:432`).

Why it costs:
- The default terminal-only timeout path is deliberately lean and avoids event-tail reads when it times out (`src/cli/commands/serve.ts:591` through `src/cli/commands/serve.ts:594`), which is good.
- The expensive path remains terminal responses and non-terminal-only polling: every read is O(full log size), sync-blocking, and terminal responses can do two complete reads.

Proposed fix:
- Add a single `readEventsSnapshot(runId, { sinceLine, terminalTailLimit })` that returns `nextLine`, optional `delta`, and optional bounded terminal tail from one pass.
- Better: maintain an in-memory line count and byte offset per run while the server is alive, plus a fallback full scan after restart.
- For terminal tail, read from the end of the file until enough newlines are found instead of reading the full log. Preserve skipped-line accounting via the line count index.

Expected gain:
- Medium on normal runs, high on verbose runs and on terminal polls after long sessions. It also reduces tail latency at exactly the moment the captain is waiting to summarize.

Risks / breakage:
- Cursor semantics are externally visible. Existing tests assert cursor/tail behavior across terminal-only and non-terminal-only modes (`test/cli/commands/serve.test.ts:1578`, `test/cli/commands/serve.test.ts:1674`, `test/cli/commands/serve.test.ts:2144`).
- Restart fallback must still return correct `next_event_line`.

Prerequisite work:
- Add file-size/log-line fixtures to tests.
- Introduce a line-index abstraction behind `RunStateStore` rather than changing tool handlers directly.

### S6. Long-poll status rereads and reparses full run state even for tiny timeout responses

What it is:
- `get_run_status` reads `state.json` before deciding whether to long-poll (`src/cli/commands/serve.ts:529`).
- After the wait resolves, it reads `state.json` again (`src/cli/commands/serve.ts:591`).
- `RunStateStore.read` uses `existsSync`, `readFileSync`, and `JSON.parse` on the full run state (`src/orchestrator/run-state.ts:219` through `src/orchestrator/run-state.ts:243`).
- Run state includes full prompts and terminal summaries (`src/orchestrator/run-state.ts:40` through `src/orchestrator/run-state.ts:47`, `src/orchestrator/run-state.ts:294` through `src/orchestrator/run-state.ts:329`).

Why it costs:
- The lean terminal-only timeout payload is just `{ status: "running", timed_out: true }`, but the server still pays full state parse before and after the wait.
- For multi-turn runs, `state.json` can grow with prompt history and full summaries, so the parse cost increases over time even though the running poll usually needs only status and terminal metadata.

Proposed fix:
- Keep a server-local in-memory run status cache updated by `RunStateStore.create`, `markTerminal`, `markCancelled`, and `update`. Use the file as durable recovery, not as the first source for hot in-process polls.
- Or split state into a small hot `status.json` (`status`, `agentId`, `readOnly`, timestamps, terminal marker) and a full archive file (`prompts`, summaries, paths).
- For long-poll timeout, avoid the second full read unless the event that woke the poll could have changed terminal status.

Expected gain:
- Medium for long-running polling sessions and large multi-turn runs. It also removes sync disk IO from the common timeout loop.

Risks / breakage:
- Must keep restart semantics. After server restart, in-memory cache is empty and must hydrate from disk.
- Splitting files changes internal storage but not public MCP shape if done behind `RunStateStore`.

Prerequisite work:
- Add tests for restart hydration, cancellation, and terminal status after in-memory cache invalidation.

### S7. `crew-mcp serve` cold-start imports unrelated command stacks

What it is:
- `src/index.ts` imports all command handlers before Commander parses the subcommand (`src/index.ts:1` through `src/index.ts:8`).
- Those imports include install-time host wiring and catalog rendering (`src/cli/commands/install.ts:21` through `src/cli/commands/install.ts:58`), status registry code (`src/cli/commands/status.ts:1` through `src/cli/commands/status.ts:17`), and verify host/catalog code (`src/cli/commands/verify.ts:17` through `src/cli/commands/verify.ts:24`).
- The binary points at one bundled entry (`package.json:6` through `package.json:8`), and `tsup` bundles that entry (`tsup.config.ts:3` through `tsup.config.ts:10`).

Why it costs:
- `crew-mcp serve` is the most latency-sensitive command because hosts start it as the MCP server. Importing installation and verification code before selecting `serve` adds cold-start parse/evaluation cost and possibly transitive dependency initialization.

Proposed fix:
- Change Commander actions to lazy dynamic imports, for example `program.command('serve').action(async () => (await import('./cli/commands/serve.js')).serveCommand())`.
- Stronger option: add a dedicated `crew-mcp-serve` bin that imports only the serve path, while retaining `crew-mcp serve` for human CLI compatibility.
- Keep `dist/index.js` as the public bin but make non-serve imports lazy.

Expected gain:
- Medium for MCP cold start. I could not benchmark it in this worktree because dependencies/build artifacts were not installed, but the import graph makes this a low-risk target.

Risks / breakage:
- Dynamic import changes stack traces slightly and may affect bundling. Verify `tsup` still emits usable ESM chunks or bundle settings still inline lazily loaded modules.
- Tests that import command functions directly should not change.

Prerequisite work:
- Add a smoke test or script that measures `crew-mcp serve` time-to-initialize and listTools readiness.

### S8. Adapter stream parsers often parse progress once and parse buffered stdout again

What it is:
- Codex streaming parses each JSONL line to emit progress (`src/adapters/codex.ts:482` through `src/adapters/codex.ts:515`), then after exit parses `result.stdout` into events again (`src/adapters/codex.ts:565` through `src/adapters/codex.ts:568`).
- Claude Code streaming formats stream lines as they arrive (`src/adapters/claude-code.ts:490` through `src/adapters/claude-code.ts:503`), then reparses collected stdout to extract the final envelope (`src/adapters/claude-code.ts:567` through `src/adapters/claude-code.ts:573`).

Why it costs:
- Long runs can produce large JSONL output. The code pays JSON parsing CPU during streaming and again after process exit. Execa also buffers stdout by default, adding memory pressure.

Proposed fix:
- For Codex, use the streaming parser as the source of truth: collect final message, file-change events, errors, and raw events incrementally while emitting progress.
- Consider `buffer: false` or equivalent execa settings so stdout is not retained wholesale when streaming is active. Keep a bounded diagnostic tail for error reporting.
- For Claude Code, capture the `result` message from stream-json incrementally and avoid scanning full stdout unless no stream parser ran.

Expected gain:
- Medium for verbose runs. This is a CPU and memory improvement more than a latency fix for short dispatches.

Risks / breakage:
- Error handling currently depends on post-process stdout/stderr parsing. Preserve enough buffered tail for diagnostics and tests.
- Some adapters may emit malformed partial lines; streaming parser must retain current tolerance.

Prerequisite work:
- Fixture tests with long JSONL streams, malformed lines, and final result extraction.

### S9. Post-run Git status probes can duplicate adapter file-change data

What it is:
- After a write-mode adapter finishes, `buildAdapterDispatchTask` calls `getModifiedFilesByRun` if the adapter did not report `filesModified` (`src/orchestrator/tools/run-agent.ts:372` through `src/orchestrator/tools/run-agent.ts:374`).
- `getModifiedFilesByRun` runs `git status` in the worktree (`src/git/worktree.ts:433` through `src/git/worktree.ts:438`).
- Codex already extracts `file_change` events from its JSONL stream (`src/adapters/codex.ts:575` through `src/adapters/codex.ts:588`).

Why it costs:
- The fallback Git status is useful and should remain, but it becomes redundant if an adapter reliably emits file-change events. It is another subprocess after every write run.

Proposed fix:
- Keep the fallback, but add adapter capability metadata: `reportsFilesModifiedReliably`. For adapters with reliable event data, skip post-run status unless the reported set is empty and the run succeeded.
- Alternatively, run post-run status only for terminal summaries shown to the user, not before marking terminal, but that risks changing `filesChanged` availability.

Expected gain:
- Low/medium per run. Higher in repos where `git status` is slow.

Risks / breakage:
- Adapter-reported paths can miss generated files or tool edits outside recognized events. The fallback is safer.
- Public `filesChanged` quality matters for merge prompts and tests.

Prerequisite work:
- Adapter-specific confidence tests comparing event-reported paths with dirty status.

### S10. Merge flow performs small serial Git operations that can be batched or parallelized

What it is:
- `mergeRunWorktree` performs worktree status, maybe commit, host status, then worktree and target `rev-parse` calls serially (`src/git/worktree.ts:461` through `src/git/worktree.ts:514`).

Why it costs:
- Merge is less frequent than polling or dispatch, but users feel this latency at the approval boundary. Independent Git calls add up on large repos or slow disks.

Proposed fix:
- Parallelize independent reads once branch safety has been established, especially worktree HEAD and target branch HEAD (`src/git/worktree.ts:486` through `src/git/worktree.ts:487`).
- Log merge-stage durations so expensive phases can be identified.
- Do not weaken the current host-dirty check; it prevents unsafe mutation (`src/git/worktree.ts:472` through `src/git/worktree.ts:476`).

Expected gain:
- Low/medium. Worth doing after higher-impact dispatch and polling work.

Risks / breakage:
- Incorrect parallelization could read target branch before checkout assumptions are valid. Keep safety checks sequential.

Prerequisite work:
- Tests for dirty host repo, no-op merge, conflict path, and successful cleanup.

## 3. Context-usage findings

### C1. The `get_run_status` contract is duplicated in a very long tool descriptor and in the skill body

What it is:
- `GET_RUN_STATUS_DESCRIPTION` is a single long string that explains async-first dispatch, required polling arguments, terminal-only behavior, receipt filtering, snapshot pitfalls, timeout payloads, and terminal payloads (`src/orchestrator/tools/get-run-status.ts:91` through `src/orchestrator/tools/get-run-status.ts:92`).
- That description is included in the static install catalog (`src/install/tool-catalog.ts:15` through `src/install/tool-catalog.ts:33`) and rendered into the skill tool list (`src/install/skill-renderer.ts:143` through `src/install/skill-renderer.ts:147`).
- The same polling contract is explained in the canonical skill body (`skills/crew-captain.body.md:180` through `skills/crew-captain.body.md:318`).

Why it costs:
- Captains load tool descriptors and the crew skill. The same long-poll protocol is therefore present multiple times in the prompt context before any run starts.
- The descriptor is useful as a fallback if the skill is not loaded, but the current length is closer to a mini-manual than a tool description.

Proposed fix:
- Shorten `GET_RUN_STATUS_DESCRIPTION` to a compact tool descriptor: "Poll a run. Use `wait_for_change_ms` and, by default, `wait_for_terminal_only: true`; terminal payloads include summary, files, prompts, and tail."
- Keep detailed examples and rationale in `skills/crew-captain.body.md` or architecture docs, not in every descriptor.
- In the rendered skill tool list, include tool names plus one-line descriptions instead of full source descriptions.

Expected gain:
- High context reduction for every crew-triggered host prompt and for install-time catalogs. This is likely one of the cheapest token wins.

Risks / breakage:
- Tool descriptor text is observable through MCP listTools and static catalog. This is not a structured-shape break, but a model/client relying on descriptor detail may behave worse if the skill is absent.
- Keep the shortened text prescriptive enough for non-skill hosts.

Prerequisite work:
- Update `test/install/skill-renderer.test.ts` assertions that currently require polling details in rendered skill output (`test/install/skill-renderer.test.ts:83` through `test/install/skill-renderer.test.ts:116`).

### C2. MCP tool results duplicate structured payloads as pretty JSON text

What it is:
- `jsonContent` returns both `content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]` and `structuredContent: value` (`src/cli/commands/serve.ts:1321` through `src/cli/commands/serve.ts:1327`).
- Many handlers use `jsonContent`, including `get_run_status`, `list_agents`, and error paths (`src/cli/commands/serve.ts:251`, `src/cli/commands/serve.ts:594`, `src/cli/commands/serve.ts:605`).

Why it costs:
- Hosts often retain text content in the model transcript even when they also parse `structuredContent`. Pretty JSON expands whitespace and duplicates every field.
- `get_run_status` terminal responses already include top-level summary, file lists, prompt metadata, and event tail; duplicating them in text wastes captain context.

Proposed fix:
- Prefer compact JSON text (`JSON.stringify(value)`) as a low-risk first step.
- Better: return a short human text line for common status results and rely on `structuredContent` for the full machine payload.
- For large terminal payloads, omit or summarize fields in `content` while preserving the full `structuredContent`.

Expected gain:
- Medium/high, depending on host transcript behavior. It is especially helpful for terminal status and `list_agents` results.

Risks / breakage:
- Public MCP structured fields remain unchanged, but `content[0].text` is observable. Clients that scrape text rather than `structuredContent` could break if fields disappear or text stops being valid JSON.
- Compact JSON is safer than human text, but saves less.

Prerequisite work:
- Audit host clients for text-scraping behavior.
- Update tests that assert exact text formatting, if any. Most existing status tests inspect `structuredContent`.

### C3. Dispatch markdown is more verbose than the captain is supposed to relay

What it is:
- `runDispatchAndRespond` returns a structured envelope plus markdown generated by `formatDispatchContent` (`src/cli/commands/serve.ts:741` through `src/cli/commands/serve.ts:777`).
- The markdown includes run id/status, worktree path, Tail in Terminal link, manual tail command, and a follow-up `get_run_status` hint (`src/cli/commands/serve.ts:793` through `src/cli/commands/serve.ts:815`).
- The skill tells the captain to emit only one line and not relay the rest of the dispatch markdown (`skills/crew-captain.body.md:216` through `skills/crew-captain.body.md:236`).

Why it costs:
- Even if the captain does not relay the markdown, the tool result text can remain in the host's conversation context.
- The structured envelope already carries `run_id`, `worktree_path`, `tail_command_path`, `tail_command_url`, and `tail_url` (`src/cli/commands/serve.ts:761` through `src/cli/commands/serve.ts:772`).

Proposed fix:
- Make dispatch `content` a single compact line: `Dispatched <agent_id> as <run_id>. Tail: <tail_url>.`
- Keep all path fields in `structuredContent`.
- Optionally provide a `verbose_text: true` input later for human CLI/debug consumers, but keep MCP default compact.

Expected gain:
- Medium for every dispatch. It also reduces the mismatch between tool output and skill instruction.

Risks / breakage:
- Existing tests assert specific dispatch markdown pieces (`test/cli/commands/serve.test.ts:306` through `test/cli/commands/serve.test.ts:360`).
- This is not a structured-shape break, but it is a text-output behavior change and should be called out.

Prerequisite work:
- Decide whether text content is part of the public compatibility surface. If yes, version the change or add a compact mode first.

### C4. The canonical crew skill is large and includes duplicated rationale

What it is:
- `skills/crew-captain.body.md` is about 21KB on disk.
- It includes dispatch heuristics, escape hatch, default flow, ask-first rubric, full polling lifecycle, tool list placeholder, guardrails, read-only caveats, effort mapping, and examples (`skills/crew-captain.body.md:17` through `skills/crew-captain.body.md:395`).
- The rendered tool list injects all tool descriptions at `{{TOOL_LIST}}` (`skills/crew-captain.body.md:319` through `skills/crew-captain.body.md:326`, `src/install/skill-renderer.ts:143` through `src/install/skill-renderer.ts:147`).

Why it costs:
- The skill loads on crew-triggered tasks across hosts. Every long paragraph becomes part of the captain's context before it has seen the user's actual request.
- Several sections are important policy but not always needed at runtime, especially detailed rationale and examples after the behavior has stabilized.

Proposed fix:
- Convert the skill body into a short operational card: dispatch criteria, polling loop, merge safety, read-only rule, and tool-name reminders.
- Move rationale, examples, and historical notes to `docs/architecture/` or an appendix not loaded by default.
- Render tool names plus one-line descriptions, not the full catalog descriptions.
- Adjust default-flow wording so `list_agents` is required when the agent identity is unknown or stale, not necessarily before every dispatch once cached inventory exists.

Expected gain:
- High. A 30-50 percent reduction in the skill body would save thousands of prompt tokens on every crew interaction.

Risks / breakage:
- The skill is the product contract for captains. Over-trimming can regress behavior, especially the "stay in the same turn" long-poll rule (`skills/crew-captain.body.md:188` through `skills/crew-captain.body.md:203`).
- Keep the hard rules verbatim or nearly verbatim; trim duplication around them.

Prerequisite work:
- Use existing renderer tests and add an eval fixture for the desired dispatch/poll/merge behavior.
- Coordinate with `docs/status/captain-flow-review-2026-04-29.md`, which records current captain-flow assumptions.

### C5. Terminal summaries are uncapped and shipped as top-level status payload

What it is:
- `RunStateStore.markTerminal` stores adapter `summary` verbatim (`src/orchestrator/run-state.ts:294` through `src/orchestrator/run-state.ts:329`).
- The file includes a measured note: 70-run sample p50 about 2K chars, p90 about 5.9K, p99 about 9.9K, max about 12K (`src/orchestrator/run-state.ts:281` through `src/orchestrator/run-state.ts:292`).
- Terminal `get_run_status` projects the latest turn summary as top-level `summary` (`src/cli/commands/serve.ts:1222` through `src/cli/commands/serve.ts:1248`).

Why it costs:
- A long adapter answer can consume thousands of captain tokens at the terminal poll. The captain then summarizes it again for the user, so the raw summary may be over-detailed for the coordination task.

Proposed fix:
- Add a wire cap for `summary`, for example 4K chars initially, with additive metadata such as `summary_truncated_at` and `summary_full_path`.
- Store the full summary on disk for debugging and merge review. Send the captain a compact summary optimized for decision-making.
- Alternatively ask adapters to produce a shorter "captain summary" separate from full output.

Expected gain:
- Medium/high for long review and implementation runs. Low for short runs.

Risks / breakage:
- Truncating existing `summary` is a breaking behavior change for clients expecting full text. Additive side-channel fields reduce the risk but do not remove it if the existing field is capped.
- A too-small cap could hide crucial failure details. Include error fields and tail separately.

Prerequisite work:
- Decide a public compatibility policy for summary truncation.
- Add tests for truncated success, failed, and cancelled terminal payloads.

### C6. Adapter tool-loop prompts replay verbose schemas and full tool outputs

What it is:
- `buildDecisionPrompt` appends a verbose "Adapter response format" block every prompt-loop turn (`src/adapters/tool-loop/transcript.ts:87` through `src/adapters/tool-loop/transcript.ts:109`).
- The transcript window keeps up to 24 messages, each truncated to 1500 chars (`src/adapters/tool-loop/constants.ts:1` through `src/adapters/tool-loop/constants.ts:3`, `src/adapters/tool-loop/transcript.ts:13` through `src/adapters/tool-loop/transcript.ts:32`).
- Claude Code stores and re-prompts with full `JSON.stringify(toolResult.output)` (`src/adapters/claude-code.ts:996` through `src/adapters/claude-code.ts:1001`, `src/adapters/claude-code.ts:1021` through `src/adapters/claude-code.ts:1025`).
- Gemini CLI does the same in its resume loop (`src/adapters/gemini-cli.ts:587` through `src/adapters/gemini-cli.ts:606`).
- OpenAI-compatible tool loop stores full function output JSON in messages (`src/adapters/openai-compatible.ts:198` through `src/adapters/openai-compatible.ts:207`, `src/adapters/openai-compatible.ts:311` through `src/adapters/openai-compatible.ts:326`).

Why it costs:
- These paths are used when an adapter itself acts as a captain over tools. Full MCP payloads, event tails, file lists, and summaries get replayed into subsequent model turns.
- The response-format instructions are repeated every turn, even though they are stable protocol text.

Proposed fix:
- Introduce `compactToolResultForTranscript(toolName, output)` with tool-specific projections. For crew status results, keep `status`, `run_id`, `summary` capped, `filesChanged` capped, and error fields; drop redundant paths and full tails unless terminal/failure needs them.
- Make the response-format block shorter and move stable protocol into a system message where the adapter supports it.
- For OpenAI-compatible models, rely more on native tool calls/structured outputs instead of string protocol where possible.

Expected gain:
- High for multi-turn captain sessions. This is likely the largest context reduction outside the skill body.

Risks / breakage:
- Tool-loop behavior is correctness-sensitive. Existing tests assert that system messages are not truncated and that finish/tool-call distinctions remain explicit (`test/adapters/tool-loop/transcript.test.ts:45` through `test/adapters/tool-loop/transcript.test.ts:114`).
- Over-compacting tool outputs can hide state needed for the next tool call.

Prerequisite work:
- Add golden prompt tests for compacted transcript output.
- Start with crew-specific result projection, then generalize.

### C7. Tool-use previews can put bulky tool arguments into progress logs and terminal tails

What it is:
- Claude Code stream formatting includes tool-use input previews via `compactPreview(block.input, '{}')` (`src/adapters/claude-code.ts:316` through `src/adapters/claude-code.ts:344`).
- Codex progress events include command lines and output previews with per-event caps (`src/adapters/codex.ts:80` through `src/adapters/codex.ts:100`, `src/adapters/codex.ts:242` through `src/adapters/codex.ts:266`).
- Terminal status returns a bounded `events_tail` from the log (`src/cli/commands/serve.ts:1187` through `src/cli/commands/serve.ts:1210`).

Why it costs:
- The caps are good, but terminal tails can still contain low-value command/tool previews rather than semantically useful progress.
- Tool arguments can include paths, JSON, or prompt fragments. Even at 160-600 chars per event, repeated events add up.

Proposed fix:
- Make progress events more semantic: show tool name and a one-line action, but omit or hash large input previews by default.
- Keep full raw provider logs in provider-native locations or a separate trace file if needed.
- Preserve the existing receipt filters as a defensive backstop (`src/orchestrator/events-filter.ts:37` through `src/orchestrator/events-filter.ts:50`).

Expected gain:
- Medium for terminal summaries and user-visible tails. Also improves signal quality.

Risks / breakage:
- Users may value seeing command previews in `tail -F`. Consider making verbose trace available separately rather than deleting it outright.

Prerequisite work:
- Decide the product boundary between progress narration and debug trace. The parked source-filter plan discusses this trade-off (`docs/plans/parked/noise-filter-at-source.md:120` through `docs/plans/parked/noise-filter-at-source.md:145`).

### C8. `executeWithSchema` duplicates JSON schema in prompt text and CLI arguments

What it is:
- Claude Code schema execution embeds the full JSON schema in the prompt and also passes it via `--json-schema` (`src/adapters/claude-code.ts:618` through `src/adapters/claude-code.ts:652`).
- OpenAI-compatible schema execution embeds the schema in prompt text instead of using native `response_format` (`src/adapters/openai-compatible.ts:96` through `src/adapters/openai-compatible.ts:123`).

Why it costs:
- The schema can be large, and duplicating it in prompt text makes the model read it even when the provider has a structured-output channel.

Proposed fix:
- For Claude Code, test whether `--json-schema` alone is sufficient with a much shorter instruction in the prompt. Keep a fallback path if older Claude CLI versions need the prompt copy.
- For OpenAI-compatible adapters, use provider-native JSON schema response format when the endpoint supports it, with prompt fallback for generic endpoints.

Expected gain:
- Medium on schema-heavy calls. Not the main crew hot path, but valuable for future structured adapter work.

Risks / breakage:
- Provider compatibility varies. Some CLIs may need schema text to steer behavior even when an argument is present.

Prerequisite work:
- Version-gated adapter tests for structured-output behavior.

### C9. Run state correctly elides prompt text on the wire, but internal prompt retention still affects IO size

What it is:
- Run state stores full prompt history (`src/orchestrator/run-state.ts:40` through `src/orchestrator/run-state.ts:47`, `src/orchestrator/run-state.ts:263` through `src/orchestrator/run-state.ts:273`).
- Terminal status projects prompt metadata without prompt text (`src/cli/commands/serve.ts:1226` through `src/cli/commands/serve.ts:1230`), and tests assert prompt elision (`test/cli/commands/serve.test.ts:260` through `test/cli/commands/serve.test.ts:304`).

Why it costs:
- This is a positive public-context choice: prompts do not get sent back to the captain.
- The cost remains internal speed/IO: full prompt history increases `state.json` parse/write size as runs continue.

Proposed fix:
- Preserve wire elision.
- If S6 splits hot status from archive state, keep prompt history only in the archive file.

Expected gain:
- Context gain already realized. Additional speed gain is covered under S6.

Risks / breakage:
- Prompt history may be used for debugging. Keep it durable, just not in the hot file.

Prerequisite work:
- Tests ensuring terminal payload continues to expose only prompt metadata.

## 4. Cross-cutting observations

### X1. The long-poll design is internally consistent; tune within it, do not replace it

The parked long-poll plan explicitly rejects background wakeup/cron-style patterns and keeps the captain's turn open (`docs/plans/parked/long-poll-cost-tuning.md:204` through `docs/plans/parked/long-poll-cost-tuning.md:217`). The skill repeats that rule (`skills/crew-captain.body.md:188` through `skills/crew-captain.body.md:203`). Optimizations should reduce per-poll payload and server-side IO, not move waiting outside the active turn.

The shipped terminal-only behavior is already a strong token optimization. Status baseline says terminal-only timeout returns `{ status: "running", timed_out: true }` with no cursor or tail (`docs/status/captain-flow-review-2026-04-29.md:10` through `docs/status/captain-flow-review-2026-04-29.md:25`), and tests cover this (`test/cli/commands/serve.test.ts:1857` through `test/cli/commands/serve.test.ts:1906`).

### X2. Runtime comments and docs still mention a "6-tool surface"

`src/orchestrator/index.ts` says the surface is a trimmed 6-tool surface (`src/orchestrator/index.ts:7` through `src/orchestrator/index.ts:10`), while the live server and tests expose seven tools including `cancel_run` (`test/cli/commands/serve.test.ts:177` through `test/cli/commands/serve.test.ts:188`). This is not a speed or context issue by itself, but doc drift around tool count makes future envelope/context reviews harder.

### X3. Public compatibility has two layers: structured payload and text content

The codebase correctly treats structured MCP shapes as stable, but text `content` is also observable. Several good context wins involve compacting markdown or JSON text while keeping `structuredContent` stable. Those should be classified as "structured-shape non-breaking, text-output potentially breaking" rather than silently treated as internal refactors.

### X4. There is no benchmark harness for the paths this audit targets

`docs/plans/active/m4-eval-and-field-report.md` explicitly keeps performance/cost benchmarking out of scope for that milestone (`docs/plans/active/m4-eval-and-field-report.md:40` through `docs/plans/active/m4-eval-and-field-report.md:41`). The same plan suggests an evaluation driver that bypasses MCP transport for adapter behavior (`docs/plans/active/m4-eval-and-field-report.md:231` through `docs/plans/active/m4-eval-and-field-report.md:239`). For MCP speed work, add a separate harness that measures:
- `crew-mcp serve` cold start to listTools-ready.
- `list_agents` cold/warm latency.
- `run_agent` time to async-first response for read-only and write-mode.
- `get_run_status` timeout CPU/IO cost over 30m simulated polling.
- terminal poll latency as `events.log` grows.
- merge latency on clean, dirty, and conflict paths.

### X5. Existing tests encode important polling invariants

The serve tests are unusually specific around long-poll and payload shape: async-first run_agent (`test/cli/commands/serve.test.ts:1465` through `test/cli/commands/serve.test.ts:1495`), terminal-only ignoring stream chunks (`test/cli/commands/serve.test.ts:1674` through `test/cli/commands/serve.test.ts:1737`), receipt filtering (`test/cli/commands/serve.test.ts:1910` through `test/cli/commands/serve.test.ts:1992`), terminal tail capping (`test/cli/commands/serve.test.ts:2282` through `test/cli/commands/serve.test.ts:2303`), and schema acceptance of `wait_for_terminal_only` (`test/cli/commands/serve.test.ts:2398` through `test/cli/commands/serve.test.ts:2413`). Any speed/context PR should preserve those invariants unless it is explicitly marked breaking.

## 5. Out of scope / did not investigate

- I did not run benchmarks. This worktree did not have an installed `node_modules`/built `dist` setup available for reliable timing, and the request was for an audit report rather than code changes.
- I did not run the Vitest suite because the report is markdown-only and no runtime code changed.
- I did not inspect provider-native external logs (`~/.codex/log`, Claude Code local state, Gemini local state). Recommendations about retaining verbose trace assume those logs exist or can be introduced separately.
- I did not evaluate MCP host transcript internals for Claude Code, Codex, or Gemini. Context findings involving `content` vs `structuredContent` are based on common host behavior and should be validated in each host.
- I did not propose "wake later", cron, background CLI dispatch, or ending the captain turn during long polls. That is intentionally outside scope per `docs/plans/parked/long-poll-cost-tuning.md`.
- I did not audit old v0.1 archive code except where current docs pointed at it. The current live surface is the seven-tool MCP server in `src/cli/commands/serve.ts`.
