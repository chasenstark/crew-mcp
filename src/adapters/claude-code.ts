import { execa } from 'execa';
import { z } from 'zod';
import { extractJson } from '../utils/json-parse.js';

import type {
  AgentAdapter,
  AgentCapability,
  ExecuteOptions,
  HealthCheckResult,
  Task,
  TaskResult,
  ToolCall,
  ToolLoopContext,
  ToolDefinition,
  ToolLoopMessage,
  ToolLoopResult,
  ToolResult,
} from './types.js';
import { logger } from '../utils/logger.js';
import { buildCliVersionTag } from '../provider-session.js';
import { AgentId } from '../workflow/agents.js';
import { executePromptToolLoop } from './tool-loop/controller.js';
import { resolveTerminalOutput } from './tool-loop/result.js';
import {
  parseToolInput,
  ToolLoopDecisionSchema,
  type ToolLoopDecision,
} from './tool-loop/decision.js';
import { TOOL_LOOP_MAX_TURNS } from './tool-loop/constants.js';
import { buildDecisionPrompt } from './tool-loop/transcript.js';

/**
 * Schema for the JSON response from `claude -p ... --output-format json`.
 */
const ClaudeResponseSchema = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  session_id: z.string().optional(),
  total_cost_usd: z.number().optional(),
  cost_usd: z.number().optional(),
  duration_ms: z.number().optional(),
  num_turns: z.number().optional(),
  is_error: z.boolean().optional(),
});

type ClaudeResponse = z.infer<typeof ClaudeResponseSchema>;

/**
 * Exported argv builder for Claude's streaming tool-loop invocation.
 * Lives outside the class so M3-8 tests can assert `--mcp-config` placement
 * without spinning up a subprocess or mocking execa. Callers inside the
 * adapter delegate to this to keep argv construction in one place.
 */
export function buildClaudeStreamArgs(opts: {
  readonly resumedSessionId?: string;
  readonly mcpConfigJson?: string;
}): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];
  if (opts.resumedSessionId) {
    args.push('--resume', opts.resumedSessionId);
  }
  // M3-8: per-invocation MCP config. Claude accepts either a file path or
  // an inline JSON literal for `--mcp-config`; inline keeps install-time
  // writes out. Session-loop attaches a `claude-code`-kind payload sourced
  // from `toClaudeMcpConfigJson(catalog)`.
  if (opts.mcpConfigJson !== undefined) {
    args.push('--mcp-config', opts.mcpConfigJson);
  }
  return args;
}

