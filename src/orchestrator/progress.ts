/**
 * Shape of a per-call progress notifier. `send(message)` increments
 * an internal monotonic counter and fires `notifications/progress`.
 * Returns void; failures are swallowed by the notifier implementation
 * so a transport hiccup can't fail dispatch.
 */
export interface ProgressNotifier {
  send(message: string): void;
}

/**
 * Maximum per-line length sent in a `notifications/progress` message.
 * Picked so a chunk fits comfortably in Claude Code's inline progress
 * area (~one terminal line at default width) without truncating
 * anything that's actually load-bearing in adapter output. Bigger
 * payloads get truncated with an ellipsis suffix. The same bounded,
 * prefixed lines are written to `events.log`, keeping `events_tail`
 * and inline progress consistent.
 */
const PROGRESS_LINE_MAX_LEN = 240;

/**
 * Format an adapter `onOutput` chunk into one or more progress
 * notification messages. Splits on newlines (multi-line chunks
 * become multiple notifications), drops empty lines, trims trailing
 * whitespace, truncates over-long lines, and prefixes each line
 * with `[<agentName>] ` so the host inline display labels who's
 * speaking.
 */
export function formatProgressLines(agentName: string, chunk: string): string[] {
  const out: string[] = [];
  for (const raw of chunk.split(/\r\n|\r|\n/)) {
    const trimmed = raw.replace(/\s+$/, '');
    if (trimmed.length === 0) continue;
    const prefix = `[${agentName}] `;
    if (prefix.length >= PROGRESS_LINE_MAX_LEN) {
      out.push(takeCodePointBudget(prefix, PROGRESS_LINE_MAX_LEN));
      continue;
    }
    const bodyBudget = PROGRESS_LINE_MAX_LEN - prefix.length;
    const unprefixed = trimmed.startsWith(prefix)
      ? trimmed.slice(prefix.length)
      : trimmed;
    const body =
      unprefixed.length > bodyBudget
        ? `${takeCodePointBudget(unprefixed, bodyBudget - 1)}…`
        : unprefixed;
    out.push(`${prefix}${body}`);
  }
  return out;
}

function takeCodePointBudget(value: string, maxCodeUnits: number): string {
  if (maxCodeUnits <= 0) return '';
  let used = 0;
  let out = '';
  for (const codePoint of value) {
    const next = used + codePoint.length;
    if (next > maxCodeUnits) break;
    out += codePoint;
    used = next;
  }
  return out;
}
