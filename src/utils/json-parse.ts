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

  const parseFromDelimiters = (
    startChar: '{' | '[',
    endChar: '}' | ']',
  ): unknown | undefined => {
    const first = trimmed.indexOf(startChar);
    if (first === -1) return undefined;
    for (let end = trimmed.lastIndexOf(endChar); end >= first; end = trimmed.lastIndexOf(endChar, end - 1)) {
      try {
        return JSON.parse(trimmed.slice(first, end + 1));
      } catch {
        // continue
      }
    }
    return undefined;
  };

  // If both array and object delimiters exist, prefer whichever appears first
  // in the text to avoid returning an object nested inside a top-level array.
  const firstBrace = trimmed.indexOf('{');
  const firstBracket = trimmed.indexOf('[');
  const tryArrayFirst = firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace);

  const primary = tryArrayFirst
    ? parseFromDelimiters('[', ']')
    : parseFromDelimiters('{', '}');
  if (primary !== undefined) {
    return primary;
  }

  const secondary = tryArrayFirst
    ? parseFromDelimiters('{', '}')
    : parseFromDelimiters('[', ']');
  if (secondary !== undefined) {
    return secondary;
  }

  throw new Error(`Could not extract JSON from text: ${trimmed.slice(0, 200)}...`);
}
