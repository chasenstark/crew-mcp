import { describe, expect, it } from 'vitest';
import {
  buildCaptainSystemPrompt,
  DEFAULT_CAPTAIN_TOOL_ENTRIES,
  type CaptainPromptAgentEntry,
} from '../../../src/captain/prompts/captain-system.js';
import type { WorkflowConfig } from '../../../src/workflow/types.js';

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

describe('buildCaptainSystemPrompt', () => {
  it('renders a stable prompt for a minimal (no-preset) call', () => {
    const prompt = buildCaptainSystemPrompt({ workflow, agents });
    expect(prompt).toMatchSnapshot();
  });

  it('renders the preset hint verbatim when provided', () => {
    const prompt = buildCaptainSystemPrompt({
      workflow,
      agents,
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
    const prompt = buildCaptainSystemPrompt({ workflow, agents });
    expect(prompt).toMatch(/## Preset hint\n\(none\)/);
  });

  it('lists every tool with mcp__crew__ prefix', () => {
    const prompt = buildCaptainSystemPrompt({ workflow, agents });
    for (const tool of DEFAULT_CAPTAIN_TOOL_ENTRIES) {
      expect(prompt).toContain(`mcp__crew__${tool.name}`);
    }
  });

  it('lists every agent with its capabilities', () => {
    const prompt = buildCaptainSystemPrompt({ workflow, agents });
    expect(prompt).toContain('**codex**');
    expect(prompt).toContain('implement, review');
    expect(prompt).toContain('**claude-code**');
    expect(prompt).toContain('review, refactor');
  });

  it('marks unhealthy agents in the inventory', () => {
    const prompt = buildCaptainSystemPrompt({
      workflow,
      agents: [{ name: 'broken', capabilities: ['analyze'], healthy: false }],
    });
    expect(prompt).toContain('**broken** [unhealthy]');
  });

  it('shows a stub agent block when no agents are registered', () => {
    const prompt = buildCaptainSystemPrompt({ workflow, agents: [] });
    expect(prompt).toContain('## Agent inventory');
    expect(prompt).toContain('(no agents registered)');
  });

  it('is deterministic: same inputs produce identical output', () => {
    const a = buildCaptainSystemPrompt({ workflow, agents });
    const b = buildCaptainSystemPrompt({ workflow, agents });
    expect(a).toBe(b);
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
    expect(prompt).not.toContain('mcp__crew__list_agents');
  });
});
