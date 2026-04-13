import type { PassSummary } from './types.js';

export function buildTieredContext(summaries: PassSummary[]): string {
  if (summaries.length === 0) return 'No previous passes.';
  const parts: string[] = [];
  for (let i = 0; i < summaries.length; i++) {
    const summary = summaries[i];
    const isOldest = i < summaries.length - 2;
    if (isOldest) {
      const abbreviated = summary.summary.length > 150
        ? summary.summary.slice(0, 150) + '...'
        : summary.summary;
      parts.push(`Pass ${summary.passNumber}: ${abbreviated}`);
    } else {
      parts.push(`Pass ${summary.passNumber}: ${summary.summary}`);
      if (summary.unresolvedIssues.length > 0) {
        parts.push(`  Unresolved: ${summary.unresolvedIssues.join('; ')}`);
      }
    }
  }
  return parts.join('\n');
}
