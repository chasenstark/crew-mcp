import { execa } from 'execa';
import { z } from 'zod';
import { extractJson } from '../utils/json-parse.js';
import { logger } from '../utils/logger.js';
import { buildCliVersionTag } from '../provider-session.js';
import { AgentId } from '../workflow/agents.js';
import { executePromptToolLoop } from './tool-loop/controller.js';
import {
  ToolLoopDecisionSchema,
} from './tool-loop/decision.js';
import { TOOL_LOOP_MAX_TURNS } from './tool-loop/constants.js';
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

interface GeminiEvent {
  type?: string;
  session_id?: string;
  content?: string;
  text?: string;
  message?: string;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

function parseJsonl(stdout: string): GeminiEvent[] {
  const events: GeminiEvent[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as GeminiEvent);
    } catch {
      logger.warn('[adapter:gemini-cli] dropped malformed JSON line');
    }
  }
  return events;
}

function extractLastText(events: GeminiEvent[]): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (typeof event.content === 'string' && event.content.trim()) {
      return event.content;
    }
    if (typeof event.text === 'string' && event.text.trim()) {
      return event.text;
    }
    if (typeof event.message === 'string' && event.message.trim()) {
      return event.message;
    }
  }
  return '';
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
  readonly supportsJsonSchema = true;
  readonly captainCapabilities = {
    // gemini CLI answers prompt-described tool catalogs in prose, not JSON.
    supportsToolLoop: false,
    supportsStructuredDecisions: true,
    supportsPauseForUserInput: true,
  };

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
    const result = await execa(
      'gemini',
      ['--output-format', 'json', task.prompt],
      {
        cwd: task.context.workingDirectory,
        timeout: task.constraints?.timeout ?? 300_000,
        cancelSignal: task.constraints?.signal,
        reject: false,
      },
    );
    const events = parseJsonl(result.stdout ?? '');
    const output = extractLastText(events);
    if (task.onOutput && output) {
      task.onOutput(output);
    }
    return {
      output,
      filesModified: [],
      status: result.exitCode === 0 ? 'success' : 'error',
      metadata: {
        rawEvents: events,
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
        signal: options?.signal,
      },
    });
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
      const fallbackResult = await this.executeWithPromptLoop(tools, messages, onToolCall, context);
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
      if (result.exitCode === 0) {
        return {
          available: true,
          authenticated: true,
          version: result.stdout.trim() || undefined,
        };
      }
      return {
        available: false,
        authenticated: false,
        error: result.stderr || 'gemini --version failed',
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

    let prompt = [
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

    for (let turn = 1; turn <= TOOL_LOOP_MAX_TURNS; turn++) {
      const args = providerSession.sessionId
        ? ['--output-format', 'json', '--resume', providerSession.sessionId, prompt]
        : ['--output-format', 'json', prompt];

      const result = await execa('gemini', args, {
        cwd: context.workingDirectory,
        cancelSignal: context.signal,
        reject: false,
      });

      if (result.exitCode !== 0 && !result.stdout) {
        throw new Error(result.stderr || `gemini exited with code ${result.exitCode}`);
      }

      const events = parseJsonl(result.stdout ?? '');
      const maybeSessionId = events.find((event) => typeof event.session_id === 'string')?.session_id;
      if (maybeSessionId && maybeSessionId !== providerSession.sessionId) {
        providerSession = {
          ...providerSession,
          sessionId: maybeSessionId,
          lastTurnAt: new Date().toISOString(),
        };
        context.onProviderSession?.(providerSession);
      }

      const assistantText = extractLastText(events);
      if (!assistantText) {
        throw new Error('Gemini CLI returned no decision text.');
      }
      const decision = ToolLoopDecisionSchema.parse(extractJson(assistantText));

      if (decision.reasoning) {
        transcript.push({ role: 'assistant', content: decision.reasoning });
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
      const toolInput = decision.input ?? {};
      transcript.push({
        role: 'assistant',
        content: JSON.stringify({ type: 'tool_call', tool: toolName, input: toolInput }),
      });
      const toolResult = await onToolCall({ name: toolName, input: toolInput });
      transcript.push({
        role: 'tool',
        name: toolName,
        content: JSON.stringify(toolResult.output),
      });
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
      { pathTaken: 'adapter' },
    );
  }
}
