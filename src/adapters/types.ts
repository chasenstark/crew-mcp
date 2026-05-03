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
  readonly capabilities: AgentCapability[];
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
 * Named capability strings that show up in first-party configs. Kept as a
 * documentation anchor — downstream code treats capabilities as free-form
 * lowercase strings, since M3 widened the surface to let users declare
 * arbitrary capabilities (e.g., "typescript", "k8s-ops") for their own
 * `run_agent` + `list_agents` discovery. Any string is valid at runtime.
 */
export type NamedAgentCapability =
  | 'implement'
  | 'review'
  | 'refactor'
  | 'test'
  | 'document'
  | 'analyze';

export type AgentCapability = NamedAgentCapability | string;

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
