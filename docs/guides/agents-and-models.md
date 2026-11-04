# Agents and models

Crew separates three ideas:

```text
captain host  -> the CLI where you talk to Crew
agent adapter -> the provider or command Crew can dispatch
model         -> the exact provider model selected for one turn
```

Claude Code and Codex can be both captains and workers. Antigravity can be a
project-scoped captain and a write-capable worker. Local and custom endpoints
are workers only.

## Built-in agents

| Agent | Good default use | Review behavior |
| --- | --- | --- |
| Claude Code | judgment, specifications, careful review | Advisory read-only plus dirty-tree probe |
| Codex | scoped implementation and long loops | OS-enforced read-only sandbox |
| Antigravity (`agy`) | long-context and bulk work | Disposable snapshot; never mergeable as a review |

Actual routing is driven by `useWhen`, strengths, health, quota signals, and
your saved preferences. A user-named agent always takes precedence when it is
available and not banned.

## Inspect available agents and models

Ask the captain which agents or provider models are available. Under the hood,
`list_agents` reports adapter capability, health, defaults, and routing hints;
`list_models` performs provider-native discovery.

Model selection is exact-or-refuse:

```text
requested model -> provider catalog -> exact match -> dispatch
                                  `-> no match ---> refuse before allocation
```

A per-call model overrides the saved default for that provider. With neither
value, Crew deliberately uses the provider CLI default. Continuations inherit
the previous turn's selection unless explicitly changed.

## Configure agent preferences

Use the interactive commands rather than editing files by hand:

```sh
crew-mcp agents list
crew-mcp agents add
crew-mcp agents edit
crew-mcp agents remove
crew-mcp config
```

`crew-mcp agents add` registers local, OpenAI-compatible, or generic agents.
The `Provider models...` screen in `crew-mcp config` discovers exact choices
and sets one default for each built-in provider. Clearing a selection restores
that provider's own CLI default. `Agent defaults...` separately chooses
implementers, panel reviewers, and per-scope ban lists. `crew-mcp agents edit`
remains the raw editor for `useWhen`, strengths, model, and effort.

The model precedence for a fresh turn is:

```text
per-call model -> saved provider default -> provider CLI default
```

Per-machine agent records live in `~/.crew/agents.json`. Workflow compatibility
files may still exist, but the CLI is the supported editing surface.

## Local and custom agents

```sh
crew-mcp agents add --provider ollama
crew-mcp agents add --provider lm-studio
crew-mcp agents add --provider openai-compatible --api-base http://localhost:8080/v1
```

The wizard discovers advertised models and stores the selected endpoint.
Requests to Ollama or LM Studio stay local when the endpoint itself is local.
Remote OpenAI-compatible endpoints use that endpoint's own authentication and
billing.

OpenAI-compatible agents are chat-completions workers without filesystem
tools. They can review supplied text, attached files and bounded automatic diffs, as well as
handle brainstorming and prose tasks.

`list_agents.repo_context_mode` makes repository access explicit:

| Mode | What the worker can receive |
| --- | --- |
| `workspace` | Working-directory access through its provider tools. This does not prove it inspected a file. |
| `supplied-text` | Prompt, peer messages, supported file attachments and automatic review diffs; no checkout tools. |
| `unknown` | Crew cannot establish the configured command's capabilities. |

OpenAI-compatible workers report `supplied-text`. Initial dispatches,
continuations, and panel reviewers carry a `repo_context.supplied_text_only`
warning. OpenAI-compatible read-only reviews receive a bounded automatic diff;
they cannot explore the checkout or fetch missing context themselves. These
warnings do not prevent supplied-text tasks from running.

Agents with `list_agents.accepts_context_files: true` accept `context_files`
on `run_agent`, `continue_run`, and each `run_panel` reviewer. For example:

```json
{
  "agent_id": "qwen",
  "prompt": "Review these two files for error handling problems.",
  "run_mode": "read_only",
  "context_files": ["src/parser.ts", "src/handler.ts"]
}
```

Paths are relative to the selected run working directory. A bound panel reads
its review workspace; a continuation reads its current run workspace. File
selections apply only to that call. Resend the paths and restate the task on
continuation; the adapter does not inherit its previous response. Unsupported
adapters reject file selections.

For capable supplied-text agents, `read_only` dispatches and continuations also
collect a diff. At a host repository root, the baseline is the current `HEAD`:
staged, unstaged and nonignored untracked contents are compared with that commit.
A clean feature branch has no working-tree diff; Crew does not guess its branch
base. When reviewing an existing Crew run, including a bound panel, the baseline
is the run's recorded starting commit, so committed implementer changes are
included. That baseline stays fixed across continuation; the contents refresh.
An explicit panel working-directory override selects the corresponding target.
Missing run metadata, non-Git directories and repository subdirectories produce
omissions rather than silently selecting another baseline or a parent checkout.
Write runs, disposable review workspaces, workspace agents and agents with
unknown capabilities do not receive automatic diffs.

Crew accepts up to 50 named paths, with at most 32 KiB per file and 64 KiB of
repository text in total. Named files take priority over automatic patches.
A shared estimated 16,384-token request budget reserves 4,096
tokens for output and 1,024 for framing, subtracts the composed prompt, and
counts serialized attachment data. Its conservative bytes/3 estimate is a
heuristic, not a tokenizer or a guarantee about the backend's context window.
Whole files that exceed these limits are omitted, rather than partially read
as complete files. Symlinks, paths outside the workspace, Git metadata,
nonregular files, binary files and invalid UTF-8 are also omitted.

Automatic scanning allows at most 2,000 paths, 512 KiB of Git metadata, 2 MiB
of file/blob reads (including named-file reads), and a five-second scan deadline.
Individual patches also have a 32 KiB limit. Its attachment states the baseline
and whether collection was complete. Renames appear as a
deletion and addition; conflicts, symlinks, submodules and unreadable entries
are omitted. Git supplies bounded metadata and raw blobs; Crew safely reads
current files and constructs patches without running repository diff or clean
filters. These checks do not provide an OS sandbox against hostile concurrent
filesystem changes. Inspect the omissions even when some patches were included.

Omissions appear in the model's attachment and in terminal warnings:
`context_truncated` for budget omissions, `context_file_omitted` for unusable
paths, `context_diff_incomplete` for incomplete automatic collection, and
`context_egress_skipped` when remote transmission is disabled. Inspect
these warnings before relying on a review. Even without a warning, Crew cannot
verify whether the backend truncated input; an attached-file review does not
establish an independent review of the whole checkout.

Loopback endpoints receive repository context by default. To send it to a remote
endpoint, set `CREW_OPENAI_ALLOW_REMOTE_CONTEXT=1` in the Crew server's
environment. Without it Crew skips context file and Git reads. Attachment
requests reject redirects; configure the final endpoint URL directly.

Generic agents run a configured command. Their filesystem, review, model, and
result guarantees depend on that command; Crew does not invent unsupported
capabilities.

## Review execution modes

```text
write             isolated branch + worktree, mergeable
read_only         existing directory, merge refused
ephemeral_review  disposable snapshot, findings only, merge refused
```

Codex can enforce read-only with its filesystem sandbox. Claude Code treats
read-only as an instruction plus a post-run dirty-tree probe. Antigravity cannot
honestly promise read-only behavior, so panels automatically give it an
`ephemeral_review` snapshot.

## Effort and quota

Agent defaults may include `low`, `medium`, `high`, `xhigh`, or `max` effort;
each adapter clamps that vocabulary to what its provider supports. Leave effort
unset unless a task benefits from a deliberate override.

Crew uses health and quota signals to avoid obviously unavailable agents.
Numeric `used_percent` headroom is currently Codex-specific; other providers
may expose only coarse availability.
