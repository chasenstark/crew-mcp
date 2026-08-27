# crew-mcp

Run Claude Code, Codex, Antigravity (Gemini), and local models as one coding
crew from the conversation you already use.

- Use the CLI logins and subscriptions you already have.
- Send the same diff to independent models and compare their judgment.
- Keep write runs isolated and decide what lands on your branch.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chasenstark/crew-mcp/main/docs/assets/crew-flow-dark.png">
  <img alt="One conversation dispatches Claude Code, Codex, agy/Antigravity and local models into isolated worktrees; you approve what merges." src="https://raw.githubusercontent.com/chasenstark/crew-mcp/main/docs/assets/crew-flow.png" width="980">
</picture>

Crew is an MCP server plus captain playbooks. Your host CLI becomes the
captain; other agents become workers and reviewers.

## Install in 60 seconds

Requires Node.js 20+, git, and an authenticated Claude Code or Codex CLI.

```sh
npm install -g crew-mcp
crew-mcp install --target all
crew-mcp verify
```

Restart your host CLI, then ask naturally:

> Have Codex implement the rate limiter, then have Claude review it.

`crew-mcp verify` checks the installed skill and tool-catalog parity. See the
[installation guide](https://github.com/chasenstark/crew-mcp/blob/main/docs/guides/installation.md)
for source installs, project scope, Antigravity setup, Codex wake modes, and
uninstalling.

## Choose a workflow

| You ask | Crew runs | Use it for |
| --- | --- | --- |
| "Have Codex build this." | **Dispatch** — one agent, one worktree, one result | A bounded implementation, investigation, or review |
| "Have three models review this." | **Panel** — parallel reviewers, full review each | Independent judgment on the same target |
| "Keep iterating until it ships." | **Iterate** — criteria-gated build/review rounds | Work that has to meet a standard, not just compile |

Runs are asynchronous. The captain reports the dispatch immediately, and a
watcher wakes the conversation when supported; you can keep using the host CLI
while workers run.

## Iterate to acceptance

`crew-iterate` turns a request into a criteria-gated delivery loop:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chasenstark/crew-mcp/main/docs/assets/crew-iterate-dark.png">
  <img alt="Your request becomes acceptance criteria you confirm, then implement and independent review loop on FAIL until all criteria pass and you decide the merge." src="https://raw.githubusercontent.com/chasenstark/crew-mcp/main/docs/assets/crew-iterate.png" width="980">
</picture>

The confirmed criteria become the contract for the implementer and every
reviewer. Crew combines dispatched reviewers with a host-native review, scores
each criterion PASS/FAIL, and folds findings back through `continue_run`.
The safety cap is 3 rounds per criteria epoch and 9 rounds total.

## Safe by design

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chasenstark/crew-mcp/main/docs/assets/crew-isolation-dark.png">
  <img alt="A crew write run happens in ~/.crew/runs/&lt;id&gt;/worktree; you inspect the diff, then merge_run squash-merges it onto your branch or discard_run throws the worktree away." src="https://raw.githubusercontent.com/chasenstark/crew-mcp/main/docs/assets/crew-isolation.png" width="980">
</picture>

Write runs use isolated git worktrees. Enforced read-only reviewers can inspect
an existing checkout; agy reviews use disposable, non-mergeable snapshot
worktrees because Antigravity cannot enforce read-only access. The captain asks
before merging or discarding. Squash is the default merge strategy; preserving
an intentional commit stack is also supported.

Workers do not receive the captain tool surface. Claude Code and Codex workers
get only a scoped `send_message` tool for returning structured findings.

## Hosts and workers

| Integration | Captain host | Worker | Review mode |
| --- | --- | --- | --- |
| Claude Code | Global or project | Yes | Advisory read-only |
| Codex | Global or project | Yes | Read-only |
| Antigravity (`agy`, Gemini models) | Project only | Yes | Disposable snapshot |
| Ollama / LM Studio | No | Text-only | No repo access |
| OpenAI-compatible / generic | No | Yes | Depends on adapter |

Provider model pins are exact-or-refuse: Crew discovers provider-native model
choices and rejects unknown names before allocating work. `crew-mcp config`
can save one validated default for each built-in provider; per-call pins still
win, and clearing a saved value restores the provider CLI default. Local
OpenAI-compatible agents are useful for brainstorming and prose today, but
they cannot read the repository until context injection is implemented.

## Tool surface

| Stage | Tools |
| --- | --- |
| Dispatch | `run_agent` · `continue_run` · `run_panel` |
| Observe | `get_run_status` · `get_panel_status` · `list_runs` · `list_agents` · `list_models` |
| Decide | `merge_run` · `discard_run` · `cancel_run` · `aggregate_panel` |
| Contract | `create_criteria` · `confirm_criteria` · `get_criteria` · `revise_criteria` |
| PR watch | `start_pr_watch` · `list_pr_watches` · `get_pr_watch_status` · `rearm_pr_watch` · `cancel_pr_watch` · `authorize_pr_watch_actions` |
| Preferences | `get_crew_preferences` |
| Messaging | `check_captain_inbox` · `acknowledge_messages` — workers get only `send_message` |

That is 25 captain tools plus one worker-only tool. The
[tool reference](https://github.com/chasenstark/crew-mcp/blob/main/docs/architecture/tools.md)
owns the complete schemas and envelope contracts.

## Extended documentation

- [Documentation home](https://github.com/chasenstark/crew-mcp/blob/main/docs/README.md)
- [Install and upgrade](https://github.com/chasenstark/crew-mcp/blob/main/docs/guides/installation.md)
- [Agents and models](https://github.com/chasenstark/crew-mcp/blob/main/docs/guides/agents-and-models.md)
- [Configuration](https://github.com/chasenstark/crew-mcp/blob/main/docs/guides/configuration.md)
- [Operations and troubleshooting](https://github.com/chasenstark/crew-mcp/blob/main/docs/guides/operations-and-troubleshooting.md)
- [Runtime architecture](https://github.com/chasenstark/crew-mcp/blob/main/docs/architecture/README.md)
- [Durable PR watch](https://github.com/chasenstark/crew-mcp/blob/main/docs/architecture/pr-watch.md)

## License

[MIT](LICENSE)
