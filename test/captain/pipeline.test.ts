import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, TaskResult } from '../../src/adapters/types.js';
import type { PassSummary, WorkflowState } from '../../src/state/types.js';
import { ModelId } from '../../src/workflow/models.js';

vi.mock('../../src/captain/steps/decompose.js', () => ({
  decompose: vi.fn(),
}));

vi.mock('../../src/captain/steps/dispatch.js', () => ({
  dispatch: vi.fn(),
}));

vi.mock('../../src/captain/steps/ingest.js', () => ({
  ingest: vi.fn(),
}));

vi.mock('../../src/captain/steps/summarize.js', () => ({
  summarize: vi.fn(),
}));

vi.mock('../../src/captain/steps/judge.js', () => ({
  judge: vi.fn(),
}));

vi.mock('../../src/captain/steps/report.js', () => ({
  report: vi.fn(),
}));

const { Pipeline } = await import('../../src/captain/pipeline.js');
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

function createHarness(workflowOverride?: {
  name: string;
  steps: Array<{ role: string; agent: string; action: string; maxPasses?: number }>;
  roleModels?: Record<string, string>;
  completion: { strategy: string; fallback: string };
}, runtimeModelOptions?: {
  captainModel?: string;
  agentModels?: Record<string, string | undefined>;
}) {
  const agentExecute = vi.fn<AgentAdapter['execute']>().mockResolvedValue({
    output: 'agent output',
    filesModified: [],
    status: 'success',
    metadata: {},
  } as TaskResult);

  const captain = {
    name: 'captain',
    capabilities: ['analyze'],
    supportsJsonSchema: true,
    execute: vi.fn(),
    healthCheck: vi.fn(),
  } as unknown as AgentAdapter;

  const registry = {
    get: vi.fn((name: string) => {
      if (name === 'agent-a' || name === 'agent-b') {
        return {
          name,
          capabilities: ['implement'],
          supportsJsonSchema: false,
          execute: agentExecute,
          healthCheck: vi.fn(),
        } as unknown as AgentAdapter;
      }
      return undefined;
    }),
    list: vi.fn(() => [
      { name: 'agent-a', capabilities: ['implement'] },
      { name: 'agent-b', capabilities: ['review'] },
    ]),
  };

  let latestState: WorkflowState | null = null;
  const state = {
    saveState: vi.fn((next: WorkflowState) => {
      latestState = next;
    }),
    addPassSummary: vi.fn(),
    addPassOutput: vi.fn(),
    loadState: vi.fn(() => latestState),
  };

  const worktreeManager = {
    createWorktree: vi.fn(async (taskId: string) => `/tmp/worktrees/${taskId}`),
    getModifiedFiles: vi.fn(async () => []),
  };

  const pipeline = new Pipeline(
    captain,
    registry,
    workflowOverride ?? {
      name: 'test',
      steps: [{ role: 'implement', agent: 'agent-a', action: 'implement', maxPasses: 3 }],
      completion: { strategy: 'judge_approval', fallback: 'max_passes' },
    },
    state as never,
    worktreeManager as never,
    runtimeModelOptions,
  );

  return { pipeline, state, agentExecute, worktreeManager };
}

function defaultDecomposition() {
  return {
    reasoning: 'split into one task',
    tasks: [
      {
        id: 'task-1',
        description: 'Implement feature',
        agent: 'agent-a',
        role: 'implement' as const,
        dependencies: [],
        scope: { files: ['src/a.ts'], description: 'feature file' },
        estimatedComplexity: 'medium' as const,
      },
    ],
    suggestedOrder: ['task-1'],
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  mockDecompose.mockResolvedValue(defaultDecomposition());
  mockDispatch.mockResolvedValue({
    agentPrompt: 'do task',
    workingDirectory: '/tmp/project',
    expectedOutputs: ['src/a.ts'],
    successCriteria: 'tests pass',
  });
  mockIngest.mockResolvedValue({
    status: 'success',
    summary: 'agent finished',
    filesModified: [],
    decisions: [],
    concerns: [],
    needsHumanAttention: false,
    reviewFindings: [],
  });
  mockSummarize.mockImplementation(async (_o, _ingest, passNumber) => ({
    passNumber,
    summary: `summary ${passNumber}`,
    unresolvedIssues: [],
    contextForNextPass: 'continue',
    filesInScope: ['src/a.ts'],
  }));
  mockJudge.mockResolvedValue({
    decision: 'done',
    reasoning: 'all good',
    isLooping: false,
  });
  mockReport.mockResolvedValue('final report');
});

