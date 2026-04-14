import { EventEmitter } from 'eventemitter3';
import type { AgentAdapter, TaskResult } from '../adapters/types.js';
import type { WorkflowConfig } from '../workflow/types.js';
import type { PassRecord, PassSummary, WorkflowState } from '../state/types.js';
import { StateStore } from '../state/store.js';
import { WorktreeManager } from '../git/worktree.js';
import { logger } from '../utils/logger.js';
import { decompose, type DecomposeOutput } from './steps/decompose.js';
import { dispatch } from './steps/dispatch.js';
import { ingest, type IngestOutput } from './steps/ingest.js';
import { summarize } from './steps/summarize.js';
import { judge } from './steps/judge.js';
import { report } from './steps/report.js';

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface PipelineEvents {
  'step:start': (step: string, data?: Record<string, unknown>) => void;
  'step:complete': (step: string, data?: Record<string, unknown>) => void;
  'agent:start': (agentName: string, taskId: string, description: string) => void;
  'agent:output': (agentName: string, taskId: string, chunk: string) => void;
  'agent:complete': (agentName: string, taskId: string, result: TaskResult) => void;
  'report': (text: string) => void;
  'ask_user': (question: string) => void;
  'error': (error: Error, context?: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Agent registry (minimal interface the pipeline needs)
// ---------------------------------------------------------------------------

export interface AgentRegistry {
  get(name: string): AgentAdapter | undefined;
  list(): { name: string; capabilities: string[] }[];
}

interface ResumeParams {
  workflowState: WorkflowState;
  previousSummaries: PassSummary[];
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class Pipeline extends EventEmitter<PipelineEvents> {
  private orchestrator: AgentAdapter;
  private registry: AgentRegistry;
  private workflow: WorkflowConfig;
  private state: StateStore;
  private worktreeManager: WorktreeManager;
  private orchestratorModel?: string;
  private agentModels: Record<string, string | undefined>;
  private globalPassCounter = 0;
  private userInputResolver: ((input: string) => void) | null = null;
  private activeAbortController: AbortController | null = null;

  constructor(
    orchestratorAdapter: AgentAdapter,
    registry: AgentRegistry,
    workflow: WorkflowConfig,
    state: StateStore,
    worktreeManager: WorktreeManager,
    options?: {
      orchestratorModel?: string;
      agentModels?: Record<string, string | undefined>;
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
  }

  /**
   * Request input from the user. Emits 'ask_user' and returns a Promise
   * that resolves when provideUserInput() is called.
   */
  requestUserInput(question: string): Promise<string> {
    return new Promise<string>((resolve) => {
      this.userInputResolver = resolve;
      this.emit('ask_user', question);
    });
  }

  /**
   * Provide user input to a waiting requestUserInput() call.
   */
  provideUserInput(input: string): void {
    if (this.userInputResolver) {
      const resolve = this.userInputResolver;
      this.userInputResolver = null;
      resolve(input);
    }
  }

  /**
   * Mark the current workflow as interrupted so it can be resumed later.
   */
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

  /**
   * Cancel active work and persist interrupted state.
   */
  cancel(reason = 'Cancelled by user'): void {
    this.markInterrupted(reason);
    if (this.activeAbortController && !this.activeAbortController.signal.aborted) {
      this.activeAbortController.abort(reason);
    }
  }

  /**
   * Execute the full orchestration pipeline for a user request.
   *
   * Flow: DECOMPOSE -> for each task (DISPATCH -> agent -> INGEST -> SUMMARIZE -> JUDGE) -> REPORT
   */
  async run(userRequest: string): Promise<string> {
    const agents = this.registry.list();
    const startedAt = new Date().toISOString();

    // -----------------------------------------------------------------------
    // Step 1: DECOMPOSE
    // -----------------------------------------------------------------------
    this.emit('step:start', 'decompose', { userRequest });
    logger.info('Decomposing user request into tasks...');

    let decomposition: DecomposeOutput;
    try {
      decomposition = await decompose(
        this.orchestrator,
        userRequest,
        agents,
        this.workflow,
        this.orchestratorModel,
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error('Step decompose failed', {
        error: error.message,
        stack: error.stack,
      });
      this.emit('error', error, { step: 'decompose' });
      throw error;
    }

    this.emit('step:complete', 'decompose', {
      taskCount: decomposition.tasks.length,
      suggestedOrder: decomposition.suggestedOrder,
    });
    logger.info(
      `Decomposed into ${decomposition.tasks.length} tasks: ${decomposition.suggestedOrder.join(', ')}`,
    );

    return this.executeWithDecomposition({
      userRequest,
      decomposition,
      startTaskIndex: 0,
      summaries: [],
      passRecords: [],
      startedAt,
    });
  }

  /**
   * Resume a previously interrupted workflow from persisted state.
   */
  async resume({ workflowState, previousSummaries }: ResumeParams): Promise<string> {
    if (!workflowState.decomposition || workflowState.decomposition.tasks.length === 0) {
      throw new Error('Cannot resume workflow: no decomposition found in saved state.');
    }

    const maxTaskIndex = workflowState.decomposition.suggestedOrder.length;
    const startTaskIndex = Math.max(0, Math.min(workflowState.currentTaskIndex, maxTaskIndex));
    const maxSavedPass = previousSummaries.reduce((max, item) => Math.max(max, item.passNumber), 0);
    this.globalPassCounter = Math.max(this.globalPassCounter, maxSavedPass);

    return this.executeWithDecomposition({
      userRequest: workflowState.userRequest,
      decomposition: workflowState.decomposition,
      startTaskIndex,
      summaries: [...previousSummaries],
      passRecords: [...workflowState.passes],
      startedAt: workflowState.startedAt ?? new Date().toISOString(),
    });
  }

  private async executeWithDecomposition(params: {
    userRequest: string;
    decomposition: DecomposeOutput;
    startTaskIndex: number;
    summaries: PassSummary[];
    passRecords: PassRecord[];
    startedAt: string;
  }): Promise<string> {
    const {
      userRequest,
      decomposition,
      startTaskIndex,
      summaries,
      passRecords,
      startedAt,
    } = params;

    this.persistRunningState({
      userRequest,
      decomposition,
      currentTaskIndex: startTaskIndex,
      passRecords,
      startedAt,
    });

    const executionOrder = decomposition.suggestedOrder;
    const failedTaskIds = new Set<string>();
    let hadErrors = false;
    this.activeAbortController = new AbortController();

    try {
      for (let taskIndex = startTaskIndex; taskIndex < executionOrder.length; taskIndex++) {
      const taskId = executionOrder[taskIndex];
      const task = decomposition.tasks.find((t) => t.id === taskId);
      if (!task) {
        logger.warn(`Task ID "${taskId}" from suggestedOrder not found, skipping.`);
        hadErrors = true;
        continue;
      }

      // Skip tasks whose dependencies have failed
      const deps = task.dependencies ?? [];
      const blockedBy = deps.filter(d => failedTaskIds.has(d));
      if (blockedBy.length > 0) {
        logger.warn(`Skipping task ${taskId}: depends on failed task(s) ${blockedBy.join(', ')}`);
        failedTaskIds.add(taskId);
        hadErrors = true;
        summaries.push({
          passNumber: this.globalPassCounter + 1,
          summary: `Task ${taskId} was skipped because dependencies failed: ${blockedBy.join(', ')}`,
          unresolvedIssues: [`Blocked by failed dependencies: ${blockedBy.join(', ')}`],
          contextForNextPass: 'Dependency failure must be resolved before rerun.',
          filesInScope: task.scope.files ?? [],
        });
        this.globalPassCounter++;
        this.state.addPassSummary(summaries[summaries.length - 1]);
        this.persistRunningState({
          userRequest,
          decomposition,
          currentTaskIndex: taskIndex + 1,
          passRecords,
          startedAt,
        });
        continue;
      }

      // Check dependencies are met
      // (In this linear execution all previous tasks are done, but we log it)
      if (task.dependencies.length > 0) {
        logger.debug(
          `Task ${taskId} depends on: ${task.dependencies.join(', ')}`,
        );
      }

      try {
        const passSummary = await this.executeTaskWithReviewLoop(
          task,
          summaries,
        );
        summaries.push(passSummary);
        this.state.addPassSummary(passSummary);
        passRecords.push({
          passNumber: passSummary.passNumber,
          taskId: task.id,
          agentName: task.agent,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error(`Task execution failed for ${taskId}`, {
          error: error.message,
          stack: error.stack,
        });
        this.emit('error', error, { step: 'task-execution', taskId });
        logger.error(`Task ${taskId} failed: ${error.message}`);
        failedTaskIds.add(taskId);
        hadErrors = true;

        // Continue to next task rather than aborting everything
        const failedSummary: PassSummary = {
          passNumber: this.globalPassCounter + 1,
          summary: `Task ${taskId} failed: ${error.message}`,
          unresolvedIssues: [`Task ${taskId} failed and needs manual resolution`],
          contextForNextPass: error.message,
          filesInScope: task.scope.files ?? [],
        };
        this.globalPassCounter++;
        summaries.push(failedSummary);
        this.state.addPassSummary(failedSummary);
      }

      this.persistRunningState({
        userRequest,
        decomposition,
        currentTaskIndex: taskIndex + 1,
        passRecords,
        startedAt,
      });
    }

      // -----------------------------------------------------------------------
      // Step 6: REPORT
      // -----------------------------------------------------------------------
      this.emit('step:start', 'report');
      logger.info('Generating final report...');

      let finalReport: string;
      try {
        finalReport = await report(
          this.orchestrator,
          summaries,
          userRequest,
          this.orchestratorModel,
        );
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.emit('error', error, { step: 'report' });
        logger.error(`Report generation failed: ${error.message}`);
        logger.error('Report step error details', {
          error: error.message,
          stack: error.stack,
        });
        hadErrors = true;
        // Fallback: produce a basic report from summaries
        finalReport = this.buildFallbackReport(summaries, userRequest);
      }

      this.emit('step:complete', 'report', { passCount: summaries.length });
      this.emit('report', finalReport);

      // Mark workflow as completed (or failed when we recovered with a fallback/partial output)
      this.state.saveState({
        status: hadErrors ? 'failed' : 'completed',
        userRequest,
        decomposition,
        currentTaskIndex: executionOrder.length,
        passes: passRecords,
        startedAt,
        completedAt: new Date().toISOString(),
        lastError: hadErrors ? 'One or more tasks failed or were skipped.' : undefined,
      });

      return finalReport;
    } finally {
      this.activeAbortController = null;
    }
  }

  /**
   * Execute a single task with the implement -> review -> judge iteration cycle.
   * Loops until the judge says "done" or maxPasses is reached.
   */
  async executeTaskWithReviewLoop(
    task: DecomposeOutput['tasks'][number],
    previousSummaries: PassSummary[],
  ): Promise<PassSummary> {
    const maxPasses = this.getMaxPasses(task.role);
    let currentPass = 1;
    let latestIngest: IngestOutput | undefined;
    let latestSummary: PassSummary | undefined;
    const localSummaries = [...previousSummaries];

    while (currentPass <= maxPasses) {
      logger.info(
        `Task ${task.id} (${task.role}): pass ${currentPass}/${maxPasses}`,
      );

      // -------------------------------------------------------------------
      // DISPATCH: craft the agent prompt
      // -------------------------------------------------------------------
      this.emit('step:start', 'dispatch', { taskId: task.id, taskDescription: task.description, pass: currentPass });

      const dispatchResult = await dispatch(
        this.orchestrator,
        { description: task.description, role: task.role },
        localSummaries,
        currentPass,
        this.orchestratorModel,
      );

      this.emit('step:complete', 'dispatch', { taskId: task.id, taskDescription: task.description, pass: currentPass });

      // -------------------------------------------------------------------
      // EXECUTE: send prompt to the assigned agent
      // -------------------------------------------------------------------
      const agent = this.registry.get(task.agent);
      if (!agent) {
        throw new Error(
          `Agent "${task.agent}" not found in registry. Available: ${this.registry.list().map((a) => a.name).join(', ')}`,
        );
      }

      this.emit('agent:start', agent.name, task.id, task.description);
      logger.info(`Dispatching to agent "${agent.name}"...`);

      const agentResult = await agent.execute({
        prompt: dispatchResult.agentPrompt,
        context: {
          workingDirectory: dispatchResult.workingDirectory ?? process.cwd(),
          files: task.scope.files,
        },
        constraints: {
          model: this.agentModels[task.agent],
          signal: this.activeAbortController?.signal,
        },
        onOutput: (chunk) => this.emit('agent:output', agent.name, task.id, chunk),
      });

      // If the adapter didn't report modified files, try to detect them via worktree
      if (agentResult.filesModified.length === 0) {
        try {
          const detectedFiles = await this.worktreeManager.getModifiedFiles(task.id);
          if (detectedFiles.length > 0) {
            agentResult.filesModified = detectedFiles;
            logger.debug(
              `Detected ${detectedFiles.length} modified files via worktree`,
            );
          }
        } catch {
          // Worktree detection is best-effort
          logger.debug('Could not detect modified files via worktree');
        }
      }

      this.emit('agent:complete', agent.name, task.id, agentResult);

      // -------------------------------------------------------------------
      // INGEST: analyze the agent's output
      // -------------------------------------------------------------------
      this.emit('step:start', 'ingest', { taskId: task.id, taskDescription: task.description });

      latestIngest = await ingest(
        this.orchestrator,
        task.description,
        agentResult,
        this.orchestratorModel,
      );

      this.emit('step:complete', 'ingest', {
        taskId: task.id,
        taskDescription: task.description,
        status: latestIngest.status,
        summary: latestIngest.summary,
        needsHumanAttention: latestIngest.needsHumanAttention,
      });
      const globalPass = ++this.globalPassCounter;
      this.state.addPassOutput(globalPass, latestIngest);

      // Check if human attention is needed
      if (latestIngest.needsHumanAttention) {
        logger.warn(
          `Task ${task.id} needs human attention: ${latestIngest.humanAttentionReason}`,
        );
        const userResponse = await this.requestUserInput(
          latestIngest.humanAttentionReason ?? 'Agent requires human input',
        );
        // Feed user response into the next dispatch as additional context
        localSummaries.push({
          passNumber: currentPass,
          summary: `User provided input: ${userResponse}`,
          unresolvedIssues: [],
          contextForNextPass: userResponse,
          filesInScope: [],
        });
      }

      // -------------------------------------------------------------------
      // SUMMARIZE: compress for context window
      // -------------------------------------------------------------------
      this.emit('step:start', 'summarize', { taskId: task.id, taskDescription: task.description });

      latestSummary = await summarize(
        this.orchestrator,
        latestIngest,
        globalPass,
        this.orchestratorModel,
      );

      this.emit('step:complete', 'summarize', {
        taskId: task.id,
        taskDescription: task.description,
        summary: latestSummary.summary,
        unresolvedIssueCount: latestSummary.unresolvedIssues.length,
      });

      // -------------------------------------------------------------------
      // JUDGE: decide whether to continue iterating
      // -------------------------------------------------------------------
      this.emit('step:start', 'judge', { taskId: task.id, taskDescription: task.description });

      const judgment = await judge(
        this.orchestrator,
        latestIngest,
        localSummaries,
        currentPass,
        maxPasses,
        this.orchestratorModel,
      );

      this.emit('step:complete', 'judge', {
        taskId: task.id,
        taskDescription: task.description,
        decision: judgment.decision,
        reasoning: judgment.reasoning,
        isLooping: judgment.isLooping,
      });
      logger.info(
        `Judge decision for ${task.id}: ${judgment.decision} — ${judgment.reasoning}`,
      );

      if (judgment.isLooping) {
        logger.warn(
          `Loop detected for task ${task.id}: ${judgment.loopDescription ?? 'same issues repeating'}`,
        );
      }

      if (judgment.decision === 'done') {
        break;
      }

      if (judgment.decision === 'ask_user') {
        const userResponse = await this.requestUserInput(
          judgment.questionForUser ?? 'The orchestrator needs your input.',
        );
        // Feed user response into the next dispatch as additional context
        localSummaries.push({
          passNumber: currentPass,
          summary: `User provided input: ${userResponse}`,
          unresolvedIssues: [],
          contextForNextPass: userResponse,
          filesInScope: [],
        });
        currentPass++;
        continue;
      }

      if (judgment.isLooping) {
        // Break out of the loop — accept current state
        break;
      }

      // iterate: add summary to local context and continue
      localSummaries.push(latestSummary);
      currentPass++;
    }

    if (!latestSummary) {
      // Should not happen, but guard against it
      throw new Error(`Task ${task.id} produced no summary after execution`);
    }

    return latestSummary;
  }

  /**
   * Determine max passes for a given task role.
   */
  private getMaxPasses(role: string): number {
    const step = this.workflow.steps.find((s) => s.role === role);
    return step?.maxPasses ?? 3;
  }

  private persistRunningState(params: {
    userRequest: string;
    decomposition: DecomposeOutput;
    currentTaskIndex: number;
    passRecords: PassRecord[];
    startedAt: string;
  }): void {
    this.state.saveState({
      status: 'running',
      userRequest: params.userRequest,
      decomposition: params.decomposition,
      currentTaskIndex: params.currentTaskIndex,
      passes: params.passRecords,
      startedAt: params.startedAt,
    });
  }

  /**
   * Build a basic fallback report when LLM report generation fails.
   */
  private buildFallbackReport(
    summaries: PassSummary[],
    userRequest: string,
  ): string {
    const lines = [`# Workflow Report`, '', `**Request:** ${userRequest}`, ''];

    for (const s of summaries) {
      lines.push(`## Pass ${s.passNumber}`);
      lines.push(s.summary);
      if (s.unresolvedIssues.length > 0) {
        lines.push('');
        lines.push('**Unresolved issues:**');
        for (const issue of s.unresolvedIssues) {
          lines.push(`- ${issue}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}
