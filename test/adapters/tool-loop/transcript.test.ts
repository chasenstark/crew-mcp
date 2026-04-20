import { describe, expect, it } from 'vitest';
import { buildDecisionPrompt } from '../../../src/adapters/tool-loop/transcript.js';
import { TOOL_LOOP_MESSAGE_CHAR_LIMIT } from '../../../src/adapters/tool-loop/constants.js';

describe('buildDecisionPrompt', () => {
  it('omits inline transcript when resuming from a provider session', () => {
    const prompt = buildDecisionPrompt(
      [{ name: 'run_decompose', description: 'decompose', inputSchema: { type: 'object' } }],
      [{ role: 'user', content: 'long prior transcript that should not be replayed' }],
      { continueFromSession: true },
    );

    expect(prompt).toContain('provider resume session already contains prior turns');
    expect(prompt).not.toContain('long prior transcript that should not be replayed');
  });

  describe('system message handling (captain-prompt truncation fix)', () => {
    // Reproduce the real M3 captain-system shape: a multi-section prompt
    // with `## Role`, `## Tools`, `## Agent inventory`, `## Preset hint`,
    // and `## Operating guardrails`. The inventory + preset + guardrails
    // sections are what matter for this regression.
    const bigSystemMessage = [
      '## Role',
      'You are the captain of a multi-agent coding crew named "default".',
      '',
      '## Tools',
      'You may call any of the following tools.',
      '- `mcp__crew__run_agent` — delegate a task',
      '- `mcp__crew__finish` — end the workflow',
      '', '',
      // Padding to push past the 1,500-char truncation threshold.
      `## Padding\n${'x'.repeat(TOOL_LOOP_MESSAGE_CHAR_LIMIT + 200)}`,
      '',
      '## Agent inventory',
      '- **claude-code**: implement, review',
      '- **codex**: implement, review',
      '',
      '## Preset hint',
      'Call finish when the user request is addressed.',
      '',
      '## Operating guardrails',
      '- Prefer inline reasoning over wrapper tools.',
    ].join('\n');

    it('renders system messages verbatim (no 1,500-char truncation that would chop agent inventory + guardrails)', () => {
      const prompt = buildDecisionPrompt(
        [{ name: 'mcp__crew__run_agent', description: 'delegate', inputSchema: { type: 'object' } }],
        [
          { role: 'system', content: bigSystemMessage },
          { role: 'user', content: 'what is this repo?' },
        ],
      );

      // The regression: agent inventory + guardrails must reach the captain,
      // not get chopped by the transcript char limit.
      expect(prompt).toContain('## Agent inventory');
      expect(prompt).toContain('**claude-code**');
      expect(prompt).toContain('**codex**');
      expect(prompt).toContain('## Preset hint');
      expect(prompt).toContain('## Operating guardrails');
    });

    it('skips the duplicated "Available tools:" catalog when the system prompt already has a tools section', () => {
      // The captain-system prompt already renders `## Tools`; re-listing
      // them via the adapter's `Available tools:` block is noise.
      const prompt = buildDecisionPrompt(
        [{ name: 'mcp__crew__run_agent', description: 'delegate', inputSchema: { type: 'object' } }],
        [{ role: 'system', content: bigSystemMessage }],
      );
      expect(prompt).not.toContain('Available tools:');
      // But the system-prompt's own Tools section is intact.
      expect(prompt).toContain('## Tools');
    });

    it('falls back to the adapter controller framing when no system message is supplied', () => {
      const prompt = buildDecisionPrompt(
        [{ name: 'run_decompose', description: 'decompose', inputSchema: { type: 'object' } }],
        [{ role: 'user', content: 'start' }],
      );
      // Legacy generic-controller path still works: the adapter's default
      // framing + tool catalog + transcript.
      expect(prompt).toContain('You are a workflow controller using external tools.');
      expect(prompt).toContain('Available tools:');
      expect(prompt).toContain('run_decompose');
    });

    it('system messages appear exactly once even when there are multiple', () => {
      const prompt = buildDecisionPrompt(
        [{ name: 'x', description: 'x', inputSchema: { type: 'object' } }],
        [
          { role: 'system', content: 'FIRST SYSTEM' },
          { role: 'user', content: 'hi' },
          { role: 'system', content: 'SECOND SYSTEM' },
        ],
      );
      expect(prompt).toContain('FIRST SYSTEM');
      expect(prompt).toContain('SECOND SYSTEM');
      // System messages must not also surface in the transcript section.
      const transcriptIdx = prompt.indexOf('Conversation transcript:');
      expect(transcriptIdx).toBeGreaterThan(-1);
      expect(prompt.slice(transcriptIdx)).not.toContain('FIRST SYSTEM');
      expect(prompt.slice(transcriptIdx)).not.toContain('SECOND SYSTEM');
    });

    it('clarifies envelope-finish vs tool-finish to prevent captain confusion', () => {
      // The logged failure had the captain emit envelope-finish after a
      // failed dispatch, silently exiting the session-loop with no final
      // report. The protocol section now spells out the distinction.
      const prompt = buildDecisionPrompt(
        [{ name: 'mcp__crew__finish', description: 'end workflow', inputSchema: { type: 'object' } }],
        [{ role: 'system', content: 'captain context' }],
      );
      expect(prompt).toMatch(/Envelope `finish` ends the current adapter invocation but does NOT end the captain workflow/);
    });
  });
});
