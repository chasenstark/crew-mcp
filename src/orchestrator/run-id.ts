/**
 * Human-readable run IDs.
 *
 * A run ID is the single token that names a run on every surface: the
 * `crew-wait <run_id>` watcher command the captain spawns in the
 * background, the `.crew/runs/<run_id>/` state directory, the worktree
 * token, `list_runs` rows, GC output, and terminal notifications.
 * Historically it was a bare `randomUUID()`, which made those surfaces —
 * especially the background watcher shell command — opaque: you could not
 * tell which agent or task a `crew-wait 5bd9cc71-...` invocation belonged
 * to. We now mint `<agent>-<task-slug>-<shorthex>` so the name describes
 * itself wherever it appears.
 *
 * Critical invariant: the ID must be stable under
 * `WorktreeManager.toRunToken` (lowercase, only `[a-z0-9._-]`, no
 * leading/trailing dash) AND unchanged by `encodeURIComponent`. The
 * worktree allocator derives the run directory via `toRunToken(runId)`
 * while `RunStateStore` joins the raw `runId`; the two only land in the
 * same `.crew/runs/<id>/` directory when `toRunToken(id) === id`. Every
 * value produced here satisfies that — see `run-id.test.ts`, which proves
 * the round-trip rather than trusting this comment.
 */

import { randomUUID } from 'node:crypto';

/**
 * Common filler words stripped from the head of a task slug so the slug
 * leads with the meaningful verb/noun ("refactor-auth" rather than
 * "can-you-refactor"). Intentionally small: over-stripping risks emptying
 * short prompts, and `makeRunId` falls back to the unfiltered words when
 * filtering removes everything.
 */
const SLUG_STOPWORDS = new Set([
  'a', 'an', 'and', 'can', 'could', 'for', 'i', 'in', 'is', 'it', 'of',
  'on', 'please', 'that', 'the', 'this', 'to', 'we', 'with', 'you',
]);

const DEFAULT_MAX_WORDS = 3;
const DEFAULT_MAX_LEN = 20;
const RUN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/**
 * True when `runId` is a single safe run-directory path segment.
 *
 * Accepted shape: non-empty lowercase ASCII, starts and ends with
 * `[a-z0-9]`, middle characters may be `[a-z0-9._-]`, and `..` is
 * forbidden. This preserves the `toRunToken(runId) === runId` invariant
 * while rejecting path traversal, absolute paths, separators, NUL, and
 * hidden-dot segments before any filesystem join.
 */
export function isValidRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId) && !runId.includes('..');
}

/**
 * Turn arbitrary text into a `toRunToken`-stable slug fragment: lowercase,
 * `[a-z0-9]` words joined by single dashes, stopword-trimmed, capped at
 * `maxWords` words and `maxLen` characters with no trailing dash. Returns
 * `''` when the text carries no usable alphanumerics (callers decide the
 * fallback).
 */
export function slugifyRunIdPart(
  text: string,
  { maxWords = DEFAULT_MAX_WORDS, maxLen = DEFAULT_MAX_LEN }: { maxWords?: number; maxLen?: number } = {},
): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '';

  const meaningful = words.filter((w) => !SLUG_STOPWORDS.has(w));
  const picked = (meaningful.length > 0 ? meaningful : words).slice(0, maxWords);

  let slug = picked.join('-');
  if (slug.length > maxLen) {
    slug = slug.slice(0, maxLen).replace(/-+$/, '');
  }
  return slug;
}

/**
 * Mint a self-describing run ID of the form `<agent>-<task-slug>-<shorthex>`,
 * e.g. `codex-refactor-auth-5bd9cc71`. The `<shorthex>` is the first group
 * of a fresh UUID (32 bits), which keeps IDs unique even when the agent and
 * task slug collide. Empty fragments are dropped, so a blank/garbage prompt
 * still yields a valid `<agent>-<shorthex>` ID.
 */
export function makeRunId(agentId: string, prompt: string): string {
  const agentSlug = slugifyRunIdPart(agentId, { maxWords: 4, maxLen: 24 }) || 'agent';
  const taskSlug = slugifyRunIdPart(prompt);
  const shortHex = randomUUID().split('-')[0];
  return [agentSlug, taskSlug, shortHex].filter(Boolean).join('-');
}
