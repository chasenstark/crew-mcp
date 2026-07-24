import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { atomicWrite } from '../utils/atomic-write.js';
import { logger as defaultLogger } from '../utils/logger.js';
import { PROJECT_MANIFEST_RELATIVE_PATH } from './project-install-manifest.js';

const execFileAsync = promisify(execFile);

/**
 * Repo-relative path of the project-scope install manifest. The project
 * install writes this file expecting teammates to commit it, but consumer
 * repos routinely `.gitignore` the whole `.crew/` runtime-state tree — which
 * silently makes the manifest un-committable. This module keeps that one
 * file re-included without un-ignoring the rest of `.crew/`. Aliases the
 * canonical constant so there is a single source of truth.
 */
export const PROJECT_MANIFEST_GITIGNORE_PATH = PROJECT_MANIFEST_RELATIVE_PATH;

/** A representative `.crew` runtime-state path. Used to detect (and refuse) a
 *  block choice that would regress the ignoring of `.crew/` runtime state. */
const RUNTIME_STATE_PROBE = '.crew/runs';

// Root-anchored (leading `/`) rules so they only touch the repo-root `.crew`;
// nested `.crew/` dirs (e.g. `packages/app/.crew/`) keep their consumer status.
const DIR_REINCLUDE = '!/.crew/';
const DIR_CONTENTS = '/.crew/*';
const MANIFEST_NEGATION = `!/${PROJECT_MANIFEST_GITIGNORE_PATH}`;
const ESCAPE_BLOCK_COMMENT =
  '# crew-mcp: keep the project install manifest committable (the rest of .crew/ stays ignored)';

/**
 * Two block shapes, tried least-invasive first:
 *  - MINIMAL just re-includes the manifest. Correct (and preferred) whenever
 *    git already descends into `.crew` — it leaves any consumer `.crew/`
 *    exceptions (e.g. `!/.crew/workflow.yaml`) intact.
 *  - FULL re-includes the `.crew` dir, re-excludes its contents, then
 *    re-includes the manifest. Needed when the `.crew` dir itself is excluded
 *    (a blanket `.crew/`, `*`, info/exclude, global excludesFile) so git won't
 *    descend, or when MINIMAL would drop pre-existing runtime-state ignoring.
 */
const MINIMAL_BLOCK_RULES: readonly string[] = [MANIFEST_NEGATION];
const FULL_BLOCK_RULES: readonly string[] = [DIR_REINCLUDE, DIR_CONTENTS, MANIFEST_NEGATION];
/** Recognised block shapes, longest first, for exact-match stripping. */
const BLOCK_SHAPES: readonly (readonly string[])[] = [FULL_BLOCK_RULES, MINIMAL_BLOCK_RULES];

export interface GitignoreUpdate {
  readonly next: string;
  readonly changed: boolean;
}

/**
 * Strip a crew-owned block: our exact comment sentinel immediately followed by
 * one of the exact block shapes (`[...FULL]` or `[...MINIMAL]`), plus a single
 * blank line we inserted before it. Only a *complete, uninterrupted* block is
 * removed — a consumer line inserted into the middle of a block leaves it
 * unmatched and fully intact, and a standalone consumer line that merely looks
 * like an owned rule is never touched.
 */
function stripCrewBlock(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === ESCAPE_BLOCK_COMMENT) {
      const shape = BLOCK_SHAPES.find((rules) =>
        rules.every((rule, k) => lines[i + 1 + k]?.trim() === rule));
      if (shape) {
        if (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
        i += shape.length; // for-loop `++` then advances past the last rule line
        continue;
      }
    }
    out.push(lines[i]);
  }
  return out;
}

/**
 * Pure transform: strip any prior crew block, then append `blockRules` (with our
 * comment) at EOF so it is the last matching rule set. Consumer lines are never
 * rewritten. `changed` reports whether the content actually differs — so when
 * the requested block already sits (alone) at EOF this is a no-op. Preserves the
 * file's EOL style and trailing newline.
 */