describe('Pipeline', () => {
  it('emits agent:output events when the adapter streams chunks', async () => {
    const { pipeline } = createHarness();

    // Override the adapter's execute to simulate streaming chunks
    const registry = (pipeline as unknown as { registry: { get: (n: string) => AgentAdapter } }).registry;
    const originalGet = registry.get.bind(registry);
    registry.get = (name: string) => {
      const adapter = originalGet(name);
      if (!adapter) return adapter;
      return {
        ...adapter,
        execute: vi.fn(async (task) => {
          task.onOutput?.('hello ');
          task.onOutput?.('world');
          return { output: 'done', filesModified: [], status: 'success', metadata: {} } as TaskResult;
        }),
      } as AgentAdapter;
    };

    const chunks: Array<{ agent: string; taskId: string; chunk: string }> = [];
    pipeline.on('agent:output', (agent, taskId, chunk) => {
      chunks.push({ agent, taskId, chunk });
    });

    await pipeline.run('Build thing');

    expect(chunks).toEqual([
      { agent: 'agent-a', taskId: 'task-1', chunk: 'hello ' },
      { agent: 'agent-a', taskId: 'task-1', chunk: 'world' },
    ]);
  });

  it('runs happy path with done decision', async () => {
    const { pipeline, state, agentExecute, worktreeManager } = createHarness();

    const result = await pipeline.run('Build thing');

    expect(result).toBe('final report');
    expect(mockDecompose).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(agentExecute).toHaveBeenCalledTimes(1);
    expect(worktreeManager.createWorktree).toHaveBeenCalledWith('task-1');
    expect(mockJudge).toHaveBeenCalledTimes(1);
    expect(mockReport).toHaveBeenCalledTimes(1);

    const finalState = state.saveState.mock.calls.at(-1)?.[0] as WorkflowState;
    expect(finalState.status).toBe('completed');
    expect(finalState.currentTaskIndex).toBe(1);
  });

  it('iterates when judge requests iterate', async () => {
    const { pipeline, agentExecute, worktreeManager } = createHarness();

    mockJudge
      .mockResolvedValueOnce({
        decision: 'iterate',
        reasoning: 'needs another pass',
        isLooping: false,
      })
      .mockResolvedValueOnce({
        decision: 'done',
        reasoning: 'resolved',
        isLooping: false,
      });

    await pipeline.run('Build thing');

    expect(mockDispatch).toHaveBeenCalledTimes(2);
    expect(agentExecute).toHaveBeenCalledTimes(2);
    expect(worktreeManager.createWorktree).toHaveBeenCalledTimes(1);
    expect(mockJudge).toHaveBeenCalledTimes(2);
  });

  it('applies maxPasses from reviewer role alias for review tasks', async () => {
    const { pipeline, agentExecute } = createHarness({
      name: 'alias-test',
      steps: [{ role: 'reviewer', agent: 'agent-a', action: 'review', maxPasses: 1 }],
      completion: { strategy: 'judge_approval', fallback: 'max_passes' },
    });

    mockDecompose.mockResolvedValue({
      reasoning: 'one review task',
      tasks: [
        {
          id: 'task-1',
          description: 'Review implementation',
          agent: 'agent-a',
          role: 'review' as const,
          dependencies: [],
          scope: { files: ['src/a.ts'], description: 'review scope' },
          estimatedComplexity: 'low' as const,
        },
      ],
      suggestedOrder: ['task-1'],
    });

    mockJudge.mockResolvedValue({
      decision: 'iterate',
      reasoning: 'needs another pass',
      isLooping: false,
    });

    await pipeline.run('Review thing');

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(agentExecute).toHaveBeenCalledTimes(1);
  });

  it('constrains dispatched workingDirectory to task worktree', async () => {
    const { pipeline, agentExecute } = createHarness();
    mockDispatch.mockResolvedValueOnce({
      agentPrompt: 'do task',
      workingDirectory: '/tmp/outside-worktree',
      expectedOutputs: ['src/a.ts'],
      successCriteria: 'tests pass',
    });

    await pipeline.run('Build thing');

    const executeCall = agentExecute.mock.calls[0]?.[0];
    expect(executeCall.context.workingDirectory).toBe('/tmp/worktrees/task-1');
  });

  it('uses roleModels.<task role> before agent model', async () => {
    const { pipeline, agentExecute } = createHarness({
      name: 'role-model-direct',
      steps: [{ role: 'reviewer', agent: 'agent-a', action: 'review' }],
      roleModels: { review: ModelId.GPT_MINI },
      completion: { strategy: 'judge_approval', fallback: 'max_passes' },
    }, {
      agentModels: { 'agent-a': 'fallback-agent-model' },
    });

    mockDecompose.mockResolvedValue({
      reasoning: 'review task',
      tasks: [
        {
          id: 'task-1',
          description: 'Review implementation',
          agent: 'agent-a',
          role: 'review' as const,
          dependencies: [],
          scope: { files: ['src/a.ts'], description: 'review scope' },
          estimatedComplexity: 'low' as const,
        },
      ],
      suggestedOrder: ['task-1'],
    });

    await pipeline.run('Review thing');

    const executeCall = agentExecute.mock.calls[0]?.[0];
    expect(executeCall.constraints?.model).toBe(ModelId.GPT_MINI);
  });

  it('uses roleModels.<step role> when task role matches workflow action', async () => {
    const { pipeline, agentExecute } = createHarness({
      name: 'role-model-action-alias',
      steps: [{ role: 'reviewer', agent: 'agent-a', action: 'review' }],
      roleModels: { reviewer: ModelId.GPT },
      completion: { strategy: 'judge_approval', fallback: 'max_passes' },
    }, {
      agentModels: { 'agent-a': 'fallback-agent-model' },
    });

    mockDecompose.mockResolvedValue({
      reasoning: 'review task',
      tasks: [
        {
          id: 'task-1',
          description: 'Review implementation',
          agent: 'agent-a',
          role: 'review' as const,
          dependencies: [],
          scope: { files: ['src/a.ts'], description: 'review scope' },
          estimatedComplexity: 'low' as const,
        },
      ],
      suggestedOrder: ['task-1'],
    });

    await pipeline.run('Review thing');

    const executeCall = agentExecute.mock.calls[0]?.[0];
    expect(executeCall.constraints?.model).toBe(ModelId.GPT);
  });

  it('uses workflow judge role model for judge step', async () => {
    const { pipeline } = createHarness({
      name: 'judge-role-model',
      steps: [{ role: 'implement', agent: 'agent-a', action: 'implement', maxPasses: 3 }],
      roleModels: { judge: ModelId.GPT },
      completion: { strategy: 'judge_approval', fallback: 'max_passes' },
    }, {
      captainModel: ModelId.CLAUDE_SONNET,
    });

    await pipeline.run('Build thing');

    const judgeModelArg = mockJudge.mock.calls[0]?.[5];
    expect(judgeModelArg).toBe(ModelId.GPT);
  });

  it('requests user input when judge asks user and resumes with response', async () => {
    const { pipeline } = createHarness();
    const questions: string[] = [];

    pipeline.on('ask_user', (question) => {
      questions.push(question);
      pipeline.provideUserInput('Use stricter validation');
    });

    mockJudge
      .mockResolvedValueOnce({
        decision: 'ask_user',
        reasoning: 'Need requirement clarification',
        questionForUser: 'Should we fail closed?',
        isLooping: false,
      })
      .mockResolvedValueOnce({
        decision: 'done',
        reasoning: 'clarified',
        isLooping: false,
      });

    await pipeline.run('Build thing');

    expect(questions).toEqual(['Should we fail closed?']);
    const secondDispatchSummaries = mockDispatch.mock.calls[1]?.[2] as PassSummary[];
    expect(secondDispatchSummaries.some((s) => s.contextForNextPass === 'Use stricter validation')).toBe(true);
  });

  it('skips dependent tasks when dependency fails', async () => {
    const { pipeline, state } = createHarness();

    mockDecompose.mockResolvedValue({
      reasoning: 'two tasks',
      tasks: [
        {
          id: 'task-1',
          description: 'first',
          agent: 'agent-a',
          role: 'implement' as const,
          dependencies: [],
          scope: { files: ['src/a.ts'], description: 'a' },
          estimatedComplexity: 'low' as const,
        },
        {
          id: 'task-2',
          description: 'second',
          agent: 'agent-b',
          role: 'implement' as const,
          dependencies: ['task-1'],
          scope: { files: ['src/b.ts'], description: 'b' },
          estimatedComplexity: 'low' as const,
        },
      ],
      suggestedOrder: ['task-1', 'task-2'],
    });

    mockDispatch.mockRejectedValueOnce(new Error('dispatch failed'));

    await pipeline.run('Build thing');

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const summariesArg = mockReport.mock.calls[0]?.[1] as PassSummary[];
    expect(summariesArg.some((s) => s.summary.includes('failed'))).toBe(true);
    expect(summariesArg.some((s) => s.summary.includes('skipped'))).toBe(true);

    const finalState = state.saveState.mock.calls.at(-1)?.[0] as WorkflowState;
    expect(finalState.status).toBe('failed');
  });

  it('falls back to basic report when report step fails', async () => {
    const { pipeline, state } = createHarness();
    mockReport.mockRejectedValueOnce(new Error('report exploded'));

    const result = await pipeline.run('Build thing');

    expect(result).toContain('# Workflow Report');
    expect(result).toContain('**Request:** Build thing');

    const finalState = state.saveState.mock.calls.at(-1)?.[0] as WorkflowState;
    expect(finalState.status).toBe('failed');
  });

  it('resumes from saved state without re-running decompose', async () => {
    const { pipeline, state, agentExecute } = createHarness();

    mockDecompose.mockResolvedValue({
      reasoning: 'unused for resume',
      tasks: [],
      suggestedOrder: [],
    });

    await pipeline.resume({
      workflowState: {
        status: 'interrupted',
        userRequest: 'Build thing',
        decomposition: {
          reasoning: 'two tasks',
          tasks: [
            {
              id: 'task-1',
              description: 'first',
              agent: 'agent-a',
              role: 'implement',
              dependencies: [],
              scope: { files: ['src/a.ts'], description: 'a' },
              estimatedComplexity: 'low',
            },
            {
              id: 'task-2',
              description: 'second',
              agent: 'agent-b',
              role: 'implement',
              dependencies: [],
              scope: { files: ['src/b.ts'], description: 'b' },
              estimatedComplexity: 'low',
            },
          ],
          suggestedOrder: ['task-1', 'task-2'],
        },
        currentTaskIndex: 1,
        passes: [],
        startedAt: '2026-01-01T00:00:00.000Z',
      },
      previousSummaries: [
        {
          passNumber: 3,
          summary: 'task 1 done',
          unresolvedIssues: [],
          contextForNextPass: 'ready',
          filesInScope: ['src/a.ts'],
        },
      ],
    });

    expect(mockDecompose).toHaveBeenCalledTimes(0);
    expect(agentExecute).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(state.addPassOutput).toHaveBeenCalledWith(4, expect.anything(), expect.any(String));
  });

  it('marks running state as interrupted', () => {
    const { pipeline, state } = createHarness();
    state.saveState({
      status: 'running',
      userRequest: 'Build thing',
      decomposition: defaultDecomposition(),
      currentTaskIndex: 0,
      passes: [],
    });

    pipeline.markInterrupted('Interrupted by test');

    expect(state.saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'interrupted',
        lastError: 'Interrupted by test',
      }),
    );
  });

  it('exits gracefully as interrupted when cancelled while waiting for user input', async () => {
    const { pipeline, state } = createHarness();

    mockJudge.mockResolvedValueOnce({
      decision: 'ask_user',
      reasoning: 'Need clarification',
      questionForUser: 'Choose one?',
      isLooping: false,
    });

    pipeline.on('ask_user', () => {
      pipeline.cancel('Cancelled during question');
    });

    const result = await pipeline.run('Build thing');

    expect(result).toBe('Workflow interrupted.');
    expect(mockReport).not.toHaveBeenCalled();

    const finalState = state.loadState() as WorkflowState;
    expect(finalState.status).toBe('interrupted');
    expect(finalState.lastError).toBe('Cancelled during question');
  });
});
