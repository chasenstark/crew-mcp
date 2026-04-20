import { z } from 'zod';

// The `input` field carries the tool-call's arguments — freeform by design,
// since every registered tool has its own input shape validated downstream
// by the tool's own zod schema.
//
// Why `z.string()` instead of a freeform-object shape: OpenAI's
// structured-output `response_format` (used by codex's `--output-schema`
// path) enforces a strict JSON Schema subset where EVERY schema node must
// have a concrete `type` key. A freeform object maps to
// `{type: 'object', additionalProperties: {}}` — the empty
// `additionalProperties: {}` is rejected by OpenAI because the subschema
// doesn't have a `type`. Earlier iterations that tried
// `z.record(z.string(), z.unknown())` hit an analogous rejection on
// `propertyNames`. The only portable answer for structured output is to
// encode the input as a JSON string, so the schema node is `{type: 'string'}`
// (always accepted), and parse it on the consuming side via `parseToolInput`.
//
// Callers in the envelope-parsing path (claude-code.ts, gemini-cli.ts, the
// generic controller) prompted the captain to emit `input: {...}` as an
// inline object. That prompt has been updated to emit
// `input: "{\"x\":1}"` — a stringified JSON literal — so both paths
// (envelope-parse AND schema-enforced) see consistent inputs.
export const ToolLoopDecisionSchema = z.object({
  type: z.enum(['tool_call', 'finish', 'fail']),
  reasoning: z.string().optional(),
  tool: z.string().optional(),
  input: z.string().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
});

export type ToolLoopDecision = z.infer<typeof ToolLoopDecisionSchema>;

/**
 * Parse the `input` field from a ToolLoopDecision into a tool-input
 * object. The LLM emits it as a stringified JSON literal (schema
 * constraint — see the comment above). Returns an empty object for
 * undefined input and for malformed/non-object JSON so downstream tool
 * dispatch receives a consistent `Record<string, unknown>` shape.
 *
 * Malformed input is silently coerced to `{}` rather than throwing: the
 * LLM occasionally emits `""` or `"null"` for no-argument tools, and the
 * tool handler's own zod schema is the authoritative validator. Surface
 * the "no input" case uniformly rather than routing it as an error.
 */
export function parseToolInput(input: string | undefined): Record<string, unknown> {
  if (!input) return {};
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to {}.
  }
  return {};
}