export function computeGitignoreUpdate(
  content: string,
  blockRules: readonly string[] = FULL_BLOCK_RULES,
): GitignoreUpdate {
  const eol = /\r\n/.test(content) ? '\r\n' : '\n';
  const hadTrailingNewline = content.length === 0 || /\r?\n$/.test(content);
  const body = content.replace(/\r?\n$/, '');
  const lines = content.length === 0 ? [] : body.split(/\r?\n/);

  const out = stripCrewBlock(lines);
  if (out.length > 0 && out[out.length - 1].trim() !== '') out.push('');
  out.push(ESCAPE_BLOCK_COMMENT, ...blockRules);

  const next = out.join(eol) + (hadTrailingNewline ? eol : '');
  return { next, changed: next !== content };
}

export type EnsureManifestCommittableOutcome =
  | 'already-committable'
  | 'gitignore-updated'
  | 'manual-fix-required';

export interface EnsureManifestCommittableResult {
  readonly outcome: EnsureManifestCommittableOutcome;
  /** The gitignore source (file) still ignoring the manifest, when known. */
  readonly source?: string;
}

export interface IgnoreCheck {
  readonly ignored: boolean;
  readonly source?: string;
}

/** Probe whether a repo-relative path is git-ignored. Injectable for tests. */
export type GitignoreProbe = (relPath: string) => Promise<IgnoreCheck>;

export interface EnsureManifestCommittableDeps {
  readonly logger?: Pick<typeof defaultLogger, 'info' | 'warn'>;
  readonly probe?: GitignoreProbe;
}

async function gitCheckIgnored(repoRoot: string, relPath: string): Promise<IgnoreCheck> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['check-ignore', '-v', '--', relPath],
      { cwd: repoRoot, timeout: 5_000 },
    );
    // `-v` prints `<source>:<line>:<pattern>\t<path>` for the *deciding* rule
    // and exits 0 for BOTH ignore and negation matches — so the exit code alone
    // does not tell ignore status. A deciding pattern that starts with `!`
    // means the path is re-included (not ignored). git reports the parent-dir
    // exclusion here when a `.crew/` dir ignore wins over a would-be negation.
    const line = stdout.split(/\r?\n/).find((entry) => entry.trim().length > 0) ?? '';
    const lhs = line.split('\t')[0] ?? '';
    const match = /^(.*?):(\d+):(.*)$/.exec(lhs);
    if (!match) return { ignored: true }; // matched a rule but unparseable — treat conservatively
    if (match[3].startsWith('!')) return { ignored: false };
    return { ignored: true, source: match[1] };
  } catch (err) {
    // git check-ignore exits 1 when no rule matches (not ignored). Any other
    // failure (128 fatal, timeout, git missing) is operational — let it
    // propagate so the caller decides (never silently report a clean result or
    // escalate to a more invasive block on a transient error).
    if ((err as { code?: unknown }).code === 1) return { ignored: false };
    throw err;
  }
}

/**
 * Ensure `.crew/install.project.json` is committable in `repoRoot` by appending
 * a root-anchored escape block to the repo-root `.gitignore`. No-op (and no
 * write) when the manifest is already committable. It tries the minimal block
 * first (which preserves any consumer `.crew` exceptions) and falls back to the
 * full block, verifying each with `git check-ignore` and refusing any choice
 * that would drop pre-existing `.crew/` runtime-state ignoring — so it never
 * claims a fix it did not achieve, nor silently opens up `.crew/`. When it
 * cannot help (a symlinked `.gitignore` it declines to clobber, or an ignore in
 * a global excludesFile / deeper `.gitignore`) it reverts any write and warns
 * with the manual step. Operational `git`/IO failures roll back any write and
 * propagate. Callers must treat this as non-fatal — a gitignore hiccup should
 * never fail the install.
 */
