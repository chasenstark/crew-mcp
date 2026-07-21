import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, writeConfigFile } from '../../../src/utils/config-store.js';
import { mergeRunToolHandler } from '../../../src/orchestrator/tools/merge-run.js';
import type { ToolHandlerDeps } from '../../../src/orchestrator/tools/shared.js';
import {
  makeHarness,
  makeMockAdapter,
  type PanelHarness,
} from './panel-test-harness.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function harness(confirmBeforeMerge: boolean): PanelHarness {
  const h = makeHarness([makeMockAdapter()]);
  cleanups.push(h.cleanup);
  writeConfigFile(h.crewHome, { ...DEFAULT_CONFIG, confirmBeforeMerge });
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

async function seedTerminalRun(h: PanelHarness, runId: string): Promise<void> {
  const worktreePath = await h.worktreeManager.createRunWorktree(runId);
  await h.runStateStore.create({
    runId,
    agentId: 'mock',
    worktreePath,
    initialPrompt: 'initial',
  });
  await h.runStateStore.markTerminal(runId, {
    status: 'success',
    summary: 'done',
    filesChanged: [],
  });
}

describe('merge_run force confirmation and commit-title floors', () => {
  it('requires confirmed:true with force even when confirmBeforeMerge is disabled', async () => {
    const h = harness(false);
    await seedTerminalRun(h, 'force-run');

    const refused = await mergeRunToolHandler({
      run_id: 'force-run',
      force: true,
      merge_strategy: 'preserve',
    }, depsFor(h));

    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/^merge_run\.force_requires_confirmed:/);
    expect(refused.content[0].text).toContain('busy_worktree');
    expect(refused.content[0].text).toContain('dirty host checkout');

    const accepted = await mergeRunToolHandler({
      run_id: 'force-run',
      force: true,
      confirmed: true,
      merge_strategy: 'preserve',
    }, depsFor(h));
    expect(accepted.isError).not.toBe(true);
    expect(accepted.structuredContent?.status).toBe('no-changes');
  });

  it.each([true, false])(
    'rejects missing squash commit_title with confirmBeforeMerge=%s',
    async (confirmBeforeMerge) => {
      const h = harness(confirmBeforeMerge);
      await seedTerminalRun(h, `title-run-${confirmBeforeMerge}`);

      const out = await mergeRunToolHandler({
        run_id: `title-run-${confirmBeforeMerge}`,
        ...(confirmBeforeMerge ? { confirmed: true } : {}),
      }, depsFor(h));

      expect(out.isError).toBe(true);
      expect(out.content[0].text).toMatch(/^merge_run\.commit_title_required:/);
      expect(out.content[0].text).toContain('does not synthesize commit titles');
    },
  );

  it('checks the squash title floor before the enabled confirmation gate', async () => {
    const h = harness(true);
    await seedTerminalRun(h, 'unconfirmed-title-run');

    const out = await mergeRunToolHandler({
      run_id: 'unconfirmed-title-run',
      merge_strategy: 'squash',
    }, depsFor(h));

    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/^merge_run\.commit_title_required:/);
    expect(out.content[0].text).not.toContain('requires explicit user confirmation');
  });

  it('warns, rather than rejects, when commit_title exceeds 72 characters', async () => {
    const h = harness(false);
    await seedTerminalRun(h, 'long-title-run');
    const commitTitle = `feat: ${'x'.repeat(70)}`;

    const out = await mergeRunToolHandler({
      run_id: 'long-title-run',
      commit_title: commitTitle,
    }, depsFor(h));

    expect(out.isError).not.toBe(true);
    expect(out.structuredContent?.status).toBe('no-changes');
    expect(out.structuredContent?.warnings).toEqual([
      expect.stringContaining(`commit_title is ${commitTitle.length} characters`),
    ]);
    expect(out.content[0].text).toContain('## Warnings');
  });

  it('keeps preserve merges exempt from the squash title floor', async () => {
    const h = harness(false);
    await seedTerminalRun(h, 'preserve-run');

    const out = await mergeRunToolHandler({
      run_id: 'preserve-run',
      merge_strategy: 'preserve',
    }, depsFor(h));

    expect(out.isError).not.toBe(true);
    expect(out.structuredContent?.status).toBe('no-changes');
  });
});
