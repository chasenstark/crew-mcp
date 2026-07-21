import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ToolHandlerDeps, ToolRequestExtra } from '../../../src/orchestrator/tools/shared.js';
import {
  criteriaDir,
  readCriteriaState,
  writeCriteriaStateAtomic,
} from '../../../src/orchestrator/criteria/store.js';
import { confirmCriteriaHandler } from '../../../src/orchestrator/tools/confirm-criteria.js';
import { continueRunToolHandler } from '../../../src/orchestrator/tools/continue-run.js';
import { createCriteriaHandler } from '../../../src/orchestrator/tools/create-criteria.js';
import { reviseCriteriaHandler } from '../../../src/orchestrator/tools/revise-criteria.js';
import {
  makeHarness,
  makeMockAdapter,
  type PanelHarness,
} from './panel-test-harness.js';
import { getDefaultConfig } from '../../../src/workflow/config-codec.js';
import type { FullConfig } from '../../../src/workflow/types.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function depsFor(h: PanelHarness, config?: FullConfig): ToolHandlerDeps {
  return {
    registry: h.ctx.registry as ToolHandlerDeps['registry'],
    worktreeManager: h.worktreeManager,
    runStateStore: h.runStateStore,
    dispatcher: h.dispatcher,
    crewHome: h.crewHome,
    projectRoot: h.root,
    getClientKind: () => 'codex',
    getCrewWaitCommand: () => 'crew-wait',
    progressTokenSeen: {
      presentLogged: false,
      absentLogged: false,
    },
    readAgentPrefs: () => ({}),
    ...(config !== undefined ? { loadWorkflowConfig: () => config } : {}),
  };
}

const extra: ToolRequestExtra = {
  sendNotification: async () => undefined,
};

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor: timeout');
}

async function createConfirmedCriteria(h: PanelHarness, id = 'criteria-1'): Promise<void> {
  createCriteriaHandler({
    criteria: [
      {
        title: 'Tests green',
        type: 'mechanical',
        detail: 'npm run test:run exits 0',
        signal: 'test output',
      },
      {
        title: 'Contract enforced',
        type: 'behavioral',
        subCriteria: ['continue_run reuses linked criteria'],
      },
      {
        title: 'No regressions',
        type: 'negative',
        detail: 'runs without criteria still work',
      },
    ],
  }, {
    crewHome: h.crewHome,
    repoRoot: h.runStateStore.repoRoot,
    makeCriteriaSetId: () => id,
  });
  await confirmCriteriaHandler({ criteria_set_id: id }, { crewHome: h.crewHome });
}

async function seedTerminalLinkedRun(h: PanelHarness, agentId = 'mock'): Promise<void> {
  await h.runStateStore.create({
    runId: 'run-1',
    agentId,
    worktreePath: h.root,
    initialPrompt: 'initial',
    readOnly: true,
    criteriaSetId: 'criteria-1',
    criteriaEpoch: 0,
  });
  await h.runStateStore.markTerminal('run-1', {
    status: 'success',
    summary: 'done',
    filesChanged: [],
  });
}

