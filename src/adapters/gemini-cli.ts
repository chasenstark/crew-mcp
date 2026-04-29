import { execa } from 'execa';
import { z } from 'zod';
import { extractJson } from '../utils/json-parse.js';
import { logger } from '../utils/logger.js';
import { buildCliVersionTag } from '../provider-session.js';
import { AgentId } from '../workflow/agents.js';
import { executePromptToolLoop } from './tool-loop/controller.js';
import { resolveTerminalOutput } from './tool-loop/result.js';
import {
  parseToolInput,
  ToolLoopDecisionSchema,
} from './tool-loop/decision.js';
import { TOOL_LOOP_MAX_TURNS } from './tool-loop/constants.js';
import { buildDecisionPrompt } from './tool-loop/transcript.js';
import type {
  AgentAdapter,
  AgentCapability,
  ExecuteOptions,
  HealthCheckResult,
  Task,
  TaskResult,
  ToolCall,
  ToolDefinition,
  ToolLoopContext,
  ToolLoopMessage,
  ToolLoopResult,
  ToolResult,
} from './types.js';

/**
 * Event shapes emitted by `gemini -o stream-json`. The CLI prints one JSON
 * object per newline-terminated line with a discriminated `type` field.
 *
 *   init    — { type: 'init', session_id: '<uuid>' }  (always the first line on a fresh session)
 *   message — { type: 'message', role: 'assistant'|'user', content?: string, delta?: string }
 *   result  — { type: 'result', stats?: {...}, ... }   (last line; summary)
 *
 * The CLI additionally emits an assistant `message` on resume turns
 * containing a `--prompt (-p) flag has been deprecated` notice. We filter
 * those out before accumulating assistant text — otherwise the captain
 * would see the deprecation warning as part of its reply.
 */
export type GeminiEventType = 'init' | 'message' | 'result';

export interface GeminiEvent {
  type?: GeminiEventType | string;
  session_id?: string;
  role?: 'user' | 'assistant' | 'system';
  content?: string;
  text?: string;
  message?: string;
  delta?: string;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Parses `-o stream-json` output into its newline-delimited JSON events.
 * Malformed or non-object lines are logged and dropped. Exported for the
 * dedicated parser tests; end-to-end callers go through the adapter.
 */
export function parseStreamJsonEvents(stdout: string): GeminiEvent[] {
  const events: GeminiEvent[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        events.push(parsed as GeminiEvent);
      } else {
        logger.warn('[adapter:gemini-cli] dropped non-object JSON line');
      }
    } catch {
      logger.warn('[adapter:gemini-cli] dropped malformed JSON line');
    }
  }
  return events;
}

/**
 * Parses `-o json` output, which is a single JSON object like
 * `{response: string, stats: {...}}`. Returns the response text, or an empty
 * string if the shape is unexpected.
 */
export function parseSingleJsonResponse(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const maybe = (parsed as { response?: unknown }).response;
      if (typeof maybe === 'string') return maybe;
    }
  } catch {
    logger.warn('[adapter:gemini-cli] -o json output was not valid JSON');
  }
  return '';
}

/**
 * Gemini emits this exact assistant-role line on resume turns. It must be
 * filtered out before being surfaced to the captain.
 */
const GEMINI_DEPRECATION_FRAGMENT = '--prompt (-p) flag has been deprecated';

export function isGeminiDeprecationNotice(content: string | undefined): boolean {
  return typeof content === 'string' && content.includes(GEMINI_DEPRECATION_FRAGMENT);
}

/**
 * Extracts the session id from a stream-json event stream. The `init` event
 * emitted on a fresh or resumed session carries it.
 */
export function extractStreamJsonSessionId(events: GeminiEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === 'init' && typeof event.session_id === 'string' && event.session_id.length > 0) {
      return event.session_id;
    }
  }
  for (const event of events) {
    if (typeof event.session_id === 'string' && event.session_id.length > 0) {
      return event.session_id;
    }
  }
  return undefined;
}

