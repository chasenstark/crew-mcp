import { execa } from 'execa';
import { z } from 'zod';

import {
  writeFileSync,
  readFileSync,
  mkdtempSync,
  existsSync,
  rmSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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
import {
  ToolLoopDecisionSchema,
  type ToolLoopDecision,
} from './tool-loop/decision.js';
import { TOOL_LOOP_MAX_TURNS } from './tool-loop/constants.js';

/**
 * Represents a single event line in the Codex JSONL output.
 */
interface CodexEvent {
  type: string;
  thread_id?: string;
  turn_id?: string;
  content?: string;
  command?: string;
  exit_code?: number;
  path?: string;
  action?: string;
  message?: string;
  reason?: string;
  [key: string]: unknown;
}

/**
 * Result of parsing JSONL text, including metrics on dropped lines.
 */
interface ParseJsonlResult {
  events: CodexEvent[];
  droppedLines: number;
}

function preview(text: string | undefined, max = 600): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}...`;
}

function numberField(
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

/**
 * Parses newline-delimited JSON (JSONL) into an array of events.
 * Malformed lines are logged at warn level and counted.
 */
function parseJsonl(text: string): ParseJsonlResult {
  const events: CodexEvent[] = [];
  const lines = text.split('\n');
  let droppedLines = 0;
  let nonEmptyLineCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    nonEmptyLineCount++;
    try {
      events.push(JSON.parse(trimmed) as CodexEvent);
    } catch {
      droppedLines++;
      logger.warn(`Codex JSONL: dropped malformed line: ${trimmed}`);
    }
  }

  if (droppedLines > 0) {
    logger.warn(`Codex JSONL: ${droppedLines} of ${nonEmptyLineCount} lines failed to parse`);
  }

  return { events, droppedLines };
}

/**
 * Extracts file paths that were changed from Codex events.
 */
function extractFileChanges(events: CodexEvent[]): string[] {
  const files: string[] = [];
  for (const event of events) {
    if (
      event.type === 'item.file_change' &&
      event.path &&
      event.action !== 'none'
    ) {
      files.push(event.path);
    }
  }
  return files;
}

/**
 * Gets the final agent message from events.
 */
function getLastAgentMessage(events: CodexEvent[]): string {
  let lastMessage = '';
  for (const event of events) {
    if (event.type === 'item.agent_message' && event.content) {
      lastMessage = event.content;
    }
  }
  return lastMessage;
}

/**
 * Formats a single Codex event as a user-visible chunk for streaming.
 * Return an empty string to suppress the event from the live view.
 *
 * TODO(user): Decide which event types should stream to the UI and how they
 * should be formatted. The Codex JSONL stream contains many event types
 * (item.agent_message, item.reasoning, item.command_execution, item.file_change,
 * turn.started, turn.completed, thread.started, etc.). Picking the right
 * subset shapes how the feature feels — too much is noisy, too little feels dead.
 *
 * Consider: do you want to show agent thoughts/reasoning, tool calls, file
 * edits, or only the final message? Format should be concise — users will
 * see these inline in the conversation view.
 *
 * Example formats:
 *   item.agent_message  -> event.content (the assistant's prose)
 *   item.command_execution -> `$ ${event.command}`
 *   item.file_change    -> `~ ${event.action} ${event.path}`
 */
function formatEventForStream(event: CodexEvent): string {
  if (event.type === 'item.agent_message' && event.content) {
    return event.content;
  }
  if (event.type === 'item.reasoning' && event.content) {
    return `\u2502 ${event.content}\n`;
  }
  return '';
}

/**
 * Checks if the events contain an error.
 */
function findError(events: CodexEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === 'error' && event.message) {
      return event.message;
    }
    if (event.type === 'turn.failed' && event.reason) {
      return `Turn failed: ${event.reason}`;
    }
  }
  return undefined;
}

export class CodexAdapter implements AgentAdapter {
  readonly name = AgentId.CODEX;
  readonly capabilities: AgentCapability[] = [
    'implement',
    'review',
    'refactor',
    'test',
    'analyze',
  ];
  readonly supportsJsonSchema = true;
  readonly orchestratorCapabilities = {
    supportsToolLoop: true,
    supportsStructuredDecisions: true,
    supportsPauseForUserInput: true,
  };

  async getCliVersionTag(): Promise<string | undefined> {
    const versionResult = await execa(AgentId.CODEX, ['--version'], {
      timeout: 10_000,
      reject: false,
    });
    if (versionResult.exitCode === 0) {
      const match = `${versionResult.stdout ?? ''} ${versionResult.stderr ?? ''}`
        .match(/(\d+\.\d+\.\d+)/);
      if (match) {
        return buildCliVersionTag(AgentId.CODEX, match[1]);
      }
    }

    const helpResult = await execa(AgentId.CODEX, ['--help'], {
      timeout: 10_000,
      reject: false,
    });
    if (helpResult.exitCode !== 0) return undefined;
    const fallbackMatch = `${helpResult.stdout ?? ''} ${helpResult.stderr ?? ''}`
      .match(/(\d+\.\d+\.\d+)/);
    if (!fallbackMatch) return undefined;
    return buildCliVersionTag(AgentId.CODEX, fallbackMatch[1]);
  }

  async execute(task: Task): Promise<TaskResult> {
    const tmpDir = mkdtempSync(join(tmpdir(), 'codex-'));
    try {
      const outputFile = join(tmpDir, 'output.json');

      const args = ['exec', task.prompt, '--json', '-o', outputFile];
      if (task.constraints?.model) {
        args.push('--model', task.constraints.model);
      }

      const timeout = task.constraints?.timeout ?? 300_000;
      logger.debug('[adapter:codex] starting execute', {
        cwd: task.context.workingDirectory,
        timeoutMs: timeout,
        outputFile,
        model: task.constraints?.model,
        promptChars: task.prompt.length,
      });

      let result;
      try {
        const subprocess = execa(AgentId.CODEX, args, {
          cwd: task.context.workingDirectory,
          timeout,
          cancelSignal: task.constraints?.signal,
          reject: false,
        });

        if (task.onOutput && subprocess.stdout) {
          let buffer = '';
          subprocess.stdout.on('data', (buf: Buffer) => {
            buffer += buf.toString('utf-8');
            let newlineIdx: number;
            while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, newlineIdx).trim();
              buffer = buffer.slice(newlineIdx + 1);
              if (!line) continue;
              try {
                const event = JSON.parse(line) as CodexEvent;
                const chunk = formatEventForStream(event);
                if (chunk) task.onOutput!(chunk);
              } catch {
                // Malformed line — already logged by the final parseJsonl pass.
              }
            }
          });
        }

        result = await subprocess;
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : 'Unknown execution error';
        logger.error('[adapter:codex] process execution threw', {
          cwd: task.context.workingDirectory,
          timeoutMs: timeout,
          error: message,
        });
        return {
          output: '',
          filesModified: [],
          status: 'error',
          metadata: {
            rawEvents: [{ error: message }],
          },
        };
      }

      logger.debug('[adapter:codex] execute finished', {
        exitCode: result.exitCode,
        stdoutChars: result.stdout?.length ?? 0,
        stderrChars: result.stderr?.length ?? 0,
      });

      if (result.exitCode !== 0 && !result.stdout) {
        logger.error('[adapter:codex] command failed with no stdout', {
          exitCode: result.exitCode,
          stderrPreview: preview(result.stderr),
        });
        return {
          output:
            result.stderr ||
            `Codex command failed with exit code ${result.exitCode} and no JSONL output`,
          filesModified: [],
          status: 'error',
          metadata: {
            rawEvents: [
              {
                exitCode: result.exitCode,
                stderr: result.stderr,
              },
            ],
          },
        };
      }

      // Parse JSONL from stdout
      const { events, droppedLines } = result.stdout
        ? parseJsonl(result.stdout)
        : { events: [], droppedLines: 0 };

      // If stdout was non-empty but every line failed to parse, treat as error
      if (result.stdout && events.length === 0) {
        logger.error('[adapter:codex] failed to parse any JSONL events', {
          droppedLines,
          stdoutPreview: preview(result.stdout),
        });
        return {
          output: 'Failed to parse any events from Codex JSONL output',
          filesModified: [],
          status: 'error',
          metadata: {
            rawEvents: [],
            droppedLines,
          },
        };
      }

      // Check for errors in events
      const errorMessage = findError(events);
      if (errorMessage) {
        logger.error('[adapter:codex] runtime error event detected', {
          errorMessage,
          droppedLines,
        });
        return {
          output: errorMessage,
          filesModified: [],
          status: 'error',
          metadata: {
            rawEvents: events,
            droppedLines,
          },
        };
      }

      // Extract file changes
      const filesModified = extractFileChanges(events);

      // Get output: prefer output file, fall back to last agent message
      let output = '';
      if (existsSync(outputFile)) {
        try {
          output = readFileSync(outputFile, 'utf-8');
        } catch {
          // Fall through to agent message
          logger.warn('[adapter:codex] could not read output file, falling back to event message', {
            outputFile,
          });
        }
      }
      if (!output) {
        output = getLastAgentMessage(events);
      }

      const hasFailedTurn = events.some((e) => e.type === 'turn.failed');

      return {
        output,
        filesModified,
        status: hasFailedTurn ? 'error' : output ? 'success' : 'partial',
        metadata: {
          rawEvents: events,
          droppedLines,
        },
      };
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
    }
  }

  async executeWithSchema<T extends z.ZodType>(
    prompt: string,
    schema: T,
    options?: ExecuteOptions,
  ): Promise<z.infer<T>> {
    const tmpDir = mkdtempSync(join(tmpdir(), 'codex-schema-'));
    try {
      const schemaFile = join(tmpDir, 'schema.json');
      const outputFile = join(tmpDir, 'output.json');

      const jsonSchema = z.toJSONSchema(schema);
      writeFileSync(schemaFile, JSON.stringify(jsonSchema, null, 2), 'utf-8');

      const args = [
        'exec',
        prompt,
        '--json',
        '--output-schema',
        schemaFile,
        '-o',
        outputFile,
        ...(options?.model ? ['--model', options.model] : []),
      ];

      const timeout = options?.timeout ?? 300_000;
      logger.debug('[adapter:codex] starting executeWithSchema', {
        cwd: options?.workingDirectory,
        timeoutMs: timeout,
        schemaFile,
        outputFile,
        model: options?.model,
        promptChars: prompt.length,
      });

      let result;
      try {
        result = await execa(AgentId.CODEX, args, {
          cwd: options?.workingDirectory,
          timeout,
          cancelSignal: options?.signal,
          reject: false,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown execution error';
        logger.error('[adapter:codex] executeWithSchema process threw', {
          cwd: options?.workingDirectory,
          timeoutMs: timeout,
          error: message,
        });
        throw new Error(`Codex execution failed before producing JSON output: ${message}`);
      }

      logger.debug('[adapter:codex] executeWithSchema finished', {
        exitCode: result.exitCode,
        stdoutChars: result.stdout?.length ?? 0,
        stderrChars: result.stderr?.length ?? 0,
      });

      if (result.exitCode !== 0 && !result.stdout) {
        logger.error('[adapter:codex] executeWithSchema failed with no stdout', {
          exitCode: result.exitCode,
          stderrPreview: preview(result.stderr),
        });
        throw new Error(
          `Codex schema execution failed with exit code ${result.exitCode}: ${result.stderr}`,
        );
      }

      // Check for errors in JSONL output
      if (result.stdout) {
        const { events } = parseJsonl(result.stdout);
        const errorMessage = findError(events);
        if (errorMessage) {
          logger.error('[adapter:codex] executeWithSchema returned error event', {
            errorMessage,
          });
          throw new Error(`Codex returned an error: ${errorMessage}`);
        }
      }

      // Read structured output from the output file
      if (!existsSync(outputFile)) {
        logger.error('[adapter:codex] executeWithSchema missing output file', {
          outputFile,
          exitCode: result.exitCode,
          stderrPreview: preview(result.stderr),
        });
        throw new Error(
          `Codex did not produce output file (exit code ${result.exitCode}): ${result.stderr}`,
        );
      }

      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(outputFile, 'utf-8'));
      } catch {
        logger.error('[adapter:codex] executeWithSchema output file was invalid JSON', {
          outputFile,
        });
        throw new Error(`Failed to parse Codex output file: ${outputFile}`);
      }

      return schema.parse(raw) as z.infer<T>;
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
    }
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

    try {
      return await this.executeWithResumeSession(tools, messages, onToolCall, context);
    } catch (error: unknown) {
      if (context.signal?.aborted) {
        return {
          status: 'interrupted',
          transcript: [...messages],
          pathTaken: 'fallback',
          error: String(context.signal.reason ?? 'Cancelled'),
        };
      }
      logger.warn('[adapter:codex] stateful resume path failed; falling back to adapter loop', {
        error: error instanceof Error ? error.message : String(error),
      });
      context.onProviderSession?.({
        provider: 'codex',
        transport: 'adapter',
        cliVersion: await this.getCliVersionTag(),
        toolNamespace: context.toolNamespace ?? 'mcp__orchestrator__',
        toolSchemaHash: context.toolSchemaHash ?? '',
        startedAt: context.providerSession?.startedAt ?? new Date().toISOString(),
        lastTurnAt: new Date().toISOString(),
      });
      const fallbackResult = await this.executeWithPromptLoop(tools, messages, onToolCall, context);
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
      { pathTaken: 'adapter' },
    );
  }

  private async executeWithResumeSession(
    tools: ToolDefinition[],
    messages: ToolLoopMessage[],
    onToolCall: (call: ToolCall) => Promise<ToolResult>,
    context: ToolLoopContext,
  ): Promise<ToolLoopResult> {
    const transcript: ToolLoopMessage[] = [...messages];
    const cliVersion = await this.getCliVersionTag();
    const configFlags = this.buildPerRunConfigFlags();

    let providerSession = {
      provider: 'codex' as const,
      transport: 'stateful-resume' as const,
      sessionId: context.providerSession?.sessionId,
      threadId: context.providerSession?.threadId,
      cliVersion,
      toolNamespace: context.toolNamespace ?? 'mcp__orchestrator__',
      toolSchemaHash: context.toolSchemaHash ?? '',
      startedAt: context.providerSession?.startedAt ?? new Date().toISOString(),
      lastTurnAt: new Date().toISOString(),
    };
    context.onProviderSession?.(providerSession);

    const renderToolCatalog = (): string => tools
      .map((tool) => `- ${tool.name}: ${tool.description}\n  input_schema: ${JSON.stringify(tool.inputSchema)}`)
      .join('\n');
    const renderTranscript = (): string => {
      if (messages.length === 0) return '(empty)';
      return messages
        .map((message, index) => {
          const role = message.name ? `${message.role}(${message.name})` : message.role;
          return `${index + 1}. ${role}: ${message.content}`;
        })
        .join('\n');
    };

    let pendingPrompt = [
      'You are a workflow controller using external tools.',
      'Decide exactly one next step per turn.',
      '',
      'Available tools:',
      renderToolCatalog(),
      '',
      'Conversation transcript:',
      renderTranscript(),
      '',
      'Respond with one JSON object matching the schema.',
      '- For tool invocation: {"type":"tool_call","tool":"<name>","input":{...},"reasoning":"..."}',
      '- For completion: {"type":"finish","output":"...","reasoning":"..."}',
      '- For hard failure: {"type":"fail","error":"...","reasoning":"..."}',
      'Rules:',
      '- Never emit multiple tool calls in one turn.',
      '- tool must match exactly one available tool name.',
    ].join('\n');

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedInputTokens = 0;
    let turnCount = 0;

    for (let turn = 1; turn <= TOOL_LOOP_MAX_TURNS; turn++) {
      const args = this.buildResumeArgs(providerSession, pendingPrompt, configFlags);
      const result = await execa(AgentId.CODEX, args, {
        cwd: context.workingDirectory,
        cancelSignal: context.signal,
        reject: false,
      });

      if (result.exitCode !== 0 && !result.stdout) {
        throw new Error(result.stderr || `codex exited with code ${result.exitCode}`);
      }

      const { events, droppedLines } = parseJsonl(result.stdout ?? '');
      const errorMessage = findError(events);
      if (errorMessage) {
        throw new Error(errorMessage);
      }
      if (events.length === 0) {
        throw new Error('Codex returned no JSONL events.');
      }

      turnCount = turn;
      const usage = this.extractResumeUsage(events);
      totalInputTokens += usage.inputTokens ?? 0;
      totalOutputTokens += usage.outputTokens ?? 0;
      totalCachedInputTokens += usage.cachedInputTokens ?? 0;

      const threadId = this.extractThreadId(events);
      if (threadId && threadId !== providerSession.threadId) {
        providerSession = {
          ...providerSession,
          sessionId: threadId,
          threadId,
          lastTurnAt: new Date().toISOString(),
        };
        context.onProviderSession?.(providerSession);
      }

      const assistantMessage = getLastAgentMessage(events);
      if (!assistantMessage) {
        throw new Error('Codex did not emit an agent message for controller decision.');
      }

      const parsedDecision = this.parseToolDecisionFromAssistant(assistantMessage);
      if (parsedDecision.reasoning) {
        transcript.push({
          role: 'assistant',
          content: parsedDecision.reasoning,
        });
      }

      if (parsedDecision.type === 'finish') {
        return {
          status: 'completed',
          transcript,
          output: parsedDecision.output ?? parsedDecision.reasoning ?? '',
          pathTaken: 'stateful-resume',
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
        return {
          status: 'failed',
          transcript,
          error: parsedDecision.error ?? parsedDecision.reasoning ?? 'Controller requested fail',
          pathTaken: 'stateful-resume',
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

      const toolInput = parsedDecision.input ?? {};
      transcript.push({
        role: 'assistant',
        content: JSON.stringify({
          type: 'tool_call',
          tool: toolName,
          input: toolInput,
        }),
      });

      const toolResult = await onToolCall({ name: toolName, input: toolInput });
      transcript.push({
        role: 'tool',
        name: toolName,
        content: JSON.stringify(toolResult.output),
      });

      pendingPrompt = [
        `Tool ${toolName} returned:`,
        JSON.stringify(toolResult.output),
        'Choose the next action as a JSON object.',
      ].join('\n');

      if (droppedLines > 0) {
        logger.warn('[adapter:codex] dropped malformed JSONL lines while parsing stateful turn', {
          droppedLines,
        });
      }
    }

    return {
      status: 'failed',
      transcript,
      error: `Exceeded maximum native tool-loop turns (${TOOL_LOOP_MAX_TURNS}).`,
      pathTaken: 'stateful-resume',
      providerSession,
      telemetry: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cachedInputTokens: totalCachedInputTokens,
        totalTurns: turnCount,
      },
    };
  }

  private buildPerRunConfigFlags(): string[] {
    const configPath = process.env.ORCHESTRATOR_CODEX_CONFIG?.trim();
    if (!configPath) return [];
    return ['--config', configPath];
  }

  private buildResumeArgs(
    session: { sessionId?: string; threadId?: string },
    prompt: string,
    configFlags: string[],
  ): string[] {
    const sessionId = session.sessionId ?? session.threadId;
    if (!sessionId) {
      return ['exec', prompt, '--json', ...configFlags];
    }

    return ['exec', 'resume', sessionId, '--json', prompt, ...configFlags];
  }

  private extractThreadId(events: CodexEvent[]): string | undefined {
    for (const event of events) {
      if (typeof event.thread_id === 'string' && event.thread_id.length > 0) {
        return event.thread_id;
      }
    }
    return undefined;
  }

  private parseToolDecisionFromAssistant(text: string): ToolLoopDecision {
    return ToolLoopDecisionSchema.parse(extractJson(text));
  }

  private extractResumeUsage(events: CodexEvent[]): {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  } {
    const usage = this.findUsagePayload(events);
    if (!usage) return {};
    return {
      inputTokens: numberField(usage, ['input_tokens']),
      outputTokens: numberField(usage, ['output_tokens']),
      cachedInputTokens: numberField(usage, ['cached_input_tokens', 'cache_read_input_tokens']),
    };
  }

  private findUsagePayload(events: CodexEvent[]): Record<string, unknown> | undefined {
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index] as Record<string, unknown>;
      const usage = event.usage;
      if (usage && typeof usage === 'object') {
        return usage as Record<string, unknown>;
      }

      const eventPayload = event.event;
      if (eventPayload && typeof eventPayload === 'object') {
        const nestedUsage = (eventPayload as Record<string, unknown>).usage;
        if (nestedUsage && typeof nestedUsage === 'object') {
          return nestedUsage as Record<string, unknown>;
        }
      }
    }

    return undefined;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const result = await execa(AgentId.CODEX, ['--help'], {
        timeout: 10_000,
        reject: false,
      });

      if (result.exitCode === 0) {
        // Try to extract version from help output
        const versionMatch = result.stdout?.match(/v?(\d+\.\d+\.\d+)/);
        return {
          available: true,
          version: versionMatch ? versionMatch[1] : undefined,
          authenticated: true, // Assumed: Codex CLI does not expose an auth-verification command; true means "not known to be unauthenticated"
        };
      }

      return {
        available: false,
        authenticated: false,
        error: result.stderr || 'codex --help failed',
      };
    } catch {
      return {
        available: false,
        authenticated: false,
        error: 'Codex CLI not found',
      };
    }
  }
}
