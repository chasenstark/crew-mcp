/**
 * The exact model LABELS the Antigravity CLI (`agy`) accepts, from `agy
 * models`. agy keys models by human label, not id. Kept in a standalone,
 * dependency-free module so BOTH the lazy registry metadata (registry.ts) and
 * the loaded AgyAdapter (agy.ts) can share ONE source of truth for
 * `recognizesModel` without the registry eagerly importing the adapter's heavy
 * deps (execa, health-check cache). Duplicating the list would risk the lazy
 * proxy and the loaded instance disagreeing on which labels are recognized.
 */
export const AGY_MODEL_LABELS = [
  'Gemini 3.1 Pro (High)',
  'Gemini 3.1 Pro (Low)',
  'Gemini 3.5 Flash (Low)',
  'Gemini 3.5 Flash (Medium)',
  'Gemini 3.5 Flash (High)',
  'Claude Sonnet 4.6 (Thinking)',
  'Claude Opus 4.6 (Thinking)',
  'GPT-OSS 120B (Medium)',
] as const;

export const AGY_MODEL_LABEL_SET: ReadonlySet<string> = new Set(AGY_MODEL_LABELS);