/**
 * Accumulates assistant text from stream-json `message` events. Handles both
 * full-content and delta-chunk shapes, drops the deprecation notice, and
 * returns an empty string when no assistant text was produced.
 *
 * The deprecation notice is filtered in two passes: (1) whole-message
 * `content` events that equal/contain the notice are skipped outright, and
 * (2) the final concatenation is post-scrubbed to catch cases where Gemini
 * streams the notice as a sequence of deltas instead of a single content
 * event. Both paths are exercised by the parser tests.
 */
export function extractStreamJsonAssistantText(events: GeminiEvent[]): string {
  const chunks: string[] = [];
  for (const event of events) {
    if (event.type !== 'message') continue;
    if (event.role && event.role !== 'assistant') continue;

    const content = typeof event.content === 'string' ? event.content : undefined;
    const delta = typeof event.delta === 'string' ? event.delta : undefined;

    if (content) {
      if (isGeminiDeprecationNotice(content)) continue;
      chunks.push(content);
      continue;
    }
    if (delta) {
      chunks.push(delta);
    }
  }
  return stripDeprecationNoticeSentences(chunks.join(''));
}

function stripDeprecationNoticeSentences(text: string): string {
  if (!text.includes(GEMINI_DEPRECATION_FRAGMENT)) return text;
  // Drop the entire sentence/line that contains the notice. We remove
  // characters up to (and including) the nearest terminating punctuation or
  // newline after the fragment so a stray "<prefix>... deprecated." doesn't
  // leak into the assistant's actual reply.
  return text.replace(
    /[^.\n]*--prompt \(-p\) flag has been deprecated[^.\n]*[.\n]?/g,
    '',
  ).trim();
}

function renderProcessFailureOutput(stdout: string, stderr: string, message: string): string {
  if (stderr) return stderr;
  if (stdout) return stdout;
  return message;
}

/**
 * Minimum Gemini CLI version eligible for the captain role. Resume-by-UUID
 * is flaky in < 0.20 per upstream issues #24808/#24532/#24535; healthCheck
 * rejects older releases so users see a clear error instead of a mystery
 * mid-run failure.
 */
export const GEMINI_MIN_VERSION = { major: 0, minor: 20, patch: 0 } as const;

/**
 * Returns the argv fragment for a `gemini -o stream-json` resume invocation.
 * The prompt is passed via `--prompt` (not positional) on resume turns; seed
 * turns use positional since no `--resume` target exists yet.
 *
 * When the session-loop supplies an `allowedServerNames` list (via
 * `McpRegistrationPayload.kind === 'gemini-cli'`), the flag
 * `--allowed-mcp-server-names <csv>` is appended. Empty list → no flag so
 * argv stays clean when the catalog has no servers.
 */
export function buildGeminiResumeArgs(
  sessionId: string | undefined,
  prompt: string,
  options?: { readonly allowedServerNames?: readonly string[] },
): string[] {
  const base: string[] = sessionId
    ? ['-o', 'stream-json', '--resume', sessionId, '--prompt', prompt]
    : ['-o', 'stream-json', prompt];
  const allowed = options?.allowedServerNames;
  if (allowed && allowed.length > 0) {
    // Allowed-names is a flag that precedes any positional prompt; we
    // prepend it to the stream-json options to keep the prompt at the tail
    // for both seed and resume calls.
    return injectAllowedMcpNames(base, allowed);
  }
  return base;
}

function injectAllowedMcpNames(
  args: string[],
  allowed: readonly string[],
): string[] {
  // Insert after `-o stream-json` so the prompt (positional or via --prompt)
  // stays at the end.
  const out = [...args];
  const csv = allowed.join(',');
  // Find index right after `stream-json` token.
  const idx = out.findIndex((t, i) => t === 'stream-json' && out[i - 1] === '-o');
  const insertAt = idx === -1 ? 0 : idx + 1;
  out.splice(insertAt, 0, '--allowed-mcp-server-names', csv);
  return out;
}

export function isInvalidSessionStderr(stderr: string): boolean {
  if (!stderr) return false;
  return /invalid session identifier/i.test(stderr);
}

export function isVersionBelowFloor(
  parsed: { major: number; minor: number; patch: number } | null,
): boolean {
  if (!parsed) return true;
  if (parsed.major < GEMINI_MIN_VERSION.major) return true;
  if (parsed.major > GEMINI_MIN_VERSION.major) return false;
  if (parsed.minor < GEMINI_MIN_VERSION.minor) return true;
  if (parsed.minor > GEMINI_MIN_VERSION.minor) return false;
  return parsed.patch < GEMINI_MIN_VERSION.patch;
}

