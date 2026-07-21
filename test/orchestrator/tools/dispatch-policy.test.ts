import { afterEach, describe, expect, it } from 'vitest';

import { getDefaultConfig } from '../../../src/workflow/config-codec.js';
import { confirmCriteriaHandler } from '../../../src/orchestrator/tools/confirm-criteria.js';
import { createCriteriaHandler } from '../../../src/orchestrator/tools/create-criteria.js';
import { runAgentToolHandler } from '../../../src/orchestrator/tools/run-agent.js';
import type { ToolHandlerDeps, ToolRequestExtra } from '../../../src/orchestrator/tools/shared.js';
import {
  makeHarness,
  makeMockAdapter,
  type PanelHarness,
  waitFor,
} from './panel-test-harness.js';

const cleanups: Array<() => void> = [];
const extra: ToolRequestExtra = { sendNotification: async () => undefined };

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function depsFor(
  h: PanelHarness,
  loadWorkflowConfig: NonNullable<ToolHandlerDeps['loadWorkflowConfig']>,
  client: 'codex' | 'claude-code' = 'codex',
): ToolHandlerDeps {
  return {
    registry: h.ctx.registry as ToolHandlerDeps['registry'],
    worktreeManager: h.worktreeManager,
    runStateStore: h.runStateStore,
    dispatcher: h.dispatcher,
    crewHome: h.crewHome,
    projectRoot: h.root,
    getClientKind: () => client,
    getCrewWaitCommand: () => undefined,
    progressTokenSeen: { presentLogged: false, absentLogged: false },
    readAgentPrefs: () => ({}),
    loadWorkflowConfig,
  };
}

async function createConfirmedCriteria(h: PanelHarness): Promise<void> {
  createCriteriaHandler({
    criteria: [{
      title: 'Dispatch policy enforced',
      type: 'behavioral',
      detail: 'criteria-linked dispatch honors iterate preferences',
    }],
  }, {
    crewHome: h.crewHome,
    repoRoot: h.runStateStore.repoRoot,
    makeCriteriaSetId: () => 'criteria-1',
  });
  await confirmCriteriaHandler({ criteria_set_id: 'criteria-1' }, { crewHome: h.crewHome });
}

describe('run_agent dispatch policy', () => {
  it('canonicalizes aliases and refuses an unlinked agent banned in either scope', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'claude-code', aliases: ['claude'] })]);
    cleanups.push(h.cleanup);
    const config = getDefaultConfig();
    config.workflow.agentDefaults = { panel: { banList: ['claude'] } };

    const out = await runAgentToolHandler({
      agent_id: 'claude-code',
      prompt: 'review',
    }, extra, depsFor(h, () => config));

    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/^agent_banned:/);
    expect(out.content[0].text).toContain('workflow.agentDefaults.panel.banList');
    expect(out.content[0].text).toContain('ban_override:true');
  });

  it('allows a banned agent only with ban_override and journals the warning', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer', aliases: ['review-alias'] })]);
    cleanups.push(h.cleanup);
    const config = getDefaultConfig();
    config.workflow.agentDefaults = { iterate: { banList: ['reviewer'] } };

    const out = await runAgentToolHandler({
      agent_id: 'review-alias',
      prompt: 'review',
      ban_override: true,
    }, extra, depsFor(h, () => config));

    expect(out.isError).not.toBe(true);
    expect(out.structuredContent?.warnings).toEqual([
      expect.stringContaining('ban_override:true was supplied'),
    ]);
    const runId = out.structuredContent?.run_id as string;
    await waitFor(() => h.runStateStore.read(runId)?.status === 'success');
    expect(h.runStateStore.read(runId)?.agentId).toBe('reviewer');
  });

  it('uses only iterate.banList for a criteria-linked run_agent after alias canonicalization', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer', aliases: ['review-alias'] })]);
    cleanups.push(h.cleanup);
    await createConfirmedCriteria(h);
    const config = getDefaultConfig();
    config.workflow.agentDefaults = {
      iterate: { banList: ['review-alias'] },
      panel: { banList: [] },
    };
    const deps = depsFor(h, () => config);

    const refused = await runAgentToolHandler({
      agent_id: 'reviewer',
      prompt: 'implement',
      criteria_set_id: 'criteria-1',
    }, extra, deps);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('workflow.agentDefaults.iterate.banList');

    config.workflow.agentDefaults = {
      iterate: { banList: [] },
      panel: { banList: ['reviewer'] },
    };
    const accepted = await runAgentToolHandler({
      agent_id: 'review-alias',
      prompt: 'implement',
      criteria_set_id: 'criteria-1',
    }, extra, deps);
    expect(accepted.isError, accepted.content[0].text).not.toBe(true);
    expect(accepted.content[0].text).toContain('**Dispatched** `reviewer`');
    const runId = accepted.structuredContent?.run_id as string;
    await waitFor(() => h.runStateStore.read(runId)?.status === 'success');
  });

  it('requires same_host_ok for own-host run_agent and warns when overridden', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'codex', aliases: ['codex-cli'] })]);
    cleanups.push(h.cleanup);
    const config = getDefaultConfig();
    const deps = depsFor(h, () => config);

    const refused = await runAgentToolHandler({
      agent_id: 'codex-cli',
      prompt: 'implement',
    }, extra, deps);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/^same_host_reviewer:/);
    expect(refused.content[0].text).toContain('same_host_ok:true');

    const accepted = await runAgentToolHandler({
      agent_id: 'codex-cli',
      prompt: 'implement',
      same_host_ok: true,
    }, extra, deps);
    expect(accepted.isError).not.toBe(true);
    expect(accepted.structuredContent?.warnings).toEqual([
      expect.stringContaining('same_host_ok:true was supplied'),
    ]);
    expect(accepted.content[0].text).toContain('**Dispatched** `codex`');
  });
});
