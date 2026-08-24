import { execa } from 'execa';
import { z } from 'zod';
import {
  HealthCheckCache,
} from '../utils/health-check-cache.js';
import { BUILTIN_AGENT_ROUTING } from './strengths.js';

import type {
  AdapterModelCatalog,
  AdapterModelResolution,
  AgentAdapter,
  AgentStrength,
  EffortLevel,
  GoalExecutionResult,
  GoalTaskConstraint,
  HealthCheckOptions,
  HealthCheckResult,
  Task,
  TaskFailure,
  TaskResult,
} from './types.js';
import { findCatalogModel, ModelCatalogCache } from './model-selection.js';
import { logger } from '../utils/logger.js';
import { buildCliVersionTag } from '../provider-session.js';
import { AgentId } from '../workflow/agents.js';
import {
  processGroupSpawnOptions,
  terminateProcessGroupOnAbort,
} from './process-group.js';
import {
  buildTaskFailure,
  classifyHttpFailure,
  classifyTextFailure,
} from './failure-classifier.js';
import { defaultCrewBinaryResolver } from '../install/crew-binary.js';
import { redactRunToken } from '../utils/redaction.js';
import { codexSafeSpawnEnvironment } from '../codex/environment.js';

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
  terminal_reason: z.string().optional(),
  api_error_status: z.union([z.number(), z.string()]).optional(),
  api_error_message: z.string().optional(),
  rate_limit_info: z.unknown().optional(),
  model: z.string().optional(),
});

type ClaudeResponse = z.infer<typeof ClaudeResponseSchema>;

interface ClaudeGoalStatus {
  readonly met?: boolean;
  readonly failed?: boolean;
  readonly providerOutcome?: GoalExecutionResult['outcome'];
  readonly reason?: string;
  readonly iterations?: number;
  readonly durationMs?: number;
}

interface ClaudeGoalControlEvidence {
  readonly cleared: boolean;
  readonly setCondition?: string;
}

const PROGRESS_LINE_MAX_LEN = 240;
// Non-streaming captures stay bounded for CLI health/manual callers. Production
// dispatch supplies onOutput, so stream-json parsing is not subject to this cap.
const CAPTURED_STDOUT_MAX_CHARS = 64 * 1024;
const CAPTURED_STDERR_MAX_CHARS = 16 * 1024;
const syntheticClaudeResponses = new WeakSet<ClaudeResponse>();

function markSyntheticEnvelope(envelope: ClaudeResponse): ClaudeResponse {
  syntheticClaudeResponses.add(envelope);
  return envelope;
}

