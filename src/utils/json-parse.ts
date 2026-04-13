/**
 * Extract JSON from messy LLM output that may include markdown fences,
 * extra explanatory text, or other formatting.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  // Try direct parse
  try {
    return JSON.parse(trimmed);
  } catch {
    /* continue */
  }

  // Try markdown code fence
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      /* continue */
    }
  }

  // Try finding a JSON object — try from first { to each } from right to left
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace !== -1) {
    for (let end = trimmed.lastIndexOf('}'); end >= firstBrace; end = trimmed.lastIndexOf('}', end - 1)) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, end + 1));
      } catch { /* continue */ }
    }
  }

  // Try finding a JSON array — try from first [ to each ] from right to left
  const firstBracket = trimmed.indexOf('[');
  if (firstBracket !== -1) {
    for (let end = trimmed.lastIndexOf(']'); end >= firstBracket; end = trimmed.lastIndexOf(']', end - 1)) {
      try {
        return JSON.parse(trimmed.slice(firstBracket, end + 1));
      } catch { /* continue */ }
    }
  }

  throw new Error(`Could not extract JSON from text: ${trimmed.slice(0, 200)}...`);
}
