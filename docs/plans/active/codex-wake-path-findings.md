# Codex wake path findings

**Status:** Draft 2026-05-09.

Related plan: `docs/plans/active/non-blocking-captain.md`.

## Question

Can Crew wake a Codex captain after a dispatched run reaches terminal, the
same way the non-blocking captain plan expects to wake Claude Code through a
background `crew-wait` process?

## Short answer

Not in the current Codex CLI host model.

For the installed Codex CLI path that Crew supports today
(`~/.codex/config.toml` MCP registration plus `~/.codex/skills/crew/SKILL.md`),
there is no evidence of a Claude-style wake primitive. A background watcher can
observe Crew state, but Codex does not appear to convert that watcher finishing
into a new user-visible model turn in an idle interactive Codex session.

There is, however, a plausible separate path through Codex's experimental
app-server / remote-control protocol. That protocol exposes thread and turn
methods, including starting a turn with synthetic user input. That is not the
same product/integration shape as the current Codex CLI host install; it should
be treated as an opt-in spike, not as a Phase 3 implementation detail for the
current non-blocking captain plan.

## Definition of "wake"

For this investigation, "wake" means all of the following:

1. The captain dispatches `run_agent` or `continue_run`.
2. The captain ends its response so the user can keep chatting.
3. Some background observer notices the run reached terminal state.
4. Without the user sending another message, the same user-visible captain
   conversation receives a new model turn.
5. That turn has enough run metadata to call `get_run_status`, summarize the
   result, and ask whether to merge, iterate, or discard.

Claude Code appears to satisfy this through background command completion:
a `Bash(..., run_in_background: true)` or background task can finish later and
the host synthesizes a new assistant turn containing the result.

Codex CLI does not appear to have an equivalent behavior in the current MCP
host path.

## Evidence gathered

### Local Codex version

Local command:

```sh
codex --version
```

Observed:

```text
codex-cli 0.130.0
```

This is newer than the `0.128.0` evidence referenced in
`non-blocking-captain.md`, so the plan's Codex notes should not remain pinned
only to `0.128.0`.

### Standard CLI surfaces

The following local surfaces were checked:

- `codex --help`
- `codex exec --help`
- `codex resume --help`
- `codex remote-control --help`
- `codex app-server --help`
- `codex exec-server --help`
- `codex features list`

Relevant observations:

- `codex exec` and `codex exec resume` are non-interactive process-entry
  points. They can start or resume a Codex session, but they do not inject a
  turn into an already-idle interactive TUI session owned by the user.
- `codex resume [SESSION_ID] [PROMPT]` can start an interactive resumed
  session with an optional prompt, but that is a new process-level interaction.
  It is not a background completion callback into the currently open captain
  session.
- Local `codex features list` reports `hooks` as stable/enabled, but hooks run
  inside the Codex lifecycle. They do not by themselves provide an idle-session
  wake callback.
- Local `codex features list` reports `remote_control` as under development and
  disabled. `remote-control` and `app-server` commands exist, but they are a
  different integration surface than the current MCP host install.

### Hooks

Official docs: <https://developers.openai.com/codex/hooks>

Codex hooks are useful but do not solve idle wake for this plan.

Important details from the docs:

- `PreToolUse`, `PermissionRequest`, `PostToolUse`, `UserPromptSubmit`, and
  `Stop` run at turn scope.
- `UserPromptSubmit` can add extra developer context to a user-submitted prompt.
- `Stop` can keep Codex going by returning a block/continuation decision, which
  causes Codex to continue from the end of the current turn.

Implication:

- `UserPromptSubmit` is a good fit for "at the next user turn, inject pending
  Crew run state."
- `Stop` is a good fit for "before the current turn truly stops, decide whether
  to continue."
- Neither event fires because an external `crew-wait` process later noticed
  `state.json` became terminal while Codex was idle.

So hooks support Phase 5-style polish in the non-blocking captain plan, but
they are not equivalent to Claude Code's background-completion wake behavior.

### App-server protocol

Official docs: <https://developers.openai.com/codex/app-server>

Local commands:

```sh
codex app-server generate-json-schema --out /private/tmp/codex-app-schema
codex app-server generate-ts --out /private/tmp/codex-app-ts
```

The generated protocol includes client requests such as:

- `thread/start`
- `thread/resume`
- `thread/loaded/list`
- `thread/read`
- `thread/inject_items`
- `turn/start`
- `turn/interrupt`

The generated `TurnStartParams` shape requires a `threadId` and an `input`
array. User text input is represented as a text item. This is the first
surface found that looks capable of starting a new Codex model turn from an
external controller.

Implication:

An app-server-backed Crew watcher could plausibly do this:

