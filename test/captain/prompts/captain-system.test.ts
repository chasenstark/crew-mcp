import { describe, expect, it } from 'vitest';
import {
  buildCaptainSystemPrompt,
  type CaptainPromptAgentEntry,
  type CaptainPromptToolEntry,
} from '../../../src/captain/prompts/captain-system.js';
import {
  M3_TOOL_NAMES,
  ToolCatalog,
} from '../../../src/captain/tools/catalog.js';
import type { WorkflowConfig } from '../../../src/workflow/types.js';
import type { AgentAdapter } from '../../../src/adapters/types.js';

const workflow: WorkflowConfig = {
  name: 'default',
  execution: { mode: 'judgment' },
  steps: [
    { role: 'coder', agent: 'codex', action: 'implement' },
    { role: 'reviewer', agent: 'claude-code', action: 'review' },
  ],
  completion: { strategy: 'judge_approval', fallback: 'max_passes' },
};

const agents: CaptainPromptAgentEntry[] = [
  { name: 'codex', capabilities: ['implement', 'review'] },
  { name: 'claude-code', capabilities: ['review', 'refactor'] },
];

/**
 * Live catalog entries (names + descriptions stripped of the `mcp__crew__`
 * prefix) — matches how judgment-runner.ts:1665-1672 passes them.
 */
function liveCatalogEntries(): readonly CaptainPromptToolEntry[] {
  const registry = {
    get(_name: string): AgentAdapter | undefined {
      return undefined;
    },
    list() {
      return agents.map((a) => ({ name: a.name, capabilities: a.capabilities }));
    },
  };
  const catalog = new ToolCatalog({ registry, workflow });
  return catalog.toActionCatalog().map((entry) => ({
    name: entry.name,
    description: entry.description,
  }));
}

