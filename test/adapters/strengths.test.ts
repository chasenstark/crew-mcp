import { describe, expect, it } from 'vitest';

import {
  BUILTIN_AGENT_ROUTING,
  CURATED_STRENGTHS,
  CURATED_STRENGTH_TAGS,
} from '../../src/adapters/strengths.js';

describe('curated strengths', () => {
  it('exports the curated tag vocabulary as the single picker source', () => {
    expect(CURATED_STRENGTHS).toHaveLength(10);
    expect(CURATED_STRENGTH_TAGS).toEqual(CURATED_STRENGTHS.map((entry) => entry.tag));
    expect(new Set(CURATED_STRENGTH_TAGS).size).toBe(CURATED_STRENGTH_TAGS.length);
    expect(CURATED_STRENGTHS).toEqual([
      { tag: 'deep-reasoning', description: 'Hardest multi-step problems; careful judgment' },
      { tag: 'code-review', description: 'Finding bugs / risks; critical review' },
      { tag: 'refactoring', description: 'Large or careful structural change' },
      { tag: 'technical-writing', description: 'Docs, specs, prose' },
      { tag: 'fast-iteration', description: 'Quick, low-latency turnaround' },
      { tag: 'autonomous-loops', description: 'Long unattended agentic runs' },
      {
        tag: 'bulk-implementation',
        description: 'Churning through mechanical / repetitive change',
      },
      { tag: 'long-context', description: 'Very large inputs; many files at once' },
      { tag: 'codebase-triage', description: 'Orienting in big / unfamiliar codebases' },
      { tag: 'multimodal', description: 'Image / screenshot / diagram input' },
    ]);
  });

  it('maps built-in adapter strengths to curated tags and declares useWhen prose', () => {
    for (const routing of Object.values(BUILTIN_AGENT_ROUTING)) {
      expect(routing.useWhen.trim().length).toBeGreaterThan(20);
      expect(routing.strengths.every((tag) => CURATED_STRENGTH_TAGS.includes(tag))).toBe(true);
    }
    expect(BUILTIN_AGENT_ROUTING).toEqual({
      'claude-code': {
        strengths: ['deep-reasoning', 'code-review', 'refactoring', 'technical-writing'],
        useWhen:
          'Prefer when correctness and judgment matter most — reviews, careful refactors, specs, and writing. The most rigorous, not the fastest.',
      },
      codex: {
        strengths: ['fast-iteration', 'autonomous-loops', 'bulk-implementation'],
        useWhen:
          'Prefer for well-scoped implementation and long unattended loops — fast at churning through mechanical changes.',
      },
      'gemini-cli': {
        strengths: ['long-context', 'codebase-triage', 'multimodal'],
        useWhen:
          'Prefer for orienting in large or unfamiliar codebases and tasks with screenshots or diagrams — the largest context window.',
      },
    });
  });
});
