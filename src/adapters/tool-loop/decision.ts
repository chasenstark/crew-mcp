import { z } from 'zod';

// The `input` field carries the tool-call's arguments — freeform by design,
// since every registered tool has its own input shape validated downstream
// by the tool's own zod schema.
//
// Why every field is `z.string().nullable()` (no `.optional()`): OpenAI's
// structured-output `response_format` (used by codex's `--output-schema`
// path) enforces a strict JSON Schema subset with THREE cumulative
// requirements we've hit one-at-a-time over this milestone:
//   1. No `propertyNames` anywhere. (Ruled out `z.record(z.string(), ...)`.)
//   2. Every schema node must have a concrete `type`. (Ruled out any
//      freeform-object shape — `additionalProperties: {}` has no `type`.)
//   3. `required` MUST list every property in `properties`, and
//      `additionalProperties` MUST be `false`. (Ruled out `.optional()`.)
// `z.string().nullable()` generates
// `{anyOf: [{type: 'string'}, {type: 'null'}]}` and, crucially, zod's
// toJSONSchema adds the field to `required` automatically when it's not
// `.optional()`. That satisfies all three constraints.
//
// Captains encode absent fields as JSON `null` on the wire; consumers
// treat `null` and the never-present case uniformly via `??` coercion
// or the `parseToolInput` helper. The only field without nullable is
// `type` — it's the discriminant and must always be one of the three
// enum values.
//
// `input` is serialized as a JSON STRING (not an inline object) — see
// constraint 2 above. Consumers JSON.parse it via `parseToolInput` on
// the way back in. The envelope-path captains (claude-code, gemini,
// generic controller) see the same schema via `buildDecisionPrompt`,
// so envelope-parse + schema-enforced paths agree on the wire format.
// Keys the schema requires to be present (per OpenAI strict mode). The
// preprocess below fills any missing key with `null` before validation, so
// envelope-path captains that omit nullable fields still parse cleanly
// while the generated JSON schema sent to OpenAI lists all of these in
// `required`.
const TOOL_LOOP_DECISION_KEYS = [
  'type',
  'reasoning',
  'tool',
  'input',
  'output',
  'error',
] as const;

const rawToolLoopDecisionSchema = z.object({
  type: z.enum(['tool_call', 'finish', 'fail']),
  reasoning: z.string().nullable(),
  tool: z.string().nullable(),
  input: z.string().nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
});

export const ToolLoopDecisionSchema = z.preprocess(
  (raw) => {
    // Fill missing keys with null so envelope-path captains (and old test
    // fixtures written before we made every field required) can still
    // emit just the keys they care about. When a captain responds with
    // `{"type":"finish","output":"ok"}`, we inject `reasoning:null`,
    // `tool:null`, `input:null`, `error:null` before validating.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const filled: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    for (const key of TOOL_LOOP_DECISION_KEYS) {
      if (!(key in filled)) filled[key] = null;
    }
    return filled;
  },
  rawToolLoopDecisionSchema,
);

export type ToolLoopDecision = z.infer<typeof ToolLoopDecisionSchema>;

/**
 * Parse the `input` field from a ToolLoopDecision into a tool-input
 * object. The LLM emits it as a stringified JSON literal (schema
 * constraint — see the comment above). Returns an empty object for
 * null/undefined input and for malformed/non-object JSON so downstream
 * tool dispatch receives a consistent `Record<string, unknown>` shape.
 *
 * Malformed input is silently coerced to `{}` rather than throwing: the
 * LLM occasionally emits `""` or `"null"` for no-argument tools, and the
 * tool handler's own zod schema is the authoritative validator. Surface
 * the "no input" case uniformly rather than routing it as an error.
 */
export function parseToolInput(input: string | null | undefined): Record<string, unknown> {
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