export class GeminiCliAdapter implements AgentAdapter {
  readonly name = AgentId.GEMINI_CLI;
  readonly capabilities: AgentCapability[] = [
    'implement',
    'review',
    'refactor',
    'test',
    'document',
    'analyze',
  ];
  // Gemini CLI has no native schema-enforcement flag; executeWithSchema
  // post-validates with Zod. Reporting false makes downstream code pick the
  // right branch (prompt-based structured output instead of native schema).
  readonly supportsJsonSchema = false;
  readonly captainCapabilities = {
    supportsToolLoop: true,
    supportsStructuredDecisions: true,
    supportsPauseForUserInput: true,
  };

  recognizesModel(modelId: string): boolean {
    return typeof modelId === 'string' && /^(gemini|qwen)/i.test(modelId);
  }

  async getCliVersionTag(): Promise<string | undefined> {
    const result = await execa('gemini', ['--version'], {
      timeout: 10_000,
      reject: false,
    });
    if (result.exitCode !== 0) return undefined;
    const match = `${result.stdout ?? ''} ${result.stderr ?? ''}`.match(/(\d+\.\d+\.\d+)/);
    if (!match) return undefined;
    return buildCliVersionTag(AgentId.GEMINI_CLI, match[1]);
  }

  async execute(task: Task): Promise<TaskResult> {
    const args = ['--output-format', 'json'];
    if (task.constraints?.model) {
      args.push('--model', task.constraints.model);
    }
    args.push(task.prompt);

    const timeout = task.constraints?.timeout ?? 300_000;

    let result;
    try {
      result = await execa('gemini', args, {
        cwd: task.context.workingDirectory,
        timeout,
        cancelSignal: task.constraints?.signal,
        reject: false,
      });
    } catch (error: unknown) {
      const stdoutText = typeof error === 'object' && error && 'stdout' in error
        ? String((error as { stdout?: string }).stdout ?? '')
        : '';
      const stderrText = typeof error === 'object' && error && 'stderr' in error
        ? String((error as { stderr?: string }).stderr ?? '')
        : '';
      const message =
        error instanceof Error ? error.message : 'Unknown execution error';
      logger.error('[adapter:gemini-cli] process execution threw', {
        cwd: task.context.workingDirectory,
        timeoutMs: timeout,
        model: task.constraints?.model,
        error: message,
      });
      return {
        output: renderProcessFailureOutput(stdoutText, stderrText, message),
        filesModified: [],
        status: 'error',
        metadata: {
          rawEvents: [
            {
              error: message,
              stdout: stdoutText,
              stderr: stderrText,
            },
          ],
        },
      };
    }

    const stdoutText = result.stdout ?? '';
    const stderrText = result.stderr ?? '';
    const output = parseSingleJsonResponse(stdoutText);
    if (task.onOutput && output) {
      task.onOutput(output);
    }
    return {
      output: output || stderrText,
      filesModified: [],
      status: result.exitCode === 0 ? 'success' : 'error',
      metadata: {
        rawEvents: [{ stdout: stdoutText, stderr: stderrText }],
      },
    };
  }

  async executeWithSchema<T extends z.ZodType>(
    prompt: string,
    schema: T,
    options?: ExecuteOptions,
  ): Promise<z.infer<T>> {
    const result = await this.execute({
      prompt: `${prompt}\n\nReturn only JSON matching this schema:\n${JSON.stringify(z.toJSONSchema(schema), null, 2)}`,
      context: { workingDirectory: options?.workingDirectory ?? process.cwd() },
      constraints: {
        timeout: options?.timeout,
        model: options?.model,
        signal: options?.signal,
      },
    });
    if (result.status === 'error') {
      throw new Error(result.output || 'Gemini CLI execution failed.');
    }
    return schema.parse(extractJson(result.output)) as z.infer<T>;
  }

