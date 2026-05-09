# M4 — Eval + Field Report

**Status:** proposed.
**Anchor commit(s):** TBD.
**Predecessor:** M3.5 (shipped, see
`docs/plans/completed/m3.5-relocate-runtime-state.md`) plus the
queued ask-user enforcement edit (a35ec5f) and Finding 5 fix
(2359ec1).
**Closes the v0.2 milestone train.** Tag `v0.2.0` lands here.

## Goal

Two artifacts:

1. **An A/B eval** measuring whether the captain skill changes
   captain behavior in measurable, defensible ways. Not whether
   the SKILL is "good" in some absolute sense — whether it does
   what its description claims (more dispatches when natural,
   more reviews after implementation, more clarifying questions
   on ambiguous asks per the M3.5-follow-up rubric).
2. **A field report** (`docs/FIELD_REPORT.md`) documenting the
   v0.1→v2 inversion and what 2 weeks of dogfooding revealed.
   This is the **portfolio artifact**. The numbers from (1) feed
   into it; the lived experience from dogfooding does the heavier
   narrative work.

**Success threshold:** the field report is honest, the numbers
support or honestly contradict the original thesis, and the
author has used crew on at least 5 real-work tasks without
reverting to v0.1's TUI.

## What this milestone is NOT

- A scientifically rigorous eval. n=20 fixture tasks across 2
  arms is **40 runs**, not a benchmark. Spot-checked oracle
  judgments + transcripts are the safety net.
- A "is the captain good at coding?" eval. The worker quality is
  Claude / Codex / Gemini's job. We're measuring **captain
  behavior**, which is what the skill controls.
- A perf or cost benchmark. Wall time + token spend get logged
  but are sanity-checks, not headlines.
- A user study. n=1, the author. The field report is honest
  about that.

## Open design questions to resolve before T1

These shape every other task. Resolve early.

### Q1: Captain substrate for the eval

**Options:**

1. **Claude API directly** — start a `messages.create` session
   with the skill in the system prompt + a tool catalog mirroring
   `mcp__crew__*`. The driver implements the tool callbacks
   (real WorktreeManager + RunStateStore, real or mocked workers).
2. **Drive Claude Code as a subprocess** — invoke the actual
   Claude Code CLI with crew installed, scripted via stdin/stdout.
3. **Both** — fast Claude-API loop for the n=40 quantitative arm,
   plus a handful of real-host smokes for qualitative confirmation.

**Recommendation: option 1 + a small option 3.** The skill is
markdown loaded into context — Claude API + skill-as-system-prompt
is the same loadout the host CLI gets, minus host-specific UI.
That's the right A/B substrate: same model, same skill, same
tools, only the SKILL toggle varies. Then 3-5 real-host smokes
in Claude Code (and Codex, post Finding 5 verification) confirm
the API loadout matches host behavior in shape if not in detail.

**Why not option 2 alone:** scripting a host CLI is brittle
(stdio quirks, prompt UI, slash-command interception), the loop
is slow (~2-5min per run × 40 = 1-3 hours), and we lose
fine-grained control over what context the captain sees.

### Q2: Workers — real or mocked?

**Options:**

1. **Real adapters** — every `mcp__crew__run_agent` spawns a real
   `claude-code` / `codex` / `gemini` subprocess. Most realistic;
   most expensive. Estimated $20-50 for the full eval.
2. **Mocked workers** — a deterministic stub adapter that returns
   a canned diff per (agent_id, task_category) tuple. Fast, free,
   reproducible. Doesn't measure worker quality.
3. **Hybrid** — real workers for the 5 hard tasks (where worker
   variance matters), mocked for the 15 easy/medium.

