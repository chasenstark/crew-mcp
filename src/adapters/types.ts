import type { z } from 'zod';
import type { PathTaken, ProviderSession } from '../provider-session.js';

export interface CaptainCapabilities {
  supportsToolLoop: boolean;
  supportsStructuredDecisions: boolean;
  supportsPauseForUserInput: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  output: unknown;
  /**
   * Control signal from a tool handler to the adapter loop. When true, the
   * tool result has already completed the surrounding workflow and the adapter
   * must return without asking the model for another decision.
   */
  terminal?: boolean;
  /**
   * Optional user-facing output to surface on terminal results. Falls back to
   * `output` when omitted.
   */
  terminalOutput?: string;
}

export interface ToolLoopMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
}

export interface ToolLoopResult {
  status: 'completed' | 'failed' | 'interrupted';
  transcript: ToolLoopMessage[];
  output?: string;
  error?: string;
  pathTaken?: PathTaken;
  providerSession?: ProviderSession;
  telemetry?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    totalTurns?: number;
  };
}

/**
 * Per-invocation MCP wiring the session-loop hands to an adapter via
 * `ToolLoopContext.mcpRegistration`. Each captain CLI has a different native
 * shape — the session-loop projects a single `ToolCatalog` through
 * `resolveCaptainConverter` (M3-8 wiring) and attaches the result here so the
 * adapter can extract what it needs.
 *
 * - `claude-code`: `inlineConfigJson` goes to `--mcp-config <json>`. Omitted
 *   when the catalog has no MCP servers — recent claude-code CLI versions
 *   reject `--mcp-config '{}'` as an invalid schema, so we skip the flag
 *   entirely rather than send an empty config.
 * - `gemini-cli`: `allowedServerNames` goes to `--allowed-mcp-server-names <csv>`.
 * - `codex`: `configOverrideArgv` is the ready-to-spread `-c mcp_servers.*=...` argv.
 *
 * Adapters MUST tolerate an undefined `mcpRegistration` and the shape
 * belonging to a different CLI (session-loop sends at most one shape per
 * call, but resilience keeps cross-test wiring simple).
 */
export type McpRegistrationPayload =
  | {
      readonly kind: 'claude-code';
      readonly inlineConfigJson?: string;
    }
  | {
      readonly kind: 'gemini-cli';
      readonly allowedServerNames: readonly string[];
    }
  | {
      readonly kind: 'codex';
      readonly configOverrideArgv: readonly string[];
    };

export interface ToolLoopContext {
  signal?: AbortSignal;
  workingDirectory?: string;
  providerSession?: ProviderSession;
  toolNamespace?: string;
  toolSchemaHash?: string;
  mcpRegistration?: McpRegistrationPayload;
  onProviderSession?: (session: ProviderSession | undefined) => void;
  onTranscriptUpdate?: (transcript: ToolLoopMessage[]) => void;
}