describe('continue_run criteria linkage', () => {
  it('omitted criteria_set_id reuses the recorded confirmed criteria set', async () => {
    let capturedPrompt = '';
    const h = makeHarness([makeMockAdapter({
      name: 'mock',
      execute: async (task) => {
        capturedPrompt = task.prompt;
        return {
          output: 'continued',
          filesModified: [],
          status: 'success',
          metadata: {},
        };
      },
    })]);
    cleanups.push(h.cleanup);
    await createConfirmedCriteria(h);
    await seedTerminalLinkedRun(h);
    const appendPrompt = h.runStateStore.appendPrompt.bind(h.runStateStore);
    vi.spyOn(h.runStateStore, 'appendPrompt').mockImplementation(async (runId, options) => {
      expect(readCriteriaState(criteriaDir(h.crewHome, 'criteria-1'))?.iterationContinuations)
        .toBe(1);
      return appendPrompt(runId, options);
    });

    const out = await continueRunToolHandler({
      run_id: 'run-1',
      prompt: 'next',
    }, extra, depsFor(h));

    expect(out.isError).toBeUndefined();
    await waitFor(() => h.runStateStore.read('run-1')?.prompts.length === 2);
    await waitFor(() => capturedPrompt.length > 0);
    expect(capturedPrompt.startsWith('Acceptance Criteria Contract\ncriteria_set_id: criteria-1')).toBe(true);
    expect(h.runStateStore.read('run-1')?.prompts[1].criteriaSetId).toBe('criteria-1');
    await waitFor(() => h.runStateStore.read('run-1')?.status === 'success');
  });

  it('rejects a different criteria_set_id for a linked run', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'mock' })]);
    cleanups.push(h.cleanup);
    await createConfirmedCriteria(h, 'criteria-1');
    await createConfirmedCriteria(h, 'criteria-2');
    await seedTerminalLinkedRun(h);

    const out = await continueRunToolHandler({
      run_id: 'run-1',
      prompt: 'next',
      criteria_set_id: 'criteria-2',
    }, extra, depsFor(h));

    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/^criteria\.linkage_mismatch:/);
  });

  it('refuses a linked set that was revised back to proposed', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'mock' })]);
    cleanups.push(h.cleanup);
    await createConfirmedCriteria(h);
    await seedTerminalLinkedRun(h);

    await reviseCriteriaHandler({
      criteria_set_id: 'criteria-1',
      ops: { update: [{ id: 'c2', title: 'Contract still enforced' }] },
    }, {
      crewHome: h.crewHome,
    });
    expect(readCriteriaState(criteriaDir(h.crewHome, 'criteria-1'))?.status).toBe('proposed');

    const out = await continueRunToolHandler({
      run_id: 'run-1',
      prompt: 'next',
    }, extra, depsFor(h));

    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/^criteria\.not_confirmed:/);
  });

  it('re-checks an alias-canonicalized iterate ban and allows only ban_override', async () => {
    const h = makeHarness([makeMockAdapter({
      name: 'mock',
      aliases: ['mock-alias'],
      enforcesReadOnly: true,
    })]);
    cleanups.push(h.cleanup);
    await createConfirmedCriteria(h);
    await seedTerminalLinkedRun(h);
    const config = getDefaultConfig();
    config.workflow.agentDefaults = {
      iterate: { banList: ['mock-alias'] },
      panel: { banList: [] },
    };

    const refused = await continueRunToolHandler({
      run_id: 'run-1',
      prompt: 'next',
    }, extra, depsFor(h, config));

    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/^agent_banned:/);
    expect(refused.content[0].text).toContain('run "run-1"');
    expect(refused.content[0].text).toContain('newly matching rule');
    expect(refused.content[0].text).toContain('workflow.agentDefaults.iterate.banList');
    expect(refused.content[0].text).toContain('ban_override:true');

    const accepted = await continueRunToolHandler({
      run_id: 'run-1',
      prompt: 'next',
      ban_override: true,
    }, extra, depsFor(h, config));
    expect(accepted.isError).not.toBe(true);
    expect(accepted.structuredContent?.warnings).toEqual([
      expect.stringContaining('ban_override:true was supplied'),
    ]);
    await waitFor(() => h.runStateStore.read('run-1')?.status === 'success');
  });

  it('re-checks own-host continuation and requires same_host_ok', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'codex', enforcesReadOnly: true })]);
    cleanups.push(h.cleanup);
    await createConfirmedCriteria(h);
    await seedTerminalLinkedRun(h, 'codex');
    const config = getDefaultConfig();

    const refused = await continueRunToolHandler({
      run_id: 'run-1',
      prompt: 'next',
    }, extra, depsFor(h, config));
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/^same_host_reviewer:/);
    expect(refused.content[0].text).toContain('run "run-1"');
    expect(refused.content[0].text).toContain('same_host_ok:true');

    const accepted = await continueRunToolHandler({
      run_id: 'run-1',
      prompt: 'next',
      same_host_ok: true,
    }, extra, depsFor(h, config));
    expect(accepted.isError).not.toBe(true);
    expect(accepted.structuredContent?.warnings).toEqual([
      expect.stringContaining('same_host_ok:true was supplied'),
    ]);
  });

  it('warns on the fourth epoch continuation, refuses the twelfth total, and allows cap_override', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'mock', enforcesReadOnly: true })]);
    cleanups.push(h.cleanup);
    await createConfirmedCriteria(h);
    await seedTerminalLinkedRun(h);
    const config = getDefaultConfig();
    const dir = criteriaDir(h.crewHome, 'criteria-1');
    writeCriteriaStateAtomic(dir, {
      ...readCriteriaState(dir)!,
      iterationContinuations: 3,
    });

    const warned = await continueRunToolHandler({
      run_id: 'run-1',
      prompt: 'fourth',
    }, extra, depsFor(h, config));
    expect(warned.isError).not.toBe(true);
    expect(warned.structuredContent?.warnings).toEqual([
      expect.stringContaining('criteria.iteration_continuation_warning:'),
    ]);
    await waitFor(() => h.runStateStore.read('run-1')?.status === 'success');

    writeCriteriaStateAtomic(dir, {
      ...readCriteriaState(dir)!,
      iterationContinuations: 11,
    });
    const promptCount = h.runStateStore.read('run-1')?.prompts.length;
    const refused = await continueRunToolHandler({
      run_id: 'run-1',
      prompt: 'twelfth',
    }, extra, depsFor(h, config));
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/^criteria\.iteration_continuation_cap:/);
    expect(refused.content[0].text).toContain('cap_override:true');
    expect(readCriteriaState(dir)?.iterationContinuations).toBe(12);
    expect(h.runStateStore.read('run-1')?.prompts).toHaveLength(promptCount ?? 0);

    const overridden = await continueRunToolHandler({
      run_id: 'run-1',
      prompt: 'override',
      cap_override: true,
    }, extra, depsFor(h, config));
    expect(overridden.isError).not.toBe(true);
    expect(overridden.structuredContent?.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('criteria.iteration_continuation_cap_override:'),
    ]));
    expect(readCriteriaState(dir)?.iterationContinuations).toBe(13);
  });
});
