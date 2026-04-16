import type { ToolDefinition, ToolLoopMessage } from '../types.js';
import { TOOL_LOOP_MESSAGE_CHAR_LIMIT, TOOL_LOOP_TRANSCRIPT_WINDOW } from './constants.js';

export function renderToolCatalog(tools: ToolDefinition[]): string {
  return tools
    .map((tool) => {
      const schema = JSON.stringify(tool.inputSchema);
      return `- ${tool.name}: ${tool.description}\n  input_schema: ${schema}`;
    })
    .join('\n');
}

export function renderTranscript(transcript: ToolLoopMessage[]): string {
  if (transcript.length === 0) return '(empty)';
  const windowed = transcript.length > TOOL_LOOP_TRANSCRIPT_WINDOW
    ? transcript.slice(-TOOL_LOOP_TRANSCRIPT_WINDOW)
    : transcript;
  const omitted = transcript.length - windowed.length;
  const summaryPrefix = omitted > 0
    ? `(omitted ${omitted} earlier transcript messages)\n`
    : '';

  return summaryPrefix + windowed
    .map((message, index) => {
      const role = message.name ? `${message.role}(${message.name})` : message.role;
      const content = message.content.length > TOOL_LOOP_MESSAGE_CHAR_LIMIT
        ? `${message.content.slice(0, TOOL_LOOP_MESSAGE_CHAR_LIMIT - 1)}…`
        : message.content;
      return `${index + 1}. ${role}: ${content}`;
    })
    .join('\n');
}

export function buildDecisionPrompt(
  tools: ToolDefinition[],
  transcript: ToolLoopMessage[],
  options: {
    continueFromSession?: boolean;
  } = {},
): string {
  const conversationSection = options.continueFromSession
    ? [
        'Conversation transcript:',
        '(omitted because the provider resume session already contains prior turns)',
        'Continue from the existing provider session state. Do not replay or restate earlier transcript.',
      ]
    : [
        'Conversation transcript:',
        renderTranscript(transcript),
      ];

  return [
    'You are a workflow controller using external tools.',
    'Decide exactly one next step per turn.',
    '',
    'Available tools:',
    renderToolCatalog(tools),
    '',
    ...conversationSection,
    '',
    'Respond with one JSON object matching the schema.',
    '- For tool invocation: {"type":"tool_call","tool":"<name>","input":{...},"reasoning":"..."}',
    '- For completion: {"type":"finish","output":"...","reasoning":"..."}',
    '- For hard failure: {"type":"fail","error":"...","reasoning":"..."}',
    'Rules:',
    '- Never emit multiple tool calls in one turn.',
    '- tool must match exactly one available tool name.',
  ].join('\n');
}