describe('buildCaptainSystemPrompt', () => {
  it('renders a stable prompt for a minimal (no-preset) call', () => {
    const prompt = buildCaptainSystemPrompt({
      workflow,
      agents,
      tools: liveCatalogEntries(),
    });
    expect(prompt).toMatchSnapshot();
  });

  it('renders the preset hint verbatim when provided', () => {
    const prompt = buildCaptainSystemPrompt({
      workflow,
      agents,
      tools: liveCatalogEntries(),
      preset: {
        name: 'default',
        hint: 'prefer review after implementation\ncall finish when done',
      },
    });
    expect(prompt).toContain('## Preset hint');
    expect(prompt).toContain('prefer review after implementation');
    expect(prompt).toContain('call finish when done');
  });

  it('renders "(none)" in the preset section when preset is absent', () => {
    const prompt = buildCaptainSystemPrompt({
      workflow,
      agents,
      tools: liveCatalogEntries(),
    });
    expect(prompt).toMatch(/## Preset hint\n\(none\)/);
  });

  it('lists every live-catalog tool with mcp__crew__ prefix', () => {
    const entries = liveCatalogEntries();
    const prompt = buildCaptainSystemPrompt({ workflow, agents, tools: entries });
    for (const tool of entries) {
      expect(prompt).toContain(`mcp__crew__${tool.name}`);
    }
    // Every M3 tool name must be represented — protects against a catalog
    // regression silently shrinking the surface.
    expect(entries.map((e) => e.name).sort()).toEqual([...M3_TOOL_NAMES].sort());
  });

  it('includes the inline-reasoning guardrails introduced in M4-1', () => {
    const prompt = buildCaptainSystemPrompt({
      workflow,
      agents,
      tools: liveCatalogEntries(),
    });
    expect(prompt).toContain(
      'Prefer inline reasoning over wrapper tools. `analyze_output` and `compress_context` exist for long-context or structured-extraction cases; skip them when you can reason about the tool_result directly.',
    );
    expect(prompt).toContain(
      "Call `run_agent` with a prompt you wrote — the agent sees the prompt verbatim. Don't route through `plan_tasks` for single-task work.",
    );
  });

  it('includes the calibrated-dialogue "Working with the user" section', () => {
    const prompt = buildCaptainSystemPrompt({
      workflow,
      agents,
      tools: liveCatalogEntries(),
    });
    // Section header must exist — the calibrated stance is a default-visible
    // contract, not an opt-in preset.
    expect(prompt).toContain('## Working with the user');
    // The three calibration buckets must all be present so the captain can
    // pick between them. Don't pin exact prose (it will iterate); pin the
    // semantic markers.
    expect(prompt).toMatch(/Small, well-specified asks/);
    expect(prompt).toMatch(/Multi-step or larger asks/);
    expect(prompt).toMatch(/Genuinely ambiguous/);
    // Ordering: Working-with-user must come BEFORE Tools so the captain reads
    // the conversational stance before seeing the tool inventory.
    const workingIdx = prompt.indexOf('## Working with the user');
    const toolsIdx = prompt.indexOf('## Tools');
    expect(workingIdx).toBeGreaterThan(-1);
    expect(toolsIdx).toBeGreaterThan(workingIdx);
    // Guard against regression to the "only when genuinely blocked" framing
    // anywhere in the prompt.
    expect(prompt).not.toMatch(/genuinely blocked/);
  });

  it('lists every agent with its capabilities', () => {
    const prompt = buildCaptainSystemPrompt({
      workflow,
      agents,
      tools: liveCatalogEntries(),
    });
    expect(prompt).toContain('**codex**');
    expect(prompt).toContain('implement, review');
    expect(prompt).toContain('**claude-code**');
    expect(prompt).toContain('review, refactor');
  });

  it('marks unhealthy agents in the inventory', () => {
    const prompt = buildCaptainSystemPrompt({
      workflow,
      agents: [{ name: 'broken', capabilities: ['analyze'], healthy: false }],
      tools: liveCatalogEntries(),
    });
    expect(prompt).toContain('**broken** [unhealthy]');
  });

  it('shows a stub agent block when no agents are registered', () => {
    const prompt = buildCaptainSystemPrompt({
      workflow,
      agents: [],
      tools: liveCatalogEntries(),
    });
    expect(prompt).toContain('## Agent inventory');
    expect(prompt).toContain('(no agents registered)');
  });

  it('is deterministic: same inputs produce identical output', () => {
    const tools = liveCatalogEntries();
    const a = buildCaptainSystemPrompt({ workflow, agents, tools });
    const b = buildCaptainSystemPrompt({ workflow, agents, tools });
    expect(a).toBe(b);
  });

  describe('suggestedAgentRoles (M5-2)', () => {
    it('renders suggested roles inline under the hint when roles are registered', () => {
      const prompt = buildCaptainSystemPrompt({
        workflow,
        agents,
        tools: liveCatalogEntries(),
        preset: {
          name: 'thorough-review',
          hint: 'review twice',
          suggestedAgentRoles: ['review', 'implement'],
        },
      });
      expect(prompt).toContain('## Preset hint');
      expect(prompt).toContain('review twice');
      expect(prompt).toContain('Suggested roles: review, implement');
      expect(prompt).not.toContain('(intent — no adapter registered)');
    });

    it('qualifies unregistered roles so the captain does not hallucinate agent_id', () => {
      const prompt = buildCaptainSystemPrompt({
        workflow,
        agents: [{ name: 'codex', capabilities: ['implement', 'review'] }],
        tools: liveCatalogEntries(),
        preset: {
          name: 'mixed',
          hint: 'hi',
          suggestedAgentRoles: ['review', 'security', 'tests'],
        },
      });
      expect(prompt).toContain('Suggested roles: review, security (intent — no adapter registered), tests (intent — no adapter registered)');
    });

    it('renders roles alone when hint is absent', () => {
      const prompt = buildCaptainSystemPrompt({
        workflow,
        agents,
        tools: liveCatalogEntries(),
        preset: {
          name: 'roles-only',
          suggestedAgentRoles: ['review'],
        },
      });
      expect(prompt).toContain('## Preset hint');
      expect(prompt).toContain('Suggested roles: review');
      // No residue of a blank hint line
      expect(prompt).not.toMatch(/## Preset hint\n\n/);
    });

    it('falls back to (none) when both hint and roles are empty', () => {
      const prompt = buildCaptainSystemPrompt({
        workflow,
        agents,
        tools: liveCatalogEntries(),
        preset: { name: 'empty' },
      });
      expect(prompt).toMatch(/## Preset hint\n\(none\)/);
    });

    it('is case-insensitive when matching roles against capabilities', () => {
      const prompt = buildCaptainSystemPrompt({
        workflow,
        agents: [{ name: 'agent', capabilities: ['Review', 'Implement'] }],
        tools: liveCatalogEntries(),
        preset: {
          name: 'case',
          suggestedAgentRoles: ['review', 'implement'],
        },
      });
      expect(prompt).not.toContain('(intent — no adapter registered)');
    });
  });

  it('accepts a caller-supplied tool list (M3-4 integration seam)', () => {
    const prompt = buildCaptainSystemPrompt({
      workflow,
      agents,
      tools: [
        { name: 'run_agent', description: 'delegate' },
        { name: 'finish', description: 'stop' },
      ],
    });
    expect(prompt).toContain('mcp__crew__run_agent');
    expect(prompt).toContain('mcp__crew__finish');
    expect(prompt).toContain('delegate');
    expect(prompt).not.toContain('mcp__crew__list_agents');
  });

  it('appends a compression advisory to the guardrails when supplied', () => {
    const prompt = buildCaptainSystemPrompt({
      workflow,
      agents,
      tools: liveCatalogEntries(),
      advisory: 'Session is getting long — consider compress_context.',
    });
    expect(prompt).toMatch(
      /## Operating guardrails[\s\S]*- Session is getting long — consider compress_context\.$/,
    );
  });

  it('ignores an empty advisory string', () => {
    const prompt = buildCaptainSystemPrompt({
      workflow,
      agents,
      tools: liveCatalogEntries(),
      advisory: '   ',
    });
    expect(prompt).not.toMatch(/Session is getting long/);
    expect(prompt.endsWith(
      "- Call `run_agent` with a prompt you wrote — the agent sees the prompt verbatim. Don't route through `plan_tasks` for single-task work.",
    )).toBe(true);
  });
});
