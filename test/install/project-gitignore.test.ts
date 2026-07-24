import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  computeGitignoreUpdate,
  ensureProjectManifestCommittable,
  PROJECT_MANIFEST_GITIGNORE_PATH,
} from '../../src/install/project-gitignore.js';

const NEGATION = `!/${PROJECT_MANIFEST_GITIGNORE_PATH}`;
const MINIMAL = [NEGATION];
const FULL = ['!/.crew/', '/.crew/*', NEGATION];

async function withTmpGitRepo<T>(fn: (repoRoot: string) => Promise<T>): Promise<T> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'crew-gitignore-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@crew.local'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoRoot });
    return await fn(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

/** True when `git add` would accept the path (i.e. it is not ignored). */
function isCommittable(repoRoot: string, relPath = PROJECT_MANIFEST_GITIGNORE_PATH): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', relPath], { cwd: repoRoot });
    return false; // exit 0 => ignored
  } catch {
    return true; // exit 1 => not ignored
  }
}

function silentLogger(): { info: (m: string) => void; warn: (m: string) => void } {
  return { info: () => {}, warn: () => {} };
}

describe('computeGitignoreUpdate', () => {
  it('appends the full block without rewriting the consumer blanket rule', () => {
    const { next, changed } = computeGitignoreUpdate('node_modules\n.crew/\n', FULL);
    expect(changed).toBe(true);
    expect(next).toMatch(/^\.crew\/$/m); // original rule preserved, not rewritten
    expect(next).toContain('!/.crew/\n');
    expect(next).toContain('/.crew/*');
    expect(next).toContain(NEGATION);
    expect(next.indexOf('/.crew/*')).toBeLessThan(next.indexOf(NEGATION));
  });

  it('appends only the negation for the minimal block', () => {
    const { next } = computeGitignoreUpdate('.crew/*\n', MINIMAL);
    expect(next).toContain(NEGATION);
    expect(next).not.toContain('!/.crew/\n'); // no dir re-include in the minimal shape
  });

  it('is idempotent when the same block already sits alone at EOF', () => {
    const first = computeGitignoreUpdate('.crew/\n', FULL);
    const second = computeGitignoreUpdate(first.next, FULL);
    expect(second.changed).toBe(false);
    expect(second.next).toBe(first.next);
  });

  it('does not strip standalone consumer lines that merely match an owned rule', () => {
    // No comment sentinel → these are consumer lines, must survive.
    const input = '/.crew/*\n!/.crew/keep.txt\n';
    const { next } = computeGitignoreUpdate(input, MINIMAL);
    expect(next).toContain('/.crew/*');
    expect(next).toContain('!/.crew/keep.txt');
    expect(next).toContain(NEGATION);
  });

  it('re-appends (no accumulation) when a later broad pattern shadows our block', () => {
    const shadowed = `.crew/\n\n# crew-mcp: keep the project install manifest committable (the rest of .crew/ stays ignored)\n!/.crew/\n/.crew/*\n${NEGATION}\n*.json\n`;
    const { next, changed } = computeGitignoreUpdate(shadowed, FULL);
    expect(changed).toBe(true);
    const lines = next.split('\n').filter((l) => l.trim().length > 0);
    expect(lines[lines.length - 1]).toBe(NEGATION);
    expect(next.split('\n').filter((l) => l.trim() === NEGATION)).toHaveLength(1);
  });

  it('leaves an interrupted block intact instead of partially stripping it', () => {
    // A consumer line inserted into the middle of a crew block must not be
    // half-stripped (which would strand owned rules). The whole block survives
    // and a fresh one is appended.
    const comment = '# crew-mcp: keep the project install manifest committable (the rest of .crew/ stays ignored)';
    const interrupted = `.crew/\n${comment}\n!/.crew/\n!/.crew/keep.txt\n/.crew/*\n${NEGATION}\n`;
    const { next } = computeGitignoreUpdate(interrupted, FULL);
    expect(next).toContain('!/.crew/keep.txt'); // consumer insert preserved
    expect(next.split('\n').filter((l) => l.trim() === comment)).toHaveLength(2); // old + fresh
  });

  it('preserves CRLF line endings', () => {
    const { next } = computeGitignoreUpdate('node_modules\r\n.crew/\r\n', FULL);
    expect(next).toContain('\r\n');
    expect(next).not.toMatch(/[^\r]\n/);
  });
});

