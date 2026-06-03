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
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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

  it('failed squash commit discards staged run changes before restoring the original branch', async () => {
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

    await expect(
      manager.mergeRunWorktree('run-1', { targetBranch }),
    ).rejects.toThrow(/blocked by test hook/);

    expect(execSync('git branch --show-current', { cwd: repoRoot, encoding: 'utf-8' }).trim()).toBe('feature');
    expect(execSync('git status --porcelain', { cwd: repoRoot, encoding: 'utf-8' })).toBe('');
    expect(execSync(`git rev-parse ${targetBranch}`, { cwd: repoRoot, encoding: 'utf-8' }).trim()).toBe(targetHead);
    expect(existsSync(join(repoRoot, 'RUN.md'))).toBe(false);
  });

  it('force=true failed squash commit preserves pre-existing staged host changes', async () => {
    const manager = new WorktreeManager({ projectRoot: repoRoot, crewHome });
    const targetBranch = execSync('git branch --show-current', { cwd: repoRoot, encoding: 'utf-8' }).trim();
    execSync('git checkout -q -b feature', { cwd: repoRoot });
    const targetHead = execSync(`git rev-parse ${targetBranch}`, { cwd: repoRoot, encoding: 'utf-8' }).trim();
    const worktreePath = await manager.createRunWorktree('run-1');

    writeFileSync(join(worktreePath, 'RUN.md'), 'run change\n', 'utf-8');
    execSync('git add RUN.md', { cwd: worktreePath });
    execSync('git commit -q -m "run change"', { cwd: worktreePath });

    writeFileSync(join(repoRoot, 'README.md'), 'init\nhost staged change\n', 'utf-8');
    execSync('git add README.md', { cwd: repoRoot });

    const hookPath = join(repoRoot, '.git', 'hooks', 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho blocked by test hook >&2\nexit 1\n', 'utf-8');
    chmodSync(hookPath, 0o755);

    await expect(
      manager.mergeRunWorktree('run-1', { targetBranch, force: true }),
    ).rejects.toThrow(/did not run git reset --hard/);

    expect(execSync('git branch --show-current', { cwd: repoRoot, encoding: 'utf-8' }).trim()).toBe(targetBranch);
    expect(readFileSync(join(repoRoot, 'README.md'), 'utf-8')).toBe('init\nhost staged change\n');
    expect(execSync('git diff --cached --name-only', { cwd: repoRoot, encoding: 'utf-8' }).split('\n')).toContain('README.md');
    expect(execSync(`git rev-parse ${targetBranch}`, { cwd: repoRoot, encoding: 'utf-8' }).trim()).toBe(targetHead);
  });
});