**Recommendation: option 2 (mocked).** We're measuring CAPTAIN
behavior — does the captain dispatch, did it pick a sensible
agent, did it ask for review afterwards. Worker quality is out of
scope. Mocks make the eval reproducible (re-run after a skill
edit, see if behavior changed). Real-host smokes (Q1's option 3)
cover "do the workers actually work end-to-end" qualitatively.

### Q3: Oracle — judge what, by what?

What needs judgment per run:

- **Did the captain dispatch when it should have?** (binary:
  task explicitly asks for another agent, or task is clearly
  large enough — captain should dispatch)
- **Did the captain answer inline when it shouldn't have
  dispatched?** (binary: task is small + targeted — captain
  should NOT have dispatched)
- **Did the captain ask a clarifying question on ambiguous asks?**
  (binary, applies to fixture tasks tagged "ambiguous-scope")
- **Did the captain review after implementation?** (binary, applies
  to "code-then-review" tasks)
- **Did the captain confirm before merge?** (binary; captain
  should never call merge_run in the eval — the eval prompt is
  supposed to never authorize merge)

These are all **rule-judged from the transcript**, not LLM-judged.
Counting tool calls + classifying tags is deterministic. Cheaper,
faster, more honest than an LLM oracle here. Reserve LLM judgment
for the final-state quality question — and only as a tiebreaker on
runs where the rule judges all-good but the diff looks wrong.

**Recommendation: rule-based oracle with optional LLM tiebreak.**

### Q4: How does the eval handle the captain's clarifying questions?

The M3.5-follow-up rubric (a35ec5f) tells the captain to ask
clarifying questions on ambiguous asks. In the eval driver, the
"user" is the harness — what does the harness reply when the
captain asks?

**Options:**

1. **Auto-answer with a canned reply per task.** Each fixture
   task includes a `clarifications` field: `{ "what does done
   look like": "<answer>" }`. The driver pattern-matches the
   captain's question; falls back to "use your best judgment"
   for unmatched questions.
2. **Auto-answer "use your best judgment".** Single canned reply.
   Loses the signal that the captain asked a useful clarifying
   question (since the answer is uniform).
3. **Refuse to answer.** Treats any clarifying question as a
   protocol violation. Wrong — punishes the rubric we just shipped.

**Recommendation: option 1.** The fixture authors the answers up
front; the driver matches loosely. We capture "did the captain
ask?" in metrics and "was the answer useful?" implicitly via
final-state quality.

### Q5: Dogfooding contamination

If the author keeps tweaking the skill body during the 2-week
dogfooding window, the field report's "lived experience" data is
muddy. Discipline: **freeze the skill body the day dogfooding
starts**, log frictions in a journal, edit notes go into a
"future work" pile rather than landing during the window. Field
report explicitly discusses what would have changed.

**Recommendation: freeze. Journal-only edits during the window.**

### Q6: When is the eval "done enough" to publish?

Not "every metric is green." Done when:

- All 40 runs completed and logged.
- Spot-check passed on 4 runs (10%) — read the transcript, verify
  the rule-judged metrics agree with what the captain actually
  did.
- The aggregate numbers + any surprises feed honestly into the
  field report.

**Recommendation: ship when honest, not when impressive.**

## Scope

**In:**

- `eval/` directory at repo root containing the driver, fixture,
  oracle, and run logs. Not part of the published npm package.
- 20-task fixture (5 easy / 10 medium / 5 hard) with prompts,
  starting repo states, and oracle rules per task.
- A/B harness running each task ×2 (with-skill, empty-skill)
  against the Claude API + mocked worker adapters.
- Aggregation script producing a single `eval/results-<date>.md`
  with the numbers.
- 3-5 real-host smokes in Claude Code (and Codex post-verification)
  confirming API-loadout behavior matches host behavior.
- 2-week dogfooding window with a `eval/dogfood-journal.md`.
- `docs/FIELD_REPORT.md` — 1500-2500 words, honest.
- `v0.2.0` git tag + README pointing prominently at the field
  report.
- Decision on `npm publish v0.2.0` (still open from
  IMPLEMENTATION_PLAN out-of-band §3).

**Out:**

- Continuous eval / regression-eval pipeline. One-shot for v0.2;
  re-runnable but not automated.
- Multi-host A/B (Codex vs Claude vs Gemini as the CAPTAIN).
  Q1's recommendation is to fix the substrate at Claude API for
  the quantitative arm. Per-host comparison is a v0.3 idea.
- Cost optimization. Mocked workers keep cost low; if the eval
  budget surprises, lower the fixture count rather than chase
  mock fidelity.
- Anything that would block tagging v0.2.0 — minor follow-ups go
  to v0.3.

## Tasks

Each block is roughly a day's focused work. Total estimate: 7-10
focused days, ~1.5 calendar weeks part-time, plus the 2-week
dogfooding window in parallel with task 6.

### T1: Decide Q1-Q6, write decisions into this doc.

Half a day. The recommendations above are starting points; the
author commits to a choice (or overrides) and locks them so
T2-T8 don't churn.

### T2: Build the eval driver harness.

`eval/driver/` — Node.js. Roughly:

```
eval/driver/
├── index.ts            # entry: `npx tsx eval/driver run --task <id> --arm <with|without>`
├── claude-session.ts   # wraps @anthropic-ai/sdk messages.create with tool-call loop
├── tool-callbacks.ts   # implements mcp__crew__* tool callbacks (real WorktreeManager + RunStateStore + mocked adapters)
├── mocked-adapters.ts  # canned diffs per (agent_id, task_category)
├── clarification-bot.ts # pattern-matches captain's questions to fixture answers
├── oracle.ts           # rule-based judgment from transcript + final state
└── transcript.ts       # serialize (input, tool calls, answers, final state) to JSON
```

Reuses crew-mcp's existing modules:

- `WorktreeManager` (from `src/git/worktree.ts`) — real worktrees
  per run.
- `RunStateStore` (from `src/orchestrator/run-state.ts`) — real
  state.json + events.log per run.
- `buildCrewMcpServer` is **not** used — the driver bypasses MCP
  transport and calls tool callbacks directly. Avoids the stdio
  cost. The MCP catalog parity test (`test/install/tool-catalog.test.ts`)
  guarantees the driver's tool definitions stay in sync with the
  live MCP surface.

Transcript schema:

```ts
interface RunTranscript {
  taskId: string;
  arm: 'with-skill' | 'empty-skill';
  startedAt: string;
  endedAt: string;
  systemPrompt: string;        // skill content (or empty placeholder)
  userPrompt: string;
  turns: Array<{
    role: 'assistant' | 'tool_result';
    content: unknown;
    toolUse?: { name: string; input: unknown };
    toolResult?: { name: string; output: unknown };
    timestampMs: number;
  }>;
  finalDiff: string;           // git diff after the run
  metrics: {
    dispatches: number;
    reviewDispatches: number;
    clarificationsAsked: number;
    mergeRunCalled: boolean;
    discardRunCalled: boolean;
    wallTimeMs: number;
    tokensIn: number;          // from API response.usage
    tokensOut: number;
  };
}
```

Acceptance: `npx tsx eval/driver run --task t-easy-01 --arm with-skill`
runs end-to-end on a hand-coded sample task, writes
`eval/runs/<runId>.json`.

### T3: Build the fixture (20 tasks).

`eval/fixture/` — one directory per task:

```
eval/fixture/
├── t-easy-01-fix-typo/
│   ├── repo/                  # starter repo state (tracked)
│   ├── task.json              # prompt, oracle rules, clarification answers
│   └── README.md              # human-readable description
├── t-easy-02-format-file/
│   └── ...
└── ...
```

`task.json` schema:

```ts
interface FixtureTask {
  id: string;
  difficulty: 'easy' | 'medium' | 'hard';
  prompt: string;              // the user message that kicks off the captain
  expectedBehavior: {
    shouldDispatch: boolean;       // captain SHOULD invoke run_agent (or NOT)
    shouldReview: boolean;         // captain SHOULD dispatch a review after impl
    shouldClarify: boolean;        // captain SHOULD ask a clarifying question first
    shouldMerge: false;            // always false; eval prompts never authorize merge
  };
  clarifications: Record<string, string>; // pattern → canned answer
  oracle: {
    finalStateChecks: Array<{ kind: 'fileExists' | 'fileContains' | 'gitBranch'; ... }>;
  };
}
```

Fixture composition:

- **5 easy** — single-file, well-scoped. Captain should NOT
  dispatch (inline edit faster). Probes the "don't ceremoniously
  dispatch" half of the rubric.
- **10 medium** — multi-file or named-agent. Captain SHOULD
  dispatch. Half are "explicit dispatch language" ("have Claude
  review X"), half are "large enough to dominate"
  ("refactor the parser").
- **5 hard** — open-ended, ambiguous, sensitive area. Captain
  SHOULD ask a clarifying question per the rubric (a35ec5f).
  Probes the new ask-user gate.

Concrete easy examples:
- "Fix the typo in src/utils/greet.ts" (`hello` → `hello,` etc.)
- "Add a missing semicolon in app.tsx"
- "Rename the variable `foo` to `bar` in lib/x.ts"
- "Add a one-line comment to the `processRequest` function"
- "Format src/parser.ts (add proper indentation)"

Concrete medium examples (dispatch-language half):
- "Have Claude review my recent changes to src/auth.ts"
- "Send the diff in src/parser.ts to Codex for a second opinion"
- "Use a code-review-tuned model to look over PR #42"
- "Have Claude implement input validation for createOrder"
- "Dispatch the test additions for parseDate to Claude"

Concrete medium examples (large-scope half):
- "Refactor the auth check into a reusable middleware"
- "Add pagination to the listUsers endpoint"
- "Migrate the legacy callback API in lib/db.ts to async/await"
- "Implement a feature flag for the new dashboard"
- "Add error handling to the API client retry logic"

Concrete hard examples (rubric-probing):
- "Improve the error messages in the validation layer" (open scope)
- "Make the search faster" (open scope, no target)
- "Refactor the user-facing API for better ergonomics" (multi-approach)
- "Add OAuth login for two new providers" (sensitive: auth)
- "Rewrite the changelog parser to handle conventional commits"
  (multi-approach + multi-agent ambiguity)

Acceptance: every fixture task has a `task.json`, a starter repo
state, a README. Spot-checked manually that the prompt actually
makes sense to a human reader. Total fixture authoring effort:
1-2 days.

### T4: Build the oracle.

`eval/driver/oracle.ts`. Per-task rule judgment:

```ts
interface OracleVerdict {
  taskId: string;
  arm: string;
  rubricMatch: {
    dispatchedCorrectly: boolean;     // captain matched expectedBehavior.shouldDispatch
    reviewedCorrectly: boolean;       // matched expectedBehavior.shouldReview
    clarifiedCorrectly: boolean;      // matched expectedBehavior.shouldClarify
    didNotMerge: boolean;             // never called merge_run (always required)
  };
  finalStateChecks: Array<{ check: string; pass: boolean }>;
  overallPass: boolean;               // all rubric matches + all finalStateChecks pass
}
```

Rules are deterministic; LLM judgment used only for spot-check
(T6) and for any task where final-state checks are too vague to
encode.

Acceptance: oracle runs against a saved transcript and emits a
verdict in <100ms. Hand-verified on the easy fixture.

### T5: Run the A/B (40 runs).

```sh
npx tsx eval/driver run-all --output eval/runs/2026-MM-DD/
```

Each task × arm = 1 run. 40 runs total. Wall time estimate:
~2min/run × 40 = 80min sequential, or 20min in 4-way parallel.
Cost estimate: $0.30/run × 40 = $12 for the captain side
(Sonnet 4.6, ~50K avg context per run).

Acceptance: `eval/runs/<date>/run-<id>.json` exists for all 40
runs. Driver re-tries any run that errored on the API (up to 2
retries; after that, log the failure and continue).

### T6: Aggregate + analyze + spot-check.

`eval/driver/aggregate.ts` reads all 40 transcripts, applies the
oracle, emits `eval/runs/<date>/results.md`:

- Aggregate pass rates (with-skill vs. empty-skill) for each
  rubric metric.
- Per-difficulty breakdown.
- Token spend ratio.
- Avg dispatches per task.
- 4 hand-picked transcripts (one per quartile of behavior
  divergence) embedded as case studies.

Spot-check: read 4 random transcripts; verify the oracle's
verdict agrees with what the captain actually did. Note any
disagreements in `results.md` for the field report.

### T7: 2-week dogfooding window.

Calendar: starts after T1-T6 are complete. **Skill body frozen**
on day 1; edits captured in `eval/dogfood-journal.md` for v0.3.

Journal entries are short and dated:

```
## 2026-MM-DD — refactor of src/x.ts

Used: have-claude-review. Captain dispatched immediately, no
clarifying question. Worktree review came back clean. Merged.

Friction: <if any>
Surprise: <if any>
Tweak I'd want: <if any>
```

Goal: minimum 5 real-work tasks, ideally 10-15. No reverts to
v0.1's TUI.

Acceptance: `eval/dogfood-journal.md` exists, has ≥5 dated
entries, describes the work done.

### T8: Write the field report.

`docs/FIELD_REPORT.md`. 1500-2500 words. Sections:

1. **The thesis** — the v0.1→v2 inversion. Why captain-as-skill
   beat captain-as-TUI for personal use.
2. **The eval design** — what we measured, what we didn't, why.
   Q1-Q6 decisions documented honestly.
3. **The numbers** — aggregate from T6. Honest about which
   metrics the skill moved and which it didn't.
4. **What the dogfooding revealed** — the lived-experience
   complement. Frictions, surprises, the things the eval missed.
5. **What I'd change for v0.3** — the journal's "tweak I'd want"
   pile, prioritized.
6. **Engineering decisions that held** — gitignore-guard →
   M3.5 inversion is a great example: a fix that turned out to
   be papering over the real problem. Hand-rolled TOML merger.
   Static tool catalog with parity test. The retired captain-LLM.
7. **Engineering decisions that didn't** — the wrong-Codex-path
   miss (Finding 5). The first-cut "vibes-language" skill body.
   Whatever else dogfooding surfaces.

Tone: honest > impressive. The portfolio value is in the
self-criticism + the willingness to publish numbers that don't
all favor the work.

### T9: Tag v0.2.0.

```sh
git tag -a v0.2.0 -m "v0.2.0 — MCP server + captain skill"
git push origin v0.2.0
# decide on npm publish v0.2.0 here (IMPLEMENTATION_PLAN out-of-band §3)
```

README update: prominent link to FIELD_REPORT.md, install
quickstart, link to the M0-M4 plan docs as background.

### T10: Move M3.5, M4 plan docs to docs/plans/completed/.

Convention housekeeping. After v0.2.0 ships:

```sh
git mv docs/plans/active/{m3-status.md,m3.5-relocate-runtime-state.md,m4-eval-and-field-report.md} docs/plans/completed/
```

## Acceptance map

| Criterion | Verified by |
|---|---|
| 40 runs completed and logged | `eval/runs/<date>/run-*.json` count = 40 |
| Aggregate report exists | `eval/runs/<date>/results.md` exists |
| Spot-check passed | 4 hand-verified transcripts noted in results |
| Dogfooding journal has ≥5 entries | `eval/dogfood-journal.md` |
| Author has not reverted to v0.1's TUI | self-report in field report |
| `docs/FIELD_REPORT.md` exists, 1500-2500 words | wc, tone-check |
| `v0.2.0` tag exists | `git tag --list 'v0.2.0'` |
| README points at field report | grep README for FIELD_REPORT |
| Real-host smokes confirm API-loadout behavior | 3-5 short notes in field report's "what dogfooding revealed" |

## Risks + open questions

1. **The eval substrate is Claude API not Claude Code.** Mitigated
   by Q1's option-3 real-host smokes. The field report should
   explicitly note this trade-off.
2. **Mocked workers don't measure real worker quality.** True. We're
   measuring captain behavior. Worker quality is the worker
   adapter's concern, not crew's.
3. **Two weeks isn't enough dogfooding.** Possibly. Field report
   includes a "what I expect from continued use" section.
4. **The author IS the eval designer.** Bias risk. Mitigation:
   spot-check transcripts personally, publish raw numbers, note
   any oracle disagreements.
5. **Skill body changes during dogfooding contaminate signal.**
   Q5 freeze discipline.
6. **Cost overrun.** Mocked workers + Sonnet captain keep budget
   ≤$20. If real workers get added later, budget review first.
7. **The eval finds the skill doesn't matter.** Honest outcome —
   field report says so. Better data than a flattering result.

## Decisions worth flagging now

1. **Mocked workers, real captain.** Reproducible eval, focused
   on the variable we control (the skill).
2. **Rule-based oracle, LLM tiebreak.** Deterministic verdicts
   beat LLM-graded benchmarks for n=40.
3. **Claude API as the eval captain substrate.** Same model the
   host CLI uses; we test the skill's effect on Claude reasoning,
   which is what the user experiences. Real-host smokes confirm
   no surprising host-specific drift.
4. **Skill body frozen during dogfooding.** Discipline beats
   muddy data.
5. **Field report tone: honest > impressive.** Portfolio value is
   in the self-criticism. Numbers that don't all favor the work
   are still publishable.
6. **No npm publish gate on this milestone.** That's an
   independent decision per IMPLEMENTATION_PLAN out-of-band §3.

## Carry-forward to v0.3

These get written to a v0.3 ideas file at the close of M4, not
tracked here:

- `crew prune` (Finding 8 deferred from v0.2).
- `crew list` (cross-repo run listing — data shape ready post-M3.5
  via repoRoot field).
- XDG_DATA_HOME / XDG_STATE_HOME on Linux.
- agents.yaml (PRODUCT_VISION's user-facing registry, not yet
  implemented; M4 dogfooding will tell us if anyone wants it).
- Multi-host concurrent merge_run lock semantics (PRODUCT_VISION
  Open Question Q6, still open).
- Multi-host A/B (Codex vs Claude vs Gemini as the captain;
  intentionally deferred from M4's quantitative arm).
- The post-2-weeks "tweak I'd want" pile from the dogfood
  journal.
- Skill drift across host CLI updates (PRODUCT_VISION Q5, watch
  item).
