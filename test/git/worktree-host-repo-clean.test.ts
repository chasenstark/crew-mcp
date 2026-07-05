/**
 * M3.5 invariant: a full run lifecycle (create → cleanup) leaves the
 * host repo's working tree completely untouched. No `.crew/` directory
 * appears, the user's `.gitignore` is never modified, and `git status`
 * sees nothing related to crew.
 *
 * Uses a real git repo (not the simple-git mock) so the assertions are
 * about the actual filesystem state the user would observe.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { WorktreeManager } from '../../src/git/worktree.js';

describe('M3.5 host-repo cleanliness', () => {
  let repoRoot: string;
  let crewHome: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'crew-clean-repo-'));
    crewHome = mkdtempSync(join(tmpdir(), 'crew-clean-home-'));
    execSync('git init -q', { cwd: repoRoot });
    execSync('git config user.email test@crew.local', { cwd: repoRoot });
    execSync('git config user.name test', { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'init\n', 'utf-8');
    execSync('git add README.md', { cwd: repoRoot });
    execSync('git commit -q -m init', { cwd: repoRoot });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(crewHome, { recursive: true, force: true });
  });

  it('host repo has no .crew/ directory after a run is created', async () => {
    const manager = new WorktreeManager({ projectRoot: repoRoot, crewHome });
    await manager.createRunWorktree('run-1');
    expect(existsSync(join(repoRoot, '.crew'))).toBe(false);
  });

  it('isCrewControlledPath recognizes the host repo and crew worktrees, rejects external dirs', async () => {
    const manager = new WorktreeManager({ projectRoot: repoRoot, crewHome });
    const worktree = await manager.createRunWorktree('run-1');
    mkdirSync(join(repoRoot, 'src'));
    // Host repo root + descendant + crew-owned worktree → trust is safe.
    expect(manager.isCrewControlledPath(repoRoot)).toBe(true);
    expect(manager.isCrewControlledPath(join(repoRoot, 'src'))).toBe(true);
    expect(manager.isCrewControlledPath(worktree)).toBe(true);
    expect(manager.isCrewControlledPath(join(crewHome, 'runs'))).toBe(true);
    // Arbitrary external dirs → NOT crew-controlled (don't auto-trust).
    expect(manager.isCrewControlledPath('/tmp')).toBe(false);
    expect(manager.isCrewControlledPath('/etc')).toBe(false);
    expect(manager.isCrewControlledPath('')).toBe(false);
  });

  it('isCrewControlledPath rejects prefix-sibling, parent-traversal, and symlink-escape paths', () => {
    const manager = new WorktreeManager({ projectRoot: repoRoot, crewHome });
    // Prefix sibling: "<repoRoot>-evil" shares a string prefix but is NOT inside.
    const sibling = `${repoRoot}-evil`;
    mkdirSync(sibling);
    // Parent-traversal that escapes the repo entirely.
    const escape = join(repoRoot, '..', 'definitely-outside');
    // Symlink planted inside the repo pointing at an external dir: a lexical
    // check would auto-trust it; realpath collapses it to the external target.
    const external = mkdtempSync(join(tmpdir(), 'crew-external-link-'));
    const link = join(repoRoot, 'vendor-link');
    symlinkSync(external, link);
    try {
      expect(manager.isCrewControlledPath(sibling)).toBe(false);
      expect(manager.isCrewControlledPath(escape)).toBe(false);
      expect(manager.isCrewControlledPath(link)).toBe(false);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it('host repo .gitignore is never created or modified by crew', async () => {
    expect(existsSync(join(repoRoot, '.gitignore'))).toBe(false);
    const manager = new WorktreeManager({ projectRoot: repoRoot, crewHome });
    await manager.createRunWorktree('run-1');
    await manager.cleanupByRunId('run-1');
    expect(existsSync(join(repoRoot, '.gitignore'))).toBe(false);
  });

  it('host repo .gitignore is preserved verbatim if the user already has one', async () => {
    const userIgnore = '# user notes\nnode_modules/\ndist/\n';
    writeFileSync(join(repoRoot, '.gitignore'), userIgnore, 'utf-8');
    execSync('git add .gitignore', { cwd: repoRoot });
    execSync('git commit -q -m gitignore', { cwd: repoRoot });

    const manager = new WorktreeManager({ projectRoot: repoRoot, crewHome });
    await manager.createRunWorktree('run-1');

    const after = readFileSync(join(repoRoot, '.gitignore'), 'utf-8');
    expect(after).toBe(userIgnore);
  });

  it('createRunWorktree refuses an unfinished merge with unmerged index paths', async () => {
    const targetBranch = execSync('git branch --show-current', { cwd: repoRoot, encoding: 'utf-8' }).trim();
    execSync('git checkout -q -b side', { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'side\n', 'utf-8');
    execSync('git add README.md && git commit -q -m side', { cwd: repoRoot });
    execSync(`git checkout -q ${targetBranch}`, { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'main\n', 'utf-8');
    execSync('git add README.md && git commit -q -m main', { cwd: repoRoot });
    try {
      execSync('git merge side', { cwd: repoRoot, stdio: 'ignore' });
    } catch {
      // Expected conflict.
    }

    const manager = new WorktreeManager({ projectRoot: repoRoot, crewHome });
    await expect(manager.createRunWorktree('run-conflict')).rejects.toThrow(
      /host_repo_not_ready:.*unmerged index paths: README.md/,
    );
  });

  it('git status in the host repo shows no crew-related changes after a full lifecycle', async () => {
    const manager = new WorktreeManager({ projectRoot: repoRoot, crewHome });
    await manager.createRunWorktree('run-1');
    const status = execSync('git status --porcelain', { cwd: repoRoot, encoding: 'utf-8' });
    expect(status).toBe('');
    // Sanity: top-level dir contains only the user's content (README, .git).
    const entries = readdirSync(repoRoot).sort();
    expect(entries).toEqual(['.git', 'README.md']);
  });

  it('run state lives under crewHome, not under the host repo', async () => {
    const manager = new WorktreeManager({ projectRoot: repoRoot, crewHome });
    const wPath = await manager.createRunWorktree('run-1');
    expect(wPath.startsWith(crewHome)).toBe(true);
    expect(wPath.startsWith(repoRoot)).toBe(false);
    expect(existsSync(join(crewHome, 'runs', 'run-1', 'worktree'))).toBe(true);
    expect(existsSync(join(crewHome, 'runs', '.meta', 'run-1.json'))).toBe(true);
  });

  it('plumbing squash lands off-checkout without running host commit hooks or touching the checkout', async () => {
    const manager = new WorktreeManager({ projectRoot: repoRoot, crewHome });
    const targetBranch = execSync('git branch --show-current', { cwd: repoRoot, encoding: 'utf-8' }).trim();
    execSync('git checkout -q -b feature', { cwd: repoRoot });
    const targetHead = execSync(`git rev-parse ${targetBranch}`, { cwd: repoRoot, encoding: 'utf-8' }).trim();
    const worktreePath = await manager.createRunWorktree('run-1');

    writeFileSync(join(worktreePath, 'RUN.md'), 'run change\n', 'utf-8');
    execSync('git add RUN.md', { cwd: worktreePath });
    execSync('git commit -q -m "run change"', { cwd: worktreePath });

    const hookPath = join(repoRoot, '.git', 'hooks', 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho blocked by test hook >&2\nexit 1\n', 'utf-8');
    chmodSync(hookPath, 0o755);

    const result = await manager.mergeRunWorktree('run-1', { targetBranch });

    expect(result.status).toBe('merged');
    expect(execSync('git branch --show-current', { cwd: repoRoot, encoding: 'utf-8' }).trim()).toBe('feature');
    expect(execSync('git status --porcelain', { cwd: repoRoot, encoding: 'utf-8' })).toBe('');
    expect(execSync(`git rev-parse ${targetBranch}`, { cwd: repoRoot, encoding: 'utf-8' }).trim()).not.toBe(targetHead);
    expect(existsSync(join(repoRoot, 'RUN.md'))).toBe(false);
  }, 30_000);

  it('force=true refuses to land a plumbing squash onto the checked-out target with staged host changes', async () => {
    const manager = new WorktreeManager({ projectRoot: repoRoot, crewHome });
    const targetBranch = execSync('git branch --show-current', { cwd: repoRoot, encoding: 'utf-8' }).trim();
    const targetHead = execSync(`git rev-parse ${targetBranch}`, { cwd: repoRoot, encoding: 'utf-8' }).trim();
    const worktreePath = await manager.createRunWorktree('run-1');

    writeFileSync(join(worktreePath, 'RUN.md'), 'run change\n', 'utf-8');
    execSync('git add RUN.md', { cwd: worktreePath });
    execSync('git commit -q -m "run change"', { cwd: worktreePath });

    writeFileSync(join(repoRoot, 'README.md'), 'init\nhost staged change\n', 'utf-8');
    execSync('git add README.md', { cwd: repoRoot });

    await expect(
      manager.mergeRunWorktree('run-1', { targetBranch, force: true }),
    ).rejects.toThrow(/target branch .* checked out with uncommitted changes/);

    expect(execSync('git branch --show-current', { cwd: repoRoot, encoding: 'utf-8' }).trim()).toBe(targetBranch);
    expect(readFileSync(join(repoRoot, 'README.md'), 'utf-8')).toBe('init\nhost staged change\n');
    expect(execSync('git diff --cached --name-only', { cwd: repoRoot, encoding: 'utf-8' }).split('\n')).toContain('README.md');
    expect(execSync(`git rev-parse ${targetBranch}`, { cwd: repoRoot, encoding: 'utf-8' }).trim()).toBe(targetHead);
  }, 15_000);
});