1. Find or remember the loaded Codex thread that represents the captain
   conversation.
2. Watch `~/.crew/runs/<runId>/state.json` until status is terminal.
3. Call `turn/start` on that thread with synthetic user input such as:
   `Crew run <runId> reached status <status>. Call get_run_status and surface it.`
4. Let Codex execute the normal captain workflow inside the same thread.

This is a credible spike candidate, but it is not verified as a user-facing
CLI/TUI wake behavior.

## Why the app-server path is not "just like Claude"

The Claude overlay in `non-blocking-captain.md` is cheap and host-native:

- The captain starts `crew-wait <run_id>` as a background command.
- Claude Code itself turns that command's eventual completion into a new
  assistant turn.
- Crew does not need to own Claude's session protocol or identify a live
  thread externally.

The Codex app-server path would be a different architecture:

- Crew would need to connect to a Codex app-server control socket or websocket.
- Crew would need to know which thread to target.
- Crew would need to preserve enough host/session identity across `/clear`,
  app restarts, and multiple open Codex sessions.
- Crew would need to send a synthetic user turn into Codex, which has different
  UX and trust implications than surfacing the result of a background command
  the captain itself started.
- Crew would need to handle app-server auth, socket discovery, lifecycle, and
  version drift.

That makes it a possible v2 host overlay, not a same-shape replacement for
`crew-wait` in the current v1 plan.

## Recommendation for `non-blocking-captain.md`

Keep the current mainline decision:

- Claude Code gets the `crew-wait` background watcher overlay.
- Standard Codex CLI gets the baseline: at the next user-initiated turn, call
  `list_runs` and surface newly-terminal runs.
- Hooks can later improve that baseline by injecting pending/terminal run
  context at turn start.

But update the plan language so it is less absolute:

```md
Codex CLI standard MCP host path has no Claude-style idle wake primitive.
Codex app-server may support an opt-in synthetic-turn wake through `turn/start`,
but that is a separate app-server/remote-control integration and remains a
deferred spike.
```

Also update the evidence note from `codex-cli 0.128.0` to include local
`codex-cli 0.130.0`.

## Proposed plan addendum

Add an out-of-scope or deferred-spike section:

```md
### Deferred spike — Codex app-server wake

Investigate whether Crew can wake a Codex captain by connecting to Codex's
app-server protocol and calling `turn/start` on the active captain thread when
a watched Crew run reaches terminal state.

Questions:

- Can Crew reliably discover the active Codex thread for the current repo?
- Does `turn/start` surface inside the same user-visible Codex app/TUI session?
- What auth/socket setup is required for local app-server control?
- What happens if multiple Codex sessions are open in the same repo?
- What happens after `/clear`, app restart, or session compaction?
- Can this be installed safely without surprising the user with synthetic
  prompts?

Acceptance for the spike:

- Start a normal user-visible Codex captain session.
- Dispatch a Crew run and end the captain turn.
- From an external watcher, trigger a new Codex turn after terminal state.
- Verify the user sees the wake in the same intended conversation.
- Verify the captain can call `get_run_status` and ask for merge/iterate/discard.
- Verify failure modes degrade to the `list_runs` next-user-turn baseline.
```

## Product decision

For v1, do not pursue Codex app-server wake as part of the non-blocking captain
implementation. It expands the scope from "install an MCP server and skill into
Codex" to "control a Codex app-server thread." That is a larger and riskier host
integration.

For v2, the spike is worth keeping because it is the only path found that could
give Codex parity with Claude's automatic terminal surfacing without waiting
for the next user message.

## Open questions

- Is the product comfortable with Crew sending synthetic user prompts into
  Codex, or should every Codex wake require an explicit user action?
- Should app-server wake target only the desktop app, or also the CLI/TUI when
  it supports remote control?
- How should Crew map a terminal run to the correct Codex thread when several
  Codex sessions are open against the same repository?
- Should the app-server wake prompt be visible as user text, hidden developer
  context, or a system-style event?
- Does app-server wake survive `/clear`, or does `/clear` intentionally sever
  the relationship between the watcher and the conversation?

## Final classification

| Path | Wake from idle? | Current plan fit | Recommendation |
|---|---:|---:|---|
| Claude Code background `crew-wait` | Yes | Strong | Ship as planned |
| Codex CLI MCP host path | No evidence | Strong baseline only | Use `list_runs` on next user turn |
| Codex hooks | No, turn-scoped only | Useful polish | Defer to hook layer |
| Codex `exec resume` | No, starts another process/turn path | Poor | Do not use for wake |
| Codex app-server `turn/start` | Plausible, unverified | Separate architecture | Defer to spike |

