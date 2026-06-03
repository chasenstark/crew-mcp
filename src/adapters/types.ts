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
  /**
   * Canonical effort levels this adapter's CLI actually accepts. The
   * captain always passes one of the five canonical levels
   * (`low|medium|high|xhigh|max`); `resolveEffectiveEffort` clamps that
   * value into this set before it reaches `execute()` so the captain
   * never has to memorize per-CLI vocabulary (e.g., codex 0.130 rejects
   * `max` with an `unknown variant` error).
   *
   * Clamp rule: walk DOWN the canonical order from the requested level
   * and return the first supported level. Falling back upward only
   * happens when no supported level is `≤ requested`, which is a
   * theoretical case we don't expect to hit today.
   *
   * Omit when the adapter has no native effort knob (claude-code,
   * gemini-cli, generic, openai-compatible) — those ignore the value
   * regardless, so the clamp would be wasted work.
   */
  readonly supportedEfforts?: readonly EffortLevel[];
  readonly supportsJsonSchema: boolean;
  /**
   * True only when this adapter's execution environment can enforce a
   * read-only filesystem policy itself. False means `read_only` is an
   * advisory prompt contract plus the dispatch layer's dirty-tree probe.
   */
  readonly enforcesReadOnly?: boolean;
  /**
   * True when `TaskResult.filesModified` is authoritative for this adapter,
   * so the dispatch layer can skip its post-run git status fallback. A
   * reliable adapter returning `[]` means "no files changed", not "unknown".
   *
   * This is about the adapter's observed terminal-result channel. For CLIs
   * that only report in-band tool-use file changes, out-of-band shell edits
   * may still be invisible and should keep the flag false unless the adapter
   * has another complete source of truth.
   */
  readonly filesModifiedReliable?: boolean;
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
  healthCheck(options?: HealthCheckOptions): Promise<HealthCheckResult>;
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
 * Canonical five-level scale used everywhere captain-facing. Adapters
 * whose CLI accepts only a subset declare `supportedEfforts` and the
 * dispatch layer clamps automatically — captain never has to think about
 * which CLI accepts which slice. Today codex (0.130) accepts
 * `low|medium|high|xhigh` only; `max` is clamped to `xhigh` on the way
 * in.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Canonical ascending order for `EffortLevel`. Used by
 * `clampEffortToSupported` to translate an arbitrary canonical level into
 * an adapter's supported set, and as the single source of truth for "is
 * X stronger than Y" comparisons. Keep in sync with the `EffortLevel`
 * union — there is no compile-time check that the array matches.
 */
export const EFFORT_ORDER: readonly EffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/**
 * Map a canonical effort level into an adapter's supported set. Used by
 * `resolveEffectiveEffort` so per-CLI vocabulary stays out of the
 * captain's prompt. Returns `undefined` when the canonical level can't
 * be expressed at all (caller treats it as "no effort flag").
 *
 * Algorithm:
 *   1. If `supported` is undefined → no constraint, return `level`
 *      unchanged. Adapters that omit `supportedEfforts` either accept
 *      everything or ignore the field entirely.
 *   2. If `level` is already in `supported` → return it.
 *   3. Walk DOWN the canonical order from `level`'s index; return the
 *      first supported level. (codex `max` → `xhigh`.)
 *   4. If nothing is found stepping down, walk UP from `level+1` and
 *      return the first supported level. Defensive; not exercised
 *      today (no adapter declares only high-tier efforts).
 *   5. If `supported` is empty, return undefined.
 */
export function clampEffortToSupported(
  level: EffortLevel,
  supported: readonly EffortLevel[] | undefined,
): EffortLevel | undefined {
  if (!supported) return level;
  if (supported.length === 0) return undefined;
  const set = new Set<EffortLevel>(supported);
  if (set.has(level)) return level;
  const idx = EFFORT_ORDER.indexOf(level);
  if (idx < 0) return level;
  for (let i = idx - 1; i >= 0; i--) {
    const candidate = EFFORT_ORDER[i];
    if (set.has(candidate)) return candidate;
  }
  for (let i = idx + 1; i < EFFORT_ORDER.length; i++) {
    const candidate = EFFORT_ORDER[i];
    if (set.has(candidate)) return candidate;
  }
  return undefined;
}

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
    /**
     * Sandbox policy for adapters that natively sandbox shell commands
     * (codex). Mirrors Codex's `--sandbox` enum verbatim — keep these
     * strings in sync with the CLI or the spawn fails. Other adapters
     * (claude-code, gemini, generic) ignore this.
     */
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    /**
     * Allow network egress from inside the sandbox. Codex's
     * `workspace-write` default blocks localhost, which silently breaks
     * tests that hit a local DB/devserver — they "pass" without
     * exercising the change. Setting this true threads
     * `-c sandbox_workspace_write.network_access=true`. No effect under
     * `read-only` (Codex has no read-only network toggle) or for
     * non-codex adapters.
     */
    networkAccess?: boolean;
    /**
     * Additional filesystem roots that should be writable alongside the
     * adapter's working directory. Codex maps these to a single
     * `-c sandbox_workspace_write.writable_roots=[...]` config override
     * (not `--add-dir`, which 0.128.0 routes through a runtime-approval
     * path that doesn't auto-approve in non-interactive `codex exec` —
     * `git commit` to a linked-worktree gitdir was silently failing
     * before the switch). This means crew's grant **replaces** the
     * user's per-machine `writable_roots` for the dispatch; that's
     * acceptable because the user's interactive codex config has no
     * business leaking into a worktree-isolated run. This is
     * intentionally path-based instead of a boolean so callers can
     * grant narrow git internals for an isolated worktree without
     * opening the parent repository's entire `.git/` directory.
     */
    writablePaths?: readonly string[];
    signal?: AbortSignal;
  };
  onOutput?: (chunk: string) => void;
}

export interface TaskResult {
  output: string;
  filesModified: string[];
  status: 'success' | 'error' | 'partial';
  sessionId?: string;
  /**
   * Advisory messages attached by the dispatch layer (not the
   * adapter itself). Today's only producer is the read-only run
   * post-dispatch dirty-tree probe in run-agent.ts, which surfaces a
   * warning when an agent edited despite the read-only contract.
   * Adapters should not populate this field.
   */
  warnings?: readonly string[];
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

export interface HealthCheckOptions {
  /**
   * Bypass the in-process health-check cache for this call. Used by
   * list_agents refresh requests when the captain needs current CLI/auth
   * state immediately.
   */
  refresh?: boolean;
}

export interface ExecuteOptions {
  workingDirectory?: string;
  timeout?: number;
  maxTurns?: number;
  model?: string;
  signal?: AbortSignal;
}
