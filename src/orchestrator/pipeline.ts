import { EventEmitter } from 'eventemitter3';
import type { AgentAdapter, TaskResult } from '../adapters/types.js';
import type { WorkflowConfig } from '../workflow/types.js';
import type { PassSummary } from '../state/types.js';
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
  'agent:start': (agentName: string, taskId: string) => void;
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

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class Pipeline extends EventEmitter<PipelineEvents> {
  private orchestrator: AgentAdapter;
  private registry: AgentRegistry;
  private workflow: WorkflowConfig;
  private state: StateStore;
  private worktreeManager: WorktreeManager;
  private globalPassCounter = 0;
  private userInputResolver: ((input: string) => void) | null = null;

  constructor(
    orchestratorAdapter: AgentAdapter,
    registry: AgentRegistry,
    workflow: WorkflowConfig,
    state: StateStore,
    worktreeManager: WorktreeManager,
  ) {
    super();
    this.orchestrator = orchestratorAdapter;
    this.registry = registry;
    this.workflow = workflow;
    this.state = state;
    this.worktreeManager = worktreeManager;
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
   * Execute the full orchestration pipeline for a user request.
   *
   * Flow: DECOMPOSE -> for each task (DISPATCH -> agent -> INGEST -> SUMMARIZE -> JUDGE) -> REPORT
   */
  async run(userRequest: string): Promise<string> {
    const agents = this.registry.list();
    const summaries: PassSummary[] = [];
    let passNumber = 0;
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
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
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

    // Save initial state
    this.state.saveState({
      status: 'running',
      userRequest,
      decomposition,
      currentTaskIndex: 0,
      passes: [],
      startedAt,
    });

    // -----------------------------------------------------------------------
    // Step 2–5: Execute tasks in suggested order
    // -----------------------------------------------------------------------
    const executionOrder = decomposition.suggestedOrder;
    const failedTaskIds = new Set<string>();

    for (const taskId of executionOrder) {
      const task = decomposition.tasks.find((t) => t.id === taskId);
      if (!task) {
        logger.warn(`Task ID "${taskId}" from suggestedOrder not found, skipping.`);
        continue;
      }

      // Skip tasks whose dependencies have failed
      const deps = task.dependencies ?? [];
      const blockedBy = deps.filter(d => failedTaskIds.has(d));
      if (blockedBy.length > 0) {
        logger.warn(`Skipping task ${taskId}: depends on failed task(s) ${blockedBy.join(', ')}`);
        failedTaskIds.add(taskId); // propagate failure
        continue;
      }

      // Check dependencies are met
      // (In this linear execution all previous tasks are done, but we log it)
      if (task.dependencies.length > 0) {
        logger.debug(
          `Task ${taskId} depends on: ${task.dependencies.join(', ')}`,
        );
      }

      passNumber++;

      try {
        const passSummary = await this.executeTaskWithReviewLoop(
          task,
          summaries,
          passNumber,
        );
        summaries.push(passSummary);
        this.state.addPassSummary(passSummary);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.emit('error', error, { step: 'task-execution', taskId });
        logger.error(`Task ${taskId} failed: ${error.message}`);
        failedTaskIds.add(taskId);

        // Continue to next task rather than aborting everything
        summaries.push({
          passNumber,
          summary: `Task ${taskId} failed: ${error.message}`,
          unresolvedIssues: [`Task ${taskId} failed and needs manual resolution`],
          contextForNextPass: error.message,
          filesInScope: [],
        });
      }

      // Update state progress
      this.state.saveState({
        status: 'running',
        userRequest,
        decomposition,
        currentTaskIndex: executionOrder.indexOf(taskId) + 1,
        passes: summaries.map((s, i) => ({
          passNumber: i + 1,
          taskId: executionOrder[i] ?? taskId,
          agentName:
            decomposition.tasks.find((t) => t.id === (executionOrder[i] ?? taskId))
              ?.agent ?? 'unknown',
          timestamp: new Date().toISOString(),
        })),
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
      finalReport = await report(this.orchestrator, summaries, userRequest);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', error, { step: 'report' });
      logger.error(`Report generation failed: ${error.message}`);
      // Fallback: produce a basic report from summaries
      finalReport = this.buildFallbackReport(summaries, userRequest);
    }

    this.emit('step:complete', 'report', { passCount: summaries.length });
    this.emit('report', finalReport);

    // Mark workflow as completed
    this.state.saveState({
      status: 'completed',
      userRequest,
      decomposition,
      currentTaskIndex: executionOrder.length,
      passes: summaries.map((s, i) => ({
        passNumber: i + 1,
        taskId: executionOrder[i] ?? `task-${i + 1}`,
        agentName:
          decomposition.tasks.find((t) => t.id === (executionOrder[i] ?? ''))
            ?.agent ?? 'unknown',
        timestamp: new Date().toISOString(),
      })),
      startedAt,
      completedAt: new Date().toISOString(),
    });

    return finalReport;
  }

  /**
   * Execute a single task with the implement -> review -> judge iteration cycle.
   * Loops until the judge says "done" or maxPasses is reached.
   */
  async executeTaskWithReviewLoop(
    task: DecomposeOutput['tasks'][number],
    previousSummaries: PassSummary[],
    passNumber: number,
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
      this.emit('step:start', 'dispatch', { taskId: task.id, pass: currentPass });

      const dispatchResult = await dispatch(
        this.orchestrator,
        { description: task.description, role: task.role },
        localSummaries,
        currentPass,
      );

      this.emit('step:complete', 'dispatch', { taskId: task.id, pass: currentPass });

      // -------------------------------------------------------------------
      // EXECUTE: send prompt to the assigned agent
      // -------------------------------------------------------------------
      const agent = this.registry.get(task.agent);
      if (!agent) {
        throw new Error(
          `Agent "${task.agent}" not found in registry. Available: ${this.registry.list().map((a) => a.name).join(', ')}`,
        );
      }

      this.emit('agent:start', agent.name, task.id);
      logger.info(`Dispatching to agent "${agent.name}"...`);

      const agentResult = await agent.execute({
        prompt: dispatchResult.agentPrompt,
        context: {
          workingDirectory: dispatchResult.workingDirectory ?? process.cwd(),
          files: task.scope.files,
        },
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
      this.emit('step:start', 'ingest', { taskId: task.id });

      latestIngest = await ingest(
        this.orchestrator,
        task.description,
        agentResult,
      );

      this.emit('step:complete', 'ingest', {
        taskId: task.id,
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
      this.emit('step:start', 'summarize', { taskId: task.id });

      latestSummary = await summarize(
        this.orchestrator,
        latestIngest,
        globalPass,
      );

      this.emit('step:complete', 'summarize', {
        taskId: task.id,
        summary: latestSummary.summary,
        unresolvedIssueCount: latestSummary.unresolvedIssues.length,
      });

      // -------------------------------------------------------------------
      // JUDGE: decide whether to continue iterating
      // -------------------------------------------------------------------
      this.emit('step:start', 'judge', { taskId: task.id });

      const judgment = await judge(
        this.orchestrator,
        latestIngest,
        localSummaries,
        currentPass,
        maxPasses,
      );

      this.emit('step:complete', 'judge', {
        taskId: task.id,
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
