/**
 * Captain-system prompt for the M3 tool-surface era.
 *
 * Replaces the 11-verb controller's structured-decision prompt with a
 * free-form role statement + tool inventory + preset hint + operating
 * guardrails. The captain sees this once per turn as the `system` message;
 * it persists across turns only as the compiled prompt string (which is
 * prompt material, not tool-schema — so edits to presets do NOT invalidate
 * providerSessionRef; only changes to the tool names/schemas do, via
 * ToolCatalog.getToolSchemaHash()).
 *
 * Callers MUST supply `tools` — the per-tool `<NAME>_DESCRIPTION` exports
 * flow through `ToolCatalog.toActionCatalog()` into the live MCP surface
 * AND this prompt, so prefix text (e.g. `**Primary**`, `**Optional**`)
 * lives in exactly one place. There is no fallback default: keeping a
 * hand-rolled duplicate here was a drift hazard.
 */

import type { WorkflowConfig, PresetConfig } from '../../workflow/types.js';

export interface CaptainPromptAgentEntry {
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly healthy?: boolean;
}

export interface BuildCaptainSystemPromptArgs {
  readonly workflow: WorkflowConfig;
  readonly agents: readonly CaptainPromptAgentEntry[];
  readonly preset?: PresetConfig;
  /**
   * Tool descriptors to render in the "## Tools" section. Required —
   * `ToolCatalog.toActionCatalog()` is the single source of truth; callers
   * pass the catalog's live list so the prompt and the CaptainActionServer
   * agree on the surface (Finding 1 — M3 schema-drift risk).
   */
  readonly tools: readonly CaptainPromptToolEntry[];
  /**
   * Optional one-line advisory appended to the guardrails section when the
   * session-loop wants to nudge the captain (e.g., M4-2's compression
   * threshold). Stays out of the tool catalog hash so firing the advisory
   * cannot invalidate `providerSessionRef`.
   */
  readonly advisory?: string;
}

export interface CaptainPromptToolEntry {
  readonly name: string;
  readonly description: string;
}

/**
 * Render the captain-system prompt. Pure function: same inputs → same output.
 * Used by both test snapshots and the live runner.
 */
export function buildCaptainSystemPrompt(args: BuildCaptainSystemPromptArgs): string {
  const sections: string[] = [];

  sections.push(renderRole(args.workflow));
  sections.push(renderWorkingWithUser());
  sections.push(renderTools(args.tools));
  sections.push(renderAgents(args.agents));
  sections.push(renderWorkflowHint(args.workflow));
  sections.push(renderPreset(args.preset, args.agents));
  sections.push(renderGuardrails(args.advisory));

  return sections
    .map((section) => section.trim())
    .filter((section) => section.length > 0)
    .join('\n\n');
}

function renderRole(workflow: WorkflowConfig): string {
  return [
    '## Role',
    `You are the user's collaborator on a multi-agent coding crew named "${workflow.name}". The user is talking to you directly — subagents (via \`run_agent\`) are tools you dispatch to do work, not separate participants. Your job is to understand what the user wants, do the work (yourself or via dispatched agents), and verify the result with them.`,
  ].join('\n');
}

function renderWorkingWithUser(): string {
  return [
    '## Working with the user',
    'Calibrate dialogue to the size of the ask. Don\'t ceremoniously confirm trivial work — over-asking defeats the point of the crew.',
    '',
    '- **Small, well-specified asks** (fix this typo, rename X to Y, add a test for `func`): just do it. Dispatch, finish.',
    '- **Multi-step or larger asks** ("rework the config", "improve the auth module", "refactor for clarity"): share your read of the request and a brief plan via `message_user`, then wait for the user to confirm or refine before dispatching. They may correct your scope, surface a constraint, or pick between approaches.',
    '- **Genuinely ambiguous "what"** (the request has multiple plausible interpretations): use `ask_user` to clarify before planning.',
    '',
    'Signals that a request wants the dialogue beat: open-ended verbs ("rework", "improve", "redesign"), no specific target file or symbol, multiple plausible approaches, or decisions with downstream consequences. When in doubt, prefer a short plan-share over silent dispatch — it\'s cheap, and the user can always say "just do it."',
    '',
    'Narrate when it helps the user track multi-step work — a short `message_user` between dispatches in a planned flow. For a single trivial dispatch, skip the narration; the result is enough.',
    '',
    'Verify before finishing when the work was planned. If you shared a plan upfront, check the dispatched agent\'s output against the plan before `finish`. For trivial asks, skip the verification beat.',
  ].join('\n');
}