describe('ensureProjectManifestCommittable', () => {
  it('reports already-committable when nothing ignores the manifest', async () => {
    await withTmpGitRepo(async (repoRoot) => {
      const res = await ensureProjectManifestCommittable(repoRoot, { logger: silentLogger() });
      expect(res.outcome).toBe('already-committable');
      expect(existsSync(join(repoRoot, '.gitignore'))).toBe(false);
    });
  });

  it('reports already-committable when the manifest is already tracked despite a .crew/ rule', async () => {
    await withTmpGitRepo(async (repoRoot) => {
      await writeFile(join(repoRoot, '.gitignore'), '.crew/\n');
      await mkdir(join(repoRoot, '.crew'), { recursive: true });
      await writeFile(join(repoRoot, '.crew', 'install.project.json'), '{}');
      execFileSync('git', ['add', '-f', PROJECT_MANIFEST_GITIGNORE_PATH], { cwd: repoRoot });
      const res = await ensureProjectManifestCommittable(repoRoot, { logger: silentLogger() });
      expect(res.outcome).toBe('already-committable');
    });
  });

  it('re-includes the manifest for a blanket .crew/ while preserving nested + root .crew state', async () => {
    await withTmpGitRepo(async (repoRoot) => {
      await writeFile(join(repoRoot, '.gitignore'), 'node_modules\n.crew/\n');
      await mkdir(join(repoRoot, 'packages', 'app', '.crew'), { recursive: true });
      expect(isCommittable(repoRoot)).toBe(false);

      const res = await ensureProjectManifestCommittable(repoRoot, { logger: silentLogger() });
      expect(res.outcome).toBe('gitignore-updated');
      expect(isCommittable(repoRoot)).toBe(true);
      expect(isCommittable(repoRoot, '.crew/runs/abc/worktree')).toBe(false);
      expect(isCommittable(repoRoot, 'packages/app/.crew/runtime.json')).toBe(false);
    });
  });

  it.each([
    ['leading-slash blanket', '/.crew/\n'],
    ['star everything', '*\n'],
    ['double-star glob', '.crew/**\n'],
    ['misordered negation', '!.crew/install.project.json\n.crew/*\n'],
    ['trailing broad rule', '.crew/*\n!.crew/install.project.json\n*.json\n'],
    ['blanket + bare anchored negation', `.crew/\n${NEGATION}\n`],
  ])('fixes a %s ignore', async (_name, gitignore) => {
    await withTmpGitRepo(async (repoRoot) => {
      await writeFile(join(repoRoot, '.gitignore'), gitignore);
      expect(isCommittable(repoRoot)).toBe(false);
      const res = await ensureProjectManifestCommittable(repoRoot, { logger: silentLogger() });
      expect(res.outcome).toBe('gitignore-updated');
      expect(isCommittable(repoRoot)).toBe(true);
    });
  });

  it('preserves a consumer .crew exception (uses the minimal block)', async () => {
    await withTmpGitRepo(async (repoRoot) => {
      await writeFile(join(repoRoot, '.gitignore'), '/.crew/*\n!/.crew/keep.txt\n');
      expect(isCommittable(repoRoot)).toBe(false);

      const res = await ensureProjectManifestCommittable(repoRoot, { logger: silentLogger() });
      expect(res.outcome).toBe('gitignore-updated');
      expect(isCommittable(repoRoot)).toBe(true);
      // the consumer's kept file must remain committable
      expect(isCommittable(repoRoot, '.crew/keep.txt')).toBe(true);
    });
  });

  it('re-fixes and does not accumulate when a later broad rule shadows our own block', async () => {
    await withTmpGitRepo(async (repoRoot) => {
      await writeFile(join(repoRoot, '.gitignore'), '.crew/\n');
      await ensureProjectManifestCommittable(repoRoot, { logger: silentLogger() });
      expect(isCommittable(repoRoot)).toBe(true);

      const current = await readFile(join(repoRoot, '.gitignore'), 'utf-8');
      await writeFile(join(repoRoot, '.gitignore'), `${current}*.json\n`);
      expect(isCommittable(repoRoot)).toBe(false);

      const res = await ensureProjectManifestCommittable(repoRoot, { logger: silentLogger() });
      expect(res.outcome).toBe('gitignore-updated');
      expect(isCommittable(repoRoot)).toBe(true);
      const finalContent = await readFile(join(repoRoot, '.gitignore'), 'utf-8');
      expect(finalContent.split('\n').filter((l) => l.trim() === NEGATION)).toHaveLength(1);
    });
  });

  it('auto-fixes an ignore in .git/info/exclude', async () => {
    await withTmpGitRepo(async (repoRoot) => {
      await mkdir(join(repoRoot, '.git', 'info'), { recursive: true });
      await writeFile(join(repoRoot, '.git', 'info', 'exclude'), '.crew/\n');
      expect(isCommittable(repoRoot)).toBe(false);
      const res = await ensureProjectManifestCommittable(repoRoot, { logger: silentLogger() });
      expect(res.outcome).toBe('gitignore-updated');
      expect(isCommittable(repoRoot)).toBe(true);
    });
  });

  it('auto-fixes an ignore in a global core.excludesFile', async () => {
    await withTmpGitRepo(async (repoRoot) => {
      const globalIgnore = join(repoRoot, 'global_ignore');
      await writeFile(globalIgnore, '.crew/\n');
      execFileSync('git', ['config', 'core.excludesFile', globalIgnore], { cwd: repoRoot });
      expect(isCommittable(repoRoot)).toBe(false);
      const res = await ensureProjectManifestCommittable(repoRoot, { logger: silentLogger() });
      expect(res.outcome).toBe('gitignore-updated');
      expect(isCommittable(repoRoot)).toBe(true);
    });
  });

  it('is idempotent across repeated installs', async () => {
    await withTmpGitRepo(async (repoRoot) => {
      await writeFile(join(repoRoot, '.gitignore'), '.crew/\n');
      await ensureProjectManifestCommittable(repoRoot, { logger: silentLogger() });
      const afterFirst = await readFile(join(repoRoot, '.gitignore'), 'utf-8');

      const res = await ensureProjectManifestCommittable(repoRoot, { logger: silentLogger() });
      expect(res.outcome).toBe('already-committable');
      const afterSecond = await readFile(join(repoRoot, '.gitignore'), 'utf-8');
      expect(afterSecond).toBe(afterFirst);
    });
  });

  it('preserves CRLF endings through the write path', async () => {
    await withTmpGitRepo(async (repoRoot) => {
      await writeFile(join(repoRoot, '.gitignore'), 'node_modules\r\n.crew/\r\n');
      const res = await ensureProjectManifestCommittable(repoRoot, { logger: silentLogger() });
      expect(res.outcome).toBe('gitignore-updated');
      expect(isCommittable(repoRoot)).toBe(true);
      const content = await readFile(join(repoRoot, '.gitignore'), 'utf-8');
      expect(content).toContain('\r\n');
      expect(content).not.toMatch(/[^\r]\n/);
    });
  });

  it('declines to clobber a symlinked .gitignore and warns', async () => {
    await withTmpGitRepo(async (repoRoot) => {
      await mkdir(join(repoRoot, '.git', 'info'), { recursive: true });
      await writeFile(join(repoRoot, '.git', 'info', 'exclude'), '.crew/\n');
      await writeFile(join(repoRoot, 'shared-ignore'), 'build/\n');
      symlinkSync('shared-ignore', join(repoRoot, '.gitignore'));

      const warnings: string[] = [];
      const res = await ensureProjectManifestCommittable(repoRoot, {
        logger: { info: () => {}, warn: (m) => warnings.push(m) },
      });
      expect(res.outcome).toBe('manual-fix-required');
      expect(lstatSync(join(repoRoot, '.gitignore')).isSymbolicLink()).toBe(true);
      expect(warnings.join('\n')).toContain('symlink');
      expect(warnings.join('\n')).toContain('git add -f');
    });
  });

  it('reverts (leaves no spurious .gitignore) when a deeper .crew/.gitignore defeats the negation', async () => {
    await withTmpGitRepo(async (repoRoot) => {
      await mkdir(join(repoRoot, '.crew'), { recursive: true });
      await writeFile(join(repoRoot, '.crew', '.gitignore'), '/install.project.json\n');
      expect(isCommittable(repoRoot)).toBe(false);

      const warnings: string[] = [];
      const res = await ensureProjectManifestCommittable(repoRoot, {
        logger: { info: () => {}, warn: (m) => warnings.push(m) },
      });
      expect(res.outcome).toBe('manual-fix-required');
      expect(existsSync(join(repoRoot, '.gitignore'))).toBe(false); // created file reverted
      expect(warnings.join('\n')).toContain('git add -f');
    });
  });

  it('restores prior .gitignore content when it cannot fix the ignore', async () => {
    await withTmpGitRepo(async (repoRoot) => {
      const original = 'node_modules\n.crew/\n';
      await writeFile(join(repoRoot, '.gitignore'), original);
      await mkdir(join(repoRoot, '.crew'), { recursive: true });
      await writeFile(join(repoRoot, '.crew', '.gitignore'), '/install.project.json\n');
      expect(isCommittable(repoRoot)).toBe(false);

      const res = await ensureProjectManifestCommittable(repoRoot, { logger: silentLogger() });
      expect(res.outcome).toBe('manual-fix-required');
      // pre-existing content restored exactly — no dead crew block left behind
      expect(await readFile(join(repoRoot, '.gitignore'), 'utf-8')).toBe(original);
    });
  });

  it('escalates to the full block rather than dropping runtime-state ignoring', async () => {
    await withTmpGitRepo(async (repoRoot) => {
      // A prior FULL block is the SOLE thing ignoring .crew/*, then a broad rule
      // re-ignores the manifest. Minimal would re-include the manifest but leave
      // .crew/runs committable — the fix must pick full instead.
      const fullBlock = computeGitignoreUpdate('', FULL).next;
      await writeFile(join(repoRoot, '.gitignore'), `${fullBlock}*.json\n`);
      expect(isCommittable(repoRoot)).toBe(false);

      const res = await ensureProjectManifestCommittable(repoRoot, { logger: silentLogger() });
      expect(res.outcome).toBe('gitignore-updated');
      expect(isCommittable(repoRoot)).toBe(true);
      // runtime state must stay ignored (proves full block was chosen)
      expect(isCommittable(repoRoot, '.crew/runs/abc')).toBe(false);
    });
  });

  it('rolls back and propagates when a verification errors mid-fix (no escalation)', async () => {
    await withTmpGitRepo(async (repoRoot) => {
      const original = '.crew/\n';
      await writeFile(join(repoRoot, '.gitignore'), original);

      // probe: before=ignored, runtime-before=ignored, then throw on the minimal
      // verification — must NOT escalate to full; must revert + propagate.
      let calls = 0;
      const probe = async () => {
        calls += 1;
        if (calls <= 2) return { ignored: true };
        throw new Error('git check-ignore timed out');
      };

      await expect(
        ensureProjectManifestCommittable(repoRoot, { logger: silentLogger(), probe }),
      ).rejects.toThrow(/timed out/);
      // the minimal block we wrote was rolled back
      expect(await readFile(join(repoRoot, '.gitignore'), 'utf-8')).toBe(original);
    });
  });

  it('propagates an operational git failure (non-repo) instead of swallowing it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crew-nogit-'));
    try {
      await expect(
        ensureProjectManifestCommittable(dir, { logger: silentLogger() }),
      ).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
