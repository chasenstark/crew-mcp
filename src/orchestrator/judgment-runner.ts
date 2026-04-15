import { EventEmitter } from 'eventemitter3';
import { isAbsolute, resolve, sep } from 'path';
import { z } from 'zod';
import type {
  AgentAdapter,
  TaskResult,
  ToolLoopMessage,
  ToolLoopResult,
} from '../adapters/types.js';
import type { WorkflowConfig } from '../workflow/types.js';
import type {
  ActionRecord,
  DecomposeOutputRef,
  PassRecord,
  PassSummary,
  TaskArtifacts,
  TaskLifecycleState,
  WorkflowState,
} from '../state/types.js';
import { StateStore } from '../state/store.js';
import { WorktreeManager } from '../git/worktree.js';
import { logger } from '../utils/logger.js';
import { executeWithValidation } from '../utils/validate.js';
import { OrchestratorActionServer } from './action-server.js';
import type { ProviderSession } from '../provider-session.js';
import { isCliVersionCompatible } from '../provider-session.js';
import { decompose, type DecomposeOutput } from './steps/decompose.js';
import { dispatch, type DispatchOutput } from './steps/dispatch.js';
import { ingest, type IngestOutput } from './steps/ingest.js';
import { summarize, type SummarizeOutput } from './steps/summarize.js';
import { judge, type JudgeOutput } from './steps/judge.js';
import { report } from './steps/report.js';
import type { AgentRegistry, PipelineEvents } from './pipeline.js';
import type { OrchestrationRunner, ResumeParams } from './runner.js';

const ControllerActionNameSchema = z.enum([
  'run_decompose',
  'select_task',
  'run_dispatch',
  'run_execute',
  'run_ingest',
  'run_summarize',
  'run_judge',
  'replan',
  'ask_user',
  'finalize_report',
  'finish',
  'fail',
]);

const ExecutableActionNameSchema = z.enum([
  'run_decompose',
  'select_task',
  'run_dispatch',
  'run_execute',
  'run_ingest',
  'run_summarize',
  'run_judge',
  'replan',
  'ask_user',
  'finalize_report',
]);

