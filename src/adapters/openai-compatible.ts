import { z } from 'zod';
import { extractJson } from '../utils/json-parse.js';
import { logger } from '../utils/logger.js';
import { ModelId } from '../workflow/models.js';
import { TOOL_LOOP_MAX_TURNS } from './tool-loop/constants.js';
import { parseToolInput, ToolLoopDecisionSchema } from './tool-loop/decision.js';
import { resolveTerminalOutput } from './tool-loop/result.js';
import type {
  AgentAdapter,
  AgentStrength,
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

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface OpenAiCompatibleAdapterOptions {
  name: string;
  model?: string;
  apiBase?: string;
  apiKey?: string;
  strengths?: AgentStrength[];
}

export class OpenAiCompatibleAdapter implements AgentAdapter {
  readonly name: string;
  readonly strengths: AgentStrength[];
  readonly supportsJsonSchema = false;
  readonly captainCapabilities = {
    supportsToolLoop: true,
    supportsStructuredDecisions: true,
    supportsPauseForUserInput: true,
  };

  private readonly defaultModel: string;
  private readonly apiBase: string;
  private readonly apiKey?: string;

  constructor(options: OpenAiCompatibleAdapterOptions) {
    this.name = options.name;
    this.defaultModel = options.model ?? ModelId.QWEN;
    this.apiBase = (options.apiBase ?? process.env.CREW_OPENAI_BASE_URL ?? 'http://127.0.0.1:11434/v1')
      .replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.CREW_OPENAI_API_KEY;
    // Empty default — what an OpenAI-compatible endpoint is "good at"
    // depends entirely on the model wired up. Users declare strengths in
    // their agent config or via ~/.crew/strengths.json.
    this.strengths = options.strengths ?? [];
  }

  async execute(task: Task): Promise<TaskResult> {
    const response = await this.chatCompletion({
      model: task.constraints?.model ?? this.defaultModel,
      messages: [{ role: 'user', content: task.prompt }],
      timeoutMs: task.constraints?.timeout,
      signal: task.constraints?.signal,
    });

    const message = response?.choices?.[0]?.message;
    const content = typeof message?.content === 'string' ? message.content : '';
    if (task.onOutput && content) {
      task.onOutput(content);
    }

    return {
      output: content,
      filesModified: [],
      status: content ? 'success' : 'partial',
      metadata: {
        rawEvents: [response],
      },
    };
  }

  async executeWithSchema<T extends z.ZodType>(
    prompt: string,
    schema: T,
    options?: ExecuteOptions,
  ): Promise<z.infer<T>> {
    const response = await this.chatCompletion({
      model: options?.model ?? this.defaultModel,
      messages: [
        {
          role: 'system',
          content: 'Return only valid JSON for the user request.',
        },
        {
          role: 'user',
          content: `${prompt}\n\nJSON schema:\n${JSON.stringify(z.toJSONSchema(schema), null, 2)}`,
        },
      ],
      timeoutMs: options?.timeout,
      signal: options?.signal,
    });

    const text = response?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('OpenAI-compatible adapter returned no content for schema execution.');
    }

    return schema.parse(extractJson(text)) as z.infer<T>;
  }

  async executeWithTools(
    tools: ToolDefinition[],
    messages: ToolLoopMessage[],
    onToolCall: (call: ToolCall) => Promise<ToolResult>,
    context?: ToolLoopContext,
  ): Promise<ToolLoopResult> {
    const transcript: ToolLoopMessage[] = [...messages];
    const publishTranscript = () => {
      context?.onTranscriptUpdate?.(transcript.map((message) => ({ ...message })));
    };
    const history: ChatMessage[] = messages.map((message) => ({
      role: message.role,
      content: message.content,
      name: message.name,
    }));
    const openAiTools = tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    const providerSession = {
      provider: 'local' as const,
      transport: 'prefix-cached' as const,
      toolNamespace: context?.toolNamespace ?? 'mcp__crew__',
      toolSchemaHash: context?.toolSchemaHash ?? '',
      startedAt: context?.providerSession?.startedAt ?? new Date().toISOString(),
      lastTurnAt: new Date().toISOString(),
    };
    context?.onProviderSession?.(providerSession);

    for (let turn = 1; turn <= TOOL_LOOP_MAX_TURNS; turn++) {
      const response = await this.chatCompletion({
        model: this.defaultModel,
        messages: history,
        tools: openAiTools,
        timeoutMs: undefined,
        signal: context?.signal,
      });

      const assistant = response?.choices?.[0]?.message as ChatMessage | undefined;
      if (!assistant) {
        return {
          status: 'failed',
          transcript,
          error: 'OpenAI-compatible adapter returned no assistant message.',
          pathTaken: 'prefix-cached',
          providerSession,
        };
      }

      if (Array.isArray(assistant.tool_calls) && assistant.tool_calls.length > 0) {
        history.push(assistant);
        for (const toolCall of assistant.tool_calls) {
          const parsedArgs = this.parseFunctionArguments(toolCall.function.arguments);
          transcript.push({
            role: 'assistant',
            content: JSON.stringify({
              type: 'tool_call',
              tool: toolCall.function.name,
              input: parsedArgs,
            }),
          });
          publishTranscript();

          const toolResult = await onToolCall({
            name: toolCall.function.name,
            input: parsedArgs,
          });

          const toolContent = JSON.stringify(toolResult.output);
          history.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolContent,
          });
          transcript.push({
            role: 'tool',
            name: toolCall.function.name,
            content: toolContent,
          });
          publishTranscript();

          if (toolResult.terminal) {
            return {
              status: 'completed',
              transcript,
              output: resolveTerminalOutput(toolResult),
              pathTaken: 'prefix-cached',
              providerSession,
            };
          }
        }

        providerSession.lastTurnAt = new Date().toISOString();
        context?.onProviderSession?.(providerSession);
        continue;
      }

      const content = typeof assistant.content === 'string' ? assistant.content : '';
      if (!content.trim()) {
        return {
          status: 'failed',
          transcript,
          error: 'OpenAI-compatible adapter returned empty completion.',
          pathTaken: 'prefix-cached',
          providerSession,
        };
      }

      let parsedDecision: z.infer<typeof ToolLoopDecisionSchema> | null = null;
      try {
        parsedDecision = ToolLoopDecisionSchema.parse(extractJson(content));
      } catch {
        // If the model did not emit a tool-loop decision object, treat content as terminal output.
      }

      if (!parsedDecision) {
        history.push(assistant);
        transcript.push({ role: 'assistant', content });
        publishTranscript();
        return {
          status: 'completed',
          transcript,
          output: content,
          pathTaken: 'prefix-cached',
          providerSession,
        };
      }

      if (parsedDecision.reasoning) {
        transcript.push({ role: 'assistant', content: parsedDecision.reasoning });
        publishTranscript();
      }

      if (parsedDecision.type === 'finish') {
        return {
          status: 'completed',
          transcript,
          output: parsedDecision.output ?? parsedDecision.reasoning ?? '',
          pathTaken: 'prefix-cached',
          providerSession,
        };
      }

      if (parsedDecision.type === 'fail') {
        return {
          status: 'failed',
          transcript,
          error: parsedDecision.error ?? parsedDecision.reasoning ?? 'Controller requested fail',
          pathTaken: 'prefix-cached',
          providerSession,
        };
      }

      const toolName = parsedDecision.tool?.trim();
      if (!toolName) {
        return {
          status: 'failed',
          transcript,
          error: 'Tool call missing tool name.',
          pathTaken: 'prefix-cached',
          providerSession,
        };
      }

      const toolInput = parseToolInput(parsedDecision.input);
      const toolCallId = `synthetic-${turn}`;
      history.push({
        role: 'assistant',
        content: parsedDecision.reasoning ?? undefined,
        tool_calls: [
          {
            id: toolCallId,
            type: 'function',
            function: {
              name: toolName,
              arguments: JSON.stringify(toolInput),
            },
          },
        ],
      });
      const toolResult = await onToolCall({ name: toolName, input: toolInput });
      const toolContent = JSON.stringify(toolResult.output);
      history.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: toolContent,
      });
      transcript.push({
        role: 'assistant',
        content: JSON.stringify({ type: 'tool_call', tool: toolName, input: toolInput }),
      });
      publishTranscript();
      transcript.push({
        role: 'tool',
        name: toolName,
        content: toolContent,
      });
      publishTranscript();
      if (toolResult.terminal) {
        return {
          status: 'completed',
          transcript,
          output: resolveTerminalOutput(toolResult),
          pathTaken: 'prefix-cached',
          providerSession,
        };
      }
      providerSession.lastTurnAt = new Date().toISOString();
      context?.onProviderSession?.(providerSession);
    }

    return {
      status: 'failed',
      transcript,
      error: `Exceeded maximum native tool-loop turns (${TOOL_LOOP_MAX_TURNS}).`,
      pathTaken: 'prefix-cached',
      providerSession,
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const response = await fetch(`${this.apiBase}/models`, {
        headers: this.apiKey
          ? { Authorization: `Bearer ${this.apiKey}` }
          : undefined,
      });
      if (response.ok) {
        return {
          available: true,
          authenticated: true,
        };
      }
      return {
        available: false,
        authenticated: false,
        error: `HTTP ${response.status} from ${this.apiBase}/models`,
      };
    } catch (error: unknown) {
      return {
        available: false,
        authenticated: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private parseFunctionArguments(raw: string): Record<string, unknown> {
    if (!raw.trim()) return {};
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
      }
      return parsed as Record<string, unknown>;
    } catch {
      logger.warn('[adapter:openai-compatible] tool arguments were not valid JSON; using empty object');
      return {};
    }
  }

  private async chatCompletion(params: {
    model: string;
    messages: ChatMessage[];
    tools?: Array<{
      type: 'function';
      function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
      };
    }>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<any> {
    if (params.signal?.aborted) {
      throw params.signal.reason ?? new Error('OpenAI-compatible request aborted');
    }

    const controller = params.timeoutMs ? new AbortController() : undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;
    if (controller && params.signal) {
      params.signal.addEventListener('abort', () => controller.abort(params.signal?.reason), { once: true });
    }
    if (controller && params.timeoutMs) {
      timeoutHandle = setTimeout(
        () => controller.abort('OpenAI-compatible request timed out'),
        params.timeoutMs,
      );
    }

    try {
      const response = await fetch(`${this.apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: params.model,
          messages: params.messages,
          tools: params.tools,
          tool_choice: params.tools ? 'auto' : undefined,
        }),
        signal: controller?.signal ?? params.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `OpenAI-compatible request failed (${response.status}): ${text}`,
        );
      }

      return response.json();
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}