  async executeWithTools(
    tools: ToolDefinition[],
    messages: ToolLoopMessage[],
    onToolCall: (call: ToolCall) => Promise<ToolResult>,
    context?: ToolLoopContext,
  ): Promise<ToolLoopResult> {
    if (!context) {
      return this.executeWithPromptLoop(tools, messages, onToolCall);
    }

    let latestTranscript = messages.map((message) => ({ ...message }));
    const wrappedContext: ToolLoopContext = {
      ...context,
      onTranscriptUpdate: (transcript) => {
        latestTranscript = transcript.map((message) => ({ ...message }));
        context.onTranscriptUpdate?.(latestTranscript);
      },
    };

    try {
      return await this.executeWithResumeSession(tools, messages, onToolCall, wrappedContext);
    } catch (error: unknown) {
      if (context.signal?.aborted) {
        return {
          status: 'interrupted',
          transcript: latestTranscript,
          pathTaken: 'fallback',
          error: String(context.signal.reason ?? 'Cancelled'),
        };
      }
      logger.warn('[adapter:gemini-cli] resume path failed; using adapter loop fallback', {
        error: error instanceof Error ? error.message : String(error),
      });
      context.onProviderSession?.({
        provider: 'gemini',
        transport: 'adapter',
        cliVersion: await this.getCliVersionTag(),
        toolNamespace: context.toolNamespace ?? 'mcp__crew__',
        toolSchemaHash: context.toolSchemaHash ?? '',
        startedAt: context.providerSession?.startedAt ?? new Date().toISOString(),
        lastTurnAt: new Date().toISOString(),
      });
      const fallbackResult = await this.executeWithPromptLoop(
        tools,
        latestTranscript,
        onToolCall,
        wrappedContext,
      );
      return {
        ...fallbackResult,
        pathTaken: 'adapter',
      };
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const result = await execa('gemini', ['--version'], {
        timeout: 10_000,
        reject: false,
      });
      if (result.exitCode !== 0) {
        return {
          available: false,
          authenticated: false,
          error: result.stderr || 'gemini --version failed',
        };
      }
      const combined = `${result.stdout ?? ''} ${result.stderr ?? ''}`;
      const match = combined.match(/(\d+)\.(\d+)\.(\d+)/);
      const parsed = match
        ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
        : null;
      const versionString = match ? `${match[1]}.${match[2]}.${match[3]}` : result.stdout.trim() || undefined;

      if (!parsed) {
        return {
          available: false,
          authenticated: false,
          version: versionString,
          error: 'Could not parse Gemini CLI version; upgrade to 0.20.0 or later.',
        };
      }

      if (isVersionBelowFloor(parsed)) {
        const floor = `${GEMINI_MIN_VERSION.major}.${GEMINI_MIN_VERSION.minor}.${GEMINI_MIN_VERSION.patch}`;
        return {
          available: false,
          authenticated: false,
          version: versionString,
          error: `Gemini CLI ${versionString} is below the supported floor ${floor}. Upgrade gemini-cli; resume is unstable on earlier releases.`,
        };
      }

      return {
        available: true,
        authenticated: true,
        version: versionString,
      };
    } catch {
      return {
        available: false,
        authenticated: false,
        error: 'Gemini CLI not found',
      };
    }
  }