export async function ensureProjectManifestCommittable(
  repoRoot: string,
  deps: EnsureManifestCommittableDeps = {},
): Promise<EnsureManifestCommittableResult> {
  const log = deps.logger ?? defaultLogger;
  const probe: GitignoreProbe = deps.probe ?? ((relPath) => gitCheckIgnored(repoRoot, relPath));

  const before = await probe(PROJECT_MANIFEST_GITIGNORE_PATH);
  if (!before.ignored) return { outcome: 'already-committable' };

  const gitignorePath = join(repoRoot, '.gitignore');

  // Never clobber a symlinked .gitignore: atomicWrite's rename would replace the
  // link with a regular file, silently breaking a shared-ignore arrangement.
  let linkStat: ReturnType<typeof lstatSync> | undefined;
  try {
    linkStat = lstatSync(gitignorePath);
  } catch {
    linkStat = undefined; // absent — treated as empty below
  }
  if (linkStat?.isSymbolicLink()) {
    warnStillIgnored(log, gitignorePath, before.source, 'the repo-root .gitignore is a symlink');
    return { outcome: 'manual-fix-required', source: before.source };
  }

  const fileExisted = linkStat !== undefined && existsSync(gitignorePath);
  const original = fileExisted ? readFileSync(gitignorePath, 'utf-8') : '';

  // Baseline: was crew runtime state ignored before we touched anything? We must
  // not regress that when we pick the (less invasive) minimal block.
  const runtimeIgnoredBefore = (await probe(RUNTIME_STATE_PROBE)).ignored;

  let lastWritten = original;
  try {
    // Try least-invasive block first, then the full block. Each candidate is
    // written from `original` (not the previous attempt) and verified.
    for (const rules of [MINIMAL_BLOCK_RULES, FULL_BLOCK_RULES]) {
      const { next } = computeGitignoreUpdate(original, rules);
      atomicWrite(gitignorePath, next);
      lastWritten = next;

      const manifestAfter = await probe(PROJECT_MANIFEST_GITIGNORE_PATH);
      if (manifestAfter.ignored) continue; // did not re-include the manifest
      // Refuse a block that drops runtime-state ignoring it used to have.
      if (runtimeIgnoredBefore && !(await probe(RUNTIME_STATE_PROBE)).ignored) continue;

      log.info(
        `crew install: updated ${gitignorePath} so .crew/install.project.json stays committable `
        + '(the rest of .crew/ runtime state remains ignored). Review and commit the .gitignore change.',
      );
      return { outcome: 'gitignore-updated' };
    }
  } catch (err) {
    // Operational git/IO failure mid-fix — roll back our write and propagate.
    // Never leave a half-applied block or silently escalate on a transient error.
    revertGuarded(gitignorePath, lastWritten, fileExisted, original);
    throw err;
  }

  // Neither block re-includes the manifest without regressing .crew/ — the
  // ignore lives somewhere the repo-root .gitignore cannot override. Revert our
  // write (guarded against a concurrent external edit) so no dead lines remain.
  revertGuarded(gitignorePath, lastWritten, fileExisted, original);
  let stillSource = before.source;
  try {
    stillSource = (await probe(PROJECT_MANIFEST_GITIGNORE_PATH)).source ?? before.source;
  } catch {
    // Best-effort source for the warning only.
  }
  warnStillIgnored(log, gitignorePath, stillSource);
  return { outcome: 'manual-fix-required', source: stillSource };
}

/** Restore/remove our write, but only if it is still exactly what we wrote —
 *  never clobber a concurrent external edit. Best-effort; never throws. */
function revertGuarded(
  gitignorePath: string,
  lastWritten: string,
  fileExisted: boolean,
  original: string,
): void {
  try {
    const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
    if (current !== lastWritten) return; // someone else changed it — leave it
    if (fileExisted) atomicWrite(gitignorePath, original);
    else rmSync(gitignorePath, { force: true });
  } catch {
    // Best-effort revert; leave whatever is on disk.
  }
}

function warnStillIgnored(
  log: Pick<typeof defaultLogger, 'info' | 'warn'>,
  gitignorePath: string,
  source: string | undefined,
  reason?: string,
): void {
  const leftClause = reason
    ? `crew left ${gitignorePath} unchanged (${reason})`
    : `crew could not re-include it from ${gitignorePath}`;
  log.warn(
    'crew install: .crew/install.project.json is still git-ignored'
    + (source ? ` by "${source}"` : '')
    + `. ${leftClause} — the ignore lives somewhere the repo-root .gitignore cannot override `
    + '(a global core.excludesFile, or a more-specific .gitignore deeper in the tree). '
    + 'Re-include it there, or commit with `git add -f .crew/install.project.json`.',
  );
}
