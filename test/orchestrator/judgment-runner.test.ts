import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AgentAdapter, TaskResult } from '../../src/adapters/types.js';
import { StateStore } from '../../src/state/store.js';
import type { WorkflowState } from '../../src/state/types.js';

vi.mock('../../src/orchestrator/steps/decompose.js', () => ({
  decompose: vi.fn(),
}));
vi.mock('../../src/orchestrator/steps/dispatch.js', () => ({
  dispatch: vi.fn(),
}));
vi.mock('../../src/orchestrator/steps/ingest.js', () => ({
  ingest: vi.fn(),
}));
vi.mock('../../src/orchestrator/steps/summarize.js', () => ({
  summarize: vi.fn(),
}));
vi.mock('../../src/orchestrator/steps/judge.js', () => ({
  judge: vi.fn(),
}));
vi.mock('../../src/orchestrator/steps/report.js', () => ({
  report: vi.fn(),
}));

const { JudgmentRunner } = await import('../../src/orchestrator/judgment-runner.js');
const { decompose } = await import('../../src/orchestrator/steps/decompose.js');
const { dispatch } = await import('../../src/orchestrator/steps/dispatch.js');
const { ingest } = await import('../../src/orchestrator/steps/ingest.js');
const { summarize } = await import('../../src/orchestrator/steps/summarize.js');
const { judge } = await import('../../src/orchestrator/steps/judge.js');
const { report } = await import('../../src/orchestrator/steps/report.js');

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
    name: 'orchestrator',
    capabilities: ['analyze'],
    supportsJsonSchema: true,
    orchestratorCapabilities: {
      supportsToolLoop: false,
      supportsStructuredDecisions: true,
      supportsPauseForUserInput: false,
    },
    execute: vi.fn(),
    executeWithSchema,
    healthCheck: vi.fn(),
  };

  return { adapter, executeWithSchema };
}

function createToolLoopAdapter(
  toolCalls: Array<{ name: string; input?: Record<string, unknown> }>,
  options?: { supportsPauseForUserInput?: boolean },
) {
  const executeWithTools = vi.fn(async (_tools, messages, onToolCall) => {
    const transcript = [...messages];
    for (const toolCall of toolCalls) {
      await onToolCall({ name: toolCall.name, input: toolCall.input ?? {} });
      transcript.push({
        role: 'assistant',
        content: `called ${toolCall.name}`,
      });
    }
    return {
      status: 'completed' as const,
      transcript,
      output: 'done',
    };
  });

  const adapter: AgentAdapter = {
    name: 'orchestrator',
    capabilities: ['analyze'],
    supportsJsonSchema: true,
    orchestratorCapabilities: {
      supportsToolLoop: true,
      supportsStructuredDecisions: true,
      supportsPauseForUserInput: options?.supportsPauseForUserInput ?? true,
    },
    execute: vi.fn(),
    executeWithSchema: vi.fn(),
    executeWithTools,
    healthCheck: vi.fn(),
  };

  return { adapter, executeWithTools };
}

function createAgentRegistry(agentExecute: ReturnType<typeof vi.fn>) {
  return {
    get: vi.fn((name: string) => {
      if (name !== 'agent-a') return undefined;
      return {
        name: 'agent-a',
        capabilities: ['implement'],
        supportsJsonSchema: false,
        orchestratorCapabilities: {
          supportsToolLoop: false,
          supportsStructuredDecisions: true,
          supportsPauseForUserInput: false,
        },
        execute: agentExecute,
        healthCheck: vi.fn(),
      } as AgentAdapter;
    }),
    list: vi.fn(() => [{ name: 'agent-a', capabilities: ['implement'] }]),
  };
}

