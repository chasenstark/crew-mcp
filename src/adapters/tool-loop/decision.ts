import { z } from 'zod';

export const ToolLoopDecisionSchema = z.object({
  type: z.enum(['tool_call', 'finish', 'fail']),
  reasoning: z.string().optional(),
  tool: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  output: z.string().optional(),
  error: z.string().optional(),
});

export type ToolLoopDecision = z.infer<typeof ToolLoopDecisionSchema>;
