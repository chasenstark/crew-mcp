import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { discardRunToolHandler } from '../../../src/orchestrator/tools/discard-run.js';
import type { ToolHandlerDeps } from '../../../src/orchestrator/tools/shared.js';
import {
  makeHarness,
  makeMockAdapter,
  type PanelHarness,
} from './panel-test-harness.js';

const cleanups: Array<() => void> = [];
const worktreeDeltaCases: ReadonlyArray<readonly [
  string,
  (worktreePath: string) => void,
]> = [
  ['untracked', (worktreePath) => {
    writeFileSync(join(worktreePath, 'deliverable.txt'), 'keep me\n', 'utf-8');
  }],
  ['tracked', (worktreePath) => {
    writeFileSync(join(worktreePath, 'README.md'), 'tracked edit\n', 'utf-8');
  }],
  ['staged', (worktreePath) => {
    writeFileSync(join(worktreePath, 'staged.txt'), 'staged edit\n', 'utf-8');
    execSync('git add staged.txt', { cwd: worktreePath });
  }],
];

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function harness(): PanelHarness {
  const h = makeHarness([makeMockAdapter()]);
  cleanups.push(h.cleanup);
  return h;
}

function depsFor(h: PanelHarness): Pick<
  ToolHandlerDeps,
  'crewHome' | 'runStateStore' | 'worktreeManager' | 'dispatcher'
> {
  return {
    crewHome: h.crewHome,
    runStateStore: h.runStateStore,
    worktreeManager: h.worktreeManager,
    dispatcher: h.dispatcher,
  };
}

async function seedTerminalRun(
  h: PanelHarness,
  runId: string,
  runMode: 'write' | 'read_only' | 'ephemeral_review' = 'write',
): Promise<string> {
  const worktreePath = runMode === 'read_only'
    ? h.root
    : await h.worktreeManager.createRunWorktree(runId);
  await h.runStateStore.create({
    runId,
    agentId: 'mock',
    worktreePath,
    initialPrompt: 'initial',
    runMode,
  });
  await h.runStateStore.markTerminal(runId, {
    status: 'success',
    summary: 'done',
    filesChanged: [],
  });
  return worktreePath;
}

describe('discard_run deliverable confirmation gate', () => {
  it.each(worktreeDeltaCases)('rejects %s worktree changes until confirmed:true', async (_kind, mutate) => {
    const h = harness();
    const worktreePath = await seedTerminalRun(h, 'dirty-run');
    mutate(worktreePath);

    const refused = await discardRunToolHandler({ run_id: 'dirty-run' }, depsFor(h));

    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/^discard_run\.confirmation_required:/);
    expect(refused.content[0].text).toContain('confirmed:true');
    expect(h.runStateStore.read('dirty-run')?.status).toBe('success');
    expect(existsSync(worktreePath)).toBe(true);

    const accepted = await discardRunToolHandler({
      run_id: 'dirty-run',
      confirmed: true,
    }, depsFor(h));
    expect(accepted.isError).not.toBe(true);
    expect(h.runStateStore.read('dirty-run')?.status).toBe('discarded');
    await h.worktreeManager.drainBackgroundCleanups();
    expect(existsSync(worktreePath)).toBe(false);
  });

  it('gates committed work against the persisted branch point even after host HEAD moves', async () => {
    const h = harness();
    const originalHead = execSync('git rev-parse HEAD', { cwd: h.root }).toString().trim();
    const worktreePath = await seedTerminalRun(h, 'committed-run');
    const metadata = JSON.parse(readFileSync(
      join(h.crewHome, 'runs', '.meta', 'committed-run.json'),
      'utf-8',
    )) as { branchPointSha: string };
    expect(metadata.branchPointSha).toBe(originalHead);

    writeFileSync(join(worktreePath, 'committed.txt'), 'committed work\n', 'utf-8');
    execSync('git add committed.txt && git commit -q -m deliverable', { cwd: worktreePath });
    writeFileSync(join(h.root, 'host-moved.txt'), 'host move\n', 'utf-8');
    execSync('git add host-moved.txt && git commit -q -m host-moved', { cwd: h.root });

    const refused = await discardRunToolHandler({ run_id: 'committed-run' }, depsFor(h));

    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('1 commit(s) ahead of its persisted branch point');
    expect(existsSync(worktreePath)).toBe(true);
  });

  it('allows a clean write run and preserves read_only and ephemeral_review carve-outs', async () => {
    const h = harness();
    const cleanPath = await seedTerminalRun(h, 'clean-run');
    const readOnlyPath = await seedTerminalRun(h, 'read-only-run', 'read_only');
    const ephemeralPath = await seedTerminalRun(h, 'ephemeral-run', 'ephemeral_review');
    writeFileSync(join(ephemeralPath, 'reviewer-stray.txt'), 'discardable\n', 'utf-8');

    for (const runId of ['clean-run', 'read-only-run', 'ephemeral-run']) {
      const out = await discardRunToolHandler({ run_id: runId }, depsFor(h));
      expect(out.isError, runId).not.toBe(true);
      expect(h.runStateStore.read(runId)?.status).toBe('discarded');
    }
    await h.worktreeManager.drainBackgroundCleanups();
    expect(existsSync(cleanPath)).toBe(false);
    expect(existsSync(readOnlyPath)).toBe(true);
    expect(existsSync(ephemeralPath)).toBe(false);
  });

  it('always requires confirmation for merge_conflict status', async () => {
    const h = harness();
    const worktreePath = await seedTerminalRun(h, 'conflict-run');
    await h.runStateStore.markMergeConflict('conflict-run', {
      target: 'main',
      conflicts: [],
    });

    const refused = await discardRunToolHandler({ run_id: 'conflict-run' }, depsFor(h));
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('merge_conflict status');
    expect(existsSync(worktreePath)).toBe(true);

    const accepted = await discardRunToolHandler({
      run_id: 'conflict-run',
      confirmed: true,
    }, depsFor(h));
    expect(accepted.isError).not.toBe(true);
  });
});
