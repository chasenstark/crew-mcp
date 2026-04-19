// Integration-level tests for the M1.5-6b flip: JudgmentRunner drives via
// SessionLoop when session + dispatcher are injected. Uses the structured
// decision adapter path (executeWithSchema) with scripted decisions, the
// same shape the M1.5 session-loop expects.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentAdapter, TaskResult } from '../../src/adapters/types.js';

function initGitRepo(dir: string): void {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@test', { cwd: dir });
  execSync('git config user.name tester', { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execSync('git add . && git commit -q -m init', { cwd: dir });
}

vi.mock('../../src/captain/steps/decompose.js', () => ({ decompose: vi.fn() }));
vi.mock('../../src/captain/steps/dispatch.js', () => ({ dispatch: vi.fn() }));
vi.mock('../../src/captain/steps/ingest.js', () => ({ ingest: vi.fn() }));
vi.mock('../../src/captain/steps/summarize.js', () => ({ summarize: vi.fn() }));
vi.mock('../../src/captain/steps/judge.js', () => ({ judge: vi.fn() }));
vi.mock('../../src/captain/steps/report.js', () => ({ report: vi.fn() }));

const { JudgmentRunner } = await import('../../src/captain/judgment-runner.js');
const { StateStore } = await import('../../src/state/store.js');
const { WorktreeManager } = await import('../../src/git/worktree.js');
const { CaptainSession } = await import('../../src/captain/session.js');
const { ToolDispatcher } = await import('../../src/captain/tool-dispatcher.js');
const { decompose } = await import('../../src/captain/steps/decompose.js');
const { dispatch } = await import('../../src/captain/steps/dispatch.js');
const { ingest } = await import('../../src/captain/steps/ingest.js');
const { summarize } = await import('../../src/captain/steps/summarize.js');
const { judge } = await import('../../src/captain/steps/judge.js');
const { report } = await import('../../src/captain/steps/report.js');

const mockDecompose = vi.mocked(decompose);
const mockDispatch = vi.mocked(dispatch);
const mockIngest = vi.mocked(ingest);
const mockSummarize = vi.mocked(summarize);
const mockJudge = vi.mocked(judge);
const mockReport = vi.mocked(report);

function singleTaskDecomposition() {
  return {
    reasoning: 'single task',
    tasks: [
      {
        id: 'task-1',
        description: 'Implement feature',
        agent: 'agent-a',
        role: 'implement' as const,
        dependencies: [],
        scope: { files: ['src/a.ts'], description: 'feature scope' },
        estimatedComplexity: 'medium' as const,
      },
    ],
    suggestedOrder: ['task-1'],
  };
}

function createDecisionAdapter(decisions: Array<Record<string, unknown>>) {
  const executeWithSchema = vi.fn(async () => {
    if (decisions.length === 0) {
      throw new Error('No more scripted decisions');
    }
    return decisions.shift();
  });
  const adapter: AgentAdapter = {
    name: 'claude-code',
    capabilities: [],
    supportsJsonSchema: true,
    execute: vi.fn(async (): Promise<TaskResult> => ({
      output: 'agent-output',
      filesModified: [],
      status: 'success',
      metadata: {},
    })),
    executeWithSchema: executeWithSchema as unknown as AgentAdapter['executeWithSchema'],
    healthCheck: vi.fn(async () => ({ available: true, authenticated: true })),
  };
  return { adapter, executeWithSchema };
}

function createAgent(name: string): AgentAdapter {
  return {
    name,
    capabilities: ['implement'],
    supportsJsonSchema: false,
    execute: vi.fn(async (): Promise<TaskResult> => ({
      output: `${name}-done`,
      filesModified: ['src/a.ts'],
      status: 'success',
      metadata: {},
    })),
    healthCheck: vi.fn(async () => ({ available: true, authenticated: true })),
  };
}

describe('JudgmentRunner session-loop integration (M1.5-6b)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'crew-jr-sl-'));
    initGitRepo(tmpRoot);
    mockDecompose.mockReset();
    mockDispatch.mockReset();
    mockIngest.mockReset();
    mockSummarize.mockReset();
    mockJudge.mockReset();
    mockReport.mockReset();
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('drives a happy-path workflow through the session-loop when session+dispatcher are injected', async () => {
    const agent = createAgent('agent-a');
    const agentRegistry = {
      get: (name: string) => (name === 'agent-a' ? agent : undefined),
      list: () => [{ name: 'agent-a', capabilities: ['implement'] }],
    };

    const { adapter: captainAdapter } = createDecisionAdapter([
      { reasoning: 'start', action: 'run_decompose', payload: {} },
      { reasoning: 'pick task', action: 'select_task', payload: {} },
      { reasoning: 'dispatch', action: 'run_dispatch', target: { taskId: 'task-1' } },
      { reasoning: 'execute', action: 'run_execute', target: { taskId: 'task-1' } },
      { reasoning: 'ingest', action: 'run_ingest', target: { taskId: 'task-1' } },
      { reasoning: 'summarize', action: 'run_summarize', target: { taskId: 'task-1' } },
      { reasoning: 'judge', action: 'run_judge', target: { taskId: 'task-1' } },
      { reasoning: 'finalize', action: 'finalize_report', payload: {} },
      { reasoning: 'done', action: 'finish', payload: {} },
    ]);

    mockDecompose.mockResolvedValue(singleTaskDecomposition());
    mockDispatch.mockResolvedValue({
      agentPrompt: 'do the thing',
      workingDirectory: undefined,
      expectedOutputs: [],
      successCriteria: 'works',
    });
    mockIngest.mockResolvedValue({
      status: 'success',
      summary: 'ok',
      needsHumanAttention: false,
      files: [],
    });
    mockSummarize.mockResolvedValue({
      passNumber: 1,
      summary: 'ok summary',
      unresolvedIssues: [],
      contextForNextPass: 'none',
      filesInScope: [],
    });
    mockJudge.mockResolvedValue({
      decision: 'done',
      reasoning: 'complete',
      isLooping: false,
    });
    mockReport.mockResolvedValue('final report');

    const stateStore = new StateStore(tmpRoot);
    const worktree = new WorktreeManager(tmpRoot);
    const session = CaptainSession.create({ projectRoot: tmpRoot });
    const dispatcher = new ToolDispatcher();

    const workflow = {
      steps: [],
      completion: { strategy: 'judge_approval' as const, fallback: 'max_passes' as const },
    } as any;

    const runner = new JudgmentRunner(
      captainAdapter,
      agentRegistry,
      workflow,
      stateStore,
      worktree,
      { session, dispatcher },
    );

    const finalReport = await runner.run('Do the thing');
    expect(finalReport).toBe('final report');

    // Session should contain: user message, then a sequence of tool_call +
    // tool_result pairs for each decision.
    const msgs = session.getMessages();
    expect(msgs[0].role).toBe('user');
    const toolCalls = msgs.filter((m) => m.role === 'tool_call');
    const toolResults = msgs.filter((m) => m.role === 'tool_result');
    expect(toolCalls.length).toBeGreaterThan(0);
    expect(toolResults.length).toBeGreaterThan(0);

    const saved = stateStore.loadState();
    expect(saved?.status).toBe('completed');
  });

  it('dispatches run_execute as a concurrent tool via the dispatcher', async () => {
    const agent = createAgent('agent-a');
    const agentRegistry = {
      get: (name: string) => (name === 'agent-a' ? agent : undefined),
      list: () => [{ name: 'agent-a', capabilities: ['implement'] }],
    };

    const { adapter: captainAdapter } = createDecisionAdapter([
      { reasoning: 'start', action: 'run_decompose', payload: {} },
      { reasoning: 'pick task', action: 'select_task', payload: {} },
      { reasoning: 'dispatch', action: 'run_dispatch', target: { taskId: 'task-1' } },
      { reasoning: 'execute', action: 'run_execute', target: { taskId: 'task-1' } },
      { reasoning: 'ingest', action: 'run_ingest', target: { taskId: 'task-1' } },
      { reasoning: 'summarize', action: 'run_summarize', target: { taskId: 'task-1' } },
      { reasoning: 'judge', action: 'run_judge', target: { taskId: 'task-1' } },
      { reasoning: 'finalize', action: 'finalize_report', payload: {} },
      { reasoning: 'done', action: 'finish', payload: {} },
    ]);

    mockDecompose.mockResolvedValue(singleTaskDecomposition());
    mockDispatch.mockResolvedValue({ agentPrompt: 'x', workingDirectory: undefined, expectedOutputs: [], successCriteria: '' });
    mockIngest.mockResolvedValue({ status: 'success', summary: 'ok', needsHumanAttention: false, files: [] });
    mockSummarize.mockResolvedValue({ passNumber: 1, summary: 'ok', unresolvedIssues: [], contextForNextPass: '', filesInScope: [] });
    mockJudge.mockResolvedValue({ decision: 'done', reasoning: 'done', isLooping: false });
    mockReport.mockResolvedValue('final report');

    const stateStore = new StateStore(tmpRoot);
    const worktree = new WorktreeManager(tmpRoot);
    const session = CaptainSession.create({ projectRoot: tmpRoot });
    const dispatcher = new ToolDispatcher();

    const dispatcherStarts: string[] = [];
    dispatcher.onEvent('run:start', (info) => dispatcherStarts.push(info.toolName));

    const workflow = { steps: [], completion: { strategy: 'judge_approval' as const, fallback: 'max_passes' as const } } as any;
    const runner = new JudgmentRunner(
      captainAdapter,
      agentRegistry,
      workflow,
      stateStore,
      worktree,
      { session, dispatcher },
    );

    await runner.run('Do it');
    // run_execute should have fired at least one dispatcher start.
    expect(dispatcherStarts).toContain('run_execute');
  });

  it('run_execute lands its worktree under .crew/runs/<runId>/worktree/ (M1.5-14 integration)', async () => {
    const agent = createAgent('agent-a');
    const agentRegistry = {
      get: (name: string) => (name === 'agent-a' ? agent : undefined),
      list: () => [{ name: 'agent-a', capabilities: ['implement'] }],
    };

    const { adapter: captainAdapter } = createDecisionAdapter([
      { reasoning: 'start', action: 'run_decompose', payload: {} },
      { reasoning: 'pick task', action: 'select_task', payload: {} },
      { reasoning: 'dispatch', action: 'run_dispatch', target: { taskId: 'task-1' } },
      { reasoning: 'execute', action: 'run_execute', target: { taskId: 'task-1' } },
      { reasoning: 'ingest', action: 'run_ingest', target: { taskId: 'task-1' } },
      { reasoning: 'summarize', action: 'run_summarize', target: { taskId: 'task-1' } },
      { reasoning: 'judge', action: 'run_judge', target: { taskId: 'task-1' } },
      { reasoning: 'finalize', action: 'finalize_report', payload: {} },
      { reasoning: 'done', action: 'finish', payload: {} },
    ]);

    mockDecompose.mockResolvedValue(singleTaskDecomposition());
    mockDispatch.mockResolvedValue({ agentPrompt: 'x', workingDirectory: undefined, expectedOutputs: [], successCriteria: '' });
    mockIngest.mockResolvedValue({ status: 'success', summary: 'ok', needsHumanAttention: false, files: [] });
    mockSummarize.mockResolvedValue({ passNumber: 1, summary: 'ok', unresolvedIssues: [], contextForNextPass: '', filesInScope: [] });
    mockJudge.mockResolvedValue({ decision: 'done', reasoning: 'done', isLooping: false });
    mockReport.mockResolvedValue('final report');

    const stateStore = new StateStore(tmpRoot);
    const worktreeManager = new WorktreeManager(tmpRoot);
    const session = CaptainSession.create({ projectRoot: tmpRoot });
    const dispatcher = new ToolDispatcher();

    // Capture working directories the agent was invoked with.
    const agentInvocationCwds: string[] = [];
    agent.execute = vi.fn(async (task) => {
      agentInvocationCwds.push(task.context.workingDirectory);
      return { output: 'done', filesModified: ['src/a.ts'], status: 'success', metadata: {} };
    });

    const workflow = { steps: [], completion: { strategy: 'judge_approval' as const, fallback: 'max_passes' as const } } as any;
    const runner = new JudgmentRunner(
      captainAdapter,
      agentRegistry,
      workflow,
      stateStore,
      worktreeManager,
      { session, dispatcher },
    );

    await runner.run('Do it');

    // The per-run worktree path should be under .crew/runs/
    expect(agentInvocationCwds.length).toBeGreaterThan(0);
    const runKeyedPattern = join(tmpRoot, '.crew', 'runs');
    expect(agentInvocationCwds[0].startsWith(runKeyedPattern)).toBe(true);
    // And NOT under the legacy .crew/worktrees/ layout.
    expect(agentInvocationCwds[0].includes('.crew/worktrees')).toBe(false);
  });

  it('concurrent run_execute dispatches get distinct worktrees', async () => {
    // Direct-test the WorktreeManager run-keyed API to document the
    // concurrent-dispatch invariant. The JudgmentRunner scheduler will
    // produce distinct subagentRunIds for distinct tasks, so distinct
    // paths fall out of the design.
    const worktreeManager = new WorktreeManager(tmpRoot);
    const [pathA, pathB] = await Promise.all([
      worktreeManager.createRunWorktree('workflow-1:task-1:0'),
      worktreeManager.createRunWorktree('workflow-1:task-2:0'),
    ]);
    expect(pathA).not.toBe(pathB);
    // Each lands under .crew/runs/<token>/worktree
    expect(pathA).toContain('/.crew/runs/');
    expect(pathB).toContain('/.crew/runs/');
  });

  it('dispatcher cleanup listener invokes cleanupByRunId on terminal events', async () => {
    const agent = createAgent('agent-a');
    const agentRegistry = {
      get: () => agent,
      list: () => [{ name: 'agent-a', capabilities: ['implement'] }],
    };

    const { adapter: captainAdapter } = createDecisionAdapter([
      { reasoning: 'start', action: 'run_decompose', payload: {} },
      { reasoning: 'pick task', action: 'select_task', payload: {} },
      { reasoning: 'dispatch', action: 'run_dispatch', target: { taskId: 'task-1' } },
      { reasoning: 'execute', action: 'run_execute', target: { taskId: 'task-1' } },
      { reasoning: 'ingest', action: 'run_ingest', target: { taskId: 'task-1' } },
      { reasoning: 'summarize', action: 'run_summarize', target: { taskId: 'task-1' } },
      { reasoning: 'judge', action: 'run_judge', target: { taskId: 'task-1' } },
      { reasoning: 'finalize', action: 'finalize_report', payload: {} },
      { reasoning: 'done', action: 'finish', payload: {} },
    ]);

    mockDecompose.mockResolvedValue(singleTaskDecomposition());
    mockDispatch.mockResolvedValue({ agentPrompt: 'x', workingDirectory: undefined, expectedOutputs: [], successCriteria: '' });
    mockIngest.mockResolvedValue({ status: 'success', summary: 'ok', needsHumanAttention: false, files: [] });
    mockSummarize.mockResolvedValue({ passNumber: 1, summary: 'ok', unresolvedIssues: [], contextForNextPass: '', filesInScope: [] });
    mockJudge.mockResolvedValue({ decision: 'done', reasoning: 'done', isLooping: false });
    mockReport.mockResolvedValue('final report');

    const stateStore = new StateStore(tmpRoot);
    const worktreeManager = new WorktreeManager(tmpRoot);
    const cleanupSpy = vi.spyOn(worktreeManager, 'cleanupByRunId');

    const session = CaptainSession.create({ projectRoot: tmpRoot });
    const dispatcher = new ToolDispatcher();
    const workflow = { steps: [], completion: { strategy: 'judge_approval' as const, fallback: 'max_passes' as const } } as any;
    const runner = new JudgmentRunner(
      captainAdapter,
      agentRegistry,
      workflow,
      stateStore,
      worktreeManager,
      { session, dispatcher },
    );

    await runner.run('Do it');

    // Cleanup should have been called for the run_execute's runId.
    expect(cleanupSpy).toHaveBeenCalled();
    const calledWith = cleanupSpy.mock.calls.map((c) => c[0]);
    expect(calledWith.some((id) => id.startsWith('workflow'))).toBe(false); // sanity
    expect(calledWith.some((id) => id.includes('task-1'))).toBe(true);
  });

  it('legacy mode (no session/dispatcher) still uses executeNativeToolLoop fallback', async () => {
    // Verifies backwards compat: pre-M1.5 constructors keep working.
    const agent = createAgent('agent-a');
    const agentRegistry = {
      get: (name: string) => (name === 'agent-a' ? agent : undefined),
      list: () => [{ name: 'agent-a', capabilities: ['implement'] }],
    };

    const { adapter: captainAdapter } = createDecisionAdapter([
      { reasoning: 'start', action: 'run_decompose', payload: {} },
      { reasoning: 'pick task', action: 'select_task', payload: {} },
      { reasoning: 'dispatch', action: 'run_dispatch', target: { taskId: 'task-1' } },
      { reasoning: 'execute', action: 'run_execute', target: { taskId: 'task-1' } },
      { reasoning: 'ingest', action: 'run_ingest', target: { taskId: 'task-1' } },
      { reasoning: 'summarize', action: 'run_summarize', target: { taskId: 'task-1' } },
      { reasoning: 'judge', action: 'run_judge', target: { taskId: 'task-1' } },
      { reasoning: 'finalize', action: 'finalize_report', payload: {} },
      { reasoning: 'done', action: 'finish', payload: {} },
    ]);

    mockDecompose.mockResolvedValue(singleTaskDecomposition());
    mockDispatch.mockResolvedValue({ agentPrompt: 'x', workingDirectory: undefined, expectedOutputs: [], successCriteria: '' });
    mockIngest.mockResolvedValue({ status: 'success', summary: 'ok', needsHumanAttention: false, files: [] });
    mockSummarize.mockResolvedValue({ passNumber: 1, summary: 'ok', unresolvedIssues: [], contextForNextPass: '', filesInScope: [] });
    mockJudge.mockResolvedValue({ decision: 'done', reasoning: 'done', isLooping: false });
    mockReport.mockResolvedValue('final report');

    const stateStore = new StateStore(tmpRoot);
    const worktree = new WorktreeManager(tmpRoot);
    const workflow = { steps: [], completion: { strategy: 'judge_approval' as const, fallback: 'max_passes' as const } } as any;
    const runner = new JudgmentRunner(
      captainAdapter,
      agentRegistry,
      workflow,
      stateStore,
      worktree,
      // No session or dispatcher — legacy path.
    );

    const final = await runner.run('Do it');
    expect(final).toBe('final report');
  });
});
