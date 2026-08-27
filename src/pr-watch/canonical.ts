import { createHash } from 'node:crypto';

/**
 * Canonical JSON used for durable PR-watch identities and digest chains.
 * Objects are key-sorted recursively; arrays retain their semantic order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortCanonical(entry));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortCanonical(record[key])]),
    );
  }
  return value;
}
