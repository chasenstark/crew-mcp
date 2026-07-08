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

  const parseBalancedFromDelimiter = (startChar: '{' | '['): unknown | undefined => {
    const first = trimmed.indexOf(startChar);
    if (first === -1) return undefined;

    const stack: Array<'{' | '['> = [];
    let inString = false;
    let escaped = false;

    for (let i = first; i < trimmed.length; i += 1) {
      const char = trimmed[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{' || char === '[') {
        stack.push(char);
        continue;
      }
      if (char !== '}' && char !== ']') continue;

      const open = stack.at(-1);
      if ((char === '}' && open !== '{') || (char === ']' && open !== '[')) {
        return undefined;
      }
      stack.pop();
      if (stack.length === 0) {
        try {
          return JSON.parse(trimmed.slice(first, i + 1));
        } catch {
          return undefined;
        }
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
    ? parseBalancedFromDelimiter('[')
    : parseBalancedFromDelimiter('{');
  if (primary !== undefined) {
    return primary;
  }

  const secondary = tryArrayFirst
    ? parseBalancedFromDelimiter('{')
    : parseBalancedFromDelimiter('[');
  if (secondary !== undefined) {
    return secondary;
  }

  throw new Error(`Could not extract JSON from text: ${trimmed.slice(0, 200)}...`);
}