describe('JudgmentRunner', () => {
  let tmpDir: string;
  let stateStore: StateStore;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), 'orchestrator-judgment-test-'));
    stateStore = new StateStore(tmpDir);

    mockDecompose.mockResolvedValue(singleTaskDecomposition());
    mockDispatch.mockResolvedValue({
      agentPrompt: 'do task',
      workingDirectory: '/tmp/workdir',
      expectedOutputs: ['src/a.ts'],
      successCriteria: 'tests pass',
    });
    mockIngest.mockResolvedValue({
      status: 'success',
      summary: 'ingested',
      filesModified: [],
      decisions: [],
      concerns: [],
      needsHumanAttention: false,
      reviewFindings: [],
    });
    mockSummarize.mockResolvedValue({
      passNumber: 1,
      summary: 'summary',
      unresolvedIssues: [],
      contextForNextPass: 'none',
      filesInScope: ['src/a.ts'],
    });
    mockJudge.mockResolvedValue({
      decision: 'done',
      reasoning: 'complete',
      isLooping: false,
    });
    mockReport.mockResolvedValue('final report');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('executes a scripted judgment-mode workflow and persists schemaVersion 2 state', async () => {
    const { adapter } = createDecisionAdapter([
      { reasoning: 'start', action: 'run_decompose', payload: {} },
      { reasoning: 'pick task', action: 'select_task', payload: { taskId: 'task-1' } },
      { reasoning: 'prep prompt', action: 'run_dispatch', payload: { taskId: 'task-1' } },
      { reasoning: 'execute', action: 'run_execute', payload: { taskId: 'task-1' } },
      { reasoning: 'ingest', action: 'run_ingest', payload: { taskId: 'task-1' } },
      { reasoning: 'summarize', action: 'run_summarize', payload: { taskId: 'task-1' } },
      { reasoning: 'judge', action: 'run_judge', payload: { taskId: 'task-1' } },
      { reasoning: 'report', action: 'finalize_report', payload: {} },
      { reasoning: 'finish', action: 'finish' },
    ]);

    const agentExecute = vi.fn().mockResolvedValue({
      output: 'done',
      filesModified: ['src/a.ts'],
      status: 'success',
      metadata: {},
    } satisfies TaskResult);

    const registry = createAgentRegistry(agentExecute);
    const worktreeManager = {
      createWorktree: vi.fn(async () => '/tmp/worktrees/task-1'),
      getModifiedFiles: vi.fn(async () => ['src/a.ts']),
    };

    const runner = new JudgmentRunner(
      adapter,
      registry,
      {
        name: 'judgment-test',
        execution: { mode: 'judgment' },
        steps: [{ role: 'implement', agent: 'agent-a', action: 'implement', maxPasses: 3 }],
        completion: { strategy: 'judge_approval', fallback: 'max_passes' },
      },
      stateStore,
      worktreeManager as never,
      {
        orchestratorModel: 'gpt-5.4',
        agentModels: { 'agent-a': 'gpt-5.3-codex' },
      },
    );

    const reportText = await runner.run('implement feature');
    expect(reportText).toBe('final report');
    expect(agentExecute).toHaveBeenCalledTimes(1);

    const saved = stateStore.loadState() as WorkflowState;
    expect(saved.status).toBe('completed');
    expect(saved.schemaVersion).toBe(2);
    expect(saved.executionMode).toBe('judgment');
    expect(saved.actionHistory?.some((record) => record.action === 'finalize_report')).toBe(true);
  });

  it('rehydrates action history on resume without re-running already executed agent calls', async () => {
    const { adapter } = createDecisionAdapter([
      { reasoning: 'ingest after resume', action: 'run_ingest', payload: { taskId: 'task-1' } },
      { reasoning: 'summarize', action: 'run_summarize', payload: { taskId: 'task-1' } },
      { reasoning: 'judge', action: 'run_judge', payload: { taskId: 'task-1' } },
      { reasoning: 'report', action: 'finalize_report', payload: {} },
      { reasoning: 'finish', action: 'finish' },
    ]);

    const agentExecute = vi.fn().mockResolvedValue({
      output: 'done',
      filesModified: ['src/a.ts'],
      status: 'success',
      metadata: {},
    } satisfies TaskResult);

    const registry = createAgentRegistry(agentExecute);
    const worktreeManager = {
      createWorktree: vi.fn(async () => '/tmp/worktrees/task-1'),
      getModifiedFiles: vi.fn(async () => ['src/a.ts']),
    };

    const runner = new JudgmentRunner(
      adapter,
      registry,
      {
        name: 'judgment-test',
        execution: { mode: 'judgment' },
        steps: [{ role: 'implement', agent: 'agent-a', action: 'implement', maxPasses: 3 }],
        completion: { strategy: 'judge_approval', fallback: 'max_passes' },
      },
      stateStore,
      worktreeManager as never,
    );

    const decomposition = singleTaskDecomposition();
    const savedState: WorkflowState = {
      schemaVersion: 2,
      executionMode: 'judgment',
      runId: 'run-resume',
      status: 'interrupted',
      userRequest: 'implement feature',
      decomposition,
      currentTaskIndex: 0,
      passes: [],
      actionHistory: [
        {
          sequence: 1,
          action: 'run_decompose',
          payload: {},
          result: { status: 'success', data: decomposition },
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          pathTaken: 'fallback',
        },
        {
          sequence: 2,
          action: 'select_task',
          payload: { taskId: 'task-1' },
          target: { taskId: 'task-1' },
          result: { status: 'success', data: { taskId: 'task-1' } },
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          pathTaken: 'fallback',
        },
        {
          sequence: 3,
          action: 'run_dispatch',
          payload: { taskId: 'task-1' },
          target: { taskId: 'task-1' },
          result: {
            status: 'success',
            data: {
              taskId: 'task-1',
              dispatch: {
                agentPrompt: 'do task',
                workingDirectory: '/tmp/workdir',
                expectedOutputs: ['src/a.ts'],
                successCriteria: 'tests pass',
              },
            },
          },
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          pathTaken: 'fallback',
        },
        {
          sequence: 4,
          action: 'run_execute',
          payload: { taskId: 'task-1' },
          target: { taskId: 'task-1' },
          result: {
            status: 'success',
            data: {
              taskId: 'task-1',
              agentResult: {
                output: 'done',
                filesModified: ['src/a.ts'],
                status: 'success',
                metadata: {},
              },
            },
          },
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          pathTaken: 'fallback',
        },
      ],
      startedAt: new Date().toISOString(),
    };

    const result = await runner.resume({
      workflowState: savedState,
      previousSummaries: [],
    });

    expect(result).toBe('final report');
    expect(agentExecute).not.toHaveBeenCalled();
    expect(mockIngest).toHaveBeenCalledTimes(1);
  });

  it('uses native tool-loop path when adapter supports executeWithTools', async () => {
    const { adapter, executeWithTools } = createToolLoopAdapter([
      { name: 'run_decompose' },
      { name: 'select_task', input: { taskId: 'task-1' } },
      { name: 'run_dispatch', input: { taskId: 'task-1' } },
      { name: 'run_execute', input: { taskId: 'task-1' } },
      { name: 'run_ingest', input: { taskId: 'task-1' } },
      { name: 'run_summarize', input: { taskId: 'task-1' } },
      { name: 'run_judge', input: { taskId: 'task-1' } },
      { name: 'finalize_report' },
    ]);

    const agentExecute = vi.fn().mockResolvedValue({
      output: 'done',
      filesModified: ['src/a.ts'],
      status: 'success',
      metadata: {},
    } satisfies TaskResult);

    const registry = createAgentRegistry(agentExecute);
    const worktreeManager = {
      createWorktree: vi.fn(async () => '/tmp/worktrees/task-1'),
      getModifiedFiles: vi.fn(async () => ['src/a.ts']),
    };

    const runner = new JudgmentRunner(
      adapter,
      registry,
      {
        name: 'judgment-test',
        execution: { mode: 'judgment' },
        steps: [{ role: 'implement', agent: 'agent-a', action: 'implement', maxPasses: 3 }],
        completion: { strategy: 'judge_approval', fallback: 'max_passes' },
      },
      stateStore,
      worktreeManager as never,
    );

    const result = await runner.run('implement feature');
    expect(result).toBe('final report');
    expect(executeWithTools).toHaveBeenCalledTimes(1);

    const saved = stateStore.loadState() as WorkflowState;
    expect(saved.actionHistory?.length).toBeGreaterThan(0);
    expect(saved.actionHistory?.every((record) => record.pathTaken === 'adapter')).toBe(true);
    expect(saved.nativeToolCalls).toBe(8);
  });

  it('auto-finalizes report when native tool-loop completes early', async () => {
    const { adapter, executeWithTools } = createToolLoopAdapter([
      { name: 'run_decompose' },
      { name: 'select_task', input: { taskId: 'task-1' } },
      { name: 'run_dispatch', input: { taskId: 'task-1' } },
      { name: 'run_execute', input: { taskId: 'task-1' } },
      { name: 'run_ingest', input: { taskId: 'task-1' } },
      { name: 'run_summarize', input: { taskId: 'task-1' } },
      { name: 'run_judge', input: { taskId: 'task-1' } },
    ]);

    const agentExecute = vi.fn().mockResolvedValue({
      output: 'done',
      filesModified: ['src/a.ts'],
      status: 'success',
      metadata: {},
    } satisfies TaskResult);

    const registry = createAgentRegistry(agentExecute);
    const worktreeManager = {
      createWorktree: vi.fn(async () => '/tmp/worktrees/task-1'),
      getModifiedFiles: vi.fn(async () => ['src/a.ts']),
    };

    const runner = new JudgmentRunner(
      adapter,
      registry,
      {
        name: 'judgment-test',
        execution: { mode: 'judgment' },
        steps: [{ role: 'implement', agent: 'agent-a', action: 'implement', maxPasses: 3 }],
        completion: { strategy: 'judge_approval', fallback: 'max_passes' },
      },
      stateStore,
      worktreeManager as never,
    );

    const result = await runner.run('implement feature');
    expect(result).toBe('final report');
    expect(executeWithTools).toHaveBeenCalledTimes(1);

    const saved = stateStore.loadState() as WorkflowState;
    expect(saved.actionHistory?.some((record) => record.action === 'finalize_report')).toBe(true);
    expect(saved.actionHistory?.at(-1)?.action).toBe('finalize_report');
    expect(saved.actionHistory?.at(-1)?.pathTaken).toBe('fallback');
    expect(saved.nativeToolCalls).toBe(7);
  });
});
