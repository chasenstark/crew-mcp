import { execa } from 'execa';
import { z } from 'zod';
import { extractJson } from '../utils/json-parse.js';
import { HealthCheckCache } from '../utils/health-check-cache.js';
import { BUILTIN_AGENT_ROUTING } from './strengths.js';

import type {
  AgentAdapter,
  AgentStrength,
  ExecuteOptions,
  HealthCheckOptions,
  HealthCheckResult,
  Task,
  TaskFailure,
  TaskResult,
} from './types.js';
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
});

type ClaudeResponse = z.infer<typeof ClaudeResponseSchema>;

const PROGRESS_LINE_MAX_LEN = 240;
const CAPTURED_STDOUT_MAX_CHARS = 64 * 1024;
const CAPTURED_STDERR_MAX_CHARS = 16 * 1024;

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
 * When the process is killed before completing (timeout, cancellation), no
 * result line is emitted. In that case we fall back to constructing a
 * synthetic envelope from whatever assistant text was streamed so upstream
 * code can still surface partial output instead of losing it entirely.
 */
function extractStreamEnvelope(stdout: string): ClaudeResponse | undefined {
  if (!stdout) return undefined;
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const assistantChunks: string[] = [];
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
      if (chunk) assistantChunks.push(chunk);
    } catch {
      // non-JSON line, skip
    }
  }

  if (assistantChunks.length === 0) return undefined;
  return {
    type: 'result',
    subtype: 'partial',
    result: assistantChunks.join(''),
    session_id: sessionId,
    is_error: true,
  };
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

