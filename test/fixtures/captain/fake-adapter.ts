/**
 * Reusable fake captain adapter for M3 end-to-end tests.
 *
 * Takes a scripted tool-call sequence and replays it through
 * executeWithTools. Each scripted "turn" is the set of tool calls the
 * captain produces on a single executeWithTools invocation. The fixture
 * exposes assertion hooks (last tools, last messages) so tests can verify
 * what the session-loop fed the captain.
 */

import type {
  AgentAdapter,
  ToolCall,
  ToolDefinition,
  ToolLoopContext,
  ToolLoopMessage,
  ToolLoopResult,
  ToolResult,
} from '../../../src/adapters/types.js';

export type ScriptedToolCall = {
  readonly name: string;
  readonly input: Record<string, unknown>;
};

export interface FakeCaptainScript {
  /**
   * One entry per captain turn. When the fake adapter is invoked for a
   * turn, it executes each call in order via onToolCall and returns.
   */
  readonly turns: ReadonlyArray<ReadonlyArray<ScriptedToolCall>>;
  /**
   * Optional per-turn assistant text. Rendered as a transcript 'assistant'
   * message (not used by session-loop today; retained for symmetry with
   * real adapters).
   */
  readonly assistantText?: ReadonlyArray<string | undefined>;
}

export interface FakeCaptainProbe {
  turnCount: number;
  lastTools?: ToolDefinition[];
  lastMessages?: ToolLoopMessage[];
  lastMcpPayload?: ToolLoopContext['mcpRegistration'];
  /**
   * Every ToolCall the fake captain emitted through onToolCall, across all
   * turns. Lets tests assert on synchronous tools (message_user, plan_tasks,
   * analyze_output, compress_context, list_agents, finish) which don't leave
   * records in the session log because they resolve inline during the
   * adapter turn. Dispatched tools (run_agent, ask_user) show up BOTH here
   * and in session.tool_call records.
   */
  toolCalls: ToolCall[];
  /**
   * Per-turn snapshot of the messages array the adapter received. M5-8
   * needs this for assertions like "turn 1 used default, turn 2 used
   * thorough-review" — `lastMessages` only tracks the most recent. Extended
   * as an orthogonal addition rather than replacing `lastMessages` so
   * existing tests don't change.
   */
  allMessages: ToolLoopMessage[][];
}

export function createFakeCaptain(
  script: FakeCaptainScript,
): { adapter: AgentAdapter; probe: FakeCaptainProbe } {
  const probe: FakeCaptainProbe = { turnCount: 0, toolCalls: [], allMessages: [] };
  let turnIdx = 0;

  const adapter: AgentAdapter = {
    name: 'fake-captain',
    strengths: [],
    supportsJsonSchema: true,
    captainCapabilities: {
      supportsToolLoop: true,
      supportsStructuredDecisions: true,
      supportsPauseForUserInput: true,
    },
    execute: async () => ({
      output: '',
      filesModified: [],
      status: 'success',
      metadata: {},
    }),
    executeWithSchema: async <T extends import('zod').ZodType>(_p: string, _s: T) => {
      throw new Error('fake-captain does not implement executeWithSchema');
    },
    executeWithTools: async (
      tools: ToolDefinition[],
      messages: ToolLoopMessage[],
      onToolCall: (call: ToolCall) => Promise<ToolResult>,
      context?: ToolLoopContext,
    ): Promise<ToolLoopResult> => {
      probe.turnCount++;
      probe.lastTools = tools;
      probe.lastMessages = messages;
      probe.allMessages.push(messages);
      probe.lastMcpPayload = context?.mcpRegistration;
      const turn = script.turns[turnIdx] ?? [];
      turnIdx++;
      for (const call of turn) {
        const emitted: ToolCall = { name: call.name, input: call.input };
        probe.toolCalls.push(emitted);
        await onToolCall(emitted);
      }
      const assistantText = script.assistantText?.[probe.turnCount - 1];
      return {
        status: 'completed',
        transcript: assistantText
          ? [{ role: 'assistant', content: assistantText }]
          : [],
      };
    },
    healthCheck: async () => ({ available: true, authenticated: true }),
  };

  return { adapter, probe };
}
