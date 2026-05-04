/**
 * Auto-gitignore guard for the host repo's `.crew/` scratch.
 *
 * `crew serve` writes per-run state, event logs, and worktree
 * directories under `<host-repo>/.crew/runs/`. Without an entry in
 * the host's `.gitignore`, every dispatch leaves untracked clutter
 * that pollutes `git status` and risks a `git add .` accidentally
 * staging crew's internals (or, worse, the worktree subdirectories
 * which git treats as embedded repos and tries to add as submodule
 * pointers).
 *
 * This module ensures `.crew/` is in the host's `.gitignore` once,
 * idempotently, the first time a `WorktreeManager` is constructed
 * against that repo. Existing `.gitignore` content is preserved
 * verbatim; we only append.
 *
 * Surfaced by the v0.2 smoke (Finding 7 in
 * `docs/status/v0.2-smoke-2026-05-04.md`).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { logger } from '../utils/logger.js';

/** What we append when a `.crew/`-covering rule is missing. */
const APPENDED_BLOCK = [
  '',
  '# crew-mcp scratch (run state, event logs, worktree dirs)',
  '.crew/',
  '',
].join('\n');

export interface EnsureCrewIgnoredResult {
  /** Whether `.gitignore` was modified during this call. */
  readonly added: boolean;
  /** Absolute path to the `.gitignore` we examined / wrote. */
  readonly gitignorePath: string;
}

/**
 * Ensure the host repo's `.gitignore` covers `.crew/`. Idempotent;
 * on a `.gitignore` that already covers `.crew/` (exactly, or via a
 * broader rule like `.crew/runs/`), this is a no-op.
 *
 * Throws are caught and warn-logged: a failure here must NEVER
 * crash `crew serve` startup. The user's repo is the source of
 * truth; if we can't write `.gitignore` (read-only filesystem,
 * permission denied, weird mount), we let the user discover the
 * pollution and add the rule themselves.
 */
export function ensureCrewIgnored(repoRoot: string): EnsureCrewIgnoredResult {
  const gitignorePath = join(repoRoot, '.gitignore');
  try {
    const exists = existsSync(gitignorePath);
    const existing = exists ? readFileSync(gitignorePath, 'utf-8') : '';

    if (alreadyCoversCrew(existing)) {
      return { added: false, gitignorePath };
    }

    // Preserve a trailing newline if the file had one; otherwise add
    // the separating newlines via APPENDED_BLOCK's leading newline.
    const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    const next = existing + sep + APPENDED_BLOCK;
    writeFileSync(gitignorePath, next, 'utf-8');
    logger.info(
      `crew: added .crew/ to ${exists ? '' : 'newly created '}${gitignorePath}`,
    );
    return { added: true, gitignorePath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `crew: could not update ${gitignorePath} (${message}). Add ".crew/" to your .gitignore manually to keep the repo clean.`,
    );
    return { added: false, gitignorePath };
  }
}

/**
 * Heuristic: does the gitignore content already cover `.crew/`?
 *
 * Looks for any non-comment, non-empty, non-negated line whose
 * pattern matches `.crew` itself or anything under it. Recognized
 * forms: `.crew`, `.crew/`, `/.crew`, `/.crew/`, `.crew/anything`.
 *
 * Misses (intentionally): obscure double-star or character-class
 * patterns. If a user has those, an extra `.crew/` line is
 * harmless (gitignore tolerates duplicates).
 */
export function alreadyCoversCrew(gitignoreContent: string): boolean {
  for (const raw of gitignoreContent.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('!')) continue; // negation — not a covering rule

    // Strip leading slash (which means "anchored at repo root" — same
    // as no leading slash for our purposes).
    const pattern = trimmed.replace(/^\//, '');

    if (pattern === '.crew' || pattern === '.crew/') return true;
    if (pattern.startsWith('.crew/')) return true; // covers `.crew/runs/` etc.
  }
  return false;
}