export interface AgentAdapter {
  readonly name: string;
  /**
   * Alternative ids that resolve to this adapter via the registry. The
   * captain may use any alias as `agent_id` in `mcp__crew__run_agent` /
   * `continue_run` calls and the registry will resolve to this adapter.
   * `list_agents` surfaces the alias array so the captain knows the
   * shorthand exists. Aliases must NOT collide with any other adapter's
   * name or alias (registry construction throws on collision).
   */
  readonly aliases?: readonly string[];
  /**
   * Soft routing hints surfaced via `list_agents`. NOT enforced anywhere
   * — the captain reads them as nudges ("good for code review", "fast
   * iteration") when picking between adapters. Free-form strings; users
   * override per-machine via `~/.crew/strengths.json` (see
   * src/strengths/store.ts), so adapter defaults are seeds, not contracts.
   *
   * Replaced the v1 `capabilities` enum (`implement|review|refactor|...`)
   * which every adapter declared identically and no code consumed.
   */
  readonly strengths: AgentStrength[];
  /**
   * Default reasoning effort for dispatches to this adapter. Omitted when
   * the underlying CLI has no reasoning-effort knob (gemini-cli today,
   * openai-compatible/generic by definition). Surfaced via `list_agents`
   * so the captain can see the per-machine default; users override via
   * `~/.crew/agents.json`. The captain may also pass a per-call `effort`
   * to `run_agent` / `continue_run`, which wins over both.
   */
  readonly defaultEffort?: EffortLevel;
  readonly supportsJsonSchema: boolean;
  readonly captainCapabilities?: CaptainCapabilities;
  execute(task: Task): Promise<TaskResult>;
  executeWithSchema?<T extends z.ZodType>(
    prompt: string,
    schema: T,
    options?: ExecuteOptions,
  ): Promise<z.infer<T>>;
  executeWithTools?(
    tools: ToolDefinition[],
    messages: ToolLoopMessage[],
    onToolCall: (call: ToolCall) => Promise<ToolResult>,
    context?: ToolLoopContext,
  ): Promise<ToolLoopResult>;
  getCliVersionTag?(): Promise<string | undefined>;
  /**
   * Returns true when the given model id is known to work with this adapter.
   * Consumed by preflight to warn + fall back when captain.model is set to a
   * model the captain CLI can't actually drive. Adapters that can drive any
   * model they're handed (e.g., generic command adapters) return true.
   */
  recognizesModel?(modelId: string): boolean;
  healthCheck(): Promise<HealthCheckResult>;
}

/**
 * Soft strength tag surfaced via `list_agents` to nudge the captain's
 * adapter pick. Free-form lowercase string; convention is kebab-case
 * descriptors of *what the adapter is good at* (e.g., `"code-review"`,
 * `"long-context"`, `"fast-iteration"`) rather than verbs the adapter
 * supports — every modern coding agent can implement, review, refactor,
 * etc., so verb-tags carried no signal.
 *
 * No enum; any string is valid at runtime. Users tune per-machine via
 * `~/.crew/agents.json`.
 */
export type AgentStrength = string;

/**
 * Adapter-agnostic reasoning-depth knob threaded through `Task.constraints`
 * and surfaced as `defaultEffort` on adapters that have a native concept
 * (codex `model_reasoning_effort`). Adapters with no native knob ignore
 * the value (and log a debug breadcrumb so the captain's pick isn't
 * silently swallowed).
 *
 * Symmetric three-level scale because every provider that exposes a
 * reasoning-effort flag uses the same three buckets — keeps the user's
 * mental model portable across adapters.
 */
export type EffortLevel = 'low' | 'medium' | 'high';

export interface Task {
  prompt: string;
  context: {
    workingDirectory: string;
    files?: string[];
    previousResults?: TaskResult[];
  };
  constraints?: {
    timeout?: number;
    maxTurns?: number;
    model?: string;
    /**
     * Reasoning effort for this dispatch. Adapters with native support
     * (codex) translate to their CLI flag; others log + ignore. Resolved
     * upstream by `planRunAgent`: per-call value > per-machine prefs file
     * > adapter default > undefined.
     */
    effort?: EffortLevel;
    sandbox?: 'read-only' | 'workspace-write' | 'full-access';
    signal?: AbortSignal;
  };
  onOutput?: (chunk: string) => void;
}

export interface TaskResult {
  output: string;
  filesModified: string[];
  status: 'success' | 'error' | 'partial';
  sessionId?: string;
  metadata: {
    costUsd?: number;
    durationMs?: number;
    numTurns?: number;
    rawEvents?: unknown[];
    droppedLines?: number;
  };
}

export interface HealthCheckResult {
  available: boolean;
  version?: string;
  authenticated: boolean;
  error?: string;
}

export interface ExecuteOptions {
  workingDirectory?: string;
  timeout?: number;
  maxTurns?: number;
  model?: string;
  signal?: AbortSignal;
}