function createClaudeStreamCapture(): {
  readonly feedLine: (line: string) => void;
  readonly feedText: (text: string) => void;
  readonly envelope: () => ClaudeResponse | undefined;
  readonly capturedText: () => string;
} {
  let lastResultLine = '';
  let assistantText = '';
  let captured = '';
  let sessionId: string | undefined;

  const feedLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    captured = appendBounded(captured, `${trimmed}\n`);
    try {
      const obj = JSON.parse(trimmed) as { type?: string; session_id?: string };
      if (typeof obj.session_id === 'string' && !sessionId) {
        sessionId = obj.session_id;
      }
      if (obj.type === 'result') {
        lastResultLine = trimmed;
      }
    } catch {
      return;
    }
    const chunk = extractAssistantTextFromStreamLine(trimmed);
    if (chunk) assistantText = appendBounded(assistantText, chunk);
  };

  return {
    feedLine,
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
      return {
        type: 'result',
        subtype: 'partial',
        result: assistantText,
        session_id: sessionId,
        is_error: true,
      };
    },
    capturedText: () => captured,
  };
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
function extractAssistantTextFromStreamLine(line: string): string {
  try {
    const obj = JSON.parse(line) as {
      type?: string;
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
    if (obj.type !== 'assistant' || !obj.message?.content) return '';
    return obj.message.content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
  } catch {
    return '';
  }
}

/**
 * Formats one Claude Code stream-json event into bounded, semantic progress
 * lines. Claude emits text, thinking, tool_use, and tool_result as nested
 * content blocks, so this walks `message.content[]` instead of relying on the
 * top-level event type alone.
 */
export function formatClaudeStreamLineForStream(line: string): string[] {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
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
  } catch {
    return [claudeEventFallback(undefined)];
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
  readonly captainCapabilities = {
    supportsStructuredDecisions: true,
    supportsPauseForUserInput: false,
  };
  private readonly healthCheckCache = new HealthCheckCache();

  recognizesModel(modelId: string): boolean {
    return typeof modelId === 'string'
      && (/^claude-/.test(modelId) || modelId === 'sonnet' || modelId === 'opus');
  }

  async getCliVersionTag(): Promise<string | undefined> {
    const result = await execa('claude', ['--version'], {
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
    const streaming = Boolean(task.onOutput);
    const args = [
      '-p',
      '-',
      '--output-format',
      streaming ? 'stream-json' : 'json',
      ...(streaming ? ['--verbose'] : []),
      '--dangerously-skip-permissions',
    ];

    if (task.constraints?.model) {
      args.push('--model', task.constraints.model);
    }

    if (task.constraints?.maxTurns) {
      args.push('--max-turns', String(task.constraints.maxTurns));
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
    const timeout = task.constraints?.timeout;
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
        cwd: task.context.workingDirectory,
        ...(timeout ? { timeout } : {}),
        ...processGroupSpawnOptions(),
        cancelSignal: task.constraints?.signal,
        buffer: false,
        reject: false,
        input: task.prompt,
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
          if (streaming) streamCapture.feedLine(trimmed);
          else rawStdoutCapture = appendBounded(rawStdoutCapture, `${trimmed}\n`);
          if (!streaming) return;
          for (const chunk of formatClaudeStreamLineForStream(trimmed)) {
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
      return {
        output: partialOutput || partialStderr || message,
        filesModified: [],
        status: 'error',
        sessionId: partialEnvelope?.session_id,
        failure: classifyTextFailure(
          [message, partialStdout, partialStderr].filter(Boolean).join('\n'),
          { defaultKind: 'process' },
        ),
        metadata: {
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

    return {
      output: parsed.result ?? '',
      filesModified,
      status: parsed.is_error ? 'error' : 'success',
      sessionId: parsed.session_id,
      ...(parsed.is_error
        ? { failure: classifyClaudeFailure(parsed, stdoutText, stderrText) }
        : {}),
      metadata: {
        costUsd: parsed.total_cost_usd ?? parsed.cost_usd,
        durationMs: parsed.duration_ms,
        numTurns: parsed.num_turns,
      },
    };
  }

  async executeWithSchema<T extends z.ZodType>(
    prompt: string,
    schema: T,
    options?: ExecuteOptions,
  ): Promise<z.infer<T>> {
    const rawJsonSchema = z.toJSONSchema(schema);
    // Strip $schema meta-field — some CLI versions don't accept it
    const { $schema: _, ...cleanSchema } = rawJsonSchema as Record<string, unknown>;
    const jsonSchema = JSON.stringify(cleanSchema);

    // Embed the schema in the prompt so the model knows the expected shape
    // even if --json-schema enforcement doesn't populate structured_output.
    const fullPrompt = prompt +
      '\n\nYou MUST respond with valid JSON matching this exact schema:\n' +
      JSON.stringify(cleanSchema, null, 2);

    const args = [
      '-p',
      '-',
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
      ...(options?.model ? ['--model', options.model] : []),
      '--json-schema',
      jsonSchema,
      // Override the system prompt to prevent CLAUDE.md, hooks, and output
      // styles from interfering with structured JSON output. This keeps
      // OAuth/keychain auth working (unlike --bare which disables them).
      '--system-prompt',
      'You are a structured data extraction engine. Return ONLY valid JSON matching the provided schema. No prose, no markdown, no explanations.',
      // Disable all tools — captain steps only need to analyze the prompt
      // and return JSON, never browse files or run commands.
      '--tools',
      '',
    ];

    if (options?.maxTurns) {
      args.push('--max-turns', String(options.maxTurns));
    }

    // No wall-clock timeout — see execute() for the rationale.
    const timeout = options?.timeout;
    logger.debug('[adapter:claude-code] starting executeWithSchema', {
      cwd: options?.workingDirectory,
      timeoutMs: timeout,
      maxTurns: options?.maxTurns,
      model: options?.model,
      promptChars: prompt.length,
    });

    let result;
    try {
      result = await execa('claude', args, {
        cwd: options?.workingDirectory,
        ...(timeout ? { timeout } : {}),
        cancelSignal: options?.signal,
        reject: false,
        input: fullPrompt,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown execution error';
      logger.error('[adapter:claude-code] executeWithSchema process threw', {
        cwd: options?.workingDirectory,
        timeoutMs: timeout,
        error: message,
      });
      throw new Error(`Claude execution failed before producing output: ${message}`);
    }

    const schemaStdout = result.stdout ?? '';
    const schemaStderr = result.stderr ?? '';
    logger.debug('[adapter:claude-code] executeWithSchema finished', {
      exitCode: result.exitCode,
      stdoutChars: schemaStdout.length,
      stderrChars: schemaStderr.length,
    });

    if (!schemaStdout) {
      logger.error('[adapter:claude-code] executeWithSchema returned no stdout', {
        exitCode: result.exitCode,
        stderrPreview: preview(schemaStderr),
      });
      throw new Error(
        `Claude CLI returned no output (exit code ${result.exitCode}): ${schemaStderr}`,
      );
    }

    let parsed: ClaudeResponse;
    try {
      parsed = ClaudeResponseSchema.parse(JSON.parse(schemaStdout));
    } catch {
      logger.error('[adapter:claude-code] executeWithSchema failed to parse JSON envelope', {
        stdoutPreview: preview(schemaStdout),
        stderrPreview: preview(schemaStderr),
      });
      throw new Error(`Failed to parse Claude response: ${schemaStdout}`);
    }

    if (parsed.is_error) {
      logger.error('[adapter:claude-code] executeWithSchema returned error response', {
        resultPreview: preview(parsed.result),
      });
      throw new Error(`Claude returned an error: ${parsed.result}`);
    }

    // Prefer structured_output (populated when --json-schema is supported).
    // Fall back to extracting JSON from the result string — the model may
    // wrap it in markdown fences or include extra text.
    let output: unknown = parsed.structured_output;
    if (output === undefined || output === null) {
      if (!parsed.result) {
        throw new Error('Claude returned neither structured_output nor a result string');
      }
      try {
        output = extractJson(parsed.result);
      } catch {
        logger.error('[adapter:claude-code] executeWithSchema could not extract JSON payload', {
          resultPreview: preview(parsed.result),
        });
        throw new Error(
          `Claude returned no structured_output and could not extract JSON from result: ${parsed.result.slice(0, 200)}`,
        );
      }
    }

    return schema.parse(output) as z.infer<T>;
  }

  async healthCheck(options?: HealthCheckOptions): Promise<HealthCheckResult> {
    return this.healthCheckCache.get(options, () => this.probeHealth());
  }

  private async probeHealth(): Promise<HealthCheckResult> {
    // Check version
    let version: string | undefined;
    try {
      const versionResult = await execa('claude', ['--version'], {
        timeout: 10_000,
        reject: false,
      });
      if (versionResult.exitCode === 0 && versionResult.stdout) {
        version = versionResult.stdout.trim();
      } else {
        return {
          available: false,
          authenticated: false,
          error: versionResult.stderr || 'claude --version failed',
        };
      }
    } catch {
      return {
        available: false,
        authenticated: false,
        error: 'Claude CLI not found',
      };
    }

    // Auth check with a minimal prompt
    try {
      const authResult = await execa(
        'claude',
        ['-p', 'respond with OK', '--output-format', 'json', '--max-turns', '1'],
        {
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
