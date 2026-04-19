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
 * The tool list is hand-rolled here so M3-3 can land before M3-4's
 * ToolCatalog. M3-4 re-threads this file through the catalog so the source
 * of truth for what the captain can see lives in exactly one place. Both
 * variants list the same 8 tools and produce the same prompt body.
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
   * Tool descriptors to render in the "## Tools" section. When absent, the
   * module falls back to its own hand-rolled list — same 8 names, same
   * short descriptions. M3-4's ToolCatalog passes its own list through so
   * the prompt and the CaptainActionServer agree on the surface.
   */
  readonly tools?: readonly CaptainPromptToolEntry[];
}

export interface CaptainPromptToolEntry {
  readonly name: string;
  readonly description: string;
}

/**
 * The 8 tools the M3 captain sees. Names are un-prefixed here; the prompt
 * renders them as the captain will call them (`mcp__crew__<name>`).
 */
export const DEFAULT_CAPTAIN_TOOL_ENTRIES: readonly CaptainPromptToolEntry[] = [
  {
    name: 'run_agent',
    description:
      'Delegate a bounded task to a named subagent. Pick agent_id from the inventory; the prompt you pass is what the agent sees verbatim.',
  },
  {
    name: 'list_agents',
    description:
      'Return the current agent inventory (names, capabilities, health). Use when the inventory may have shifted or when you want up-to-date quota hints.',
  },
  {
    name: 'ask_user',
    description:
      'Block and wait for a user response. Reach for this only when genuinely blocked; small clarifications should be answered inline.',
  },
  {
    name: 'message_user',
    description:
      'Write a message to the user without ending the turn. Use for status updates, partial reports, or narration the user should see.',
  },
  {
    name: 'plan_tasks',
    description:
      'Decompose the user request into structured tasks. Useful for multi-step work; optional for trivial asks.',
  },
  {
    name: 'analyze_output',
    description:
      'Summarize an agent result into a structured assessment (decisions, concerns, review findings). Optional wrapper.',
  },
  {
    name: 'compress_context',
    description:
      'Condense a long analyzed output into a terse summary for the next pass. Optional wrapper.',
  },
  {
    name: 'finish',
    description:
      'Emit the final report and terminate the session. Call this when the user request is addressed — do not wait for external confirmation.',
  },
];

/**
 * Render the captain-system prompt. Pure function: same inputs → same output.
 * Used by both test snapshots and the live runner.
 */
export function buildCaptainSystemPrompt(args: BuildCaptainSystemPromptArgs): string {
  const tools = args.tools ?? DEFAULT_CAPTAIN_TOOL_ENTRIES;
  const sections: string[] = [];

  sections.push(renderRole(args.workflow));
  sections.push(renderTools(tools));
  sections.push(renderAgents(args.agents));
  sections.push(renderPreset(args.preset));
  sections.push(renderGuardrails());

  return sections
    .map((section) => section.trim())
    .filter((section) => section.length > 0)
    .join('\n\n');
}

function renderRole(workflow: WorkflowConfig): string {
  return [
    '## Role',
    `You are the captain of a multi-agent coding crew named "${workflow.name}". You orchestrate subagents via the tool calls below, ` +
      'decide when work is done, and communicate results back to the user.',
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

function renderPreset(preset: PresetConfig | undefined): string {
  const header = '## Preset hint';
  const hint = preset?.hint?.trim();
  if (!hint) {
    // Empty section header with no body — the plan calls for an "empty section
    // header when preset is absent" so the prompt shape stays stable.
    return `${header}\n(none)`;
  }
  return `${header}\n${hint}`;
}

function renderGuardrails(): string {
  return [
    '## Operating guardrails',
    '- Call `finish` when the user\'s request is addressed.',
    '- If you are uncertain or genuinely blocked, call `ask_user`.',
    '- Budgets apply — exceeded budgets arrive as `warning` on tool results; you may continue or stop.',
  ].join('\n');
}
