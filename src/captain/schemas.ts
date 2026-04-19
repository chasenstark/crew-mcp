import { z } from 'zod';

// Step 1: DECOMPOSE
// M3-6: `role` is now `z.string()` — the hard enum
// (implement|review|test|refactor|document|analyze) was tied to the 11-verb
// controller's capability gate (dropped in M3-2). Free-form strings let
// users decompose with domain-appropriate roles (e.g., "devops", "security").
export const DecomposeOutputSchema = z.object({
  reasoning: z.string().describe('Brief explanation of how the request was broken down (2-3 sentences)'),
  tasks: z.array(z.object({
    id: z.string().describe("Short identifier, e.g. 'task-1'"),
    description: z.string().describe('What this task accomplishes'),
    agent: z.string().describe('Which agent should handle this'),
    role: z.string().describe('The semantic role the task plays (e.g. implement, review, devops)'),
    dependencies: z.array(z.string()).describe('IDs of tasks that must complete first'),
    scope: z.object({
      files: z.array(z.string()).optional().describe('Specific files/directories involved'),
      description: z.string().describe('What area of the codebase this touches'),
    }),
    estimatedComplexity: z.enum(['low', 'medium', 'high']),
  })),
  suggestedOrder: z.array(z.string()).describe('Task IDs in recommended execution order'),
});

// Step 2: INGEST
// (decompose, ingest, summarize are the three step schemas that survive
// post-M4-6. Dispatch + judge were retired when the captain moved to inline
// reasoning via run_agent + finish.)
export const IngestOutputSchema = z.object({
  status: z.enum(['success', 'partial', 'failure']),
  summary: z.string().describe('2-3 sentence summary of what the agent did'),
  filesModified: z.array(z.object({
    path: z.string(),
    action: z.enum(['created', 'modified', 'deleted']),
  })),
  decisions: z.array(z.string()).describe('Key technical decisions the agent made'),
  concerns: z.array(z.object({
    severity: z.enum(['info', 'warning', 'error']),
    description: z.string(),
  })).describe('Issues or concerns found in the output'),
  needsHumanAttention: z.boolean(),
  humanAttentionReason: z.string().optional(),
  reviewFindings: z.array(z.object({
    severity: z.enum(['critical', 'major', 'minor', 'suggestion']),
    description: z.string(),
    file: z.string().optional(),
    actionable: z.boolean(),
  })).optional().describe('For review tasks: specific findings'),
});

// Step 3: SUMMARIZE
export const SummarizeOutputSchema = z.object({
  passNumber: z.number(),
  summary: z.string().describe('3-8 sentence summary of what happened'),
  unresolvedIssues: z.array(z.string()).describe('Issues still needing attention'),
  contextForNextPass: z.string().describe('Specific context the next agent needs'),
  filesInScope: z.array(z.string()).describe('Files that were touched'),
});

