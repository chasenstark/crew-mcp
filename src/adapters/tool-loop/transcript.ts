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
  // Split system messages out of the transcript. The caller (judgment-runner
  // for captain turns, or a generic tool-loop consumer) typically puts the
  // grounding prompt at position 0 with role='system'. Rendering it through
  // the transcript's 1,500-char truncation chops load-bearing sections —
  // the M3 captain-system prompt in particular is ~2,000 chars and its
  // tail (agent inventory, preset hint, operating guardrails) is the part
  // the captain needs most to avoid hallucinating agent_ids. Render system
  // messages verbatim at the top instead; non-system messages still go
  // through the transcript window + char limit.
  const systemMessages = transcript.filter((m) => m.role === 'system');
  const nonSystemTranscript = transcript.filter((m) => m.role !== 'system');

  const conversationSection = options.continueFromSession
    ? [
        'Conversation transcript:',
        '(omitted because the provider resume session already contains prior turns)',
        'Continue from the existing provider session state. Do not replay or restate earlier transcript.',
      ]
    : [
        'Conversation transcript:',
        renderTranscript(nonSystemTranscript),
      ];

  // When the caller provided a system message, render it as the primary
  // framing and keep the adapter-owned JSON envelope protocol as a clearly
  // labeled sub-section. When no system message exists (generic tool-loop
  // callers), fall back to the adapter's default controller framing.
  const preamble = systemMessages.length > 0
    ? systemMessages.map((m) => m.content).join('\n\n')
    : [
        'You are a workflow controller using external tools.',
        'Decide exactly one next step per turn.',
      ].join('\n');

  const sections: string[] = [preamble, ''];

  // Only repeat the tool catalog when there's no caller-provided system
  // prompt — captain-system prompts already render a `## Tools` section
  // with identical names + descriptions, so listing them a second time is
  // noise that pushes the useful transcript further down the context.
  if (systemMessages.length === 0) {
    sections.push('Available tools:', renderToolCatalog(tools), '');
  }

  sections.push(...conversationSection, '');

  sections.push(
    '# Adapter response format',
    'The adapter wraps your replies in a JSON envelope with the schema below. You MUST include every top-level key; use `null` for fields that don\'t apply to the action you\'re taking.',
    '',
    'Schema (all keys required):',
    '  type      — one of "tool_call" | "finish" | "fail"',
    '  reasoning — string or null; brief explanation of the decision',
    '  tool      — string or null; required when type="tool_call", else null',
    '  input     — string or null; stringified JSON object of tool arguments (e.g. "{\\"summary\\":\\"done\\"}"). Required when type="tool_call", else null',
    '  output    — string or null; required when type="finish", else null',
    '  error     — string or null; required when type="fail", else null',
    '',
    'Examples:',
    '- Tool invocation:  {"type":"tool_call","tool":"mcp__crew__finish","input":"{\\"summary\\":\\"done\\"}","reasoning":"Request answered.","output":null,"error":null}',
    '- End adapter turn: {"type":"finish","output":"ok","reasoning":"Workflow complete.","tool":null,"input":null,"error":null}',
    '- Hard failure:     {"type":"fail","error":"could not parse","reasoning":"…","tool":null,"input":null,"output":null}',
    '',
    'Rules:',
    '- Never emit multiple tool calls in one turn.',
    '- `tool` must match exactly one available tool name.',
    '- `input` is a STRING containing a JSON-encoded object, not an inline object literal. The adapter JSON.parses it before dispatch. Empty input is represented as "{}" (not null) when the tool accepts arguments but you have none to send; use null only when type is not "tool_call".',
    '- Envelope `finish` ends the current adapter invocation but does NOT end the captain workflow — to end the workflow, invoke the `finish` tool (e.g. `mcp__crew__finish`) via `tool_call`.',
  );

  return sections.join('\n');
}
