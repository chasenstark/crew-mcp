/**
 * Drop low-signal adapter event lines from the terminal `events_tail`
 * payload returned by `get_run_status`. Only acts on patterns we've
 * verified are pure receipts — lines that announce "started X" or
 * "completed X with exit 0" without carrying any synthesis content.
 *
 * Currently codex-only because each adapter shapes its stream
 * differently:
 *   - Codex streams a structured event protocol via `[codex] command:`,
 *     `[codex] event:`, `[codex] message:`, `[codex] turn:` lines.
 *     Sampling real runs found ~88% of lines were start/exit-0
 *     receipts; the captain reads those and learns nothing.
 *   - Claude-code, Gemini, OpenAI-compatible, and Generic adapters
 *     pipe raw model output text through `onOutput` (see e.g.
 *     `src/adapters/claude-code.ts:498`). Their tails are already
 *     signal-dense; no patterns to filter.
 *
 * Non-zero exits are intentionally kept — `(exit 1)`, `(exit 137)`
 * etc. signal a problem the captain should see (a stuck loop, a
 * killed process). Only `(exit 0)` is dropped because it's the
 * "everything went fine, no content to report" case.
 *
 * The full `events.log` on disk is unchanged — `events_log_path` is
 * surfaced on the dispatch envelope for users who want raw chronology
 * via `tail -F`.
 *
 * Adding rules: if a future adapter starts emitting receipts, append
 * a `{ pattern, reason }` entry to `NOISE_PATTERNS`. Keep `reason`
 * specific so the next reader can tell whether the rule still fits.
 */

export interface NoiseRule {
  readonly pattern: RegExp;
  readonly reason: string;
}

export const NOISE_PATTERNS: readonly NoiseRule[] = [
  {
    pattern: /^\[codex\] command: started /,
    reason: 'codex receipt: command-started, no content',
  },
  {
    pattern: /^\[codex\] command: .* \(exit 0\)$/,
    reason: 'codex receipt: command-completed cleanly, no content',
  },
  {
    pattern: /^\[codex\] event: item\.(started|completed)\//,
    reason: 'codex receipt: web_search/etc. status, no content',
  },
];

/**
 * Filter out lines matching any rule in `NOISE_PATTERNS`. Order is
 * preserved; non-matching lines pass through unchanged. Pure function;
 * does not modify the input array.
 */
export function filterEventsTailNoise(lines: readonly string[]): string[] {
  return lines.filter((line) => !NOISE_PATTERNS.some((rule) => rule.pattern.test(line)));
}
