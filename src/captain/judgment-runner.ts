import { randomUUID } from 'crypto';
import type {
  AgentAdapter,
  ToolResult,
} from '../adapters/types.js';
import type {
  DecomposeOutputRef,
  PassRecord,
  PassSummary,
  WorkflowState,
} from '../state/types.js';
import { StateStore } from '../state/store.js';
import { WorktreeManager } from '../git/worktree.js';
import { logger } from '../utils/logger.js';
import type { ProviderSession } from '../provider-session.js';
import { isCliVersionCompatible } from '../provider-session.js';
import { AdapterId } from '../workflow/agents.js';
import type { AgentRegistry } from './events.js';
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
import { resolveActivePreset } from './preset-resolver.js';
import type { WorkflowConfig, PresetConfig } from '../workflow/types.js';
import type { CaptainActionServer } from './action-server.js';
import {
  SessionLoop,
  shouldAdviseCompression,
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

interface RuntimeState {
  runId: string;
  startedAt: string;
  userRequest: string;
  decomposition: DecomposeOutputRef;
  passRecords: PassRecord[];
  summaries: PassSummary[];
  reportFinalized: boolean;
  finalReport?: string;
  hadErrors: boolean;
  providerSession?: ProviderSession;
}

interface Guardrails {
  /** Upper bound on SessionLoop turns. See SessionLoop.maxTurns. */
  maxTotalActions: number;
}

const DEFAULT_GUARDRAILS: Guardrails = {
  maxTotalActions: 200,
};

export class JudgmentRunner extends RunnerBase implements CrewRunner {
  private captain: AgentAdapter;
  private registry: AgentRegistry;
  private workflow: WorkflowConfig;
  private state: StateStore;
  private worktreeManager: WorktreeManager;
  private captainModel?: string;
  private agentModels: Record<string, string | undefined>;
  private guardrails: Guardrails;
  private session: CaptainSession;
  private dispatcher: ToolDispatcher;
  // M5-6: preset resolution is per-turn — `presets` + `defaultPresetName` +
  // `session.activePreset` feed `resolveActivePreset` on each captain turn.
  // Storing the narrow args (not the full config) keeps the runner decoupled
  // from unrelated config fields and matches the resolver's contract.
  private readonly presets: Record<string, PresetConfig> | undefined;
  private readonly defaultPresetName: string | undefined;
  // Cached so successive turns don't rebuild — the catalog is pure relative
  // to (registry, workflow) and those don't mutate after construction. The
  // preset is NO LONGER part of the catalog (M5-6 decoupling).
  private m3Catalog: M3ToolCatalog | undefined;

  constructor(
    captainAdapter: AgentAdapter,
    registry: AgentRegistry,
    workflow: WorkflowConfig,
    state: StateStore,
    worktreeManager: WorktreeManager,
    options: {
      captainModel?: string;
      agentModels?: Record<string, string | undefined>;
      guardrails?: Partial<Guardrails>;
      /**
       * Persistent captain session. Required post-M4-5: the M3 session-loop
       * path is the only captain driver, and it needs a session to persist
       * the message log across turns.
       */
      session: CaptainSession;
      /**
       * Shared ToolDispatcher for in-flight tool calls. Required post-M4-5
       * for the same reason as `session`.
       */
      dispatcher: ToolDispatcher;
      /**
       * Full map of declared presets (from `config.presets`). M5-6 resolves
       * the active preset per-turn from this map using the session override
       * or the config default; absent → no preset is rendered.
       */
      presets?: Record<string, PresetConfig>;
      /**
       * Default preset name (from `config.captain.preset`). Used by the
       * per-turn resolver when the session has no override; absent → no
       * hint injected.
       */
      defaultPresetName?: string;
    },
  ) {
    super(state);
    this.captain = captainAdapter;
    this.registry = registry;
    this.workflow = workflow;
    this.state = state;
    this.worktreeManager = worktreeManager;
    this.captainModel = options.captainModel;
    this.agentModels = options.agentModels ?? {};
    this.guardrails = {
      ...DEFAULT_GUARDRAILS,
      ...(options.guardrails ?? {}),
    };
    this.session = options.session;
    this.dispatcher = options.dispatcher;
    this.presets = options.presets;
    this.defaultPresetName = options.defaultPresetName;
  }

  getSession(): CaptainSession {
    return this.session;
  }

  getDispatcher(): ToolDispatcher {
    return this.dispatcher;
  }

  /**
   * Override RunnerBase.cancel() to abort our activeAbortController. The
   * signal is the SessionLoop's externalSignal — the loop's abort handler
   * calls loop.cancel() which owns dispatcher.cancelAll + currentTurn abort.
   * Single-owner cascade (S5).
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
    // M3-11: linear-mode gating moved to the v4→v5 migration reader, which
    // throws LegacyExecutionModeError before this method is reached. The
    // reader's error is the single user-facing recovery path (see
    // migrations/v4-to-v5.ts). `resume()` itself is deprecated —
    // `crew resume` is removed in M3-12; `crew run` is the single entry.
    //
    // M4-5: the legacy `actionHistory` rehydration branch has been removed.
    // v5 snapshots don't carry `actionHistory`; any v4/legacy payload is
    // rejected by the migration reader before reaching here.
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
      providerSession,
    });

    this.persistRuntimeState(runtime, 'running');
    return this.execute(runtime);
  }

  /**
   * Drive the captain via the M3 SessionLoop using the 8-tool surface
   * (run_agent, list_agents, ask_user, message_user, plan_tasks,
   * analyze_output, compress_context, finish).
   */
  async executeSessionLoop(runtime: RuntimeState): Promise<string> {
    this.activeAbortController = new AbortController();

    // Seed the session with the initial user message so the loop has work.
    if (this.session.getMessages().length === 0) {
      this.session.appendUserMessage(runtime.userRequest);
    }

    // Holder for the SessionLoop so the M3 captain-turn closure can call
    // loop.requestExit(summary) when the captain invokes the finish tool.
    // Populated just after loop construction below; read lazily inside
    // handleM3ToolCallFromAdapter.
    const loopHolder: { loop?: SessionLoop } = {};

    const { captainTurn, scheduler } = this.buildM3SessionLoopPair(runtime, loopHolder);

    // Wire dispatcher cleanup: terminal dispatcher events with a runId should
    // release the per-run worktree (M1.5-14 integration).
    const cleanupRunWorktree = (runId: string, event: string) => {
      void this.worktreeManager.cleanupByRunId(runId).catch((err: unknown) => {
        logger.warn('[judgment-runner] failed to cleanup run worktree', {
          runId,
          event,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };
    const cleanupListeners = [
      this.dispatcher.onEvent('run:complete', (info) => {
        if (info.runId) cleanupRunWorktree(info.runId, 'run:complete');
      }),
      this.dispatcher.onEvent('run:failed', (info) => {
        if (info.runId) cleanupRunWorktree(info.runId, 'run:failed');
      }),
      this.dispatcher.onEvent('run:cancelled', (info) => {
        if (info.runId) cleanupRunWorktree(info.runId, 'run:cancelled');
      }),
    ];

    const loop = new SessionLoop({
      session: this.session,
      dispatcher: this.dispatcher,
      captain: captainTurn,
      scheduler,
      maxTurns: this.guardrails.maxTotalActions,
    });
    loopHolder.loop = loop;

    try {
      const { finalReport } = await loop.run({
        externalSignal: this.activeAbortController.signal,
      });
      if (finalReport) runtime.finalReport = finalReport;
      return runtime.finalReport ?? this.buildFallbackReport(runtime.summaries, runtime.userRequest);
    } finally {
      for (const l of cleanupListeners) l.dispose();
      this.activeAbortController = null;
    }
  }

  private async execute(runtime: RuntimeState): Promise<string> {
    // M4-5: entry invariant — session + dispatcher are always present post-
    // M4-4 (createRunner guarantees both). The legacy no-session fallback
    // (native-loop + deterministic controller) has been removed.
    if (!this.session || !this.dispatcher) {
      throw new Error(
        'JudgmentRunner.execute requires session + dispatcher. create-runner wires both via M1.5-10.',
      );
    }

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

  private createInitialRuntimeState(args: {
    runId: string;
    startedAt: string;
    userRequest: string;
    passRecords?: PassRecord[];
    summaries?: PassSummary[];
    decomposition?: DecomposeOutputRef;
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
      reportFinalized: false,
      hadErrors: false,
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

    // M4-5: the M3 catalog owns the tool-schema hash now (the legacy
    // actionServer field was deleted). The 8-tool surface's hash must
    // remain stable across runs for provider-session resume to work.
    const currentToolHash = this.getM3Catalog().getToolSchemaHash();
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

  private toWorkflowState(runtime: RuntimeState): WorkflowState {
    // v5-shaped snapshot (M3-11). The nine runtime-scratch fields removed
    // in v5 — executionMode, toolCallTranscript, actionHistory,
    // controllerCursor, nativeToolCalls, artifactsByTask, taskStates,
    // pendingQueue, providerSession — are NOT written. store.saveState
    // stamps schemaVersion to the current version (5) on write.
    return {
      schemaVersion: 5,
      runId: runtime.runId,
      status: 'running',
      userRequest: runtime.userRequest,
      decomposition: runtime.decomposition,
      currentTaskIndex: this.computeCurrentTaskIndex(runtime),
      passes: runtime.passRecords,
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
    // The M3 path doesn't populate taskStates, so this always reports
    // index 0 for non-empty decompositions. Kept for WorkflowState
    // schema compatibility — currentTaskIndex is a required field.
    return runtime.decomposition.suggestedOrder.length > 0 ? 0 : 0;
  }

  private async dispatchAskUser(question: string): Promise<string> {
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

  /**
   * Cached AgentListSource for list_agents. Adapts the legacy AgentRegistry
   * shape (which exposes only `get` + `list`) to the AgentListSource that
   * listAgents consumes. Cached so repeated list_agents calls don't
   * re-allocate the shim object — the underlying registry never mutates
   * after construction.
   */
  private listAgentsSource: { listAvailable: () => AgentAdapter[] } | undefined;
  private getListAgentsSource(): { listAvailable: () => AgentAdapter[] } {
    if (!this.listAgentsSource) {
      this.listAgentsSource = {
        listAvailable: () => {
          const names = this.registry.list().map((a) => a.name);
          return names
            .map((n) => this.registry.get(n))
            .filter((a): a is AgentAdapter => a !== undefined);
        },
      };
    }
    return this.listAgentsSource;
  }

  /**
   * M3-10a: lazy M3 tool catalog. Cached after first construction — the
   * inputs (registry, workflow, session, dispatcher) don't mutate after
   * `new JudgmentRunner(...)`. M5-6 removed `preset` from the catalog's
   * inputs: the preset is prompt material, never tool-spec material, so
   * binding it onto the catalog was a drift hazard.
   */
  private getM3Catalog(): M3ToolCatalog {
    if (!this.m3Catalog) {
      this.m3Catalog = new M3ToolCatalog({
        registry: this.registry,
        workflow: this.workflow,
        session: this.session,
        dispatcher: this.dispatcher,
      });
    }
    return this.m3Catalog;
  }

  /**
   * Build the M3 session-loop pair (captain-turn + scheduler + action-
   * server). The action-server is constructed from the ToolCatalog, so its
   * listTools() returns exactly the 8 M3 tools namespaced with
   * `mcp__crew__`.
   */
  private buildM3SessionLoopPair(
    runtime: RuntimeState,
    loopHolder: { loop?: SessionLoop },
  ): {
    captainTurn: SessionLoopTurn;
    scheduler: ToolCallScheduler;
    actionServer: CaptainActionServer;
  } {
    const catalog = this.getM3Catalog();
    const actionServer = catalog.buildActionServer();
    const pendingDispatched = new Map<string, SessionLoopToolCall>();
    // Finish semantics: the handler calls `dispatchFinish(session, loop,
    // input)` which is the SINGLE canonical path — it appends the
    // assistant summary and calls loop.requestExit(summary). The loop's
    // `finalReport` is what surfaces back to executeSessionLoop; no
    // turn-result done/finalReport indirection needed. The quiet-turn
    // safety net in SessionLoop.runOneTurn already guards with
    // `!this.done` so an explicit requestExit doesn't trip it.

    const captainTurn: SessionLoopTurn = {
      execute: async (args) => {
        if (!this.captain.executeWithTools) {
          throw new Error(
            'M3 captain-turn requires adapter.executeWithTools. Got: ' + this.captain.name,
          );
        }
        pendingDispatched.clear();

        const agents = catalog.toPromptAgentInventory();
        const tools = actionServer.listTools();
        // M5-6: per-turn preset resolution. session.activePreset (set via
        // /preset) beats config.captain.preset; an unknown name at either
        // tier resolves to `undefined`, which renders as `(none)`.
        const resolvedPreset = resolveActivePreset({
          presets: this.presets,
          defaultPresetName: this.defaultPresetName,
          sessionOverride: this.session?.activePreset,
        });
        const systemPrompt = buildCaptainSystemPrompt({
          workflow: this.workflow,
          agents,
          preset: resolvedPreset?.preset,
          tools: tools.map((t) => ({
            // strip the mcp__crew__ prefix so the prompt matches how the
            // adapter will present the tool to the model.
            name: t.name.startsWith(actionServer.toolNamespace)
              ? t.name.slice(actionServer.toolNamespace.length)
              : t.name,
            description: t.description,
          })),
          advisory: this.session ? shouldAdviseCompression(this.session) : undefined,
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
          (call) => this.handleM3ToolCallFromAdapter(call, actionServer, pendingDispatched, loopHolder),
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

        const providerSessionRejected =
          result.status === 'failed' &&
          typeof result.error === 'string' &&
          /session id|invalid session|rejected/i.test(result.error);
        if (result.status === 'failed' && !providerSessionRejected) {
          throw new Error(`Captain adapter failed: ${result.error ?? 'unknown error'}`);
        }

        const toolCalls = [...pendingDispatched.values()];
        return {
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          // `done` + `finalReport` are driven by SessionLoop.requestExit
          // (invoked inside dispatchFinish) — not by the turn-result.
          // Having one canonical exit path avoids the "which path won"
          // confusion during debugging.
          providerSessionRejected,
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
    loopHolder: { loop?: SessionLoop },
  ): Promise<ToolResult> {
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
      if (!summary) {
        return { output: { status: 'error', error: 'finish requires a non-empty summary' } };
      }
      const finishBlock = this.describeFinishBlock(pendingDispatched);
      if (finishBlock) {
        return {
          output: {
            status: 'blocked',
            error: finishBlock,
            note: 'Wait for dispatched tool results before calling finish.',
          },
        };
      }
      if (!this.session || !loopHolder.loop) {
        // Invariant: executeSessionLoop populates loopHolder.loop synchronously
        // before loop.run() starts, so this branch is unreachable in
        // production. If a future refactor moves the assignment, fail fast
        // rather than silently skipping requestExit.
        throw new Error(
          '[judgment-runner] finish handler reached without session+loop wired — check executeSessionLoop ordering.',
        );
      }
      // Validate outcome against the enum rather than casting — a bogus
      // value becomes `undefined` (matches `finishInputSchema.outcome`
      // being optional).
      const rawOutcome = normalized.input.outcome;
      const outcome: 'success' | 'partial' | 'failed' | undefined =
        rawOutcome === 'success' || rawOutcome === 'partial' || rawOutcome === 'failed'
          ? rawOutcome
          : undefined;
      // Canonical exit path (review NEW-A/B): dispatchFinish appends the
      // assistant summary AND calls loop.requestExit. The loop's
      // `finalReport` is what surfaces to executeSessionLoop.
      const result = dispatchFinish(this.session, loopHolder.loop, { summary, outcome });
      if (result.status === 'blocked') {
        return {
          output: {
            status: 'blocked',
            error: result.reason ?? 'Cannot finish while dispatched tools are still in flight.',
            pendingDispatches: result.pendingDispatches,
          },
        };
      }
      return {
        output: { status: 'ok', outcome: 'finished', summary },
        terminal: true,
        terminalOutput: summary,
      };
    }

    if (normalized.name === 'message_user') {
      if (!this.session) return { output: { status: 'error', error: 'no session' } };
      const text = typeof normalized.input.text === 'string' ? normalized.input.text : '';
      if (!text) return { output: { status: 'error', error: 'empty text' } };
      const result = dispatchMessageUser(this.session, { text });
      return { output: { status: 'ok', result } };
    }

    if (normalized.name === 'list_agents') {
      const out = await listAgents({ registry: this.getListAgentsSource() });
      return { output: { status: 'ok', result: out } };
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
        return { output: { status: 'ok', result: out } };
      } catch (err) {
        return { output: { status: 'error', error: err instanceof Error ? err.message : String(err) } };
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
        return { output: { status: 'ok', result: out } };
      } catch (err) {
        return { output: { status: 'error', error: err instanceof Error ? err.message : String(err) } };
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
        return { output: { status: 'ok', result: out } };
      } catch (err) {
        return { output: { status: 'error', error: err instanceof Error ? err.message : String(err) } };
      }
    }

    return {
      output: { status: 'error', error: `Unknown tool: ${call.name}` },
    };
  }

  private describeFinishBlock(
    pendingDispatched: Map<string, SessionLoopToolCall>,
  ): string | undefined {
    if (pendingDispatched.size > 0) {
      const names = Array.from(pendingDispatched.values())
        .map((call) => `${call.toolName}(${call.toolCallId})`)
        .join(', ');
      return `Cannot finish while ${pendingDispatched.size} dispatched tool call${pendingDispatched.size === 1 ? '' : 's'} are queued in this turn: ${names}.`;
    }
    const inFlight = this.dispatcher.listInFlight();
    if (inFlight.length === 0) return undefined;
    const names = inFlight
      .map((call) => `${call.toolName}(${call.toolCallId})`)
      .join(', ');
    return `Cannot finish while ${inFlight.length} dispatched tool call${inFlight.length === 1 ? '' : 's'} are still in flight: ${names}.`;
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
