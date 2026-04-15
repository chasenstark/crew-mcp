export function toAliasToken(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const wrapped = /^\$\{([A-Za-z][A-Za-z0-9_]*)\}$/.exec(trimmed);
  if (wrapped) return wrapped[1].toUpperCase();

  if (/^[A-Z][A-Z0-9_]*$/.test(trimmed)) return trimmed.toUpperCase();
  return null;
}
