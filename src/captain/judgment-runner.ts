import { randomUUID } from 'crypto';
import { z } from 'zod';
import type {
  AgentAdapter,
  TaskResult,
  ToolLoopMessage,
  ToolLoopResult,
} from '../adapters/types.js';
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
import { CaptainActionServer } from './action-server.js';
import type { ProviderSession } from '../provider-session.js';
import { isCliVersionCompatible } from '../provider-session.js';
import { AdapterId } from '../workflow/agents.js';
import {
  decompose,
  dispatch,
  ingest,
  judge,
  report,
  summarize,
  type DecomposeOutput,
  type IngestOutput,
} from './steps/index.js';
import type { DispatchOutput } from './steps/dispatch.js';
import type { SummarizeOutput } from './steps/summarize.js';
import type { JudgeOutput } from './steps/judge.js';
import type { AgentRegistry, PipelineEvents } from './pipeline.js';
import type { CrewRunner, ResumeParams } from './runner.js';
import { RunnerBase } from './runner-base.js';
import { CaptainSession } from './session.js';
import { ToolDispatcher } from './tool-dispatcher.js';
import { dispatchAskUser, waitForUserResponse } from './tools/ask-user.js';
import { ToolCatalog as M3ToolCatalog } from './tools/catalog.js';
import { planRunAgent } from './tools/run-agent.js';
import { listAgents } from './tools/list-agents.js';
import { dispatchMessageUser } from './tools/message-user.js';
import { dispatchFinish } from './tools/finish.js';
import { dispatchPlanTasks } from './tools/plan-tasks.js';
import { dispatchAnalyzeOutput } from './tools/analyze-output.js';
import { dispatchCompressContext } from './tools/compress-context.js';
import { buildCaptainSystemPrompt } from './prompts/captain-system.js';
import { resolveCaptainConverter } from './mcp-registration.js';
import type { WorkflowConfig, PresetConfig, FullConfig } from '../workflow/types.js';
import {
  SessionLoop,
  type SessionLoopTurn,
  type SessionLoopToolCall,
  type ToolCallScheduler,
} from './session-loop.js';
import {
  buildFallbackReport as buildWorkflowFallbackReport,
  createRunId as createWorkflowRunId,
  getMaxPasses,
  resolveCaptainModel,
  resolveTaskModel,
  resolveTaskWorkingDirectory,
  type CaptainStage,
} from './task-execution-core.js';

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

// Per-action payload fields, unioned into a bounded loose shape.
// Anthropic structured-output stalls 5m on z.record(string, unknown)'s rendered
// schema (propertyNames + additionalProperties:{}). z.any() avoids the stall
// but renders as `{}`, giving the model no structure hint about what fields
// each action expects. This explicit object renders as a plain JSON Schema
// object with `properties` and `additionalProperties: false`, which the API
// accepts and which nudges the model toward the right per-action fields:
//   - taskId: select_task, run_dispatch, run_execute, run_ingest,
//             run_summarize, run_judge
//   - question: ask_user
//   - reason: replan
//   - tasks / suggestedOrder: result fields from run_decompose / replan
// Per-action input is still re-validated by each action's inputSchema in
// executeActionDecision, so extra properties here are harmless.
const ControllerDecisionPayloadSchema = z.object({
  taskId: z.string().optional(),
  question: z.string().optional(),
  reason: z.string().optional(),
  tasks: z.array(z.any()).optional(),
  suggestedOrder: z.array(z.string()).optional(),
}).optional();

