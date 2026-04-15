import { z } from 'zod';
import { extractJson } from '../utils/json-parse.js';
import { logger } from '../utils/logger.js';
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

const TOOL_LOOP_MAX_TURNS = 200;

const ToolLoopDecisionSchema = z.object({
  type: z.enum(['tool_call', 'finish', 'fail']),
  reasoning: z.string().optional(),
  tool: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  output: z.string().optional(),
  error: z.string().optional(),
});

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
  capabilities?: AgentCapability[];
}

export class OpenAiCompatibleAdapter implements AgentAdapter {
  readonly name: string;
  readonly capabilities: AgentCapability[];
  readonly supportsJsonSchema = false;
  readonly orchestratorCapabilities = {
    supportsToolLoop: true,
    supportsStructuredDecisions: true,
    supportsPauseForUserInput: true,
  };

  private readonly defaultModel: string;
  private readonly apiBase: string;
  private readonly apiKey?: string;

  constructor(options: OpenAiCompatibleAdapterOptions) {
    this.name = options.name;
    this.defaultModel = options.model ?? 'qwen3:32b';
    this.apiBase = (options.apiBase ?? process.env.ORCHESTRATOR_OPENAI_BASE_URL ?? 'http://127.0.0.1:11434/v1')
      .replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.ORCHESTRATOR_OPENAI_API_KEY;
    this.capabilities = options.capabilities ?? [
      'implement',
      'review',
      'refactor',
      'test',
      'document',
      'analyze',
    ];
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
      toolNamespace: context?.toolNamespace ?? 'mcp__orchestrator__',
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

      history.push(assistant);

      if (Array.isArray(assistant.tool_calls) && assistant.tool_calls.length > 0) {
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
        transcript.push({ role: 'assistant', content });
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

      const toolInput = parsedDecision.input ?? {};
      const toolResult = await onToolCall({ name: toolName, input: toolInput });
      const toolContent = JSON.stringify(toolResult.output);
      history.push({
        role: 'tool',
        tool_call_id: `synthetic-${turn}`,
        content: toolContent,
      });
      transcript.push({
        role: 'assistant',
        content: JSON.stringify({ type: 'tool_call', tool: toolName, input: toolInput }),
      });
      transcript.push({
        role: 'tool',
        name: toolName,
        content: toolContent,
      });
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
    const controller = params.timeoutMs ? new AbortController() : undefined;
    if (controller && params.signal) {
      params.signal.addEventListener('abort', () => controller.abort(params.signal?.reason), { once: true });
    }
    if (controller && params.timeoutMs) {
      setTimeout(() => controller.abort('OpenAI-compatible request timed out'), params.timeoutMs);
    }

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
  }
}
