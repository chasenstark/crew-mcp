import { afterEach, describe, expect, it } from 'vitest';

import type { ToolHandlerDeps, ToolRequestExtra } from '../../../src/orchestrator/tools/shared.js';
import { criteriaDir, readCriteriaState } from '../../../src/orchestrator/criteria/store.js';
import { confirmCriteriaHandler } from '../../../src/orchestrator/tools/confirm-criteria.js';
import { continueRunToolHandler } from '../../../src/orchestrator/tools/continue-run.js';
import { createCriteriaHandler } from '../../../src/orchestrator/tools/create-criteria.js';
import { reviseCriteriaHandler } from '../../../src/orchestrator/tools/revise-criteria.js';
import {
  makeHarness,
  makeMockAdapter,
  type PanelHarness,
} from './panel-test-harness.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function depsFor(h: PanelHarness): ToolHandlerDeps {
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

async function seedTerminalLinkedRun(h: PanelHarness): Promise<void> {
  await h.runStateStore.create({
    runId: 'run-1',
    agentId: 'mock',
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
});
