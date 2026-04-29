import type {
  ToolCall,
  ToolDefinition,
  ToolLoopMessage,
  ToolLoopResult,
  ToolResult,
} from '../types.js';
import { TOOL_LOOP_MAX_TURNS } from './constants.js';
import type { ToolLoopDecision } from './decision.js';
import { parseToolInput } from './decision.js';
import { resolveTerminalOutput } from './result.js';
import { buildDecisionPrompt } from './transcript.js';

function cloneTranscript(transcript: ToolLoopMessage[]): ToolLoopMessage[] {
  return transcript.map((message) => ({ ...message }));
}

function isInterrupted(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === 'AbortError';
}

function resolveInterruptMessage(error: unknown, signal?: AbortSignal): string {
  if (signal?.reason !== undefined) {
    return String(signal.reason);
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  return 'Interrupted';
}

export async function executePromptToolLoop(
  tools: ToolDefinition[],
  messages: ToolLoopMessage[],
  onToolCall: (call: ToolCall) => Promise<ToolResult>,
  decide: (prompt: string) => Promise<ToolLoopDecision>,
  options: {
    pathTaken?: ToolLoopResult['pathTaken'];
    signal?: AbortSignal;
    onTranscriptUpdate?: (transcript: ToolLoopMessage[]) => void;
  } = {},
): Promise<ToolLoopResult> {
  const transcript: ToolLoopMessage[] = [...messages];
  const publishTranscript = () => {
    options.onTranscriptUpdate?.(cloneTranscript(transcript));
  };

  for (let turn = 1; turn <= TOOL_LOOP_MAX_TURNS; turn++) {
    if (options.signal?.aborted) {
      return {
        status: 'interrupted',
        transcript,
        error: resolveInterruptMessage(options.signal.reason, options.signal),
        pathTaken: options.pathTaken,
      };
    }

    let decision: ToolLoopDecision;
    try {
      decision = await decide(buildDecisionPrompt(tools, transcript));
    } catch (error: unknown) {
      if (isInterrupted(error, options.signal)) {
        return {
          status: 'interrupted',
          transcript,
          error: resolveInterruptMessage(error, options.signal),
          pathTaken: options.pathTaken,
        };
      }
      return {
        status: 'failed',
        transcript,
        error: error instanceof Error ? error.message : String(error),
        pathTaken: options.pathTaken,
      };
    }

    if (decision.reasoning) {
      transcript.push({
        role: 'assistant',
        content: decision.reasoning,
      });
      publishTranscript();
    }

    if (decision.type === 'finish') {
      const output = decision.output ?? decision.reasoning ?? '';
      return {
        status: 'completed',
        transcript,
        output,
        pathTaken: options.pathTaken,
      };
    }

    if (decision.type === 'fail') {
      return {
        status: 'failed',
        transcript,
        error: decision.error ?? decision.reasoning ?? 'Controller requested fail',
        pathTaken: options.pathTaken,
      };
    }

    const toolName = decision.tool?.trim();
    if (!toolName) {
      return {
        status: 'failed',
        transcript,
        error: 'Tool call missing tool name.',
        pathTaken: options.pathTaken,
      };
    }

    const knownTool = tools.find((tool) => tool.name === toolName);
    if (!knownTool) {
      return {
        status: 'failed',
        transcript,
        error: `Unknown tool "${toolName}".`,
        pathTaken: options.pathTaken,
      };
    }

    const toolInput = parseToolInput(decision.input);
    transcript.push({
      role: 'assistant',
      content: JSON.stringify({
        type: 'tool_call',
        tool: toolName,
        input: toolInput,
      }),
    });
    publishTranscript();

    let toolResult: ToolResult;
    try {
      toolResult = await onToolCall({ name: toolName, input: toolInput });
    } catch (error: unknown) {
      if (isInterrupted(error, options.signal)) {
        return {
          status: 'interrupted',
          transcript,
          error: resolveInterruptMessage(error, options.signal),
          pathTaken: options.pathTaken,
        };
      }
      return {
        status: 'failed',
        transcript,
        error: error instanceof Error ? error.message : String(error),
        pathTaken: options.pathTaken,
      };
    }

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
        pathTaken: options.pathTaken,
      };
    }
  }

  return {
    status: 'failed',
    transcript,
    error: `Exceeded maximum native tool-loop turns (${TOOL_LOOP_MAX_TURNS}).`,
    pathTaken: options.pathTaken,
  };
}
