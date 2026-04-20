import { z } from 'zod';

// The `input` field carries the tool-call's arguments — freeform by design,
// since every registered tool has its own input shape validated downstream
// by the tool's own zod schema. Using `z.record(z.string(), z.unknown())`
// here was the previous idiom, but it emits `propertyNames: {type: 'string'}`
// in the generated JSON Schema, which OpenAI's structured-output
// `response_format` rejects with:
//   "In context=('properties', 'input'), 'propertyNames' is not permitted."
// We use `z.looseObject({})` instead — it generates
// `{type: 'object', additionalProperties: true}` (no propertyNames) and
// still types as a plain object at compile time. Runtime coercion in
// consumers (`parsedDecision.input ?? {}`) handles the null/undefined case.
export const ToolLoopDecisionSchema = z.object({
  type: z.enum(['tool_call', 'finish', 'fail']),
  reasoning: z.string().optional(),
  tool: z.string().optional(),
  input: z.looseObject({}).optional(),
  output: z.string().optional(),
  error: z.string().optional(),
});

export type ToolLoopDecision = z.infer<typeof ToolLoopDecisionSchema>;
