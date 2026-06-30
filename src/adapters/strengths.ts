import type { AgentStrength } from './types.js';

export interface CuratedStrength {
  readonly tag: AgentStrength;
  readonly description: string;
}

export const CURATED_STRENGTHS: readonly CuratedStrength[] = [
  {
    tag: 'deep-reasoning',
    description: 'Hardest multi-step problems; careful judgment',
  },
  {
    tag: 'code-review',
    description: 'Finding bugs / risks; critical review',
  },
  {
    tag: 'refactoring',
    description: 'Large or careful structural change',
  },
  {
    tag: 'technical-writing',
    description: 'Docs, specs, prose',
  },
  {
    tag: 'fast-iteration',
    description: 'Quick, low-latency turnaround',
  },
  {
    tag: 'autonomous-loops',
    description: 'Long unattended agentic runs',
  },
  {
    tag: 'bulk-implementation',
    description: 'Churning through mechanical / repetitive change',
  },
  {
    tag: 'long-context',
    description: 'Very large inputs; many files at once',
  },
  {
    tag: 'codebase-triage',
    description: 'Orienting in big / unfamiliar codebases',
  },
  {
    tag: 'multimodal',
    description: 'Image / screenshot / diagram input',
  },
] as const;

export const CURATED_STRENGTH_TAGS: readonly AgentStrength[] =
  CURATED_STRENGTHS.map((strength) => strength.tag);

export const BUILTIN_AGENT_ROUTING = {
  'claude-code': {
    strengths: [
      'deep-reasoning',
      'code-review',
      'refactoring',
      'technical-writing',
    ],
    useWhen:
      'Prefer when correctness and judgment matter most — reviews, careful refactors, specs, and writing. The most rigorous, not the fastest.',
  },
  codex: {
    strengths: [
      'fast-iteration',
      'autonomous-loops',
      'bulk-implementation',
    ],
    useWhen:
      'Prefer for well-scoped implementation and long unattended loops — fast at churning through mechanical changes.',
  },
  'gemini-cli': {
    strengths: [
      'long-context',
      'codebase-triage',
      'multimodal',
    ],
    useWhen:
      'Prefer for orienting in large or unfamiliar codebases and tasks with screenshots or diagrams — the largest context window.',
  },
  agy: {
    strengths: [
      'bulk-implementation',
      'fast-iteration',
      'long-context',
    ],
    useWhen:
      'A Gemini/Antigravity model for WRITE-MODE implementation in an isolated worktree — large context, fast. NOT a reviewer: agy cannot run read-only, so never use it for review or triage (route those to codex or claude).',
  },
} as const satisfies Record<string, {
  readonly strengths: readonly AgentStrength[];
  readonly useWhen: string;
}>;
