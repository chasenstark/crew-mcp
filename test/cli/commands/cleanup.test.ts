/**
 * `crew-mcp cleanup` — on-demand GC. Uses a real git repo + WorktreeManager
 * so the assertions cover the actual worktree removal, with a fixed clock
 * and explicit/config-backed TTLs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { cleanupCommand } from '../../../src/cli/commands/cleanup.js';
import { WorktreeManager } from '../../../src/git/worktree.js';
import { writeConfigFile, DEFAULT_CONFIG } from '../../../src/utils/config-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

function captureStdout(): { text: string } & Pick<NodeJS.WriteStream, 'write'> {
  const sink = {
    text: '',
    write(chunk: string | Uint8Array): boolean {
      sink.text += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    },
  };
  return sink as { text: string } & Pick<NodeJS.WriteStream, 'write'>;
}

describe('cleanupCommand', () => {
  let repoRoot: string;
  let crewHome: string;

  const seedRun = async (runId: string, completedAt: string): Promise<string> => {
    const manager = new WorktreeManager({ projectRoot: repoRoot, crewHome });
    await manager.createRunWorktree(runId);
    const dir = join(crewHome, 'runs', runId);
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId,
        agentId: 'mock',
        status: 'success',
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt,
        worktreePath: join(dir, 'worktree'),
        repoRoot,
        prompts: [{ turn: 1, prompt: 'go', startedAt: '2026-01-01T00:00:00.000Z', completedAt }],
        filesChanged: [],
      }, null, 2),
      'utf-8',
    );
    return join(dir, 'worktree');
  };

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'crew-cleanup-repo-'));
    crewHome = mkdtempSync(join(tmpdir(), 'crew-cleanup-home-'));
    execSync('git init -q', { cwd: repoRoot });
    execSync('git config user.email test@crew.local', { cwd: repoRoot });
    execSync('git config user.name test', { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'init\n', 'utf-8');
    execSync('git add README.md', { cwd: repoRoot });
    execSync('git commit -q -m init', { cwd: repoRoot });
  });

  afterEach(() => {
    delete process.env.CREW_WORKTREE_TTL_DAYS;
    delete process.env.CREW_RUNDIR_TTL_DAYS;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(crewHome, { recursive: true, force: true });
  });

  it('dry run reports what would be reclaimed without touching anything', async () => {
    const wt = await seedRun('aaaaaaaa-0000-0000-0000-000000000001', '2026-01-01T00:00:00.000Z');
    const stdout = captureStdout();

    const code = await cleanupCommand({
      cwd: repoRoot,
      crewHome,
      dryRun: true,
      worktreeTtlDays: 7,
      runDirTtlDays: 30,
      now: T0 + 8 * DAY_MS,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    expect(code).toBe(0);
    expect(existsSync(wt)).toBe(true); // untouched
    expect(stdout.text).toContain('(dry run)');
    expect(stdout.text).toContain('aaaaaaaa');
    expect(stdout.text).toMatch(/Would reclaim: 1 worktree/);
  });

  it('dry run reports a TTL-aged run-dir as pending behind its worktree, not deleted', async () => {
    // Past both windows but the worktree is still present: the real pass
    // reclaims the worktree first and defers run-dir deletion, so the preview
    // must say "pending worktree reclaim" rather than count it as deleted.
    const wt = await seedRun('aaaaaaaa-0000-0000-0000-0000000000aa', '2026-01-01T00:00:00.000Z');
    const stdout = captureStdout();

    await cleanupCommand({
      cwd: repoRoot,
      crewHome,
      dryRun: true,
      worktreeTtlDays: 7,
      runDirTtlDays: 30,
      now: T0 + 31 * DAY_MS,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    expect(existsSync(wt)).toBe(true); // untouched
    expect(stdout.text).toMatch(/Would reclaim: 1 worktree.* 0 run-dir\(s\) now/);
    expect(stdout.text).toContain('pending worktree reclaim');
    expect(stdout.text).toContain('run-dir (after worktree reclaim)');
  });

  it('reclaims the worktree for real', async () => {
    const wt = await seedRun('aaaaaaaa-0000-0000-0000-000000000002', '2026-01-01T00:00:00.000Z');
    const stdout = captureStdout();

    await cleanupCommand({
      cwd: repoRoot,
      crewHome,
      worktreeTtlDays: 7,
      runDirTtlDays: 30,
      now: T0 + 8 * DAY_MS,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    expect(existsSync(wt)).toBe(false);
    expect(stdout.text).toMatch(/Reclaimed: 1 worktree/);
  });

  it('honors the worktree TTL from config.json when no flag is passed', async () => {
    const wt = await seedRun('aaaaaaaa-0000-0000-0000-000000000003', '2026-01-01T00:00:00.000Z');
    // worktreeTtlDays 0 → reclaim any terminal run immediately.
    writeConfigFile(crewHome, {
      ...DEFAULT_CONFIG,
      cleanup: { worktreeTtlDays: 0, runDirTtlDays: 30 },
    });
    const stdout = captureStdout();

    await cleanupCommand({
      cwd: repoRoot,
      crewHome,
      now: T0 + 1 * DAY_MS,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    expect(existsSync(wt)).toBe(false);
  });
});