function preview(text: string | undefined, max = 600): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}...`;
}

function compactPreview(value: unknown, fallback: string, max = 160): string {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (value !== undefined) {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const compacted = text.replace(/\s+/g, ' ').trim();
  return preview(compacted || fallback, max);
}

function takeCodePointBudget(value: string, maxCodeUnits: number): string {
  if (maxCodeUnits <= 0) return '';
  let used = 0;
  let out = '';
  for (const codePoint of value) {
    const next = used + codePoint.length;
    if (next > maxCodeUnits) break;
    out += codePoint;
    used = next;
  }
  return out;
}

function claudeProgressLine(kind: string, summary: string): string {
  const raw = `${kind}: ${summary.replace(/\s+/g, ' ').trim()}`;
  if (raw.length <= PROGRESS_LINE_MAX_LEN) return raw;
  return `${takeCodePointBudget(raw, PROGRESS_LINE_MAX_LEN - 1)}…`;
}

function claudeEventFallback(type: unknown, innerType?: unknown): string {
  const top = typeof type === 'string' && type.trim() ? type.trim() : 'unknown';
  const inner = typeof innerType === 'string' && innerType.trim()
    ? `/${innerType.trim()}`
    : '';
  return claudeProgressLine('event', `${top}${inner}`);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  return value as Record<string, unknown>;
}

function parseClaudeGoalStatus(object: Record<string, unknown>): ClaudeGoalStatus | undefined {
  const rawOutcome = typeof object.outcome === 'string'
    ? object.outcome
    : typeof object.status === 'string'
      ? object.status
      : undefined;
  const providerOutcome = rawOutcome !== undefined && [
    'achieved',
    'impossible',
    'turn_capped',
    'provider_error',
    'evaluator_error',
  ].includes(rawOutcome)
    ? rawOutcome as GoalExecutionResult['outcome']
    : undefined;
  if (
    object.type !== 'goal_status'
    || (typeof object.met !== 'boolean' && providerOutcome === undefined)
  ) return undefined;
  return {
    ...(typeof object.met === 'boolean' ? { met: object.met } : {}),
    ...(typeof object.failed === 'boolean' ? { failed: object.failed } : {}),
    ...(providerOutcome !== undefined ? { providerOutcome } : {}),
    ...(typeof object.reason === 'string' ? { reason: object.reason } : {}),
    ...(typeof object.iterations === 'number' ? { iterations: object.iterations } : {}),
    ...(typeof object.durationMs === 'number' ? { durationMs: object.durationMs } : {}),
  };
}

/**
 * Goal status is authoritative only in provider-owned stream envelopes. Never
 * recurse through assistant content: a worker can emit arbitrary text and
 * tool inputs containing goal_status-shaped objects.
 */
function extractProviderClaudeGoalStatus(
  event: Record<string, unknown>,
): ClaudeGoalStatus | undefined {
  if (event.type === 'goal_status') return parseClaudeGoalStatus(event);
  if (event.type === 'system' && event.subtype === 'hook_response') {
    return parseClaudeGoalStatus(asObject(event.attachment));
  }
  return undefined;
}

/** Provider control acknowledgements are synthetic assistant envelopes. */
function extractProviderClaudeGoalControlText(
  event: Record<string, unknown>,
): string | undefined {
  if (event.type !== 'assistant') return undefined;
  const message = asObject(event.message);
  if (message.model !== '<synthetic>') return undefined;
  const content = message.content;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const block = asObject(content[0]);
  return block.type === 'text' && typeof block.text === 'string'
    ? block.text
    : undefined;
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

/**
 * Extracts the final result envelope from claude's stream-json output, which
 * emits one JSON object per line. The last `type: "result"` line is the
 * summary equivalent to non-streaming `--output-format json`.
 *
 * When stream-json exits without a terminal result line, we fall back to a
 * synthetic envelope from the last assistant message so upstream code can
 * still surface partial output instead of losing it entirely.
 */
function extractStreamEnvelope(stdout: string): ClaudeResponse | undefined {
  if (!stdout) return undefined;
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  let assistantText = '';
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
      if (chunk) assistantText = chunk;
    } catch {
      // non-JSON line, skip
    }
  }

  if (!assistantText) return undefined;
  return markSyntheticEnvelope({
    type: 'result',
    subtype: 'partial',
    result: assistantText,
    session_id: sessionId,
    is_error: true,
  });
}

function appendBounded(existing: string, next: string, maxChars = CAPTURED_STDOUT_MAX_CHARS): string {
  const combined = existing + next;
  return combined.length <= maxChars ? combined : combined.slice(combined.length - maxChars);
}

function createBoundedStderrCapture(): {
  readonly feed: (chunk: string) => void;
  readonly text: () => string;
} {
  let captured = '';
  return {
    feed: (chunk: string) => {
      captured = appendBounded(captured, chunk, CAPTURED_STDERR_MAX_CHARS);
    },
    text: () => captured,
  };
}

function normalizeClaudeObservedModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized !== '<synthetic>'
    ? normalized
    : undefined;
}

function createClaudeStreamCapture(): {
  readonly feedLine: (line: string) => void;
  readonly feedParsedLine: (line: string, event: Record<string, unknown> | undefined) => void;
  readonly feedText: (text: string) => void;
  readonly envelope: () => ClaudeResponse | undefined;
  readonly capturedText: () => string;
  readonly observedModel: () => string | undefined;
  readonly goalStatus: () => ClaudeGoalStatus | undefined;
  readonly goalControl: () => ClaudeGoalControlEvidence;
} {
  let lastResultLine = '';
  let assistantText = '';
  let captured = '';
  let sessionId: string | undefined;
  let observedModel: string | undefined;
  let goalStatus: ClaudeGoalStatus | undefined;
  let goalCleared = false;
  let goalSetCondition: string | undefined;

  const feedParsedLine = (line: string, event: Record<string, unknown> | undefined): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    captured = appendBounded(captured, `${trimmed}\n`);
    if (event === undefined) return;
    goalStatus = extractProviderClaudeGoalStatus(event) ?? goalStatus;
    if (typeof event.session_id === 'string' && !sessionId) {
      sessionId = event.session_id;
    }
    const eventModel = event.type === 'system' && event.subtype === 'init'
      ? event.model
      : event.type === 'assistant'
        ? asObject(event.message).model
        : undefined;
    const normalizedEventModel = normalizeClaudeObservedModel(eventModel);
    if (normalizedEventModel !== undefined && !observedModel) {
      observedModel = normalizedEventModel;
    }
    if (event.type === 'result') {
      lastResultLine = trimmed;
    }
    const chunk = extractAssistantTextFromStreamLine(event);
    if (chunk) {
      assistantText = appendBounded('', chunk);
    }
    const controlText = extractProviderClaudeGoalControlText(event);
    if (controlText !== undefined) {
      const setMatch = controlText.match(/^Goal set:\s*([\s\S]+)$/u);
      if (setMatch) goalSetCondition = setMatch[1].trim();
      if (/^(?:Goal cleared:|No goal set\.)/u.test(controlText.trim())) goalCleared = true;
    }
  };

  const feedLine = (line: string): void => {
    feedParsedLine(line, parseClaudeStreamLine(line));
  };

  return {
    feedLine,
    feedParsedLine,
    feedText: (text: string) => {
      for (const line of text.split('\n')) feedLine(line);
    },
    envelope: () => {
      if (lastResultLine) {
        try {
          return ClaudeResponseSchema.parse(JSON.parse(lastResultLine));
        } catch {
          return undefined;
        }
      }
      if (!assistantText) return undefined;
      return markSyntheticEnvelope({
        type: 'result',
        subtype: 'partial',
        result: assistantText,
        session_id: sessionId,
        is_error: true,
      });
    },
    capturedText: () => captured,
    observedModel: () => observedModel,
    goalStatus: () => goalStatus,
    goalControl: () => ({
      cleared: goalCleared,
      ...(goalSetCondition !== undefined ? { setCondition: goalSetCondition } : {}),
    }),
  };
}

function claudeGoalCondition(constraint: GoalTaskConstraint): string | undefined {
  if (constraint.request === undefined) return undefined;
  return [
    'A fresh execution of this explicitly repeat-safe validation command exits 0:',
    JSON.stringify(constraint.request.validationCommand),
    'Stop immediately and report blocked if infrastructure, permissions, or dependencies prevent validation.',
  ].join(' ');
}

function claudeStreamUserMessage(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

function claudeTaskInput(task: Task): { readonly input: string; readonly structured: boolean } {
  const goal = task.constraints?.goal;
  if (goal === undefined) return { input: task.prompt, structured: false };
  const messages: string[] = [];
  if (goal.action === 'clear' || goal.action === 'replace') {
    messages.push(claudeStreamUserMessage('/goal clear'));
  }
  const condition = claudeGoalCondition(goal);
  if ((goal.action === 'start' || goal.action === 'replace') && condition !== undefined) {
    messages.push(claudeStreamUserMessage(`/goal ${condition}`));
  }
  messages.push(claudeStreamUserMessage(task.prompt));
  return { input: `${messages.join('\n')}\n`, structured: true };
}

function resolveClaudeGoalResult(args: {
  readonly constraint: GoalTaskConstraint;
  readonly parsed?: ClaudeResponse;
  readonly capture: ReturnType<typeof createClaudeStreamCapture>;
  readonly status: TaskResult['status'];
}): GoalExecutionResult {
  const { constraint, parsed, capture } = args;
  const control = capture.goalControl();
  const status = capture.goalStatus();
  const turnsUsed = Math.max(0, status?.iterations ?? parsed?.num_turns ?? 0);
  const wallClockMsUsed = Math.max(0, status?.durationMs ?? parsed?.duration_ms ?? 0);
  if (constraint.action === 'clear') {
    return {
      outcome: control.cleared ? 'not_requested' : 'evaluator_error',
      authoritative: control.cleared,
      reason: control.cleared
        ? 'Claude confirmed that the native goal was cleared.'
        : 'Claude did not emit an authoritative goal-clear confirmation.',
      turnsUsed: 0,
      wallClockMsUsed: 0,
    };
  }
  const expectedCondition = claudeGoalCondition(constraint);
  if (
    (constraint.action === 'start' || constraint.action === 'replace')
    && control.setCondition !== expectedCondition
  ) {
    return {
      outcome: 'evaluator_error',
      authoritative: false,
      reason: 'Claude did not echo the exact requested native goal condition.',
      turnsUsed,
      wallClockMsUsed,
    };
  }
  if (constraint.action === 'replace' && !control.cleared) {
    return {
      outcome: 'evaluator_error',
      authoritative: false,
      reason: 'Claude did not confirm clearing the prior goal before replacement.',
      turnsUsed,
      wallClockMsUsed,
    };
  }
  if (status?.providerOutcome !== undefined) {
    return {
      outcome: status.providerOutcome,
      authoritative: true,
      ...(status.reason !== undefined ? { reason: status.reason } : {}),
      turnsUsed,
      wallClockMsUsed,
    };
  }
  if (status?.met === true) {
    return {
      outcome: 'achieved',
      authoritative: true,
      ...(status.reason !== undefined ? { reason: status.reason } : {}),
      turnsUsed,
      wallClockMsUsed,
    };
  }
  if (
    status?.failed === true
    && /(?:evaluator|evaluation).*(?:error|timeout|timed out)/iu.test(status.reason ?? '')
  ) {
    return {
      outcome: 'evaluator_error',
      authoritative: true,
      ...(status.reason !== undefined ? { reason: status.reason } : {}),
      turnsUsed,
      wallClockMsUsed,
    };
  }
  if (status?.failed === true) {
    return {
      outcome: 'impossible',
      authoritative: true,
      ...(status.reason !== undefined ? { reason: status.reason } : {}),
      turnsUsed,
      wallClockMsUsed,
    };
  }
  const terminalReason = parsed?.terminal_reason?.toLowerCase();
  if (terminalReason?.includes('max_turn')) {
    return {
      outcome: 'turn_capped',
      authoritative: true,
      reason: parsed?.terminal_reason,
      turnsUsed,
      wallClockMsUsed,
    };
  }
  if (args.status === 'error' || parsed?.is_error === true) {
    return {
      outcome: terminalReason?.includes('evaluator') ? 'evaluator_error' : 'provider_error',
      authoritative: true,
      reason: parsed?.terminal_reason ?? parsed?.api_error_message,
      turnsUsed,
      wallClockMsUsed,
    };
  }
  if (terminalReason === 'completed') {
    return {
      outcome: 'evaluator_error',
      authoritative: false,
      reason: 'Claude completed the process but did not expose a goal-specific terminal event.',
      turnsUsed,
      wallClockMsUsed,
    };
  }
  return {
    outcome: 'evaluator_error',
    authoritative: false,
    reason: 'Claude returned no recognized terminal goal event.',
    turnsUsed,
    wallClockMsUsed,
  };
}

function thrownClaudeGoalResult(
  constraint: GoalTaskConstraint | undefined,
  error: unknown,
  signal: AbortSignal | undefined,
): GoalExecutionResult | undefined {
  if (constraint === undefined) return undefined;
  const details = error as { timedOut?: boolean; isCanceled?: boolean };
  if (details.timedOut === true) {
    return {
      outcome: 'watchdog_timeout',
      authoritative: true,
      reason: 'Crew wall-clock watchdog terminated the Claude process.',
      turnsUsed: 0,
      wallClockMsUsed: constraint.maxWallClockMs,
    };
  }
  if (signal?.aborted === true || details.isCanceled === true) {
    return {
      outcome: 'cancelled',
      authoritative: true,
      reason: 'Crew cancelled the Claude process.',
      turnsUsed: 0,
      wallClockMsUsed: 0,
    };
  }
  return {
    outcome: 'provider_error',
    authoritative: true,
    reason: error instanceof Error ? error.message : String(error),
    turnsUsed: 0,
    wallClockMsUsed: 0,
  };
}

function isMissingResultEnvelope(parsed: ClaudeResponse): boolean {
  return syntheticClaudeResponses.has(parsed);
}

function missingResultEnvelopeFailure(): TaskFailure {
  return buildTaskFailure({
    kind: 'unknown',
    confidence: 'low',
    providerCode: 'missing_result_envelope',
    rawSignal: 'missing_result_envelope',
  });
}

function classifyClaudeFailure(
  parsed: ClaudeResponse | undefined,
  stdoutText: string,
  stderrText: string,
): TaskFailure {
  const apiStatus = numericStatus(parsed?.api_error_status);
  const body = [
    parsed?.terminal_reason,
    parsed?.api_error_message,
    parsed?.result,
    stderrText,
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join('\n');
  if (apiStatus !== undefined) {
    return classifyHttpFailure({
      status: apiStatus,
      body,
      providerCode: String(apiStatus),
    });
  }

  const parsedRateLimit = classifyClaudeRateLimitPayload(parsed?.rate_limit_info);
  if (parsedRateLimit) return parsedRateLimit;

  const streamRateLimit = classifyClaudeRateLimitEvent(stdoutText);
  if (streamRateLimit) return streamRateLimit;

  return classifyTextFailure(body, { defaultKind: 'unknown' });
}

function classifyClaudeRateLimitEvent(stdoutText: string): TaskFailure | undefined {
  if (!stdoutText) return undefined;
  const lines = stdoutText.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type !== 'rate_limit_event') continue;
      const failure = classifyClaudeRateLimitPayload(event.rate_limit_info);
      if (failure) return failure;
    } catch {
      // Ignore non-JSON progress lines.
    }
  }
  return undefined;
}

function classifyClaudeRateLimitPayload(payload: unknown): TaskFailure | undefined {
  const info = asObject(payload);
  if (Object.keys(info).length === 0) return undefined;
  const status = typeof info.status === 'string' ? info.status : undefined;
  if (status && /^allowed$/i.test(status)) return undefined;
  const rawSignal = compactJson(info);
  const resetAt = resetAtFromEpochSeconds(
    getNumericField(info, ['resetsAt', 'resetAt', 'reset_at', 'overageResetsAt']),
  );
  return buildTaskFailure({
    kind: /quota|exhaust|exceed/i.test(rawSignal) ? 'quota_exhausted' : 'rate_limited',
    confidence: 'high',
    providerCode: [
      typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined,
      status,
    ].filter(Boolean).join(':') || 'rate_limit_event',
    rawSignal,
    resetAt,
  });
}

function numericStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function resetAtFromEpochSeconds(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const ms = value > 10_000_000_000 ? value : value * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Pulls user-visible assistant text from a single stream-json line.
 * Returns '' for non-assistant events (tool_use, system, result).
 */
function parseClaudeStreamLine(line: string): Record<string, unknown> | undefined {
  try {
    const event = JSON.parse(line) as unknown;
    if (!event || typeof event !== 'object' || Array.isArray(event)) return undefined;
    return event as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractAssistantTextFromStreamLine(lineOrEvent: string | Record<string, unknown>): string {
  const obj = typeof lineOrEvent === 'string'
    ? parseClaudeStreamLine(lineOrEvent)
    : lineOrEvent;
  const content = (obj?.message as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (obj?.type !== 'assistant' || !content) return '';
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/**
 * Formats one Claude Code stream-json event into bounded, semantic progress
 * lines. Claude emits text, thinking, tool_use, and tool_result as nested
 * content blocks, so this walks `message.content[]` instead of relying on the
 * top-level event type alone.
 */
export function formatClaudeStreamLineForStream(lineOrEvent: string | Record<string, unknown> | undefined): string[] {
  const event = typeof lineOrEvent === 'string'
    ? parseClaudeStreamLine(lineOrEvent)
    : lineOrEvent;
  if (!event) {
    return [claudeEventFallback(undefined)];
  }

  const type = event.type;
  if (typeof type !== 'string' || !type) {
    return [claudeEventFallback(type)];
  }

  switch (type) {
    case 'system':
      return [formatClaudeSystemEvent(event)];
    case 'rate_limit_event':
      return [formatClaudeRateLimitEvent(event)];
    case 'assistant':
      return formatClaudeAssistantEvent(event);
    case 'user':
      return formatClaudeUserEvent(event);
    case 'result':
      return [formatClaudeResultEvent(event)];
    default:
      return [claudeEventFallback(type)];
  }
}
function formatClaudeSystemEvent(event: Record<string, unknown>): string {
  const subtype = typeof event.subtype === 'string' ? event.subtype : 'event';
  if (subtype !== 'init') {
    return claudeProgressLine('system', compactPreview(subtype, 'event'));
  }

  const model = typeof event.model === 'string' ? event.model : undefined;
  const tools = Array.isArray(event.tools) ? event.tools.length : undefined;
  const servers = Array.isArray(event.mcp_servers)
    ? event.mcp_servers.map((server) => asObject(server))
    : [];
  const connectedServers = servers.filter((server) => server.status === 'connected').length;
  const parts = ['init'];
  if (model) parts.push(model);
  if (tools !== undefined) parts.push(`tools=${tools}`);
  if (servers.length > 0) parts.push(`mcp=${connectedServers}/${servers.length}`);
  return claudeProgressLine('system', parts.join(' '));
}

function formatClaudeRateLimitEvent(event: Record<string, unknown>): string {
  const info = asObject(event.rate_limit_info);
  const status = typeof info.status === 'string' ? info.status : undefined;
  const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined;
  return claudeProgressLine(
    'system',
    compactPreview(['rate-limit', status, type].filter(Boolean).join(' '), 'rate-limit'),
  );
}

function getClaudeContentBlocks(event: Record<string, unknown>): Record<string, unknown>[] {
  const content = asObject(event.message).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block && typeof block === 'object' && !Array.isArray(block))
    .map((block) => block as Record<string, unknown>);
}

function formatClaudeAssistantEvent(event: Record<string, unknown>): string[] {
  const blocks = getClaudeContentBlocks(event);
  if (blocks.length === 0) return [claudeEventFallback('assistant')];

  const lines: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        lines.push(claudeProgressLine('message', compactPreview(block.text, 'message')));
        break;
      case 'thinking':
        lines.push(claudeProgressLine('thinking', compactPreview(block.thinking, 'thinking')));
        break;
      case 'tool_use':
        lines.push(formatClaudeToolUseBlock(block));
        break;
      default:
        lines.push(claudeEventFallback('assistant', block.type));
        break;
    }
  }
  return lines;
}

function formatClaudeToolUseBlock(block: Record<string, unknown>): string {
  const name = typeof block.name === 'string' && block.name.trim()
    ? block.name.trim()
    : 'tool';
  const args = compactPreview(block.input, '{}');
  return claudeProgressLine('tool', `${name}(${args})`);
}

function formatClaudeUserEvent(event: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const block of getClaudeContentBlocks(event)) {
    switch (block.type) {
      case 'tool_result':
        lines.push(claudeProgressLine('result', block.is_error === true ? 'error' : 'ok'));
        break;
      case 'text':
        break;
      default:
        lines.push(claudeEventFallback('user', block.type));
        break;
    }
  }
  return lines;
}

function formatClaudeResultEvent(event: Record<string, unknown>): string {
  if (event.is_error === true || event.subtype === 'error') {
    return claudeProgressLine(
      'turn',
      `failed ${compactPreview(event.terminal_reason ?? event.result, 'error')}`,
    );
  }
  return claudeProgressLine('turn', 'completed');
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
  // Captain-facing shorthand. `mcp__crew__run_agent({ agent_id: "claude" })`
  // resolves to this adapter the same as `agent_id: "claude-code"`.
  readonly aliases: readonly string[] = ['claude'];
  // Soft routing hints; users override via ~/.crew/agents.json.
  // See AgentStrength docs in src/adapters/types.ts.
  readonly strengths: AgentStrength[] = [...BUILTIN_AGENT_ROUTING['claude-code'].strengths];
  readonly useWhen = BUILTIN_AGENT_ROUTING['claude-code'].useWhen;
  readonly supportsJsonSchema = true;
  readonly enforcesReadOnly = false;
  readonly modelSelectionSupport = 'provider-validated' as const;
  // Reviews run in place via the read_only dispatch path (advisory contract,
  // not FS-sandboxed — enforcesReadOnly above stays the enforcement truth).
  // Keep in lockstep with BUILTIN_ADAPTER_METADATA in registry.ts
  // (proxy/instance parity).
  readonly reviewDispatchMode = 'read-only-dispatch' as const;
  // Current implementation extracts paths from final prose only. Claude tool
  // events do not cover shell edits, git mv, or every write path we allow.
  readonly filesModifiedReliable = false;
  readonly streamsIncrementally = true;
  readonly supportsResume = true;
  readonly goalSupport = 'claude-native' as const;
  // `claude -p` accepts the full canonical scale via --effort. No
  // defaultEffort: when neither the captain nor agents.json asks, the flag
  // is omitted so the CLI's own session default wins. Keep in lockstep with
  // BUILTIN_ADAPTER_METADATA in registry.ts (proxy/instance parity).
  readonly supportedEfforts: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
  readonly captainCapabilities = {
    supportsStructuredDecisions: true,
    supportsPauseForUserInput: false,
  };
  private readonly healthCheckCache = new HealthCheckCache();
  private readonly versionHealthCheckCache = new HealthCheckCache();
  private readonly modelCatalogCache = new ModelCatalogCache();

  async listModels(options?: { refresh?: boolean }): Promise<AdapterModelCatalog> {
    return this.modelCatalogCache.get(options, async () => {
      const aliases = [
        { model: 'sonnet', displayName: 'Claude Sonnet (latest alias)' },
        { model: 'opus', displayName: 'Claude Opus (latest alias)' },
        { model: 'haiku', displayName: 'Claude Haiku (latest alias)' },
      ];
      let warning: string | undefined;
      try {
        const result = await execa('claude', ['--help'], {
          ...codexSafeSpawnEnvironment(),
          timeout: 10_000,
          reject: false,
          stdin: 'ignore',
        });
        const help = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
        if (result.exitCode === 0 && /(?:^|[\s'"(])fable(?:$|[\s'"),])/imu.test(help)) {
          aliases.push({ model: 'fable', displayName: 'Claude Fable (latest alias)' });
        } else {
          warning = result.exitCode === 0
            ? 'Installed Claude CLI help does not advertise the fable alias; Crew omitted it.'
            : `Could not verify Claude aliases from --help (exit ${result.exitCode}); Crew omitted fable.`;
        }
      } catch (err) {
        warning = `Could not verify Claude aliases from --help; Crew omitted fable: ${err instanceof Error ? err.message : String(err)}`;
      }
      return {
        support: this.modelSelectionSupport,
        source: 'documented-aliases',
        authoritative: false,
        models: aliases,
        checkedAt: new Date().toISOString(),
        ...(warning ? { warnings: [warning] } : {}),
      };
    });
  }

  async resolveModel(
    requested: string,
    options?: { refreshOnMiss?: boolean },
  ): Promise<AdapterModelResolution> {
    if (/^claude-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(requested)) {
      return { ok: true, argument: requested, displayName: requested, validation: 'syntax' };
    }
    let catalog = await this.listModels();
    let descriptor = findCatalogModel(catalog, requested);
    if (!descriptor && options?.refreshOnMiss === true) {
      catalog = await this.listModels({ refresh: true });
      descriptor = findCatalogModel(catalog, requested);
    }
    if (descriptor) {
      return {
        ok: true,
        argument: descriptor.model,
        displayName: descriptor.displayName,
        validation: 'catalog',
      };
    }
    if (requested === 'fable' && (catalog.warnings?.length ?? 0) > 0) {
      return {
        ok: false,
        code: 'model_selection.discovery_unavailable',
        message: `model_selection.discovery_unavailable: the installed Claude CLI did not confirm the fable alias. ${catalog.warnings?.join(' ') ?? ''}`.trim(),
      };
    }
    return {
      ok: false,
      code: 'model_selection.unknown',
      message: `model_selection.unknown: Claude does not recognize bare alias "${requested}". Call list_models and use an advertised alias or an exact claude-* model id.`,
    };
  }

  async getCliVersionTag(): Promise<string | undefined> {
    const result = await execa('claude', ['--version'], {
      ...codexSafeSpawnEnvironment(),
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
    const goalConstraint = task.constraints?.goal;
    const taskInput = claudeTaskInput(task);
    // Goal/control evidence is available only in stream-json output, even for
    // direct adapter callers that did not request progress callbacks.
    const streaming = Boolean(task.onOutput) || goalConstraint !== undefined;
    const args = [
      '-p',
      ...(taskInput.structured ? [] : ['-']),
      '--output-format',
      streaming ? 'stream-json' : 'json',
      ...(streaming ? ['--verbose'] : []),
      ...(taskInput.structured ? ['--input-format', 'stream-json', '--include-hook-events'] : []),
      '--dangerously-skip-permissions',
    ];

    if (task.constraints?.model) {
      args.push('--model', task.constraints.model);
    }

    const maxTurns = goalConstraint?.request !== undefined
      ? goalConstraint.maxTurns
      : task.constraints?.maxTurns;
    if (maxTurns) {
      args.push('--max-turns', String(maxTurns));
    }

    if (task.constraints?.effort) {
      args.push('--effort', task.constraints.effort);
    }

    if (task.constraints?.resumeSessionId) {
      args.push('--resume', task.constraints.resumeSessionId);
    }

    if (task.dispatchMcpEnv) {
      const crewBinary = defaultCrewBinaryResolver();
      args.push(
        '--mcp-config',
        JSON.stringify({
          mcpServers: {
            crew: {
              command: crewBinary.command,
              args: [...crewBinary.args],
              env: {
                CREW_RUN_ID: task.dispatchMcpEnv.CREW_RUN_ID,
                CREW_RUN_TOKEN: task.dispatchMcpEnv.CREW_RUN_TOKEN,
              },
            },
          },
        }),
        '--strict-mcp-config',
      );
    }

    // No wall-clock timeout (was 300_000 pre-2026-05). Cancellation
    // is captain-driven via cancelSignal; the agent's own turn/token
    // budget is the natural cap.
    const timeout = goalConstraint?.request !== undefined
      ? goalConstraint.maxWallClockMs
      : task.constraints?.timeout;
    logger.debug('[adapter:claude-code] starting execute', {
      cwd: task.context.workingDirectory,
      timeoutMs: timeout,
      maxTurns: task.constraints?.maxTurns,
      model: task.constraints?.model,
      promptChars: task.prompt.length,
    });

    let result;
    const streamCapture = createClaudeStreamCapture();
    const stderrCapture = createBoundedStderrCapture();
    let rawStdoutCapture = '';
    let flushBufferedLine: (() => void) | undefined;
    try {
      const subprocess = execa('claude', args, {
        ...codexSafeSpawnEnvironment(),
        cwd: task.context.workingDirectory,
        ...(timeout ? { timeout } : {}),
        ...processGroupSpawnOptions(),
        cancelSignal: task.constraints?.signal,
        buffer: false,
        reject: false,
        input: taskInput.input,
      });
      const disposeProcessGroupAbort = terminateProcessGroupOnAbort(
        subprocess,
        task.constraints?.signal,
      );

      if (subprocess.stdout) {
        let buffer = '';
        const emitLine = (line: string): void => {
          const trimmed = line.trim();
          if (!trimmed) return;
          const parsed = streaming ? parseClaudeStreamLine(trimmed) : undefined;
          if (streaming) streamCapture.feedParsedLine(trimmed, parsed);
          else rawStdoutCapture = appendBounded(rawStdoutCapture, `${trimmed}\n`);
          if (!streaming || task.onOutput === undefined) return;
          for (const chunk of formatClaudeStreamLineForStream(parsed)) {
            try {
              task.onOutput!(chunk);
            } catch (err) {
              logger.warn(
                `[adapter:claude-code] onOutput listener failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }
        };
        flushBufferedLine = () => {
          if (!buffer.trim()) {
            buffer = '';
            return;
          }
          emitLine(buffer);
          buffer = '';
        };
        subprocess.stdout.on('data', (buf: Buffer) => {
          buffer += buf.toString('utf-8');
          let newlineIdx: number;
          while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIdx);
            buffer = buffer.slice(newlineIdx + 1);
            emitLine(line);
          }
        });
        subprocess.stdout.on('end', flushBufferedLine);
      }
      if (subprocess.stderr) {
        subprocess.stderr.setEncoding('utf-8');
        subprocess.stderr.on('data', (chunk: string | Buffer) => {
          try {
            stderrCapture.feed(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
          } catch (err) {
            logger.warn(
              `[adapter:claude-code] stderr capture failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        });
      }

      try {
        result = await subprocess;
      } finally {
        disposeProcessGroupAbort();
      }
      flushBufferedLine?.();
      const fallbackStdoutValue = (result as unknown as { stdout?: unknown }).stdout;
      if (typeof fallbackStdoutValue === 'string') {
        const fallbackStdout = fallbackStdoutValue;
        if (streaming && !streamCapture.capturedText()) streamCapture.feedText(fallbackStdout);
        if (!streaming && !rawStdoutCapture) rawStdoutCapture = fallbackStdout;
      }
    } catch (error: unknown) {
      const runToken = task.dispatchMcpEnv?.CREW_RUN_TOKEN;
      const message = redactRunToken(
        error instanceof Error ? error.message : 'Unknown execution error',
        runToken,
      );
      const partialStdout = redactRunToken(
        streamCapture.capturedText() || rawStdoutCapture,
        runToken,
      );
      const errorStderr = (error as { stderr?: unknown })?.stderr;
      const partialStderr = redactRunToken(
        stderrCapture.text() || (typeof errorStderr === 'string' ? errorStderr : ''),
        runToken,
      );
      const partialEnvelope = streaming ? streamCapture.envelope() ?? extractStreamEnvelope(partialStdout) : undefined;
      const partialOutput = redactRunToken(partialEnvelope?.result ?? partialStdout, runToken);
      logger.error('[adapter:claude-code] process execution threw', {
        cwd: task.context.workingDirectory,
        timeoutMs: timeout,
        error: message,
      });
      const goal = thrownClaudeGoalResult(goalConstraint, error, task.constraints?.signal);
      return {
        output: partialOutput || partialStderr || message,
        filesModified: [],
        status: 'error',
        sessionId: partialEnvelope?.session_id,
        failure: classifyTextFailure(
          [message, partialStdout, partialStderr].filter(Boolean).join('\n'),
          { defaultKind: 'process' },
        ),
        ...(goal !== undefined ? { goal } : {}),
        metadata: {
          ...(streamCapture.observedModel() !== undefined
            ? { observedModel: streamCapture.observedModel() }
            : {}),
          rawEvents: [{
            error: message,
            rawStdout: partialStdout,
            rawStderr: partialStderr,
          }],
        },
      };
    }

    const stdoutText = streaming
      ? streamCapture.capturedText() || (result.stdout ?? '')
      : rawStdoutCapture || (result.stdout ?? '');
    const fallbackStderr = (result as unknown as { stderr?: unknown }).stderr;
    const stderrText = stderrCapture.text()
      || (typeof fallbackStderr === 'string' ? fallbackStderr : '');
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
        failure: classifyTextFailure(
          stderrText || `Claude CLI exited with code ${result.exitCode} and no output`,
          { defaultKind: 'process' },
        ),
        ...(goalConstraint !== undefined
          ? {
              goal: {
                outcome: 'provider_error',
                authoritative: true,
                reason: stderrText || `Claude CLI exited with code ${result.exitCode}`,
                turnsUsed: 0,
                wallClockMsUsed: 0,
              } as const,
            }
          : {}),
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
      parsed = streamCapture.envelope() ?? extractStreamEnvelope(stdoutText);
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
        failure: classifyTextFailure(
          [parseError, stdoutText, stderrText].filter(Boolean).join('\n'),
          { defaultKind: 'unknown' },
        ),
        ...(goalConstraint !== undefined
          ? {
              goal: {
                outcome: 'evaluator_error',
                authoritative: false,
                reason: parseError,
                turnsUsed: 0,
                wallClockMsUsed: 0,
              } as const,
            }
          : {}),
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

    const missingResultEnvelope = isMissingResultEnvelope(parsed);
    const status = missingResultEnvelope && result.exitCode === 0
      ? 'partial'
      : parsed.is_error ? 'error' : 'success';

    const goal = goalConstraint !== undefined
      ? resolveClaudeGoalResult({ constraint: goalConstraint, parsed, capture: streamCapture, status })
      : undefined;
    const parsedObservedModel = normalizeClaudeObservedModel(parsed.model);

    return {
      output: parsed.result ?? '',
      filesModified,
      status,
      sessionId: parsed.session_id,
      ...(status === 'partial'
        ? { failure: missingResultEnvelopeFailure() }
        : status === 'error'
          ? { failure: classifyClaudeFailure(parsed, stdoutText, stderrText) }
        : {}),
      ...(goal !== undefined ? { goal } : {}),
      metadata: {
        ...(streaming && streamCapture.observedModel() !== undefined
          ? { observedModel: streamCapture.observedModel() }
          : parsedObservedModel !== undefined
            ? { observedModel: parsedObservedModel }
            : {}),
        costUsd: parsed.total_cost_usd ?? parsed.cost_usd,
        durationMs: parsed.duration_ms,
        numTurns: parsed.num_turns,
      },
    };
  }

  async healthCheck(options?: HealthCheckOptions): Promise<HealthCheckResult> {
    const versionProbe = await this.versionHealthCheckCache.get(
      options,
      () => this.probeVersion(),
    );
    if (!versionProbe.available || versionProbe.version === undefined) {
      return versionProbe;
    }
    const version = versionProbe.version;
    return this.healthCheckCache.get(
      options,
      () => options?.refresh === true
        ? this.probePromptAuth(version)
        : Promise.resolve({
            available: true,
            version,
            authenticated: true,
          }),
      {
        cacheKey: `claude-code:${version}`,
        cliVersion: version,
      },
    );
  }

  private async probeVersion(): Promise<HealthCheckResult> {
    try {
      const versionResult = await execa('claude', ['--version'], {
        ...codexSafeSpawnEnvironment(),
        timeout: 10_000,
        reject: false,
      });
      if (versionResult.exitCode === 0 && versionResult.stdout) {
        return {
          available: true,
          version: versionResult.stdout.trim(),
          authenticated: true,
        };
      }
      return {
        available: false,
        authenticated: false,
        error: versionResult.stderr || 'claude --version failed',
      };
    } catch {
      return {
        available: false,
        authenticated: false,
        error: 'Claude CLI not found',
      };
    }
  }

  private async probePromptAuth(version: string): Promise<HealthCheckResult> {
    // Auth check with a minimal prompt
    try {
      const authResult = await execa(
        'claude',
        ['-p', 'respond with OK', '--output-format', 'json', '--max-turns', '1'],
        {
          ...codexSafeSpawnEnvironment(),
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
