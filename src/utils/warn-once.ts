const warned = new Set<string>();

export function warnOnce(key: string, warn: () => void): void {
  if (warned.has(key)) return;
  warned.add(key);
  warn();
}