/**
 * Render the workflow's role → candidate-agents map as a hint section.
 * The captain treats this as a preference, not a contract — see the section
 * body. Steps with no candidates (shouldn't happen post-codec validation)
 * are skipped silently.
 */
function renderWorkflowHint(workflow: WorkflowConfig): string {
  if (!workflow.steps || workflow.steps.length === 0) return '';
  const lines = workflow.steps
    .filter((step) => step.agents && step.agents.length > 0)
    .map((step) => {
      const candidates = step.agents.join(', ');
      const passes = typeof step.maxPasses === 'number' ? ` (≤${step.maxPasses} passes)` : '';
      return `- **${step.role}** → ${step.action}: try \`${candidates}\`${passes}`;
    });
  if (lines.length === 0) return '';
  return [
    '## Workflow hint',
    'Each role lists candidate agents in preference order — try the first available, deviate when there\'s reason (unhealthy agent, capability mismatch, the user told you to). This is a hint, not a contract; you have discretion to skip a role for trivial work or add an extra dispatch when warranted.',
    ...lines,
  ].join('\n');
}

function renderTools(tools: readonly CaptainPromptToolEntry[]): string {
  if (tools.length === 0) return '';
  const lines = tools.map(
    (tool) => `- \`mcp__crew__${tool.name}\` — ${tool.description}`,
  );
  return ['## Tools', 'You may call any of the following tools. Each call is structured; never emit raw shell commands.', ...lines].join('\n');
}

function renderAgents(agents: readonly CaptainPromptAgentEntry[]): string {
  const header = '## Agent inventory';
  if (agents.length === 0) {
    return `${header}\n(no agents registered)`;
  }
  const lines = agents.map((agent) => {
    const health = agent.healthy === false ? ' [unhealthy]' : '';
    const caps = agent.capabilities.length > 0 ? agent.capabilities.join(', ') : '(none)';
    return `- **${agent.name}**${health}: ${caps}`;
  });
  return [header, ...lines].join('\n');
}

function renderPreset(
  preset: PresetConfig | undefined,
  agents: readonly CaptainPromptAgentEntry[],
): string {
  const header = '## Preset hint';
  const hint = preset?.hint?.trim();
  const rolesLine = renderSuggestedRoles(preset?.suggestedAgentRoles, agents);

  if (!hint && !rolesLine) {
    // Empty section header with no body — the plan calls for an "empty section
    // header when preset is absent" so the prompt shape stays stable.
    return `${header}\n(none)`;
  }

  const body: string[] = [];
  if (hint) body.push(hint);
  if (rolesLine) body.push(rolesLine);
  return `${header}\n${body.join('\n')}`;
}

/**
 * Render `suggestedAgentRoles` inline with an inventory-aware qualifier.
 * Each role is checked against every registered agent's `capabilities` array
 * (case-insensitive). A role that no agent claims is qualified as
 * "(intent — no adapter registered)" so the captain doesn't hallucinate
 * `run_agent(agent_id='X')` for an unregistered role.
 *
 * Returns an empty string when roles is empty/undefined — caller decides
 * how to compose the section.
 */
function renderSuggestedRoles(
  roles: readonly string[] | undefined,
  agents: readonly CaptainPromptAgentEntry[],
): string {
  if (!roles || roles.length === 0) return '';
  const registered = new Set<string>();
  for (const agent of agents) {
    for (const cap of agent.capabilities) {
      registered.add(cap.toLowerCase());
    }
  }
  const rendered = roles.map((role) => {
    const match = registered.has(role.toLowerCase());
    return match ? role : `${role} (intent — no adapter registered)`;
  });
  return `Suggested roles: ${rendered.join(', ')}`;
}

function renderGuardrails(advisory?: string): string {
  const lines = [
    '## Operating guardrails',
    '- Call `finish` when the user\'s request is addressed and (for planned work) you\'ve verified the result.',
    '- Do not call `finish` while `run_agent` or `ask_user` work is queued or in flight; wait for the tool result first.',
    '- Match dialogue to ask size — see *Working with the user*. Don\'t confirm trivial changes; do share a plan before dispatching for multi-step or larger asks.',
    '- Budgets apply — exceeded budgets arrive as `warning` on tool results; you may continue or stop.',
    '- Prefer inline reasoning over wrapper tools. `analyze_output` and `compress_context` exist for long-context or structured-extraction cases; skip them when you can reason about the tool_result directly.',
    '- Call `run_agent` with a prompt you wrote — the agent sees the prompt verbatim. Don\'t route through `plan_tasks` for single-task work.',
  ];
  const trimmed = advisory?.trim();
  if (trimmed) {
    lines.push(`- ${trimmed}`);
  }
  return lines.join('\n');
}