  private async executeWithResumeSession(
    tools: ToolDefinition[],
    messages: ToolLoopMessage[],
    onToolCall: (call: ToolCall) => Promise<ToolResult>,
    context: ToolLoopContext,
  ): Promise<ToolLoopResult> {
    const transcript: ToolLoopMessage[] = [...messages];
    const publishTranscript = () => {
      context.onTranscriptUpdate?.(transcript.map((message) => ({ ...message })));
    };
    const cliVersion = await this.getCliVersionTag();
    let providerSession = {
      provider: 'gemini' as const,
      transport: 'stateful-resume' as const,
      sessionId: context.providerSession?.sessionId,
      cliVersion,
      toolNamespace: context.toolNamespace ?? 'mcp__crew__',
      toolSchemaHash: context.toolSchemaHash ?? '',
      startedAt: context.providerSession?.startedAt ?? new Date().toISOString(),
      lastTurnAt: new Date().toISOString(),
    };
    context.onProviderSession?.(providerSession);
    let prompt = buildDecisionPrompt(
      tools,
      transcript,
      { continueFromSession: Boolean(providerSession.sessionId) },
    );

    const allowedServerNames =
      context.mcpRegistration?.kind === 'gemini-cli'
        ? context.mcpRegistration.allowedServerNames
        : undefined;

    for (let turn = 1; turn <= TOOL_LOOP_MAX_TURNS; turn++) {
      const args = buildGeminiResumeArgs(providerSession.sessionId, prompt, {
        allowedServerNames,
      });

      const result = await execa('gemini', args, {
        cwd: context.workingDirectory,
        cancelSignal: context.signal,
        reject: false,
      });

      const stderrText = result.stderr ?? '';
      if (isInvalidSessionStderr(stderrText)) {
        logger.warn('[adapter:gemini-cli] session id rejected by CLI; dropping it for replay', {
          sessionId: providerSession.sessionId,
        });
        providerSession = {
          ...providerSession,
          sessionId: undefined,
          lastTurnAt: new Date().toISOString(),
        };
        context.onProviderSession?.(providerSession);
        throw new Error('Gemini resume session invalidated upstream; caller must replay.');
      }

      if (result.exitCode !== 0 && !result.stdout) {
        throw new Error(stderrText || `gemini exited with code ${result.exitCode}`);
      }

      const events = parseStreamJsonEvents(result.stdout ?? '');
      const maybeSessionId = extractStreamJsonSessionId(events);
      if (maybeSessionId && maybeSessionId !== providerSession.sessionId) {
        providerSession = {
          ...providerSession,
          sessionId: maybeSessionId,
          lastTurnAt: new Date().toISOString(),
        };
        context.onProviderSession?.(providerSession);
      }

      const assistantText = extractStreamJsonAssistantText(events);
      if (!assistantText) {
        throw new Error('Gemini CLI returned no decision text.');
      }
      const decision = ToolLoopDecisionSchema.parse(extractJson(assistantText));

      if (decision.reasoning) {
        transcript.push({ role: 'assistant', content: decision.reasoning });
        publishTranscript();
      }

      if (decision.type === 'finish') {
        return {
          status: 'completed',
          transcript,
          output: decision.output ?? decision.reasoning ?? '',
          pathTaken: 'stateful-resume',
          providerSession,
        };
      }
      if (decision.type === 'fail') {
        return {
          status: 'failed',
          transcript,
          error: decision.error ?? decision.reasoning ?? 'Controller requested fail',
          pathTaken: 'stateful-resume',
          providerSession,
        };
      }

      const toolName = decision.tool?.trim();
      if (!toolName) throw new Error('Tool call missing tool name.');
      const toolInput = parseToolInput(decision.input);
      transcript.push({
        role: 'assistant',
        content: JSON.stringify({ type: 'tool_call', tool: toolName, input: toolInput }),
      });
      publishTranscript();
      const toolResult = await onToolCall({ name: toolName, input: toolInput });
      transcript.push({
        role: 'tool',
        name: toolName,
        content: JSON.stringify(toolResult.output),
      });
      publishTranscript();
      if (toolResult.terminal) {
        return {
          status: 'completed',
          transcript,
          output: resolveTerminalOutput(toolResult),
          pathTaken: 'stateful-resume',
          providerSession,
        };
      }
      prompt = [
        `Tool ${toolName} returned:`,
        JSON.stringify(toolResult.output),
        'Choose the next action as a JSON object.',
      ].join('\n');
    }

    return {
      status: 'failed',
      transcript,
      error: `Exceeded maximum native tool-loop turns (${TOOL_LOOP_MAX_TURNS}).`,
      pathTaken: 'stateful-resume',
      providerSession,
    };
  }

  private async executeWithPromptLoop(
    tools: ToolDefinition[],
    messages: ToolLoopMessage[],
    onToolCall: (call: ToolCall) => Promise<ToolResult>,
    context?: ToolLoopContext,
  ): Promise<ToolLoopResult> {
    return executePromptToolLoop(
      tools,
      messages,
      onToolCall,
      (prompt) =>
        this.executeWithSchema(prompt, ToolLoopDecisionSchema, {
          signal: context?.signal,
          workingDirectory: context?.workingDirectory,
        }),
      {
        pathTaken: 'adapter',
        signal: context?.signal,
        onTranscriptUpdate: context?.onTranscriptUpdate,
      },
    );
  }
}
