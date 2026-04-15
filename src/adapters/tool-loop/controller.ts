import type {
  ToolCall,
  ToolDefinition,
  ToolLoopMessage,
  ToolLoopResult,
  ToolResult,
} from '../types.js';
import { TOOL_LOOP_MAX_TURNS } from './constants.js';
import type { ToolLoopDecision } from './decision.js';
import { buildDecisionPrompt } from './transcript.js';

export async function executePromptToolLoop(
  tools: ToolDefinition[],
  messages: ToolLoopMessage[],
  onToolCall: (call: ToolCall) => Promise<ToolResult>,
  decide: (prompt: string) => Promise<ToolLoopDecision>,
  options: {
    pathTaken?: ToolLoopResult['pathTaken'];
  } = {},
): Promise<ToolLoopResult> {
  const transcript: ToolLoopMessage[] = [...messages];

  for (let turn = 1; turn <= TOOL_LOOP_MAX_TURNS; turn++) {
    let decision: ToolLoopDecision;
    try {
      decision = await decide(buildDecisionPrompt(tools, transcript));
    } catch (error: unknown) {
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

    const toolInput = decision.input ?? {};
    transcript.push({
      role: 'assistant',
      content: JSON.stringify({
        type: 'tool_call',
        tool: toolName,
        input: toolInput,
      }),
    });

    let toolResult: ToolResult;
    try {
      toolResult = await onToolCall({ name: toolName, input: toolInput });
    } catch (error: unknown) {
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
  }

  return {
    status: 'failed',
    transcript,
    error: `Exceeded maximum native tool-loop turns (${TOOL_LOOP_MAX_TURNS}).`,
    pathTaken: options.pathTaken,
  };
}
