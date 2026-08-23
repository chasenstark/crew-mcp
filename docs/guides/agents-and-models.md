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

Current OpenAI-compatible agents are chat-completions workers. They do not
receive repository contents or filesystem tools, so use them for brainstorming,
prose, and supplied-text review—not claims that require reading the checkout.

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