const ControllerDecisionSchema = z.object({
  reasoning: z.string(),
  action: ControllerActionNameSchema,
  target: z.object({
    taskId: z.string().optional(),
  }).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

type ControllerDecision = z.infer<typeof ControllerDecisionSchema>;
type ControllerActionName = z.infer<typeof ControllerActionNameSchema>;
type ExecutableActionName = z.infer<typeof ExecutableActionNameSchema>;

const EmptyInputSchema = z.object({}).passthrough();
const SelectTaskInputSchema = z.object({ taskId: z.string().optional() }).passthrough();
const RunExecuteInputSchema = z.object({
  taskId: z.string().optional(),
  promptOverride: z.string().optional(),
  workingDirectory: z.string().optional(),
}).passthrough();
const TaskScopedInputSchema = z.object({ taskId: z.string().optional() }).passthrough();
const AskUserInputSchema = z.object({ question: z.string().min(1) });
const ReplanInputSchema = z.object({ reason: z.string().optional() }).passthrough();

interface RuntimeState {
  runId: string;
  startedAt: string;
  userRequest: string;
  decomposition: DecomposeOutputRef;
  passRecords: PassRecord[];
  summaries: PassSummary[];
  taskStates: Record<string, TaskLifecycleState>;
  pendingQueue: string[];
  artifactsByTask: Record<string, TaskArtifacts>;
  actionHistory: ActionRecord[];
  controllerCursor: number;
  toolCallTranscript: WorkflowState['toolCallTranscript'];
  activeTaskId?: string;
  globalPassCounter: number;
  taskJudgePassCount: Record<string, number>;
  taskPassNumbers: Record<string, number>;
  taskExecutionCounts: Record<string, number>;
  taskWorktrees: Record<string, string>;
  reportFinalized: boolean;
  finalReport?: string;
  hadErrors: boolean;
  deterministicFallbackCount: number;
  replanCount: number;
  nativeToolCalls: number;
  providerSession?: ProviderSession;
}

interface ActionDefinition<TInput, TOutput> {
  name: ExecutableActionName;
  description: string;
  inputSchema: z.ZodType<TInput>;
  handler: (input: TInput, runtime: RuntimeState) => Promise<TOutput>;
}

type ActionDefinitions = {
  [K in ExecutableActionName]: ActionDefinition<unknown, unknown>;
};

interface Guardrails {
  maxTotalActions: number;
  maxNativeToolCalls: number;
  maxAgentExecutionsPerTask: number;
  maxConsecutiveSameAction: number;
  maxReplans: number;
  maxDeterministicFallbacks: number;
}

const DEFAULT_GUARDRAILS: Guardrails = {
  maxTotalActions: 200,
  maxNativeToolCalls: 300,
  maxAgentExecutionsPerTask: 6,
  maxConsecutiveSameAction: 5,
  maxReplans: 3,
  maxDeterministicFallbacks: 6,
};

type OrchestratorStage =
  | 'decompose'
  | 'dispatch'
  | 'ingest'
  | 'summarize'
  | 'judge'
  | 'report';

export class JudgmentRunner extends EventEmitter<PipelineEvents> implements OrchestrationRunner {
  private orchestrator: AgentAdapter;
  private registry: AgentRegistry;
  private workflow: WorkflowConfig;
  private state: StateStore;
  private worktreeManager: WorktreeManager;
  private orchestratorModel?: string;
  private agentModels: Record<string, string | undefined>;
  private userInputResolver: ((input: string) => void) | null = null;
  private userInputRejecter: ((error: Error) => void) | null = null;
  private activeAbortController: AbortController | null = null;
  private actions: ActionDefinitions;
  private actionServer: OrchestratorActionServer;
  private guardrails: Guardrails;

  constructor(
    orchestratorAdapter: AgentAdapter,
    registry: AgentRegistry,
    workflow: WorkflowConfig,
    state: StateStore,
    worktreeManager: WorktreeManager,
    options?: {
      orchestratorModel?: string;
      agentModels?: Record<string, string | undefined>;
      guardrails?: Partial<Guardrails>;
    },
  ) {
    super();
    this.orchestrator = orchestratorAdapter;
    this.registry = registry;
    this.workflow = workflow;
    this.state = state;
    this.worktreeManager = worktreeManager;
    this.orchestratorModel = options?.orchestratorModel;
    this.agentModels = options?.agentModels ?? {};
    this.guardrails = {
      ...DEFAULT_GUARDRAILS,
      ...(options?.guardrails ?? {}),
    };
    this.actions = this.buildActionRegistry();
    this.actionServer = this.buildActionServer();
  }

  requestUserInput(question: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.userInputResolver = resolve;
      this.userInputRejecter = reject;
      this.emit('ask_user', question);
    });
  }

  provideUserInput(input: string): void {
    if (this.userInputResolver) {
      const resolve = this.userInputResolver;
      this.userInputResolver = null;
      this.userInputRejecter = null;
      resolve(input);
    }
  }

  private rejectPendingUserInput(reason: string): void {
    if (this.userInputRejecter) {
      const reject = this.userInputRejecter;
      this.userInputResolver = null;
      this.userInputRejecter = null;
      reject(new Error(reason));
    }
  }

  markInterrupted(reason = 'Interrupted by user'): void {
    const snapshot = this.state.loadState();
    if (!snapshot) return;
    if (snapshot.status !== 'running' && snapshot.status !== 'interrupted') return;

    this.state.saveState({
      ...snapshot,
      status: 'interrupted',
      interruptedAt: new Date().toISOString(),
      lastError: reason,
    });
  }

  cancel(reason = 'Cancelled by user'): void {
    this.markInterrupted(reason);
    if (this.activeAbortController && !this.activeAbortController.signal.aborted) {
      this.activeAbortController.abort(reason);
    }
    this.rejectPendingUserInput(reason);
  }

  async run(userRequest: string): Promise<string> {
    const startedAt = new Date().toISOString();
    const runId = this.createRunId(startedAt);
    const runtime = this.createInitialRuntimeState({
      runId,
      startedAt,
      userRequest,
    });

    this.persistRuntimeState(runtime, 'running');
    return this.execute(runtime);
  }

  async resume({ workflowState, previousSummaries }: ResumeParams): Promise<string> {
    if ((workflowState.executionMode ?? 'linear') !== 'judgment') {
      throw new Error('Cannot resume a linear-mode run with JudgmentRunner.');
    }

    const runId = workflowState.runId ?? this.createRunId(workflowState.startedAt);
    const startedAt = workflowState.startedAt ?? new Date().toISOString();
    const providerSession = await this.resolveResumeProviderSession(workflowState.providerSession);
    const runtime = this.createInitialRuntimeState({
      runId,
      startedAt,
      userRequest: workflowState.userRequest,
      passRecords: [...workflowState.passes],
      summaries: [...previousSummaries],
      decomposition: workflowState.decomposition,
      toolCallTranscript: workflowState.toolCallTranscript,
      nativeToolCalls: workflowState.nativeToolCalls,
      providerSession,
    });

    if (workflowState.actionHistory && workflowState.actionHistory.length > 0) {
      this.rehydrateFromActionHistory(runtime, workflowState.actionHistory);
    } else {
      runtime.taskStates = { ...(workflowState.taskStates ?? {}) };
      runtime.pendingQueue = [...(workflowState.pendingQueue ?? [])];
      runtime.artifactsByTask = { ...(workflowState.artifactsByTask ?? {}) };
      runtime.controllerCursor = workflowState.controllerCursor ?? 0;
      runtime.actionHistory = [];
    }

    runtime.globalPassCounter = previousSummaries.reduce(
      (max, summary) => Math.max(max, summary.passNumber),
      runtime.globalPassCounter,
    );

    this.persistRuntimeState(runtime, 'running');
    return this.execute(runtime);
  }

  private async execute(runtime: RuntimeState): Promise<string> {
    this.activeAbortController = new AbortController();

    try {
      const supportsAdapterToolLoop = Boolean(
        this.orchestrator.orchestratorCapabilities?.supportsToolLoop
        && this.orchestrator.executeWithTools
      );

      let interrupted = false;
      if (supportsAdapterToolLoop) {
        try {
          interrupted = await this.executeNativeToolLoop(runtime);
        } catch (error: unknown) {
          runtime.hadErrors = true;
          runtime.providerSession = undefined;
          logger.warn('Native tool-loop failed, falling back to structured decision mode.', {
            error: error instanceof Error ? error.message : String(error),
          });
          interrupted = await this.executeFallbackLoop(runtime);
        }
      } else {
        interrupted = await this.executeFallbackLoop(runtime);
      }

      if (interrupted) {
        return 'Workflow interrupted.';
      }

      if (!runtime.finalReport) {
        runtime.finalReport = this.buildFallbackReport(runtime.summaries, runtime.userRequest);
      }

      runtime.providerSession = undefined;
      this.state.saveState({
        ...this.toWorkflowState(runtime),
        status: runtime.hadErrors ? 'failed' : 'completed',
        completedAt: new Date().toISOString(),
        lastError: runtime.hadErrors ? 'Judgment workflow completed with recoverable errors.' : undefined,
      });

      if (runtime.finalReport && !runtime.reportFinalized) {
        this.emit('report', runtime.finalReport);
      }

      return runtime.finalReport;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      runtime.providerSession = undefined;
      this.state.saveState({
        ...this.toWorkflowState(runtime),
        status: 'failed',
        completedAt: new Date().toISOString(),
        lastError: err.message,
      });
      this.emit('error', err, { step: 'judgment' });
      throw err;
    } finally {
      this.activeAbortController = null;
    }
  }

  private async executeFallbackLoop(runtime: RuntimeState): Promise<boolean> {
    const signal = this.activeAbortController?.signal;

    while (runtime.controllerCursor <= runtime.actionHistory.length) {
      if (signal?.aborted) {
        this.handleInterrupted(runtime);
        return true;
      }
      if (runtime.actionHistory.length >= this.guardrails.maxTotalActions) {
        throw new Error(
          `Judgment action budget exceeded (${this.guardrails.maxTotalActions}).`,
        );
      }

      const decided = await this.decideNextAction(runtime);
      const validated = this.validateDecision(decided, runtime);
      let decision = decided;

      if (!validated.ok) {
        runtime.hadErrors = true;
        runtime.deterministicFallbackCount++;
        logger.warn('Invalid controller decision; using deterministic fallback.', {
          reason: validated.reason,
          decision,
        });
        if (runtime.deterministicFallbackCount > this.guardrails.maxDeterministicFallbacks) {
          throw new Error(
            `Controller exceeded deterministic fallback budget (${this.guardrails.maxDeterministicFallbacks}).`,
          );
        }
        decision = {
          reasoning: `Deterministic fallback: ${validated.reason}`,
          ...this.computeDeterministicFallback(runtime),
        };
      }

      if (decision.action === 'finish') {
        if (!runtime.reportFinalized) {
          runtime.hadErrors = true;
          runtime.deterministicFallbackCount++;
          if (runtime.deterministicFallbackCount > this.guardrails.maxDeterministicFallbacks) {
            throw new Error(
              `Controller exceeded deterministic fallback budget (${this.guardrails.maxDeterministicFallbacks}).`,
            );
          }
          decision = {
            reasoning:
              'finish requires finalize_report first; applying deterministic fallback',
            action: 'finalize_report',
            payload: {},
          };
        } else {
          break;
        }
      }

      if (decision.action === 'fail') {
        throw new Error(`Controller aborted run: ${decision.reasoning}`);
      }

      await this.executeActionDecision(decision, runtime, 'fallback');
      this.persistRuntimeState(runtime, 'running');
    }

    return false;
  }

  private async executeNativeToolLoop(runtime: RuntimeState): Promise<boolean> {
    if (!this.orchestrator.executeWithTools) {
      throw new Error('Adapter does not implement executeWithTools.');
    }
    const supportsPauseForUserInput = Boolean(
      this.orchestrator.orchestratorCapabilities?.supportsPauseForUserInput,
    );

    const tools = this.actionServer.listTools();
    const startMessages = runtime.toolCallTranscript && runtime.toolCallTranscript.length > 0
      ? runtime.toolCallTranscript.map((message) => ({ ...message }))
      : this.buildNativeStartMessages(runtime);

    const result = await this.orchestrator.executeWithTools(
      tools,
      startMessages,
      async (call) => {
        runtime.nativeToolCalls++;
        if (runtime.nativeToolCalls > this.guardrails.maxNativeToolCalls) {
          throw new Error(
            `Native tool-call budget exceeded (${this.guardrails.maxNativeToolCalls}).`,
          );
        }
        const { decision, pathTaken } = this.resolveNativeToolDecision(call, runtime);
        if (decision.action === 'finish' || decision.action === 'fail') {
          return {
            output: {
              ok: true,
              terminal: decision.action,
              message: 'Use terminal response instead of tool call for finish/fail.',
            },
          };
        }
        if (decision.action === 'ask_user' && !supportsPauseForUserInput) {
          throw new Error(
            'Adapter tool-loop path cannot pause for user input; switching to fallback mode.',
          );
        }
        await this.executeActionDecision(decision, runtime, pathTaken);
        this.persistRuntimeState(runtime, 'running');
        return {
          output: {
            ok: true,
            action: decision.action,
            taskId: decision.target?.taskId,
            sequence: runtime.actionHistory.length,
          },
        };
      },
      {
        signal: this.activeAbortController?.signal,
        workingDirectory: process.cwd(),
        providerSession: runtime.providerSession,
        toolNamespace: this.actionServer.toolNamespace,
        toolSchemaHash: this.actionServer.getToolSchemaHash(),
        onProviderSession: (session) => {
          runtime.providerSession = session;
        },
      },
    );

    runtime.toolCallTranscript = result.transcript;
    if (result.providerSession) {
      runtime.providerSession = result.providerSession;
    } else if (result.pathTaken === 'adapter' || result.pathTaken === 'fallback') {
      runtime.providerSession = undefined;
    }
    return this.handleNativeLoopResult(result, runtime);
  }

  private createInitialRuntimeState(args: {
    runId: string;
    startedAt: string;
    userRequest: string;
    passRecords?: PassRecord[];
    summaries?: PassSummary[];
    decomposition?: DecomposeOutputRef;
    toolCallTranscript?: WorkflowState['toolCallTranscript'];
    nativeToolCalls?: number;
    providerSession?: ProviderSession;
  }): RuntimeState {
    return {
      runId: args.runId,
      startedAt: args.startedAt,
      userRequest: args.userRequest,
      decomposition: args.decomposition ?? {
        reasoning: '',
        tasks: [],
        suggestedOrder: [],
      },
      passRecords: args.passRecords ?? [],
      summaries: args.summaries ?? [],
      taskStates: {},
      pendingQueue: [],
      artifactsByTask: {},
      actionHistory: [],
      controllerCursor: 0,
      toolCallTranscript: args.toolCallTranscript,
      globalPassCounter: (args.summaries ?? []).reduce(
        (max, summary) => Math.max(max, summary.passNumber),
        0,
      ),
      taskJudgePassCount: {},
      taskPassNumbers: {},
      taskExecutionCounts: {},
      taskWorktrees: {},
      reportFinalized: false,
      hadErrors: false,
      deterministicFallbackCount: 0,
      replanCount: 0,
      nativeToolCalls: args.nativeToolCalls ?? 0,
      providerSession: args.providerSession,
    };
  }

  private async resolveResumeProviderSession(
    savedSession: ProviderSession | undefined,
  ): Promise<ProviderSession | undefined> {
    if (!savedSession) return undefined;

    const expectedProvider = this.resolveProviderNameForAdapter(this.orchestrator.name);
    if (savedSession.provider !== expectedProvider) {
      logger.warn(
        `Dropping provider session from ${savedSession.provider}; active adapter is ${this.orchestrator.name}.`,
      );
      return undefined;
    }

    const currentToolHash = this.actionServer.getToolSchemaHash();
    if (savedSession.toolSchemaHash !== currentToolHash) {
      logger.warn('Dropping provider session because tool schema hash changed.', {
        previous: savedSession.toolSchemaHash,
        current: currentToolHash,
      });
      return undefined;
    }

    if (!this.orchestrator.getCliVersionTag) {
      logger.warn('Dropping provider session because adapter cannot validate CLI compatibility.');
      return undefined;
    }

    let detectedCliVersion: string | undefined;
    try {
      detectedCliVersion = await this.orchestrator.getCliVersionTag();
    } catch (error: unknown) {
      logger.warn('Dropping provider session because CLI version detection failed.', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }

    if (!isCliVersionCompatible(savedSession.cliVersion, detectedCliVersion)) {
      logger.warn('Dropping provider session because CLI version is incompatible.', {
        saved: savedSession.cliVersion,
        detected: detectedCliVersion,
      });
      return undefined;
    }

    return {
      ...savedSession,
      cliVersion: detectedCliVersion,
      toolSchemaHash: currentToolHash,
      lastTurnAt: new Date().toISOString(),
    };
  }

  private resolveProviderNameForAdapter(adapterName: string): ProviderSession['provider'] {
    if (adapterName === 'claude-code') return 'claude';
    if (adapterName === 'codex') return 'codex';
    if (adapterName === 'gemini-cli') return 'gemini';
    return 'local';
  }

  private rehydrateFromActionHistory(runtime: RuntimeState, history: ActionRecord[]): void {
    const sorted = [...history].sort((a, b) => a.sequence - b.sequence);

    for (const record of sorted) {
      runtime.actionHistory.push(record);
      runtime.controllerCursor = Math.max(runtime.controllerCursor, record.sequence);
      this.applyActionResult(runtime, record.action, record.result.data);
      if (record.action === 'run_execute') {
        const taskId = record.target?.taskId;
        if (taskId) {
          runtime.taskExecutionCounts[taskId] = (runtime.taskExecutionCounts[taskId] ?? 0) + 1;
        }
      }
      if (record.action === 'run_judge') {
        const taskId = record.target?.taskId;
        if (taskId) {
          runtime.taskJudgePassCount[taskId] = (runtime.taskJudgePassCount[taskId] ?? 0) + 1;
        }
      }
      if (record.action === 'finalize_report' && record.result.status === 'success') {
        runtime.reportFinalized = true;
        runtime.finalReport = typeof record.result.data === 'string'
          ? record.result.data
          : runtime.finalReport;
      }
      if (record.action === 'replan' && record.result.status === 'success') {
        runtime.replanCount++;
      }
    }
  }

  private toWorkflowState(runtime: RuntimeState): WorkflowState {
    return {
      schemaVersion: 3,
      executionMode: 'judgment',
      runId: runtime.runId,
      status: 'running',
      userRequest: runtime.userRequest,
      decomposition: runtime.decomposition,
      currentTaskIndex: this.computeCurrentTaskIndex(runtime),
      passes: runtime.passRecords,
      taskStates: runtime.taskStates,
      pendingQueue: runtime.pendingQueue,
      artifactsByTask: runtime.artifactsByTask,
      actionHistory: runtime.actionHistory,
      controllerCursor: runtime.controllerCursor,
      toolCallTranscript: runtime.toolCallTranscript,
      nativeToolCalls: runtime.nativeToolCalls,
      providerSession: runtime.providerSession,
      startedAt: runtime.startedAt,
    };
  }

  private persistRuntimeState(runtime: RuntimeState, status: WorkflowState['status']): void {
    this.state.saveState({
      ...this.toWorkflowState(runtime),
      status,
      interruptedAt: status === 'interrupted' ? new Date().toISOString() : undefined,
      completedAt: status === 'completed' || status === 'failed'
        ? new Date().toISOString()
        : undefined,
      lastError: status === 'failed' ? 'Judgment workflow failed.' : undefined,
    });
  }

  private computeCurrentTaskIndex(runtime: RuntimeState): number {
    const order = runtime.decomposition.suggestedOrder;
    for (let idx = 0; idx < order.length; idx++) {
      const taskId = order[idx];
      const state = runtime.taskStates[taskId];
      if (state !== 'done' && state !== 'failed' && state !== 'blocked') {
        return idx;
      }
    }
    return order.length;
  }

  private resolveTaskModel(task: { role: string; agent: string }): string | undefined {
    const roleModels = this.workflow.roleModels ?? {};
    const directRoleModel = roleModels[task.role]?.trim();
    if (directRoleModel) return directRoleModel;

    const stepByAction = this.workflow.steps.find((step) => step.action === task.role);
    if (stepByAction) {
      const stepRoleModel = roleModels[stepByAction.role]?.trim();
      if (stepRoleModel) return stepRoleModel;
    }

    const agentModel = this.agentModels[task.agent]?.trim();
    return agentModel || undefined;
  }

  private resolveOrchestratorModel(stage: OrchestratorStage): string | undefined {
    if (stage === 'judge') {
      const roleModel = this.workflow.roleModels?.judge?.trim();
      if (roleModel) return roleModel;
    }
    return this.orchestratorModel;
  }

  private buildActionRegistry(): ActionDefinitions {
    return {
      run_decompose: {
        name: 'run_decompose',
        description: 'Break the user request into concrete tasks and execution order.',
        inputSchema: EmptyInputSchema,
        handler: async (_input, runtime) => {
          this.emit('step:start', 'decompose', { userRequest: runtime.userRequest });
          const decomposition = await decompose(
            this.orchestrator,
            runtime.userRequest,
            this.registry.list(),
            this.workflow,
            this.resolveOrchestratorModel('decompose'),
          );
          this.applyDecomposition(runtime, decomposition, false);
          this.emit('step:complete', 'decompose', {
            taskCount: decomposition.tasks.length,
            suggestedOrder: decomposition.suggestedOrder,
          });
          return decomposition;
        },
      },
      select_task: {
        name: 'select_task',
        description: 'Select the next executable task from pending work.',
        inputSchema: SelectTaskInputSchema,
        handler: async (rawInput, runtime) => {
          const input = SelectTaskInputSchema.parse(rawInput);
          const selectedTaskId = this.selectTask(runtime, input.taskId);
          runtime.activeTaskId = selectedTaskId;
          return { taskId: selectedTaskId };
        },
      },
      run_dispatch: {
        name: 'run_dispatch',
        description: 'Create a focused prompt for the chosen agent and task.',
        inputSchema: TaskScopedInputSchema,
        handler: async (rawInput, runtime) => {
          const input = TaskScopedInputSchema.parse(rawInput);
          const taskId = input.taskId ?? runtime.activeTaskId;
          const task = this.requireTask(runtime, taskId);
          const pass = (runtime.taskJudgePassCount[task.id] ?? 0) + 1;

          this.emit('step:start', 'dispatch', {
            taskId: task.id,
            taskDescription: task.description,
            pass,
          });
          const dispatchResult = await dispatch(
            this.orchestrator,
            { description: task.description, role: task.role },
            runtime.summaries,
            pass,
            this.resolveOrchestratorModel('dispatch'),
          );
          this.ensureTaskArtifacts(runtime, task.id).dispatch = dispatchResult;
          this.emit('step:complete', 'dispatch', {
            taskId: task.id,
            taskDescription: task.description,
            pass,
          });
          return { taskId: task.id, dispatch: dispatchResult };
        },
      },
      run_execute: {
        name: 'run_execute',
        description: 'Execute selected task in the assigned agent worktree.',
        inputSchema: RunExecuteInputSchema,
        handler: async (rawInput, runtime) => {
          const input = RunExecuteInputSchema.parse(rawInput);
          const taskId = input.taskId ?? runtime.activeTaskId;
          const task = this.requireTask(runtime, taskId);
          this.assertTaskDependenciesSatisfied(runtime, task.id);

          const executionCount = runtime.taskExecutionCounts[task.id] ?? 0;
          if (executionCount >= this.guardrails.maxAgentExecutionsPerTask) {
            throw new Error(
              `Task ${task.id} exceeded max agent executions (${this.guardrails.maxAgentExecutionsPerTask}).`,
            );
          }

          let worktree = runtime.taskWorktrees[task.id];
          if (!worktree) {
            worktree = await this.worktreeManager.createWorktree(task.id);
            runtime.taskWorktrees[task.id] = worktree;
          }

          const artifacts = this.ensureTaskArtifacts(runtime, task.id);
          const dispatchResult = artifacts.dispatch as DispatchOutput | undefined;
          const prompt = input.promptOverride ?? dispatchResult?.agentPrompt ?? task.description;
          const workingDirectory = this.resolveTaskWorkingDirectory(
            worktree,
            input.workingDirectory ?? dispatchResult?.workingDirectory,
          );
          const agent = this.registry.get(task.agent);
          if (!agent) {
            throw new Error(
              `Agent "${task.agent}" not found in registry. Available: ${this.registry.list().map((a) => a.name).join(', ')}`,
            );
          }

          this.emit('agent:start', agent.name, task.id, task.description);
          const agentResult = await agent.execute({
            prompt,
            context: {
              workingDirectory,
              files: task.scope.files,
            },
            constraints: {
              model: this.resolveTaskModel(task),
              signal: this.activeAbortController?.signal,
            },
            onOutput: (chunk) => this.emit('agent:output', agent.name, task.id, chunk),
          });

          if (agentResult.filesModified.length === 0) {
            try {
              const detectedFiles = await this.worktreeManager.getModifiedFiles(task.id);
              if (detectedFiles.length > 0) {
                agentResult.filesModified = detectedFiles;
              }
            } catch {
              logger.debug('Could not detect modified files via worktree');
            }
          }

          runtime.taskExecutionCounts[task.id] = executionCount + 1;
          runtime.taskStates[task.id] = 'running';
          artifacts.agentResult = agentResult;
          this.emit('agent:complete', agent.name, task.id, agentResult);
          return { taskId: task.id, agentResult };
        },
      },
      run_ingest: {
        name: 'run_ingest',
        description: 'Analyze the latest agent output into structured findings.',
        inputSchema: TaskScopedInputSchema,
        handler: async (rawInput, runtime) => {
          const input = TaskScopedInputSchema.parse(rawInput);
          const taskId = input.taskId ?? runtime.activeTaskId;
          const task = this.requireTask(runtime, taskId);
          const artifacts = this.ensureTaskArtifacts(runtime, task.id);
          if (!artifacts.agentResult) {
            throw new Error(`Task ${task.id} has no agent output to ingest.`);
          }

          this.emit('step:start', 'ingest', {
            taskId: task.id,
            taskDescription: task.description,
          });
          const ingestResult = await ingest(
            this.orchestrator,
            task.description,
            artifacts.agentResult,
            this.resolveOrchestratorModel('ingest'),
          );
          runtime.globalPassCounter++;
          runtime.taskPassNumbers[task.id] = runtime.globalPassCounter;
          this.state.addPassOutput(runtime.globalPassCounter, ingestResult, runtime.runId);
          artifacts.ingest = ingestResult;
          this.emit('step:complete', 'ingest', {
            taskId: task.id,
            taskDescription: task.description,
            status: ingestResult.status,
            summary: ingestResult.summary,
            needsHumanAttention: ingestResult.needsHumanAttention,
          });
          return { taskId: task.id, ingest: ingestResult };
        },
      },
      run_summarize: {
        name: 'run_summarize',
        description: 'Compress the current ingest output for downstream context.',
        inputSchema: TaskScopedInputSchema,
        handler: async (rawInput, runtime) => {
          const input = TaskScopedInputSchema.parse(rawInput);
          const taskId = input.taskId ?? runtime.activeTaskId;
          const task = this.requireTask(runtime, taskId);
          const artifacts = this.ensureTaskArtifacts(runtime, task.id);
          const ingestResult = artifacts.ingest as IngestOutput | undefined;
          if (!ingestResult) {
            throw new Error(`Task ${task.id} has no ingest result to summarize.`);
          }

          const passNumber = runtime.taskPassNumbers[task.id] ?? (runtime.globalPassCounter + 1);
          this.emit('step:start', 'summarize', {
            taskId: task.id,
            taskDescription: task.description,
          });
          const summary = await summarize(
            this.orchestrator,
            ingestResult,
            passNumber,
            this.resolveOrchestratorModel('summarize'),
          );
          artifacts.summary = summary;
          runtime.summaries.push(summary);
          runtime.passRecords.push({
            passNumber: summary.passNumber,
            taskId: task.id,
            agentName: task.agent,
            timestamp: new Date().toISOString(),
          });
          this.state.addPassSummary(summary, runtime.runId);
          this.emit('step:complete', 'summarize', {
            taskId: task.id,
            taskDescription: task.description,
            summary: summary.summary,
            unresolvedIssueCount: summary.unresolvedIssues.length,
          });
          return { taskId: task.id, summary };
        },
      },
      run_judge: {
        name: 'run_judge',
        description: 'Evaluate whether the task is done, needs another pass, or needs user input.',
        inputSchema: TaskScopedInputSchema,
        handler: async (rawInput, runtime) => {
          const input = TaskScopedInputSchema.parse(rawInput);
          const taskId = input.taskId ?? runtime.activeTaskId;
          const task = this.requireTask(runtime, taskId);
          const artifacts = this.ensureTaskArtifacts(runtime, task.id);
          const ingestResult = artifacts.ingest as IngestOutput | undefined;
          if (!ingestResult) {
            throw new Error(`Task ${task.id} has no ingest result to judge.`);
          }

          const currentPass = (runtime.taskJudgePassCount[task.id] ?? 0) + 1;
          runtime.taskJudgePassCount[task.id] = currentPass;
          const maxPasses = this.getMaxPasses(task.role);
          this.emit('step:start', 'judge', {
            taskId: task.id,
            taskDescription: task.description,
          });
          const judgment = await judge(
            this.orchestrator,
            ingestResult,
            runtime.summaries,
            currentPass,
            maxPasses,
            this.resolveOrchestratorModel('judge'),
          );
          artifacts.judge = judgment;
          if (judgment.decision === 'done') {
            runtime.taskStates[task.id] = 'done';
            runtime.pendingQueue = runtime.pendingQueue.filter((candidate) => candidate !== task.id);
            runtime.activeTaskId = undefined;
          } else if (judgment.decision === 'iterate') {
            runtime.taskStates[task.id] = 'pending';
            if (!runtime.pendingQueue.includes(task.id)) {
              runtime.pendingQueue.unshift(task.id);
            }
            runtime.activeTaskId = task.id;
          } else {
            runtime.taskStates[task.id] = 'running';
          }

          this.emit('step:complete', 'judge', {
            taskId: task.id,
            taskDescription: task.description,
            decision: judgment.decision,
            reasoning: judgment.reasoning,
            isLooping: judgment.isLooping,
          });
          return { taskId: task.id, judgment };
        },
      },
      ask_user: {
        name: 'ask_user',
        description: 'Ask the human for clarification and include the response in context.',
        inputSchema: AskUserInputSchema,
        handler: async (rawInput, runtime) => {
          const input = AskUserInputSchema.parse(rawInput);
          const response = await this.requestUserInput(input.question);
          const syntheticSummary: PassSummary = {
            passNumber: runtime.globalPassCounter + 1,
            summary: `User input: ${response}`,
            unresolvedIssues: [],
            contextForNextPass: response,
            filesInScope: [],
          };
          runtime.summaries.push(syntheticSummary);
          return {
            question: input.question,
            response,
          };
        },
      },
      replan: {
        name: 'replan',
        description: 'Run decomposition again using current results to correct the remaining plan.',
        inputSchema: ReplanInputSchema,
        handler: async (rawInput, runtime) => {
          const input = ReplanInputSchema.parse(rawInput);
          if (runtime.replanCount >= this.guardrails.maxReplans) {
            throw new Error(`Replan budget exceeded (${this.guardrails.maxReplans}).`);
          }
          runtime.replanCount++;
          const replanPrompt = [
            runtime.userRequest,
            '',
            'REPLAN CONTEXT:',
            this.renderReplanContext(runtime, input.reason),
          ].join('\n');
          const decomposition = await decompose(
            this.orchestrator,
            replanPrompt,
            this.registry.list(),
            this.workflow,
            this.resolveOrchestratorModel('decompose'),
          );
          this.applyDecomposition(runtime, decomposition, true);
          return decomposition;
        },
      },
      finalize_report: {
        name: 'finalize_report',
        description: 'Generate and emit the final user-facing report.',
        inputSchema: EmptyInputSchema,
        handler: async (_rawInput, runtime) => {
          this.emit('step:start', 'report');
          let finalReport: string;
          try {
            finalReport = await report(
              this.orchestrator,
              runtime.summaries,
              runtime.userRequest,
              this.resolveOrchestratorModel('report'),
            );
          } catch (error: unknown) {
            runtime.hadErrors = true;
            const message = error instanceof Error ? error.message : String(error);
            logger.error('Judgment report generation failed, using fallback report', { error: message });
            finalReport = this.buildFallbackReport(runtime.summaries, runtime.userRequest);
          }

          runtime.reportFinalized = true;
          runtime.finalReport = finalReport;
          this.emit('step:complete', 'report', { passCount: runtime.summaries.length });
          this.emit('report', finalReport);
          return finalReport;
        },
      },
    };
  }

  private buildActionServer(): OrchestratorActionServer {
    return new OrchestratorActionServer(
      Object.values(this.actions).map((action) => ({
        name: action.name,
        description: action.description,
        inputSchema: action.inputSchema,
      })),
    );
  }

  private buildNativeStartMessages(runtime: RuntimeState): ToolLoopMessage[] {
    const tools = this.actionServer.listTools()
      .map((tool) => `- ${tool.name}: ${tool.description}`)
      .join('\n');

    const policyHints = this.workflow.steps.flatMap((step) => {
      const hints: string[] = [];
      if (step.condition) {
        hints.push(`- condition (${step.action}): ${step.condition}`);
      }
      if (step.criteria && step.criteria.length > 0) {
        hints.push(...step.criteria.map((criteria) => `- criteria (${step.action}): ${criteria}`));
      }
      return hints;
    }).join('\n') || '- none';

    return [
      {
        role: 'system',
        content: [
          'You are the judgment-mode orchestration controller.',
          'Call tools one at a time to progress workflow execution.',
          'Do not finish until finalize_report has succeeded.',
          'Available tools:',
          tools,
          'Policy hints (soft):',
          policyHints,
        ].join('\n'),
      },
      {
        role: 'user',
        content: `User request: ${runtime.userRequest}`,
      },
    ];
  }

  private resolveNativeToolDecision(
    call: { name: string; input: Record<string, unknown> },
    runtime: RuntimeState,
  ): { decision: ControllerDecision; pathTaken: ActionRecord['pathTaken'] } {
    const normalizedCall = this.actionServer.resolveToolCall(call);
    const action = ControllerActionNameSchema.safeParse(normalizedCall.name);
    if (!action.success || action.data === 'finish' || action.data === 'fail') {
      runtime.hadErrors = true;
      runtime.deterministicFallbackCount++;
      if (runtime.deterministicFallbackCount > this.guardrails.maxDeterministicFallbacks) {
        throw new Error(
          `Controller exceeded deterministic fallback budget (${this.guardrails.maxDeterministicFallbacks}).`,
        );
      }
      return {
        decision: {
          reasoning: `Unknown or terminal native tool call "${call.name}".`,
          ...this.computeDeterministicFallback(runtime),
        },
        pathTaken: 'fallback',
      };
    }

    const taskId =
      typeof normalizedCall.input?.taskId === 'string'
        ? normalizedCall.input.taskId
        : runtime.activeTaskId;
    const decision: ControllerDecision = {
      reasoning:
        typeof normalizedCall.input?.reasoning === 'string'
          ? normalizedCall.input.reasoning
          : `native tool call: ${action.data}`,
      action: action.data,
      target: taskId ? { taskId } : undefined,
      payload: normalizedCall.input,
    };

    const validated = this.validateDecision(decision, runtime);
    if (validated.ok) {
      return {
        decision,
        pathTaken: runtime.providerSession?.transport ?? 'native',
      };
    }

    runtime.hadErrors = true;
    runtime.deterministicFallbackCount++;
    if (runtime.deterministicFallbackCount > this.guardrails.maxDeterministicFallbacks) {
      throw new Error(
        `Controller exceeded deterministic fallback budget (${this.guardrails.maxDeterministicFallbacks}).`,
      );
    }

    return {
      decision: {
        reasoning: `Native tool call invalid: ${validated.reason}`,
        ...this.computeDeterministicFallback(runtime),
      },
      pathTaken: 'fallback',
    };
  }

  private async handleNativeLoopResult(result: ToolLoopResult, runtime: RuntimeState): Promise<boolean> {
    if (result.status === 'interrupted') {
      this.handleInterrupted(runtime);
      return true;
    }
    if (result.status === 'failed') {
      throw new Error(result.error ?? 'Native tool-loop failed.');
    }
    if (!runtime.reportFinalized) {
      runtime.hadErrors = true;
      runtime.deterministicFallbackCount++;
      if (runtime.deterministicFallbackCount > this.guardrails.maxDeterministicFallbacks) {
        throw new Error(
          `Controller exceeded deterministic fallback budget (${this.guardrails.maxDeterministicFallbacks}).`,
        );
      }
      await this.executeActionDecision(
        {
          reasoning:
            'Native tool-loop completed without finalize_report; applying deterministic fallback.',
          action: 'finalize_report',
          payload: {},
        },
        runtime,
        'fallback',
      );
      this.persistRuntimeState(runtime, 'running');
    }
    return false;
  }

  private async decideNextAction(runtime: RuntimeState): Promise<ControllerDecision> {
    const prompt = this.buildControllerPrompt(runtime);
    try {
      return await executeWithValidation(
        this.orchestrator,
        prompt,
        ControllerDecisionSchema,
        { model: this.orchestratorModel },
      );
    } catch (error: unknown) {
      runtime.hadErrors = true;
      runtime.deterministicFallbackCount++;
      if (runtime.deterministicFallbackCount > this.guardrails.maxDeterministicFallbacks) {
        throw new Error(
          `Controller exceeded deterministic fallback budget (${this.guardrails.maxDeterministicFallbacks}).`,
        );
      }
      const fallback = this.computeDeterministicFallback(runtime);
      logger.warn('Controller decision parse failed, using deterministic fallback', {
        error: error instanceof Error ? error.message : String(error),
        fallback,
      });
      return {
        reasoning: 'Controller decision failed schema validation; using deterministic fallback.',
        ...fallback,
      };
    }
  }

  private buildControllerPrompt(runtime: RuntimeState): string {
    const actionInventory = Object.values(this.actions)
      .map((action) => `- ${action.name}: ${action.description}`)
      .join('\n');

    const tasks = runtime.decomposition.tasks.map((task) => {
      const status = runtime.taskStates[task.id] ?? 'pending';
      const deps = task.dependencies.length > 0 ? task.dependencies.join(', ') : 'none';
      return `- ${task.id} [${status}] agent=${task.agent} role=${task.role} deps=${deps} :: ${task.description}`;
    }).join('\n') || '(no tasks yet)';

    const historyTail = runtime.actionHistory.slice(-8).map((entry) => ({
      sequence: entry.sequence,
      action: entry.action,
      taskId: entry.target?.taskId,
      status: entry.result.status,
      reasoning: entry.reasoning,
    }));

    const policyHints = this.workflow.steps.flatMap((step) => {
      const hints: string[] = [];
      if (step.condition) {
        hints.push(`- condition (${step.action}): ${step.condition}`);
      }
      if (step.criteria && step.criteria.length > 0) {
        hints.push(...step.criteria.map((criteria) => `- criteria (${step.action}): ${criteria}`));
      }
      return hints;
    }).join('\n') || '- none';

    const pendingQueue = runtime.pendingQueue.length > 0
      ? runtime.pendingQueue.join(', ')
      : '(empty)';

    return `You are the orchestrator controller for a coding workflow.

You must choose exactly one next action for this turn.

User request:
${runtime.userRequest}

Action inventory:
${actionInventory}
- finish: end run (ONLY after finalize_report succeeded)
- fail: terminate run as failed with clear reasoning

Hard constraints:
- finish is forbidden before finalize_report.
- run_execute requires a selected task whose dependencies are done.
- run_ingest requires run_execute output for that task.
- run_summarize and run_judge require ingest results for that task.
- select_task should choose a pending task with satisfied dependencies.

Policy hints (soft; can be overridden with reasoning):
${policyHints}

Current task graph:
${tasks}

Current selected task: ${runtime.activeTaskId ?? '(none)'}
Pending queue: ${pendingQueue}
Report finalized: ${runtime.reportFinalized ? 'yes' : 'no'}
Replans used: ${runtime.replanCount}/${this.guardrails.maxReplans}
Deterministic fallbacks used: ${runtime.deterministicFallbackCount}/${this.guardrails.maxDeterministicFallbacks}

Recent action history:
${JSON.stringify(historyTail, null, 2)}

Return valid JSON matching the schema.`;
  }

  private validateDecision(
    decision: ControllerDecision,
    runtime: RuntimeState,
  ): { ok: true } | { ok: false; reason: string } {
    const action = decision.action;
    const taskId = decision.target?.taskId ?? (
      typeof decision.payload?.taskId === 'string' ? decision.payload.taskId : runtime.activeTaskId
    );

    if (action === 'finish') {
      if (!runtime.reportFinalized) {
        return { ok: false, reason: 'finish requested before finalize_report' };
      }
      return { ok: true };
    }

    if (action === 'fail' || action === 'ask_user') {
      return { ok: true };
    }

    if ((action === 'run_decompose' || action === 'replan') && runtime.actionHistory.length === 0) {
      return { ok: true };
    }

    if (action === 'replan' && runtime.replanCount >= this.guardrails.maxReplans) {
      return { ok: false, reason: 'replan budget exceeded' };
    }

    if (action === 'select_task') {
      if (runtime.decomposition.tasks.length === 0) return { ok: false, reason: 'no decomposition available' };
      return { ok: true };
    }

    if (action === 'run_decompose') return { ok: true };

    if (action === 'finalize_report') {
      if (runtime.decomposition.tasks.length === 0) return { ok: true };
      const hasNonTerminalTasks = runtime.decomposition.tasks.some((task) => {
        const state = runtime.taskStates[task.id] ?? 'pending';
        return state !== 'done' && state !== 'failed' && state !== 'blocked';
      });
      if (hasNonTerminalTasks) {
        return { ok: false, reason: 'cannot finalize report with non-terminal tasks' };
      }
      return { ok: true };
    }

    const task = taskId ? runtime.decomposition.tasks.find((candidate) => candidate.id === taskId) : undefined;
    if (!task) {
      return { ok: false, reason: `task required for ${action} but missing` };
    }

    if (action === 'run_execute') {
      const unresolvedDependency = task.dependencies.find((dependencyId) => {
        const state = runtime.taskStates[dependencyId];
        return state !== 'done';
      });
      if (unresolvedDependency) {
        return { ok: false, reason: `task ${task.id} has unresolved dependency ${unresolvedDependency}` };
      }
    }

    if (action === 'run_ingest') {
      const artifacts = runtime.artifactsByTask[task.id];
      if (!artifacts?.agentResult) {
        return { ok: false, reason: `task ${task.id} missing agent result` };
      }
    }

    if (action === 'run_summarize' || action === 'run_judge') {
      const artifacts = runtime.artifactsByTask[task.id];
      if (!artifacts?.ingest) {
        return { ok: false, reason: `task ${task.id} missing ingest result` };
      }
    }

    const sameActionCount = this.getConsecutiveActionCount(runtime, action);
    if (sameActionCount >= this.guardrails.maxConsecutiveSameAction) {
      return {
        ok: false,
        reason: `action ${action} exceeded consecutive limit (${this.guardrails.maxConsecutiveSameAction})`,
      };
    }

    return { ok: true };
  }

  private getConsecutiveActionCount(runtime: RuntimeState, action: string): number {
    let count = 0;
    for (let idx = runtime.actionHistory.length - 1; idx >= 0; idx--) {
      if (runtime.actionHistory[idx].action !== action) break;
      count++;
    }
    return count;
  }

  private computeDeterministicFallback(runtime: RuntimeState): Pick<ControllerDecision, 'action' | 'payload' | 'target'> {
    if (runtime.decomposition.tasks.length === 0) {
      return { action: 'run_decompose', payload: {} };
    }

    const taskId = runtime.activeTaskId ?? this.findNextEligibleTask(runtime);
    if (!taskId) {
      if (!runtime.reportFinalized) {
        return { action: 'finalize_report', payload: {} };
      }
      return { action: 'finish' };
    }

    const artifacts = runtime.artifactsByTask[taskId] ?? {};
    if (!artifacts.dispatch) {
      return { action: 'run_dispatch', target: { taskId }, payload: { taskId } };
    }
    if (!artifacts.agentResult) {
      return { action: 'run_execute', target: { taskId }, payload: { taskId } };
    }
    if (!artifacts.ingest) {
      return { action: 'run_ingest', target: { taskId }, payload: { taskId } };
    }
    if (!artifacts.summary) {
      return { action: 'run_summarize', target: { taskId }, payload: { taskId } };
    }

    const judgment = artifacts.judge as JudgeOutput | undefined;
    if (!judgment) {
      return { action: 'run_judge', target: { taskId }, payload: { taskId } };
    }

    if (judgment.decision === 'ask_user') {
      return {
        action: 'ask_user',
        payload: { question: judgment.questionForUser ?? 'Please provide guidance for this task.' },
      };
    }

    if (judgment.decision === 'iterate') {
      return { action: 'run_dispatch', target: { taskId }, payload: { taskId } };
    }

    const nextTaskId = this.findNextEligibleTask(runtime);
    if (nextTaskId) {
      return { action: 'select_task', payload: { taskId: nextTaskId } };
    }

    if (!runtime.reportFinalized) {
      return { action: 'finalize_report', payload: {} };
    }
    return { action: 'finish' };
  }

  private async executeActionDecision(
    decision: ControllerDecision,
    runtime: RuntimeState,
    pathTaken: ActionRecord['pathTaken'],
  ): Promise<void> {
    const action = ExecutableActionNameSchema.parse(decision.action);
    const definition = this.actions[action];
    const payload = decision.payload ?? {};
    const parsedInput = definition.inputSchema.parse(payload);
    const startedAt = new Date().toISOString();
    const taskId = decision.target?.taskId ?? (
      typeof (parsedInput as Record<string, unknown>).taskId === 'string'
        ? String((parsedInput as Record<string, unknown>).taskId)
        : runtime.activeTaskId
    );

    try {
      const data = await definition.handler(parsedInput, runtime);
      const record: ActionRecord = {
        sequence: runtime.actionHistory.length + 1,
        action,
        target: taskId ? { taskId } : undefined,
        payload,
        reasoning: decision.reasoning,
        result: {
          status: 'success',
          data,
        },
        startedAt,
        completedAt: new Date().toISOString(),
        pathTaken,
      };
      runtime.actionHistory.push(record);
      runtime.controllerCursor = record.sequence;
      this.applyActionResult(runtime, action, data);
    } catch (error: unknown) {
      runtime.hadErrors = true;
      const message = error instanceof Error ? error.message : String(error);
      const record: ActionRecord = {
        sequence: runtime.actionHistory.length + 1,
        action,
        target: taskId ? { taskId } : undefined,
        payload,
        reasoning: decision.reasoning,
        result: {
          status: 'error',
          error: message,
        },
        startedAt,
        completedAt: new Date().toISOString(),
        pathTaken,
      };
      runtime.actionHistory.push(record);
      runtime.controllerCursor = record.sequence;
      throw error;
    }
  }

  private applyActionResult(runtime: RuntimeState, action: string, data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const payload = data as Record<string, unknown>;
    const taskId = typeof payload.taskId === 'string' ? payload.taskId : undefined;

    if ((action === 'run_decompose' || action === 'replan') && payload.tasks && payload.suggestedOrder) {
      runtime.decomposition = payload as unknown as DecomposeOutputRef;
    }
    if (action === 'select_task' && taskId) {
      runtime.activeTaskId = taskId;
    }
    if (action === 'run_dispatch' && taskId && payload.dispatch) {
      this.ensureTaskArtifacts(runtime, taskId).dispatch = payload.dispatch as DispatchOutput;
    }
    if (action === 'run_execute' && taskId && payload.agentResult) {
      this.ensureTaskArtifacts(runtime, taskId).agentResult = payload.agentResult as TaskResult;
      runtime.taskStates[taskId] = 'running';
    }
    if (action === 'run_ingest' && taskId && payload.ingest) {
      this.ensureTaskArtifacts(runtime, taskId).ingest = payload.ingest;
    }
    if (action === 'run_summarize' && taskId && payload.summary) {
      this.ensureTaskArtifacts(runtime, taskId).summary = payload.summary as PassSummary;
    }
    if (action === 'run_judge' && taskId && payload.judgment) {
      const judgment = payload.judgment as JudgeOutput;
      this.ensureTaskArtifacts(runtime, taskId).judge = judgment;
      if (judgment.decision === 'done') runtime.taskStates[taskId] = 'done';
      if (judgment.decision === 'iterate') runtime.taskStates[taskId] = 'pending';
    }
    if (action === 'finalize_report' && typeof data === 'string') {
      runtime.finalReport = data;
      runtime.reportFinalized = true;
    }
  }

  private applyDecomposition(
    runtime: RuntimeState,
    decomposition: DecomposeOutput,
    preserveTerminalStates: boolean,
  ): void {
    const previousStates = runtime.taskStates;
    const nextStates: Record<string, TaskLifecycleState> = {};

    for (const task of decomposition.tasks) {
      const previous = previousStates[task.id];
      if (
        preserveTerminalStates
        && (previous === 'done' || previous === 'failed' || previous === 'blocked')
      ) {
        nextStates[task.id] = previous;
      } else {
        nextStates[task.id] = 'pending';
      }
    }

    runtime.decomposition = decomposition;
    runtime.taskStates = nextStates;
    runtime.pendingQueue = decomposition.suggestedOrder.filter((taskId) => {
      const state = nextStates[taskId];
      return state !== 'done' && state !== 'failed' && state !== 'blocked';
    });
    runtime.activeTaskId = undefined;
  }

  private ensureTaskArtifacts(runtime: RuntimeState, taskId: string): TaskArtifacts {
    if (!runtime.artifactsByTask[taskId]) {
      runtime.artifactsByTask[taskId] = {};
    }
    return runtime.artifactsByTask[taskId];
  }

  private requireTask(runtime: RuntimeState, taskId?: string) {
    if (!taskId) {
      throw new Error('No task selected.');
    }
    const task = runtime.decomposition.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found in decomposition.`);
    }
    return task;
  }

  private assertTaskDependenciesSatisfied(runtime: RuntimeState, taskId: string): void {
    const task = this.requireTask(runtime, taskId);
    const unresolved = task.dependencies.filter((dependencyId) => runtime.taskStates[dependencyId] !== 'done');
    if (unresolved.length > 0) {
      throw new Error(`Task ${taskId} has unresolved dependencies: ${unresolved.join(', ')}`);
    }
  }

  private selectTask(runtime: RuntimeState, requestedTaskId?: string): string {
    if (requestedTaskId) {
      const state = runtime.taskStates[requestedTaskId];
      if (state !== 'pending' && state !== 'running') {
        throw new Error(
          `Task ${requestedTaskId} is not selectable (state=${state ?? 'unknown'}).`,
        );
      }
      this.assertTaskDependenciesSatisfied(runtime, requestedTaskId);
      if (!runtime.pendingQueue.includes(requestedTaskId)) {
        runtime.pendingQueue.unshift(requestedTaskId);
      }
      return requestedTaskId;
    }

    const selected = this.findNextEligibleTask(runtime);
    if (!selected) {
      throw new Error('No eligible tasks remain for selection.');
    }
    runtime.pendingQueue = runtime.pendingQueue.filter((taskId) => taskId !== selected);
    return selected;
  }

  private findNextEligibleTask(runtime: RuntimeState): string | undefined {
    const queue = runtime.pendingQueue.length > 0
      ? runtime.pendingQueue
      : runtime.decomposition.suggestedOrder;

    for (const taskId of queue) {
      const state = runtime.taskStates[taskId] ?? 'pending';
      if (state !== 'pending' && state !== 'running') continue;
      const task = runtime.decomposition.tasks.find((candidate) => candidate.id === taskId);
      if (!task) continue;
      const blockedBy = task.dependencies.filter((dependencyId) => {
        const dependencyState = runtime.taskStates[dependencyId] ?? 'pending';
        return dependencyState !== 'done';
      });
      if (blockedBy.length === 0) return taskId;
      if (blockedBy.some((dependencyId) => {
        const dependencyState = runtime.taskStates[dependencyId];
        return dependencyState === 'failed' || dependencyState === 'blocked';
      })) {
        runtime.taskStates[taskId] = 'blocked';
      }
    }
    return undefined;
  }

  private renderReplanContext(runtime: RuntimeState, reason?: string): string {
    const stateSummary = runtime.decomposition.tasks.map((task) => {
      const status = runtime.taskStates[task.id] ?? 'pending';
      return `- ${task.id}: ${status} (${task.description})`;
    }).join('\n') || '- no tasks yet';

    const recentSummaries = runtime.summaries.slice(-4).map((summary) => (
      `- Pass ${summary.passNumber}: ${summary.summary}`
    )).join('\n') || '- no summaries yet';

    return [
      reason ? `Reason: ${reason}` : 'Reason: controller requested replan.',
      'Current task states:',
      stateSummary,
      'Recent execution context:',
      recentSummaries,
      'Preserve completed work and only adjust remaining or blocked tasks.',
    ].join('\n');
  }

  private handleInterrupted(runtime: RuntimeState): string {
    this.state.saveState({
      ...this.toWorkflowState(runtime),
      status: 'interrupted',
      interruptedAt: new Date().toISOString(),
      lastError:
        (typeof this.activeAbortController?.signal.reason === 'string'
          ? this.activeAbortController.signal.reason
          : undefined) ?? 'Interrupted by user',
    });
    return 'Workflow interrupted.';
  }

  private resolveTaskWorkingDirectory(taskWorktree: string, requested?: string): string {
    if (!requested || !requested.trim()) return taskWorktree;
    const candidate = requested.trim();

    const ensureWithinTaskWorktree = (pathValue: string): string => {
      const normalizedWorktree = resolve(taskWorktree);
      const normalizedPath = resolve(pathValue);
      if (
        normalizedPath === normalizedWorktree ||
        normalizedPath.startsWith(normalizedWorktree + sep)
      ) {
        return normalizedPath;
      }

      logger.warn(
        `Ignoring workingDirectory "${requested}" because it is outside task worktree ${taskWorktree}`,
      );
      return taskWorktree;
    };

    if (isAbsolute(candidate)) {
      return ensureWithinTaskWorktree(candidate);
    }

    return ensureWithinTaskWorktree(resolve(taskWorktree, candidate));
  }

  private getMaxPasses(role: string): number {
    const normalizedRole = role.trim().toLowerCase();
    const aliasMap: Record<string, string[]> = {
      implement: ['implement', 'coder'],
      refactor: ['refactor', 'coder'],
      document: ['document', 'coder'],
      review: ['review', 'reviewer'],
      test: ['test', 'reviewer'],
      analyze: ['analyze', 'reviewer', 'judge'],
    };
    const candidates = aliasMap[normalizedRole] ?? [normalizedRole];

    for (const candidate of candidates) {
      const step = this.workflow.steps.find(
        (s) => s.role.trim().toLowerCase() === candidate,
      );
      if (typeof step?.maxPasses === 'number') {
        return step.maxPasses;
      }
    }

    return 3;
  }

  private createRunId(seed?: string): string {
    const source = (seed ?? new Date().toISOString()).replace(/[:.]/g, '-');
    return `run-${source}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private buildFallbackReport(summaries: PassSummary[], userRequest: string): string {
    const lines = ['# Workflow Report', '', `**Request:** ${userRequest}`, ''];

    for (const summary of summaries) {
      lines.push(`## Pass ${summary.passNumber}`);
      lines.push(summary.summary);
      if (summary.unresolvedIssues.length > 0) {
        lines.push('');
        lines.push('**Unresolved issues:**');
        for (const issue of summary.unresolvedIssues) {
          lines.push(`- ${issue}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}