const ControllerDecisionSchema = z.object({
  reasoning: z.string(),
  action: ControllerActionNameSchema,
  target: z.object({
    taskId: z.string().optional(),
  }).optional(),
  payload: ControllerDecisionPayloadSchema,
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

/**
 * Captain tool surface selector. `'m3-tools'` (default as of M3-10b) is the
 * 8-tool surface introduced in M3-4 (ToolCatalog), scheduled via
 * buildM3SessionLoopPair. `'legacy'` is the pre-M3 11-verb controller
 * surface; kept alive for migration-coverage tests and deprecated. A
 * follow-up milestone deletes the legacy path entirely (matches the
 * architectural plan's "zero 11-verb hits in src/" exit gate; tests under
 * test/captain/judgment-runner*.test.ts opt in explicitly until migrated).
 */
export type CaptainToolSurface = 'legacy' | 'm3-tools';

export class JudgmentRunner extends RunnerBase implements CrewRunner {
  private captain: AgentAdapter;
  private registry: AgentRegistry;
  private workflow: WorkflowConfig;
  private state: StateStore;
  private worktreeManager: WorktreeManager;
  private captainModel?: string;
  private agentModels: Record<string, string | undefined>;
  private actions: ActionDefinitions;
  private actionServer: CaptainActionServer;
  private guardrails: Guardrails;
  private session: CaptainSession | undefined;
  private dispatcher: ToolDispatcher | undefined;
  private readonly toolSurface: CaptainToolSurface;
  private readonly preset: PresetConfig | undefined;
  // Cached so successive turns don't rebuild — the catalog is pure relative
  // to (registry, workflow, preset) and those don't mutate after construction.
  private m3Catalog: M3ToolCatalog | undefined;

  constructor(
    captainAdapter: AgentAdapter,
    registry: AgentRegistry,
    workflow: WorkflowConfig,
    state: StateStore,
    worktreeManager: WorktreeManager,
    options?: {
      captainModel?: string;
      agentModels?: Record<string, string | undefined>;
      guardrails?: Partial<Guardrails>;
      /**
       * Persistent captain session. When present, ask_user action handlers
       * dispatch through the ToolDispatcher rather than the slot-based shim.
       * M1.5-10 wires this from create-runner.
       */
      session?: CaptainSession;
      /**
       * Shared ToolDispatcher for in-flight tool calls. When present, the
       * ask_user action dispatches directly; subagent runs in M3 will use the
       * same dispatcher.
       */
      dispatcher?: ToolDispatcher;
      /**
       * Which captain tool surface to present. Default `'m3-tools'` post-
       * M3-10b; legacy tests opt in via `'legacy'`. Opt-in via constructor
       * option (NOT an env var) so tool-schema hashes stay stable across
       * parallel CI workers.
       */
      toolSurface?: CaptainToolSurface;
      /**
       * Active preset — consumed by the M3 captain-system prompt. Passed
       * through from create-runner; absent → no hint injected.
       */
      preset?: PresetConfig;
    },
  ) {
    super(state);
    this.captain = captainAdapter;
    this.registry = registry;
    this.workflow = workflow;
    this.state = state;
    this.worktreeManager = worktreeManager;
    this.captainModel = options?.captainModel;
    this.agentModels = options?.agentModels ?? {};
    this.guardrails = {
      ...DEFAULT_GUARDRAILS,
      ...(options?.guardrails ?? {}),
    };
    this.session = options?.session;
    this.dispatcher = options?.dispatcher;
    this.toolSurface = options?.toolSurface ?? 'm3-tools';
    this.preset = options?.preset;
    this.actions = this.buildActionRegistry();
    this.actionServer = this.buildActionServer();
  }

  getSession(): CaptainSession | undefined {
    return this.session;
  }

  getDispatcher(): ToolDispatcher | undefined {
    return this.dispatcher;
  }

  /**
   * Override RunnerBase.cancel() to abort our activeAbortController. When
   * the session-loop is active, that signal is the loop's externalSignal —
   * the loop's abort handler calls loop.cancel() which owns
   * dispatcher.cancelAll + currentTurn abort. Single-owner cascade (S5).
   *
   * For the legacy path (no session-loop), the native-loop consumes the
   * AbortController signal directly; dispatcher is typically absent.
   */
  override cancel(reason = 'Cancelled by user'): void {
    super.cancel(reason);
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

  /**
   * M1.5-6b entry point. Drives the captain via SessionLoop. Branches on
   * `this.toolSurface`:
   *   - `'legacy'`: 11-verb controller via buildSessionLoopCaptain +
   *     buildSessionLoopScheduler. Each turn pulls one structured decision,
   *     executes synchronous actions inline, dispatches run_execute and
   *     ask_user via ToolDispatcher.
   *   - `'m3-tools'`: 8-tool surface via buildM3SessionLoopCaptain +
   *     buildM3Scheduler. The captain emits real tool_calls over the 8 M3
   *     tools (run_agent, list_agents, ask_user, message_user, plan_tasks,
   *     analyze_output, compress_context, finish).
   *
   * M3-10a adds the branch; M3-10b flips the default to `'m3-tools'` and
   * deletes the legacy pair.
   */
  async executeSessionLoop(runtime: RuntimeState): Promise<string> {
    if (!this.session || !this.dispatcher) {
      throw new Error(
        'executeSessionLoop requires session + dispatcher injected in constructor (M1.5-10 wires these).',
      );
    }
    this.activeAbortController = new AbortController();

    // Seed the session with the initial user message so the loop has work.
    if (this.session.getMessages().length === 0) {
      this.session.appendUserMessage(runtime.userRequest);
    }

    const { captainTurn, scheduler, actionServer } = this.toolSurface === 'm3-tools'
      ? this.buildM3SessionLoopPair(runtime)
      : this.buildLegacySessionLoopPair(runtime);

    // Wire dispatcher cleanup: terminal dispatcher events with a runId should
    // release the per-run worktree (M1.5-14 integration).
    const cleanupListeners = [
      this.dispatcher.onEvent('run:complete', (info) => {
        if (info.runId) void this.worktreeManager.cleanupByRunId(info.runId);
      }),
      this.dispatcher.onEvent('run:failed', (info) => {
        if (info.runId) void this.worktreeManager.cleanupByRunId(info.runId);
      }),
      this.dispatcher.onEvent('run:cancelled', (info) => {
        if (info.runId) void this.worktreeManager.cleanupByRunId(info.runId);
      }),
    ];

    const loop = new SessionLoop({
      session: this.session,
      dispatcher: this.dispatcher,
      captain: captainTurn,
      scheduler,
      maxTurns: this.guardrails.maxTotalActions,
    });

    try {
      const { finalReport } = await loop.run({
        externalSignal: this.activeAbortController.signal,
      });
      if (finalReport) runtime.finalReport = finalReport;
      // Use the active action-server's hash for logging continuity in M3
      // mode; legacy mode already returned its own hash elsewhere.
      void actionServer;
      return runtime.finalReport ?? this.buildFallbackReport(runtime.summaries, runtime.userRequest);
    } finally {
      for (const l of cleanupListeners) l.dispose();
      this.activeAbortController = null;
    }
  }

  /**
   * @deprecated M3-10b flipped the default to 'm3-tools'. This legacy pair
   * survives only so opted-in migration-coverage tests
   * (`toolSurface: 'legacy'`) can exercise the 11-verb controller flow
   * while the test fixtures are rewritten. A follow-up milestone removes
   * the legacy pair entirely — once the audit in the plan's exit gate
   * ("grep -r run_execute src/" returns zero hits) can pass.
   */
  private buildLegacySessionLoopPair(runtime: RuntimeState): {
    captainTurn: SessionLoopTurn;
    scheduler: ToolCallScheduler;
    actionServer: CaptainActionServer;
  } {
    return {
      captainTurn: this.buildSessionLoopCaptain(runtime),
      scheduler: this.buildSessionLoopScheduler(runtime),
      actionServer: this.actionServer,
    };
  }

  private buildSessionLoopCaptain(runtime: RuntimeState): SessionLoopTurn {
    return {
      execute: async (args) => {
        // One structured decision per turn. Captain sees the current message
        // log (via args.messages) but we build the controller prompt from
        // runtime state — the runtime is the source of truth for task
        // planning, and messages are just the captain's conversation history
        // for stateful-resume adapters.
        //
        // Concurrency note (S3): a dispatched run_execute task runs
        // concurrently with this captain turn. The dispatched task calls
        // executeActionDecision which appends to runtime.actionHistory,
        // taskStates, etc. JavaScript's single-threaded model means no
        // torn writes, but this turn may read a snapshot that's a few
        // operations behind the "live" state. That's acceptable: each
        // decision is evaluated against the state-at-decision-time and
        // validated against the then-current runtime; stale reads
        // produce a slightly older decision, not a corrupted one.
        //
        // The one collision risk — toolCallId generation colliding between
        // concurrent turns — is eliminated by using randomUUID below.
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
              reasoning: 'finish requires finalize_report first; applying deterministic fallback',
              action: 'finalize_report',
              payload: {},
            };
          } else {
            return { done: true, finalReport: runtime.finalReport };
          }
        }

        if (decision.action === 'fail') {
          throw new Error(`Controller aborted run: ${decision.reasoning}`);
        }

        // S3: use randomUUID to keep toolCallIds collision-free under
        // concurrent execution. The prior `ctl-${actionHistory.length}-...`
        // scheme could collide between a captain turn and a concurrent
        // dispatcher task both reading the same length. randomUUID is
        // cheap and decouples id generation from runtime state.
        const toolCallId = `ctl-${randomUUID()}`;

        if (decision.action === 'run_execute') {
          return {
            toolCalls: [
              {
                toolCallId,
                toolName: 'run_execute',
                input: { decision: decision as unknown as Record<string, unknown> },
              },
            ],
          };
        }
        if (decision.action === 'ask_user') {
          return {
            toolCalls: [
              {
                toolCallId,
                toolName: 'ask_user',
                input: { decision: decision as unknown as Record<string, unknown> },
              },
            ],
          };
        }

        // Synchronous action: execute inline, record the action result, and
        // emit a synthetic tool_call+tool_result pair so the session log
        // stays faithful.
        return {
          toolCalls: [
            {
              toolCallId,
              toolName: decision.action,
              input: { decision: decision as unknown as Record<string, unknown> },
            },
          ],
        };
      },
      // S2: wire the M1.5-8 self-heal. When the session-loop detects a
      // provider-session rejection (providerSessionRejected in a prior
      // turn's result), it calls this to re-probe the CLI version and
      // update session.cliVersionTag. The captain adapter provides the
      // actual detection function.
      refreshCliVersionTag: async () => {
        if (!this.captain.getCliVersionTag) return undefined;
        return this.session?.refreshCliVersionTag(() =>
          (this.captain.getCliVersionTag as () => Promise<string | undefined>)(),
        );
      },
    };
  }

  private buildSessionLoopScheduler(runtime: RuntimeState): ToolCallScheduler {
    return {
      schedule: async (call, _ctx) => {
        const decision = (call.input as { decision?: ControllerDecision }).decision;
        if (!decision) {
          return { kind: 'synchronous', result: { ok: false, error: 'missing decision' }, status: 'error' };
        }

        if (call.toolName === 'run_execute') {
          // Long-running subagent. Dispatch via ToolDispatcher; the tool_result
          // will arrive on run:complete and trigger the next captain turn.
          //
          // S4: no activeAbortController shuffle. Each dispatched task owns
          // its own per-call AbortController inside the dispatcher's map;
          // taskCtx.signal is what cooperative work should observe.
          //
          // subagentRunId matches the worktree runKey the handler will
          // derive (workflowRunId:taskId:executionCountBeforeIncrement),
          // so the cleanup listener can target the right worktree.
          const taskId = decision.target?.taskId ?? '';
          const executionCountBefore = runtime.taskExecutionCounts[taskId] ?? 0;
          const subagentRunId = `${runtime.runId}:${taskId}:${executionCountBefore}`;
          return {
            kind: 'dispatched',
            task: {
              toolCallId: call.toolCallId,
              toolName: 'run_execute',
              runId: subagentRunId,
              run: async (_taskCtx) => {
                await this.executeActionDecision(decision, runtime, 'adapter');
                return {
                  ok: true,
                  action: 'run_execute',
                  taskId,
                  sequence: runtime.actionHistory.length,
                };
              },
            },
          };
        }

        if (call.toolName === 'ask_user') {
          // Single dispatcher task per ask_user. The task awaits the next
          // user_message via the shared coordinator (waitForUserResponse);
          // when it resolves, the dispatcher emits run:complete and the
          // SessionLoop's listener writes the single tool_result for this
          // toolCallId. No double-dispatch (B2 fix).
          const question =
            typeof (decision.payload as { question?: string } | undefined)?.question === 'string'
              ? (decision.payload as { question: string }).question
              : 'Captain needs your input.';
          return {
            kind: 'dispatched',
            task: {
              toolCallId: call.toolCallId,
              toolName: 'ask_user',
              run: async (askCtx) => {
                const response = await waitForUserResponse(this.session!, askCtx.signal);
                const syntheticSummary: PassSummary = {
                  passNumber: runtime.globalPassCounter + 1,
                  summary: `User input: ${response}`,
                  unresolvedIssues: [],
                  contextForNextPass: response,
                  filesInScope: [],
                };
                runtime.summaries.push(syntheticSummary);
                return { ok: true, question, response };
              },
            },
          };
        }

        // Synchronous: execute inline, return the output.
        try {
          await this.executeActionDecision(decision, runtime, 'adapter');
          this.persistRuntimeState(runtime, 'running');
          return {
            kind: 'synchronous',
            result: {
              ok: true,
              action: decision.action,
              taskId: decision.target?.taskId,
              sequence: runtime.actionHistory.length,
            },
            status: 'success',
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            kind: 'synchronous',
            result: { ok: false, action: decision.action, error: message },
            status: 'error',
          };
        }
      },
    };
  }

  private async execute(runtime: RuntimeState): Promise<string> {
    // Session-loop path (M1.5-6b) — used whenever session + dispatcher are
    // injected (create-runner wires them in production via M1.5-10).
    if (this.session && this.dispatcher) {
      try {
        const finalReport = await this.executeSessionLoop(runtime);
        runtime.finalReport = finalReport;
        this.state.saveState({
          ...this.toWorkflowState(runtime),
          status: runtime.hadErrors ? 'failed' : 'completed',
          completedAt: new Date().toISOString(),
          lastError: runtime.hadErrors
            ? 'Judgment workflow completed with recoverable errors.'
            : undefined,
        });
        if (finalReport && !runtime.reportFinalized) {
          this.emit('report', finalReport);
        }
        return finalReport;
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.state.saveState({
          ...this.toWorkflowState(runtime),
          status: 'failed',
          completedAt: new Date().toISOString(),
          lastError: error.message,
        });
        this.emit('error', error, { step: 'judgment' });
        throw error;
      }
    }

    // Legacy path: no session / dispatcher provided (older tests,
    // pipeline-linear callers). Preserved as a fallback; M3 will delete
    // once all test fixtures are migrated.
    this.activeAbortController = new AbortController();

    try {
      const supportsAdapterToolLoop = Boolean(
        this.captain.captainCapabilities?.supportsToolLoop
        && this.captain.executeWithTools
      );

      let interrupted = false;
      if (supportsAdapterToolLoop) {
        try {
          interrupted = await this.executeNativeToolLoop(runtime);
        } catch (error: unknown) {
          runtime.hadErrors = true;
          // M1.5-7: do NOT clear providerSession on non-fatal errors.
          // The session (durable message log + schema-validated ref) is the
          // source of truth for continuity; a single failed tool-loop turn
          // shouldn't nuke the ref and force a full replay.
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
      // M1.5-7: don't wipe providerSession on fatal errors either — the
      // CaptainSession invalidates only on schema/cliVersion drift. Letting
      // the ref survive means a retry can resume rather than replay.
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

  /**
   * @deprecated M1.5-6b — the SessionLoop path (executeSessionLoop) is the
   * production driver when create-runner wires session+dispatcher. This
   * method is retained as a fallback for legacy tests that construct a
   * JudgmentRunner without them. M3 will delete along with pipeline.ts.
   */
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

  /** @deprecated M1.5-6b — see executeFallbackLoop. M3: delete. */
  private async executeNativeToolLoop(runtime: RuntimeState): Promise<boolean> {
    if (!this.captain.executeWithTools) {
      throw new Error('Adapter does not implement executeWithTools.');
    }
    const supportsPauseForUserInput = Boolean(
      this.captain.captainCapabilities?.supportsPauseForUserInput,
    );

    const tools = this.actionServer.listTools();
    const startMessages = runtime.toolCallTranscript && runtime.toolCallTranscript.length > 0
      ? runtime.toolCallTranscript.map((message) => ({ ...message }))
      : this.buildNativeStartMessages(runtime);
    let latestTranscript = this.cloneToolLoopMessages(startMessages) ?? [];

    const result = await this.captain.executeWithTools(
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
        const toolOutput = {
          ok: true,
          action: decision.action,
          taskId: decision.target?.taskId,
          sequence: runtime.actionHistory.length,
        };
        latestTranscript = [
          ...latestTranscript,
          {
            role: 'tool',
            name: call.name,
            content: JSON.stringify(toolOutput),
          },
        ];
        this.persistNativeLoopProgress(runtime, { toolCallTranscript: latestTranscript });
        return {
          output: toolOutput,
        };
      },
      {
        signal: this.activeAbortController?.signal,
        workingDirectory: process.cwd(),
        providerSession: runtime.providerSession,
        toolNamespace: this.actionServer.toolNamespace,
        toolSchemaHash: this.actionServer.getToolSchemaHash(),
        onProviderSession: (session) => {
          this.persistNativeLoopProgress(runtime, { providerSession: session });
        },
        onTranscriptUpdate: (transcript) => {
          latestTranscript = this.cloneToolLoopMessages(transcript) ?? [];
          this.persistNativeLoopProgress(runtime, { toolCallTranscript: transcript });
        },
      },
    );

    runtime.toolCallTranscript = this.selectMostAdvancedTranscript(
      runtime.toolCallTranscript,
      result.transcript,
    );
    if (result.providerSession) {
      runtime.providerSession = result.providerSession;
    }
    // M1.5-7: no longer reset on adapter/fallback paths — the session's
    // ref invalidation is handled by CaptainSession on schema/version drift.
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

    const expectedProvider = this.resolveProviderNameForAdapter(this.captain.name);
    if (savedSession.provider !== expectedProvider) {
      logger.warn(
        `Dropping provider session from ${savedSession.provider}; active adapter is ${this.captain.name}.`,
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

    if (!this.captain.getCliVersionTag) {
      logger.warn('Dropping provider session because adapter cannot validate CLI compatibility.');
      return undefined;
    }

    let detectedCliVersion: string | undefined;
    try {
      detectedCliVersion = await this.captain.getCliVersionTag();
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
    if (adapterName === AdapterId.CLAUDE_CODE) return 'claude';
    if (adapterName === AdapterId.CODEX) return 'codex';
    if (adapterName === AdapterId.GEMINI_CLI) return 'gemini';
    return 'local';
  }

  private rehydrateFromActionHistory(runtime: RuntimeState, history: ActionRecord[]): void {
    const sorted = [...history].sort((a, b) => a.sequence - b.sequence);

    for (const record of sorted) {
      runtime.actionHistory.push(record);
      runtime.controllerCursor = Math.max(runtime.controllerCursor, record.sequence);
      this.applyActionResult(runtime, record.action, record.result.data);
      if (record.action === 'run_execute' && record.result.status === 'success') {
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
      schemaVersion: 4,
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

  private cloneToolLoopMessages(
    transcript: ToolLoopMessage[] | undefined,
  ): WorkflowState['toolCallTranscript'] {
    return transcript?.map((message) => ({ ...message }));
  }

  private persistNativeLoopProgress(
    runtime: RuntimeState,
    updates: {
      providerSession?: ProviderSession;
      toolCallTranscript?: ToolLoopMessage[];
    },
  ): void {
    if ('providerSession' in updates) {
      runtime.providerSession = updates.providerSession;
    }
    if ('toolCallTranscript' in updates) {
      runtime.toolCallTranscript = this.cloneToolLoopMessages(updates.toolCallTranscript);
    }
    this.persistRuntimeState(runtime, 'running');
  }

  private selectMostAdvancedTranscript(
    current: WorkflowState['toolCallTranscript'],
    candidate: ToolLoopMessage[] | undefined,
  ): WorkflowState['toolCallTranscript'] {
    const currentTranscript = this.cloneToolLoopMessages(current);
    const candidateTranscript = this.cloneToolLoopMessages(candidate);
    if (!currentTranscript || currentTranscript.length === 0) {
      return candidateTranscript;
    }
    if (!candidateTranscript || candidateTranscript.length === 0) {
      return currentTranscript;
    }
    return candidateTranscript.length >= currentTranscript.length
      ? candidateTranscript
      : currentTranscript;
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

  private async dispatchAskUser(question: string): Promise<string> {
    // M1.5-11: ask_user is strictly dispatcher-backed. If a session+dispatcher
    // aren't injected (legacy tests), the call fails loudly so the missing
    // wiring is obvious.
    if (!this.session || !this.dispatcher) {
      throw new Error(
        'ask_user requires a CaptainSession + ToolDispatcher on the JudgmentRunner. '
        + 'M1.5-10 wires both via create-runner; pre-M1.5 slot fallback has been retired.',
      );
    }
    const result = await dispatchAskUser({
      session: this.session,
      dispatcher: this.dispatcher,
      question,
      externalSignal: this.activeAbortController?.signal,
    });
    return result.response;
  }

  private resolveTaskModel(task: { role: string; agent: string }): string | undefined {
    return resolveTaskModel(this.workflow, this.agentModels, task);
  }

  private resolveCaptainModel(stage: CaptainStage): string | undefined {
    return resolveCaptainModel(this.workflow, this.captainModel, stage);
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
            this.captain,
            runtime.userRequest,
            this.registry.list(),
            this.workflow,
            this.resolveCaptainModel('decompose'),
            { signal: this.activeAbortController?.signal },
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
            this.captain,
            { description: task.description, role: task.role },
            runtime.summaries,
            pass,
            this.resolveCaptainModel('dispatch'),
            { signal: this.activeAbortController?.signal },
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

          // M1.5-14: session-loop runs use the run-keyed worktree API
          // (.crew/runs/<subRunId>/worktree/). Each run_execute dispatch
          // gets a unique subRunId so concurrent run_executes never share
          // a worktree and so the dispatcher cleanup hook
          // (cleanupByRunId on terminal events) can release resources
          // eagerly. Iteration on the same task produces a fresh
          // worktree per call — the captain is expected to carry state
          // via the conversation + file-modified outputs, not the
          // worktree directory.
          //
          // Legacy (no session) path keeps the cached task-keyed layout
          // to preserve judgment-runner.test.ts fixtures exactly.
          const useRunKeyed = Boolean(this.session && this.dispatcher);
          let worktree: string;
          let runKey: string | undefined;
          if (useRunKeyed) {
            runKey = `${runtime.runId}:${task.id}:${executionCount}`;
            worktree = await this.worktreeManager.createRunWorktree(runKey);
          } else {
            worktree = runtime.taskWorktrees[task.id];
            if (!worktree) {
              worktree = await this.worktreeManager.createWorktree(task.id);
              runtime.taskWorktrees[task.id] = worktree;
            }
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
              const detectedFiles = useRunKeyed && runKey !== undefined
                ? await this.worktreeManager.getModifiedFilesByRun(runKey)
                : await this.worktreeManager.getModifiedFiles(task.id);
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
            this.captain,
            task.description,
            artifacts.agentResult,
            this.resolveCaptainModel('ingest'),
            { signal: this.activeAbortController?.signal },
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
            this.captain,
            ingestResult,
            passNumber,
            this.resolveCaptainModel('summarize'),
            { signal: this.activeAbortController?.signal },
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
            this.captain,
            ingestResult,
            runtime.summaries,
            currentPass,
            maxPasses,
            this.resolveCaptainModel('judge'),
            { signal: this.activeAbortController?.signal },
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
          const response = await this.dispatchAskUser(input.question);
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
            this.captain,
            replanPrompt,
            this.registry.list(),
            this.workflow,
            this.resolveCaptainModel('decompose'),
            { signal: this.activeAbortController?.signal },
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
              this.captain,
              runtime.summaries,
              runtime.userRequest,
              this.resolveCaptainModel('report'),
              { signal: this.activeAbortController?.signal },
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

  private buildActionServer(): CaptainActionServer {
    return new CaptainActionServer(
      Object.values(this.actions).map((action) => ({
        name: action.name,
        description: action.description,
        inputSchema: action.inputSchema,
      })),
    );
  }

  /**
   * M3-10a: lazy M3 tool catalog. Cached after first construction — the
   * inputs (registry, workflow, preset) don't mutate after `new
   * JudgmentRunner(...)`.
   */
  private getM3Catalog(): M3ToolCatalog {
    if (!this.m3Catalog) {
      this.m3Catalog = new M3ToolCatalog({
        registry: this.registry,
        workflow: this.workflow,
        preset: this.preset,
        session: this.session,
        dispatcher: this.dispatcher,
      });
    }
    return this.m3Catalog;
  }

  /**
   * M3-10a: build the M3 session-loop pair (captain-turn + scheduler +
   * action-server). The action-server is constructed from the ToolCatalog,
   * so its listTools() returns exactly the 8 M3 tools namespaced with
   * `mcp__crew__`.
   *
   * This is structurally parallel to buildLegacySessionLoopPair and lives
   * beside it; M3-10b deletes the legacy pair.
   */
  private buildM3SessionLoopPair(runtime: RuntimeState): {
    captainTurn: SessionLoopTurn;
    scheduler: ToolCallScheduler;
    actionServer: CaptainActionServer;
  } {
    const catalog = this.getM3Catalog();
    const actionServer = catalog.buildActionServer();
    const pendingDispatched = new Map<string, SessionLoopToolCall>();
    // Mutable summary for the finish tool. Typed explicitly so closures can
    // mutate it without TypeScript narrowing to `never`.
    const finishState: { summary: string | undefined } = { summary: undefined };

    const captainTurn: SessionLoopTurn = {
      execute: async (args) => {
        if (!this.captain.executeWithTools) {
          throw new Error(
            'M3 captain-turn requires adapter.executeWithTools. Got: ' + this.captain.name,
          );
        }
        pendingDispatched.clear();
        finishState.summary = undefined;

        const agents = catalog.toPromptAgentInventory();
        const tools = actionServer.listTools();
        const systemPrompt = buildCaptainSystemPrompt({
          workflow: this.workflow,
          agents,
          preset: this.preset,
          tools: tools.map((t) => ({
            // strip the mcp__crew__ prefix so the prompt matches how the
            // adapter will present the tool to the model.
            name: t.name.startsWith(actionServer.toolNamespace)
              ? t.name.slice(actionServer.toolNamespace.length)
              : t.name,
            description: t.description,
          })),
        });

        // Seed messages with the system prompt in front. The existing session
        // messages (user + prior tool_calls/results) remain the durable
        // history; the system prompt is rebuilt per turn since the agent
        // inventory and preset may shift.
        const messages = [
          { role: 'system' as const, content: systemPrompt },
          ...args.messages,
        ];

        const result = await this.captain.executeWithTools(
          tools,
          messages,
          (call) => this.handleM3ToolCallFromAdapter(call, actionServer, pendingDispatched, (f) => {
            finishState.summary = f.summary;
          }),
          {
            signal: args.signal,
            workingDirectory: process.cwd(),
            providerSession: runtime.providerSession,
            toolNamespace: actionServer.toolNamespace,
            toolSchemaHash: actionServer.getToolSchemaHash(),
            mcpRegistration: resolveCaptainConverter(
              this.captain.name,
              catalog.toMcpRegistrationCatalog(),
            ),
            onProviderSession: (session) => {
              runtime.providerSession = session;
            },
          },
        );

        if (result.providerSession && this.session) {
          this.session.providerSessionRef = result.providerSession.sessionId;
          runtime.providerSession = result.providerSession;
        }

        const toolCalls = [...pendingDispatched.values()];
        return {
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          done: finishState.summary !== undefined,
          finalReport: finishState.summary,
          providerSessionRejected:
            result.status === 'failed' &&
            typeof result.error === 'string' &&
            /session id|invalid session|rejected/i.test(result.error),
        };
      },
      refreshCliVersionTag: async () => {
        if (!this.captain.getCliVersionTag) return undefined;
        return this.session?.refreshCliVersionTag(() =>
          (this.captain.getCliVersionTag as () => Promise<string | undefined>)(),
        );
      },
    };

    const scheduler: ToolCallScheduler = {
      schedule: async (call) => {
        // SessionLoopToolCall uses toolName; action-server's resolver maps
        // the mcp__crew__ prefix. Reshape to its expected `{name, input}`.
        const normalized = actionServer.resolveToolCall({
          name: call.toolName,
          input: call.input,
        });
        if (normalized.name === 'run_agent') {
          // Re-plan here so the runId + worktree are allocated inside the
          // dispatcher's window. planRunAgent returns a fresh runId each
          // call — the pending marker in pendingDispatched was only a
          // signal to the session-loop that we needed scheduling.
          const input = call.input as Record<string, unknown>;
          const plan = await planRunAgent(
            {
              agent_id: String(input.agent_id ?? ''),
              prompt: String(input.prompt ?? ''),
              working_directory: typeof input.working_directory === 'string'
                ? input.working_directory
                : undefined,
              model: typeof input.model === 'string' ? input.model : undefined,
            },
            call.toolCallId,
            {
              registry: this.registry,
              worktreeManager: this.worktreeManager,
              resolveModel: (agentName) => this.agentModels[agentName],
            },
          );
          if (plan.kind === 'error') {
            return { kind: 'synchronous', result: { error: plan.message }, status: 'error' };
          }
          return {
            kind: 'dispatched',
            task: {
              toolCallId: plan.task.toolCallId,
              toolName: plan.task.toolName,
              runId: plan.task.runId,
              input: plan.task.input,
              run: plan.task.run,
            },
          };
        }
        if (normalized.name === 'ask_user') {
          return {
            kind: 'dispatched',
            task: {
              toolCallId: call.toolCallId,
              toolName: 'ask_user',
              run: async (ctx) => {
                const response = await waitForUserResponse(this.session!, ctx.signal);
                return { response };
              },
            },
          };
        }
        // All other M3 tools were handled inline in onToolCall via
        // handleM3ToolCallFromAdapter; they should not appear here.
        return {
          kind: 'synchronous',
          result: { error: `Unexpected tool for scheduler: ${normalized.name}` },
          status: 'error',
        };
      },
    };

    return { captainTurn, scheduler, actionServer };
  }

  /**
   * Unified onToolCall handler for the M3 captain-turn. The adapter invokes
   * this for each tool call the model emits. Synchronous M3 tools
   * (message_user, list_agents, plan_tasks, analyze_output,
   * compress_context) run inline and return their real output so the
   * adapter's inner loop can continue if the model wants to chain calls.
   *
   * Dispatched tools (run_agent, ask_user) return a placeholder tool result
   * immediately — `{status: 'dispatched', toolCallId}` — and record the
   * call so buildM3SessionLoopPair's execute() can emit it as a
   * SessionLoopToolCall for the scheduler to pick up. finish is handled
   * inline (write assistant summary, set done flag) but also returns a
   * placeholder so the adapter's loop stops cleanly.
   */
  private async handleM3ToolCallFromAdapter(
    call: { name: string; input: Record<string, unknown> },
    actionServer: CaptainActionServer,
    pendingDispatched: Map<string, SessionLoopToolCall>,
    onFinish: (signal: { summary: string }) => void,
  ): Promise<{ output: unknown }> {
    const normalized = actionServer.resolveToolCall(call);
    const toolCallId = randomUUID();

    if (normalized.name === 'run_agent' || normalized.name === 'ask_user') {
      pendingDispatched.set(toolCallId, {
        toolCallId,
        toolName: normalized.name,
        input: normalized.input,
      });
      return {
        output: {
          status: 'dispatched',
          toolCallId,
          note: 'Result will arrive on a subsequent turn; stop calling tools for this turn.',
        },
      };
    }

    if (normalized.name === 'finish') {
      const summary = typeof normalized.input.summary === 'string'
        ? normalized.input.summary
        : '';
      if (this.session && summary) {
        this.session.appendAssistantMessage(summary);
      }
      onFinish({ summary });
      return { output: { status: 'finished', summary } };
    }

    if (normalized.name === 'message_user') {
      if (!this.session) return { output: { status: 'skipped', reason: 'no session' } };
      const text = typeof normalized.input.text === 'string' ? normalized.input.text : '';
      if (!text) return { output: { status: 'error', error: 'empty text' } };
      const result = dispatchMessageUser(this.session, { text });
      return { output: result };
    }

    if (normalized.name === 'list_agents') {
      // Adapt legacy AgentRegistry to the AgentListSource minimal
      // interface that listAgents consumes — `listAvailable()` returns
      // the per-adapter objects the tool needs for health probes.
      const source = {
        listAvailable: () => {
          const names = this.registry.list().map((a) => a.name);
          return names
            .map((n) => this.registry.get(n))
            .filter((a): a is AgentAdapter => a !== undefined);
        },
      };
      const out = await listAgents({ registry: source });
      return { output: out };
    }

    if (normalized.name === 'plan_tasks') {
      try {
        const out = await dispatchPlanTasks(
          {
            user_request: String(normalized.input.user_request ?? ''),
            hints: Array.isArray(normalized.input.hints)
              ? (normalized.input.hints as unknown[]).filter((h): h is string => typeof h === 'string')
              : undefined,
          },
          {
            captain: this.captain,
            workflow: this.workflow,
            agents: this.getM3Catalog().toPromptAgentInventory(),
            model: this.captainModel,
            signal: this.activeAbortController?.signal,
          },
        );
        return { output: out };
      } catch (err) {
        return { output: { error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (normalized.name === 'analyze_output') {
      try {
        const out = await dispatchAnalyzeOutput(
          {
            task_description: String(normalized.input.task_description ?? ''),
            agent_output: String(normalized.input.agent_output ?? ''),
            files_modified: Array.isArray(normalized.input.files_modified)
              ? (normalized.input.files_modified as unknown[]).filter(
                  (h): h is string => typeof h === 'string',
                )
              : undefined,
          },
          {
            captain: this.captain,
            model: this.captainModel,
            signal: this.activeAbortController?.signal,
          },
        );
        return { output: out };
      } catch (err) {
        return { output: { error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (normalized.name === 'compress_context') {
      try {
        const out = await dispatchCompressContext(
          {
            analyzed_output: normalized.input.analyzed_output,
            pass_number: typeof normalized.input.pass_number === 'number'
              ? normalized.input.pass_number
              : undefined,
          },
          {
            captain: this.captain,
            model: this.captainModel,
            signal: this.activeAbortController?.signal,
          },
        );
        return { output: out };
      } catch (err) {
        return { output: { error: err instanceof Error ? err.message : String(err) } };
      }
    }

    return {
      output: { error: `Unknown tool: ${call.name}` },
    };
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
          'You are the judgment-mode captain.',
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
        this.captain,
        prompt,
        ControllerDecisionSchema,
        {
          model: this.captainModel,
          signal: this.activeAbortController?.signal,
        },
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

    return `You are the captain controller for a coding workflow.

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

    if (action === 'fail') {
      return { ok: true };
    }

    if (action === 'ask_user') {
      const question = typeof decision.payload?.question === 'string'
        ? decision.payload.question.trim()
        : '';
      if (!question) {
        return { ok: false, reason: 'ask_user requires a non-empty question' };
      }
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
    return resolveTaskWorkingDirectory(taskWorktree, requested);
  }

  private getMaxPasses(role: string): number {
    return getMaxPasses(this.workflow, role);
  }

  private createRunId(seed?: string): string {
    return createWorkflowRunId(seed);
  }

  private buildFallbackReport(summaries: PassSummary[], userRequest: string): string {
    return buildWorkflowFallbackReport(summaries, userRequest);
  }
}