function preview(text: string | undefined, max = 600): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}...`;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  return value as Record<string, unknown>;
}

function getNumericField(
  value: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function mergeUsage(
  current: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  },
  next: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  },
): {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
} {
  return {
    inputTokens: next.inputTokens ?? current.inputTokens,
    outputTokens: next.outputTokens ?? current.outputTokens,
    cachedInputTokens: next.cachedInputTokens ?? current.cachedInputTokens,
  };
}

/**
 * Extracts the final result envelope from claude's stream-json output, which
 * emits one JSON object per line. The last `type: "result"` line is the
 * summary equivalent to non-streaming `--output-format json`.
 *
 * When the process is killed before completing (timeout, cancellation), no
 * result line is emitted. In that case we fall back to constructing a
 * synthetic envelope from whatever assistant text was streamed so upstream
 * code can still surface partial output instead of losing it entirely.
 */
function extractStreamEnvelope(stdout: string): ClaudeResponse | undefined {
  if (!stdout) return undefined;
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const assistantChunks: string[] = [];
  let sessionId: string | undefined;

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]) as { type?: string; session_id?: string };
      if (obj.type === 'result') {
        return ClaudeResponseSchema.parse(obj);
      }
    } catch {
      // non-JSON line, skip
    }
  }

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as { type?: string; session_id?: string };
      if (obj.session_id && !sessionId) sessionId = obj.session_id;
      const chunk = extractAssistantTextFromStreamLine(line);
      if (chunk) assistantChunks.push(chunk);
    } catch {
      // non-JSON line, skip
    }
  }

  if (assistantChunks.length === 0) return undefined;
  return {
    type: 'result',
    subtype: 'partial',
    result: assistantChunks.join(''),
    session_id: sessionId,
    is_error: true,
  };
}

/**
 * Pulls user-visible assistant text from a single stream-json line.
 * Returns '' for non-assistant events (tool_use, system, result).
 */
function extractAssistantTextFromStreamLine(line: string): string {
  try {
    const obj = JSON.parse(line) as {
      type?: string;
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
    if (obj.type !== 'assistant' || !obj.message?.content) return '';
    return obj.message.content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
  } catch {
    return '';
  }
}

/**
 * Extracts modified file paths from Claude's result text.
 * Looks for common patterns like "Files created:", "Files modified:", etc.
 */
function extractFilePaths(text: string): string[] {
  const paths: string[] = [];
  const lines = text.split('\n');
  let inFileList = false;

  for (const line of lines) {
    if (/files?\s+(created|modified|updated|changed|edited)/i.test(line)) {
      inFileList = true;
      // Check if the file path is on the same line after a colon
      const afterColon = line.split(':').slice(1).join(':').trim();
      if (afterColon && afterColon.startsWith('- ')) {
        const path = afterColon.replace(/^- /, '').trim();
        if (path) paths.push(path);
      }
      continue;
    }

    if (inFileList) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        const path = trimmed.replace(/^- /, '').trim();
        if (path) paths.push(path);
      } else if (trimmed === '') {
        inFileList = false;
      } else {
        inFileList = false;
      }
    }
  }

  return paths;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = AgentId.CLAUDE_CODE;
  readonly capabilities: AgentCapability[] = [
    'implement',
    'review',
    'refactor',
    'test',
    'document',
    'analyze',
  ];
  readonly supportsJsonSchema = true;
  readonly captainCapabilities = {
    supportsToolLoop: true,
    supportsStructuredDecisions: true,
    supportsPauseForUserInput: true,
  };

  recognizesModel(modelId: string): boolean {
    return typeof modelId === 'string' && /^claude-/.test(modelId);
  }

  async getCliVersionTag(): Promise<string | undefined> {
    const result = await execa('claude', ['--version'], {
      timeout: 10_000,
      reject: false,
    });
    if (result.exitCode !== 0) return undefined;

    const text = `${result.stdout ?? ''} ${result.stderr ?? ''}`.trim();
    const match = text.match(/(\d+\.\d+\.\d+)/);
    if (!match) return undefined;
    return buildCliVersionTag(AgentId.CLAUDE_CODE, match[1]);
  }

  async execute(task: Task): Promise<TaskResult> {
    const streaming = Boolean(task.onOutput);
    const args = [
      '-p',
      task.prompt,
      '--output-format',
      streaming ? 'stream-json' : 'json',
      ...(streaming ? ['--verbose'] : []),
      '--dangerously-skip-permissions',
    ];

    if (task.constraints?.model) {
      args.push('--model', task.constraints.model);
    }

    if (task.constraints?.maxTurns) {
      args.push('--max-turns', String(task.constraints.maxTurns));
    }

    const timeout = task.constraints?.timeout ?? 300_000; // 5 minutes default
    logger.debug('[adapter:claude-code] starting execute', {
      cwd: task.context.workingDirectory,
      timeoutMs: timeout,
      maxTurns: task.constraints?.maxTurns,
      model: task.constraints?.model,
      promptChars: task.prompt.length,
    });

    let result;
    try {
      const subprocess = execa('claude', args, {
        cwd: task.context.workingDirectory,
        timeout,
        cancelSignal: task.constraints?.signal,
        reject: false,
        stdin: 'ignore',
      });

      if (streaming && subprocess.stdout) {
        let buffer = '';
        subprocess.stdout.on('data', (buf: Buffer) => {
          buffer += buf.toString('utf-8');
          let newlineIdx: number;
          while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (!line) continue;
            const chunk = extractAssistantTextFromStreamLine(line);
            if (chunk) task.onOutput!(chunk);
          }
        });
      }

      result = await subprocess;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Unknown execution error';
      const partialStdout = typeof (error as { stdout?: unknown })?.stdout === 'string'
        ? (error as { stdout: string }).stdout
        : '';
      const partialStderr = typeof (error as { stderr?: unknown })?.stderr === 'string'
        ? (error as { stderr: string }).stderr
        : '';
      const partialEnvelope = streaming ? extractStreamEnvelope(partialStdout) : undefined;
      const partialOutput = partialEnvelope?.result ?? partialStdout;
      logger.error('[adapter:claude-code] process execution threw', {
        cwd: task.context.workingDirectory,
        timeoutMs: timeout,
        error: message,
      });
      return {
        output: partialOutput || partialStderr || message,
        filesModified: [],
        status: 'error',
        sessionId: partialEnvelope?.session_id,
        metadata: {
          rawEvents: [{
            error: message,
            rawStdout: partialStdout,
            rawStderr: partialStderr,
          }],
        },
      };
    }

    const stdoutText = result.stdout ?? '';
    const stderrText = result.stderr ?? '';
    logger.debug('[adapter:claude-code] execute finished', {
      exitCode: result.exitCode,
      stdoutChars: stdoutText.length,
      stderrChars: stderrText.length,
    });

    // CLI crash: non-zero exit code and no stdout
    if (!stdoutText && result.exitCode !== 0) {
      logger.error('[adapter:claude-code] command failed with no stdout', {
        exitCode: result.exitCode,
        stderrPreview: preview(stderrText),
      });
      return {
        output: stderrText || 'Claude CLI exited with no output',
        filesModified: [],
        status: 'error',
        metadata: {
          rawEvents: [
            {
              exitCode: result.exitCode,
              stderr: stderrText,
            },
          ],
        },
      };
    }

    // Parse JSON response. In stream-json mode the envelope is the last
    // line of type "result"; in json mode the entire stdout is the envelope.
    let parsed: ClaudeResponse | undefined;
    let parseError: string | undefined;
    if (streaming) {
      parsed = extractStreamEnvelope(stdoutText);
      if (!parsed) parseError = 'no result envelope or assistant text in stream';
    } else {
      try {
        parsed = ClaudeResponseSchema.parse(JSON.parse(stdoutText));
      } catch (error: unknown) {
        parseError = error instanceof Error ? error.message : 'JSON parse error';
      }
    }

    if (!parsed) {
      logger.error('[adapter:claude-code] failed to parse JSON output', {
        exitCode: result.exitCode,
        stdoutPreview: preview(stdoutText),
        stderrPreview: preview(stderrText),
      });
      return {
        output: stdoutText || 'Failed to parse Claude response',
        filesModified: [],
        status: 'error',
        metadata: {
          rawEvents: [
            {
              parseError,
              rawStdout: stdoutText,
            },
          ],
        },
      };
    }

    const filesModified = extractFilePaths(parsed.result ?? '');

    return {
      output: parsed.result ?? '',
      filesModified,
      status: parsed.is_error ? 'error' : 'success',
      sessionId: parsed.session_id,
      metadata: {
        costUsd: parsed.total_cost_usd ?? parsed.cost_usd,
        durationMs: parsed.duration_ms,
        numTurns: parsed.num_turns,
      },
    };
  }

  async executeWithSchema<T extends z.ZodType>(
    prompt: string,
    schema: T,
    options?: ExecuteOptions,
  ): Promise<z.infer<T>> {
    const rawJsonSchema = z.toJSONSchema(schema);
    // Strip $schema meta-field — some CLI versions don't accept it
    const { $schema: _, ...cleanSchema } = rawJsonSchema as Record<string, unknown>;
    const jsonSchema = JSON.stringify(cleanSchema);

    // Embed the schema in the prompt so the model knows the expected shape
    // even if --json-schema enforcement doesn't populate structured_output.
    const fullPrompt = prompt +
      '\n\nYou MUST respond with valid JSON matching this exact schema:\n' +
      JSON.stringify(cleanSchema, null, 2);

    const args = [
      '-p',
      fullPrompt,
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
      ...(options?.model ? ['--model', options.model] : []),
      '--json-schema',
      jsonSchema,
      // Override the system prompt to prevent CLAUDE.md, hooks, and output
      // styles from interfering with structured JSON output. This keeps
      // OAuth/keychain auth working (unlike --bare which disables them).
      '--system-prompt',
      'You are a structured data extraction engine. Return ONLY valid JSON matching the provided schema. No prose, no markdown, no explanations.',
      // Disable all tools — captain steps only need to analyze the prompt
      // and return JSON, never browse files or run commands.
      '--tools',
      '',
    ];

    if (options?.maxTurns) {
      args.push('--max-turns', String(options.maxTurns));
    }

    const timeout = options?.timeout ?? 300_000;
    logger.debug('[adapter:claude-code] starting executeWithSchema', {
      cwd: options?.workingDirectory,
      timeoutMs: timeout,
      maxTurns: options?.maxTurns,
      model: options?.model,
      promptChars: prompt.length,
    });

    let result;
    try {
      result = await execa('claude', args, {
        cwd: options?.workingDirectory,
        timeout,
        cancelSignal: options?.signal,
        reject: false,
        stdin: 'ignore',
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown execution error';
      logger.error('[adapter:claude-code] executeWithSchema process threw', {
        cwd: options?.workingDirectory,
        timeoutMs: timeout,
        error: message,
      });
      throw new Error(`Claude execution failed before producing output: ${message}`);
    }

    const schemaStdout = result.stdout ?? '';
    const schemaStderr = result.stderr ?? '';
    logger.debug('[adapter:claude-code] executeWithSchema finished', {
      exitCode: result.exitCode,
      stdoutChars: schemaStdout.length,
      stderrChars: schemaStderr.length,
    });

    if (!schemaStdout) {
      logger.error('[adapter:claude-code] executeWithSchema returned no stdout', {
        exitCode: result.exitCode,
        stderrPreview: preview(schemaStderr),
      });
      throw new Error(
        `Claude CLI returned no output (exit code ${result.exitCode}): ${schemaStderr}`,
      );
    }

    let parsed: ClaudeResponse;
    try {
      parsed = ClaudeResponseSchema.parse(JSON.parse(schemaStdout));
    } catch {
      logger.error('[adapter:claude-code] executeWithSchema failed to parse JSON envelope', {
        stdoutPreview: preview(schemaStdout),
        stderrPreview: preview(schemaStderr),
      });
      throw new Error(`Failed to parse Claude response: ${schemaStdout}`);
    }

    if (parsed.is_error) {
      logger.error('[adapter:claude-code] executeWithSchema returned error response', {
        resultPreview: preview(parsed.result),
      });
      throw new Error(`Claude returned an error: ${parsed.result}`);
    }

    // Prefer structured_output (populated when --json-schema is supported).
    // Fall back to extracting JSON from the result string — the model may
    // wrap it in markdown fences or include extra text.
    let output: unknown = parsed.structured_output;
    if (output === undefined || output === null) {
      if (!parsed.result) {
        throw new Error('Claude returned neither structured_output nor a result string');
      }
      try {
        output = extractJson(parsed.result);
      } catch {
        logger.error('[adapter:claude-code] executeWithSchema could not extract JSON payload', {
          resultPreview: preview(parsed.result),
        });
        throw new Error(
          `Claude returned no structured_output and could not extract JSON from result: ${parsed.result.slice(0, 200)}`,
        );
      }
    }

    return schema.parse(output) as z.infer<T>;
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
      return await this.executeWithStreamSession(tools, messages, onToolCall, wrappedContext);
    } catch (error: unknown) {
      if (context.signal?.aborted) {
        return {
          status: 'interrupted',
          transcript: latestTranscript,
          pathTaken: 'fallback',
          error: String(context.signal.reason ?? 'Cancelled'),
        };
      }
      logger.warn('[adapter:claude-code] stateful stream path failed; falling back to adapter loop', {
        error: error instanceof Error ? error.message : String(error),
      });
      context.onProviderSession?.({
        provider: 'claude',
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

  private async executeWithStreamSession(
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
    const resumedSessionId = context.providerSession?.sessionId;

    const args = buildClaudeStreamArgs({
      resumedSessionId,
      mcpConfigJson:
        context.mcpRegistration?.kind === 'claude-code'
          ? context.mcpRegistration.inlineConfigJson
          : undefined,
    });

    logger.info('[adapter:claude-code] spawning stream session', {
      cwd: context.workingDirectory,
      resumedSessionId,
      toolCount: tools.length,
    });
    const subprocess = execa('claude', args, {
      cwd: context.workingDirectory,
      cancelSignal: context.signal,
      reject: false,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (!subprocess.stdout || !subprocess.stdin) {
      throw new Error('Claude stream session missing stdio pipes.');
    }

    if (subprocess.stderr) {
      subprocess.stderr.setEncoding('utf-8');
      subprocess.stderr.on('data', (chunk: string) => {
        const trimmed = chunk.trim();
        if (trimmed) logger.warn('[adapter:claude-code] stderr', trimmed);
      });
    }
    subprocess.on('exit', (code, signal) => {
      logger.info('[adapter:claude-code] subprocess exit', { code, signal });
    });

    const providerSession = {
      provider: 'claude' as const,
      transport: resumedSessionId ? 'stateful-resume' as const : 'native' as const,
      sessionId: resumedSessionId,
      cliVersion,
      toolNamespace: context.toolNamespace ?? 'mcp__crew__',
      toolSchemaHash: context.toolSchemaHash ?? '',
      startedAt: context.providerSession?.startedAt ?? new Date().toISOString(),
      lastTurnAt: new Date().toISOString(),
    };
    context.onProviderSession?.(providerSession);

    const iterator = this.streamJsonLines(subprocess.stdout)[Symbol.asyncIterator]();

    const bootstrapPrompt = buildDecisionPrompt(
      tools,
      transcript,
      { continueFromSession: Boolean(resumedSessionId) },
    );

    let pendingPrompt = bootstrapPrompt;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedInputTokens = 0;
    let turnCount = 0;

    try {
      for (let turn = 1; turn <= TOOL_LOOP_MAX_TURNS; turn++) {
        const userMessage = {
          type: 'user',
          message: {
            role: 'user',
            content: pendingPrompt,
          },
        };
        logger.info('[adapter:claude-code] stream turn start', {
          turn,
          promptPreview: preview(pendingPrompt, 200),
        });
        subprocess.stdin.write(`${JSON.stringify(userMessage)}\n`);

        const turnData = await this.readStreamTurn(iterator);
        logger.info('[adapter:claude-code] stream turn end', {
          turn,
          assistantPreview: preview(turnData.assistantText, 200),
          sessionId: turnData.sessionId,
        });
        turnCount = turn;
        totalInputTokens += turnData.usage.inputTokens ?? 0;
        totalOutputTokens += turnData.usage.outputTokens ?? 0;
        totalCachedInputTokens += turnData.usage.cachedInputTokens ?? 0;

        if (turnData.sessionId && turnData.sessionId !== providerSession.sessionId) {
          providerSession.sessionId = turnData.sessionId;
          providerSession.lastTurnAt = new Date().toISOString();
          context.onProviderSession?.(providerSession);
        }

        const parsedDecision = this.parseToolDecisionFromAssistant(turnData.assistantText);
        if (parsedDecision.reasoning) {
          transcript.push({
            role: 'assistant',
            content: parsedDecision.reasoning,
          });
          publishTranscript();
        }

        if (parsedDecision.type === 'finish') {
          subprocess.stdin.end();
          return {
            status: 'completed',
            transcript,
            output: parsedDecision.output ?? parsedDecision.reasoning ?? '',
            pathTaken: providerSession.transport,
            providerSession,
            telemetry: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              cachedInputTokens: totalCachedInputTokens,
              totalTurns: turnCount,
            },
          };
        }

        if (parsedDecision.type === 'fail') {
          subprocess.stdin.end();
          return {
            status: 'failed',
            transcript,
            error: parsedDecision.error ?? parsedDecision.reasoning ?? 'Controller requested fail',
            pathTaken: providerSession.transport,
            providerSession,
            telemetry: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              cachedInputTokens: totalCachedInputTokens,
              totalTurns: turnCount,
            },
          };
        }

        const toolName = parsedDecision.tool?.trim();
        if (!toolName) {
          throw new Error('Tool call missing tool name.');
        }

        const knownTool = tools.find((tool) => tool.name === toolName);
        if (!knownTool) {
          throw new Error(`Unknown tool "${toolName}".`);
        }

        const toolInput = parseToolInput(parsedDecision.input);
        transcript.push({
          role: 'assistant',
          content: JSON.stringify({
            type: 'tool_call',
            tool: toolName,
            input: toolInput,
          }),
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
          subprocess.stdin.end();
          return {
            status: 'completed',
            transcript,
            output: resolveTerminalOutput(toolResult),
            pathTaken: providerSession.transport,
            providerSession,
            telemetry: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              cachedInputTokens: totalCachedInputTokens,
              totalTurns: turnCount,
            },
          };
        }

        pendingPrompt = [
          `Tool ${toolName} returned:`,
          JSON.stringify(toolResult.output),
          'Choose the next action as a JSON object.',
        ].join('\n');
      }
    } finally {
      subprocess.stdin.end();
      try {
        await subprocess;
      } catch {
        // execa reject is disabled, but keep this as a final safety net.
      }
    }

    return {
      status: 'failed',
      transcript,
      error: `Exceeded maximum native tool-loop turns (${TOOL_LOOP_MAX_TURNS}).`,
      pathTaken: providerSession.transport,
      providerSession,
      telemetry: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cachedInputTokens: totalCachedInputTokens,
        totalTurns: turnCount,
      },
    };
  }

  private parseToolDecisionFromAssistant(text: string): ToolLoopDecision {
    const payload = extractJson(text);
    return ToolLoopDecisionSchema.parse(payload);
  }

  private async readStreamTurn(
    iterator: AsyncIterator<string>,
  ): Promise<{
    assistantText: string;
    sessionId?: string;
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
    };
  }> {
    let assistantText = '';
    let sessionId: string | undefined;
    let usage: {
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
    } = {};

    const idleMs = Number(process.env.CREW_STREAM_IDLE_TIMEOUT_MS ?? 120_000);

    while (true) {
      const next = await this.nextWithIdleTimeout(iterator, idleMs);
      if (next.done) {
        throw new Error('Claude stream ended before result event.');
      }

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(next.value) as Record<string, unknown>;
      } catch {
        continue;
      }

      const lineText = extractAssistantTextFromStreamLine(next.value);
      if (lineText) assistantText += lineText;

      if (typeof event.session_id === 'string') {
        sessionId = event.session_id;
      }

      usage = mergeUsage(usage, this.extractUsageFromEvent(event));
      if (event.type === 'result') {
        return { assistantText, sessionId, usage };
      }
    }
  }

  private extractUsageFromEvent(event: Record<string, unknown>): {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  } {
    const directUsage = asObject(event.usage);
    const messageUsage = asObject(asObject(event.message).usage);
    const usage = Object.keys(directUsage).length > 0 ? directUsage : messageUsage;

    return {
      inputTokens: getNumericField(usage, ['input_tokens']),
      outputTokens: getNumericField(usage, ['output_tokens']),
      cachedInputTokens: getNumericField(usage, ['cache_read_input_tokens', 'cached_input_tokens']),
    };
  }

  private async nextWithIdleTimeout<T>(
    iterator: AsyncIterator<T>,
    idleMs: number,
  ): Promise<IteratorResult<T>> {
    if (!Number.isFinite(idleMs) || idleMs <= 0) {
      return iterator.next();
    }
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<IteratorResult<T>>((_resolve, reject) => {
      timer = setTimeout(() => {
        const seconds = Math.round(idleMs / 1000);
        const err = new Error(
          `Claude stream idle for ${seconds}s with no stream-json output — aborting turn. `
          + `Set CREW_STREAM_IDLE_TIMEOUT_MS to adjust; check that 'claude' CLI is authenticated and reachable.`,
        );
        logger.error('[adapter:claude-code] stream idle timeout', { idleMs });
        reject(err);
      }, idleMs);
    });
    try {
      return await Promise.race([iterator.next(), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async *streamJsonLines(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
    let buffer = '';
    for await (const chunk of stream) {
      buffer += chunk.toString('utf-8');
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) yield line;
        newlineIndex = buffer.indexOf('\n');
      }
    }

    const trailing = buffer.trim();
    if (trailing) {
      yield trailing;
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    // Check version
    let version: string | undefined;
    try {
      const versionResult = await execa('claude', ['--version'], {
        timeout: 10_000,
        reject: false,
      });
      if (versionResult.exitCode === 0 && versionResult.stdout) {
        version = versionResult.stdout.trim();
      } else {
        return {
          available: false,
          authenticated: false,
          error: versionResult.stderr || 'claude --version failed',
        };
      }
    } catch {
      return {
        available: false,
        authenticated: false,
        error: 'Claude CLI not found',
      };
    }

    // Auth check with a minimal prompt
    try {
      const authResult = await execa(
        'claude',
        ['-p', 'respond with OK', '--output-format', 'json', '--max-turns', '1'],
        {
          timeout: 30_000,
          reject: false,
          stdin: 'ignore',
        },
      );

      if (authResult.exitCode === 0 && authResult.stdout) {
        return {
          available: true,
          version,
          authenticated: true,
        };
      }

      let authError: string | undefined;
      if (authResult.stdout?.trim()) {
        try {
          const parsed = ClaudeResponseSchema.safeParse(JSON.parse(authResult.stdout));
          if (parsed.success && typeof parsed.data.result === 'string' && parsed.data.result.trim()) {
            authError = parsed.data.result.trim();
          } else {
            authError = authResult.stdout.trim();
          }
        } catch {
          authError = authResult.stdout.trim();
        }
      }
      if (!authError) {
        authError = authResult.stderr?.trim();
      }

      return {
        available: true,
        version,
        authenticated: false,
        error: authError || 'Authentication check failed',
      };
    } catch {
      return {
        available: true,
        version,
        authenticated: false,
        error: 'Authentication check timed out',
      };
    }
  }
}
