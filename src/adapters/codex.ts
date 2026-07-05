import { execa } from 'execa';
import { z } from 'zod';

import {
  writeFileSync,
  readFileSync,
  mkdtempSync,
  existsSync,
  rmSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractJson } from '../utils/json-parse.js';
import { HealthCheckCache } from '../utils/health-check-cache.js';
import { BUILTIN_AGENT_ROUTING } from './strengths.js';
import {
  logBestEffortFailure,
  registerTempDirForCleanup,
  unregisterTempDirForCleanup,
} from '../utils/best-effort.js';
import type {
  AgentAdapter,
  AgentStrength,
  EffortLevel,
  ExecuteOptions,
  HealthCheckOptions,
  HealthCheckResult,
  Task,
  TaskResult,
  ToolCall,
  ToolLoopContext,
  ToolDefinition,
  ToolLoopMessage,
  ToolLoopResult,
  ToolResult,
} from './types.js';
import { logger } from '../utils/logger.js';
import { buildCliVersionTag } from '../provider-session.js';
import { AgentId } from '../workflow/agents.js';
import { executePromptToolLoop } from './tool-loop/controller.js';
import {
  ToolLoopDecisionSchema,
  type ToolLoopDecision,
} from './tool-loop/decision.js';
import {
  processGroupSpawnOptions,
  terminateProcessGroupOnAbort,
} from './process-group.js';
import { classifyTextFailure } from './failure-classifier.js';
import type { TaskFailure } from './types.js';

/**
 * Represents a single event line in the Codex JSONL output.
 *
 * Codex CLI 0.121+ wraps all content events in an `item.completed` envelope:
 *   { type: 'item.completed', item: { type: 'agent_message', text: '...' } }
 *   { type: 'item.completed', item: { type: 'file_change', path: '...', action: 'modified' } }
 * Meta events (`thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `error`)
 * remain flat at the top level.
 */
interface CodexItem {
  type?: string;
  text?: string;
  path?: string;
  action?: string;
  command?: string;
  exit_code?: number | null;
  [key: string]: unknown;
}

export interface CodexEvent {
  type: string;
  thread_id?: string;
  turn_id?: string;
  item?: CodexItem;
  message?: string;
  reason?: string;
  [key: string]: unknown;
}

/**
 * Result of parsing JSONL text, including metrics on dropped lines.
 */
interface ParseJsonlResult {
  events: CodexEvent[];
  droppedLines: number;
}

const CODEX_STREAM_LINE_MAX_LEN = 240;
const CODEX_STREAM_TRUNCATION_SUFFIX = '...';
const CODEX_CAPTURED_EVENT_LIMIT = 500;
const CODEX_CAPTURED_STDOUT_MAX_CHARS = 64 * 1024;
const CODEX_CAPTURED_STDERR_MAX_CHARS = 16 * 1024;

function parseJsonlEvent(line: string): CodexEvent | undefined {
  const parsed = JSON.parse(line);
  if (
    typeof parsed !== 'object'
    || parsed === null
    || Array.isArray(parsed)
  ) {
    return undefined;
  }
  return parsed as CodexEvent;
}

function preview(text: string | undefined, max = 600): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}...`;
}

function streamPreview(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
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

function boundStreamLine(line: string): string {
  if (line.length <= CODEX_STREAM_LINE_MAX_LEN) return line;
  const budget = CODEX_STREAM_LINE_MAX_LEN - CODEX_STREAM_TRUNCATION_SUFFIX.length;
  return `${takeCodePointBudget(line, budget)}${CODEX_STREAM_TRUNCATION_SUFFIX}`;
}

function codexStreamLine(kind: string, summary: string): string {
  const fallbackSummary = streamPreview(summary) || 'unknown';
  return boundStreamLine(`${kind}: ${fallbackSummary}`);
}

function codexEventFallback(event: unknown): string {
  const type = typeof event === 'object' && event !== null
    ? streamPreview((event as { type?: unknown }).type)
    : '';
  const itemType = typeof event === 'object' && event !== null
    && typeof (event as { item?: unknown }).item === 'object'
    && (event as { item?: unknown }).item !== null
    ? streamPreview(((event as { item: { type?: unknown } }).item).type)
    : '';
  if ((type === 'item.started' || type === 'item.completed') && itemType) {
    return codexStreamLine('event', `${type}/${itemType}`);
  }
  return codexStreamLine('event', type || 'unknown');
}

/**
 * Parses newline-delimited JSON (JSONL) into an array of events.
 * Malformed lines are logged at warn level and counted.
 */
export function parseJsonl(text: string): ParseJsonlResult {
  const events: CodexEvent[] = [];
  const lines = text.split('\n');
  let droppedLines = 0;
  let nonEmptyLineCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    nonEmptyLineCount++;
    try {
      const event = parseJsonlEvent(trimmed);
      if (!event) {
        droppedLines++;
        logger.warn(`Codex JSONL: dropped non-object line: ${trimmed}`);
        continue;
      }
      events.push(event);
    } catch {
      droppedLines++;
      logger.warn(`Codex JSONL: dropped malformed line: ${trimmed}`);
    }
  }

  if (droppedLines > 0) {
    logger.warn(`Codex JSONL: ${droppedLines} of ${nonEmptyLineCount} lines failed to parse`);
  }

  return { events, droppedLines };
}

/**
 * Returns the `item` payload for a Codex content event, matching the modern
 * `item.completed` envelope. Older or unwrapped events return `undefined`.
 */
function getItemOfType(event: CodexEvent, itemType: string): CodexItem | undefined {
  if (event.type !== 'item.completed') return undefined;
  const item = event.item;
  if (!item || item.type !== itemType) return undefined;
  return item;
}

/**
 * Extracts file paths that were changed from Codex events.
 * Recognizes the 0.121+ `{type: 'item.completed', item: {type: 'file_change', ...}}`
 * shape.
 */
export function extractFileChanges(events: CodexEvent[]): string[] {
  const files: string[] = [];
  for (const event of events) {
    const item = getItemOfType(event, 'file_change');
    if (!item) continue;
    if (typeof item.path !== 'string') continue;
    if (item.action === 'none') continue;
    files.push(item.path);
  }
  return files;
}

/**
 * Gets the final agent message text from events. Uses the modern
 * `item.completed` → `item.type === 'agent_message'` envelope.
 */
export function getLastAgentMessage(events: CodexEvent[]): string {
  let lastMessage = '';
  for (const event of events) {
    const item = getItemOfType(event, 'agent_message');
    if (item && typeof item.text === 'string') {
      lastMessage = item.text;
    }
  }
  return lastMessage;
}

/**
 * Formats a single Codex event as a bounded semantic markdown progress line.
 * Event shapes drift between Codex CLI versions, so unexpected payloads fall
 * back to a non-empty event line instead of breaking the stream.
 */
export function formatEventForStream(event: CodexEvent): string {
  try {
    switch (event.type) {
      case 'thread.started':
        return codexStreamLine('turn', 'thread started');
      case 'turn.started':
        return codexStreamLine('turn', 'started');
      case 'turn.completed':
        return codexStreamLine('turn', 'completed');
      case 'turn.failed': {
        const reason = streamPreview(event.reason);
        return codexStreamLine('turn', reason ? `failed (${reason})` : 'failed');
      }
      case 'error':
        return codexStreamLine('error', streamPreview(event.message) || 'unknown');
      case 'item.started':
      case 'item.completed':
        return formatItemEventForStream(event);
      default:
        return codexEventFallback(event);
    }
  } catch {
    return codexStreamLine('event', 'unknown');
  }
}

function formatItemEventForStream(event: CodexEvent): string {
  const item = event.item;
  if (!item || typeof item !== 'object') {
    return codexEventFallback(event);
  }

  if (event.type === 'item.started' && item.type === 'command_execution') {
    const command = streamPreview(item.command);
    return codexStreamLine('command', command ? `started ${command}` : 'started');
  }

  if (event.type !== 'item.completed') {
    return codexEventFallback(event);
  }

  switch (item.type) {
    case 'agent_message':
      return codexStreamLine('message', streamPreview(item.text) || 'message');
    case 'reasoning':
      return codexStreamLine('reasoning', streamPreview(item.text) || 'reasoning');
    case 'command_execution': {
      const command = streamPreview(item.command) || 'completed';
      const exitCode = typeof item.exit_code === 'number'
        ? ` (exit ${item.exit_code})`
        : '';
      return codexStreamLine('command', `${command}${exitCode}`);
    }
    case 'file_change': {
      const path = streamPreview(item.path);
      const action = streamPreview(item.action);
      const normalizedAction = action === 'none' ? 'no change' : action;
      return codexStreamLine('file', [
        normalizedAction || 'changed',
        path,
      ].filter(Boolean).join(' '));
    }
    default:
      return codexEventFallback(event);
  }
}

/**
 * Checks if the events contain an error.
 */
export function findError(events: CodexEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === 'error' && event.message) {
      return event.message;
    }
    if (event.type === 'turn.failed' && event.reason) {
      return `Turn failed: ${event.reason}`;
    }
  }
  return undefined;
}

function classifyCodexFailure(events: CodexEvent[]): TaskFailure | undefined {
  for (const event of events) {
    if (event.type !== 'error' && event.type !== 'turn.failed') continue;
    const message = event.type === 'error' ? event.message : event.reason;
    const providerCode = codexProviderCode(event);
    return classifyTextFailure(
      [message, providerCode].filter((part): part is string => typeof part === 'string').join('\n'),
      {
        defaultKind: 'unknown',
        ...(providerCode ? { providerCode, confidence: 'high' } : {}),
      },
    );
  }
  return undefined;
}

function classifyCodexFailureEvent(event: CodexEvent | undefined): TaskFailure | undefined {
  if (!event || (event.type !== 'error' && event.type !== 'turn.failed')) return undefined;
  const message = event.type === 'error' ? event.message : event.reason;
  const providerCode = codexProviderCode(event);
  return classifyTextFailure(
    [message, providerCode].filter((part): part is string => typeof part === 'string').join('\n'),
    {
      defaultKind: 'unknown',
      ...(providerCode ? { providerCode, confidence: 'high' } : {}),
    },
  );
}

function codexProviderCode(event: CodexEvent): string | undefined {
  for (const key of ['code', 'error_code', 'errorCode', 'reason_code', 'reasonCode']) {
    const value = event[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function appendBounded(existing: string, next: string, maxChars = CODEX_CAPTURED_STDOUT_MAX_CHARS): string {
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
      captured = appendBounded(captured, chunk, CODEX_CAPTURED_STDERR_MAX_CHARS);
    },
    text: () => captured,
  };
}

function createCodexTerminalReducer(): {
  readonly feedLine: (line: string) => CodexEvent | undefined;
  readonly feedText: (text: string) => void;
  readonly snapshot: () => {
    readonly events: CodexEvent[];
    readonly droppedLines: number;
    readonly capturedText: string;
    readonly errorMessage?: string;
    readonly failureEvent?: CodexEvent;
    readonly filesModified: string[];
    readonly lastAgentMessage: string;
    readonly threadId?: string;
    readonly hasFailedTurn: boolean;
  };
} {
  const events: CodexEvent[] = [];
  const filesModified: string[] = [];
  let droppedLines = 0;
  let capturedText = '';
  let errorMessage: string | undefined;
  let failureEvent: CodexEvent | undefined;
  let lastAgentMessage = '';
  let threadId: string | undefined;
  let hasFailedTurn = false;

  const feedEvent = (event: CodexEvent): void => {
    if (events.length === CODEX_CAPTURED_EVENT_LIMIT) events.shift();
    events.push(event);
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      threadId = event.thread_id;
    }
    if (event.type === 'turn.failed') {
      hasFailedTurn = true;
    }
    if (errorMessage === undefined) {
      if (event.type === 'error' && event.message) {
        errorMessage = event.message;
        failureEvent = event;
      } else if (event.type === 'turn.failed' && event.reason) {
        errorMessage = `Turn failed: ${event.reason}`;
        failureEvent = event;
      }
    }
    const item = getItemOfType(event, 'file_change');
    if (item && typeof item.path === 'string' && item.action !== 'none') {
      filesModified.push(item.path);
    }
    const messageItem = getItemOfType(event, 'agent_message');
    if (messageItem && typeof messageItem.text === 'string') {
      lastAgentMessage = messageItem.text;
    }
  };

  const feedLine = (line: string): CodexEvent | undefined => {
    const trimmed = line.trim();
    if (!trimmed) return undefined;
    capturedText = appendBounded(capturedText, `${trimmed}\n`);
    try {
      const event = parseJsonlEvent(trimmed);
      if (!event) {
        droppedLines++;
        logger.warn(`Codex JSONL: dropped non-object line: ${trimmed}`);
        return undefined;
      }
      feedEvent(event);
      return event;
    } catch {
      droppedLines++;
      logger.warn(`Codex JSONL: dropped malformed line: ${trimmed}`);
      return undefined;
    }
  };

  return {
    feedLine,
    feedText: (text: string) => {
      for (const line of text.split('\n')) {
        if (line.trim()) feedLine(line);
      }
    },
    snapshot: () => ({
      events: [...events],
      droppedLines,
      capturedText,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      ...(failureEvent !== undefined ? { failureEvent } : {}),
      filesModified: [...filesModified],
      lastAgentMessage,
      ...(threadId !== undefined ? { threadId } : {}),
      hasFailedTurn,
    }),
  };
}

export class CodexAdapter implements AgentAdapter {
  readonly name = AgentId.CODEX;
  // Soft routing hints; users override via ~/.crew/agents.json.
  // See AgentStrength docs in src/adapters/types.ts.
  readonly strengths: AgentStrength[] = [...BUILTIN_AGENT_ROUTING.codex.strengths];
  readonly useWhen = BUILTIN_AGENT_ROUTING.codex.useWhen;
  // Codex CLI takes `-c model_reasoning_effort=<low|medium|high|xhigh>`.
  // Default to medium — matches Codex's own default and gives the user a
  // knob in both directions. Per-call override comes via
  // Task.constraints.effort.
  readonly defaultEffort: EffortLevel = 'medium';
  // Codex 0.130 rejects unknown variants with a hard
  // `unknown variant ..., expected one of none, minimal, low, medium,
  // high, xhigh` error before the run starts. The canonical EffortLevel
  // includes `max`, so we declare the supported subset here and let
  // resolveEffectiveEffort clamp captain-provided `max` down to `xhigh`.
  // (`none` and `minimal` are codex extensions outside the canonical
  // scale; we don't surface them upward.)
  readonly supportedEfforts: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];
  readonly supportsJsonSchema = true;
  readonly enforcesReadOnly = true;
  // Reviews run in place via the read_only dispatch path. Keep in lockstep
  // with BUILTIN_ADAPTER_METADATA in registry.ts (proxy/instance parity).
  readonly reviewDispatchMode = 'read-only-dispatch' as const;
  // Codex emits structured `file_change` events for in-band file edits; treat
  // that terminal list as authoritative so an empty array means no file_change
  // events were observed.
  readonly filesModifiedReliable = true;
  readonly streamsIncrementally = true;
  readonly supportsResume = true;
  readonly captainCapabilities = {
    supportsToolLoop: true,
    supportsStructuredDecisions: true,
    supportsPauseForUserInput: true,
  };
  private readonly healthCheckCache = new HealthCheckCache();

  recognizesModel(modelId: string): boolean {
    return typeof modelId === 'string' && /^(gpt-|o\d)/.test(modelId);
  }

  async getCliVersionTag(): Promise<string | undefined> {
    const versionResult = await execa(AgentId.CODEX, ['--version'], {
      timeout: 10_000,
      reject: false,
      stdin: 'ignore',
    });
    if (versionResult.exitCode !== 0) return undefined;
    const match = `${versionResult.stdout ?? ''} ${versionResult.stderr ?? ''}`
      .match(/(\d+\.\d+\.\d+)/);
    if (!match) return undefined;
    return buildCliVersionTag(AgentId.CODEX, match[1]);
  }

  async execute(task: Task): Promise<TaskResult> {
    const tmpDir = mkdtempSync(join(tmpdir(), 'codex-'));
    registerTempDirForCleanup(tmpDir);
    try {
      const outputFile = join(tmpDir, 'output.json');

      const resumeSessionId = task.constraints?.resumeSessionId;
      const args = [
        'exec',
        ...(resumeSessionId ? ['resume'] : []),
        '--json',
        '--skip-git-repo-check',
        '-o',
        outputFile,
      ];
      if (task.constraints?.model) {
        args.push('--model', task.constraints.model);
      }
      if (task.constraints?.effort) {
        // Codex CLI applies reasoning effort via the TOML override flag.
        // Threading it here means a per-dispatch effort override always
        // wins over the user's CLI config + the per-machine agents.json
        // default (resolution happens upstream in planRunAgent).
        args.push('-c', `model_reasoning_effort="${task.constraints.effort}"`);
      }
      if (task.constraints?.sandbox) {
        // String values mirror Codex's `--sandbox` enum. Type union in
        // adapters/types.ts enforces this at compile time; if Codex
        // renames a value upstream, fix both places together.
        args.push('--sandbox', task.constraints.sandbox);
      }
      // Sandbox writable-roots grant. We set `sandbox_workspace_write.writable_roots`
      // via a `-c` config override rather than `--add-dir`. Why not --add-dir:
      // observed failure mode 2026-05 — codex exec dispatches to a worktree
      // whose `.git` is a linked-worktree pointer at `<host>/.git/worktrees/<wt>`,
      // and `git commit` needs to write `index.lock` there. We passed that
      // gitdir via `--add-dir` and codex still blocked the write with
      // "outside the writable root". The codex binary surfaces two distinct
      // notions of writable root: `writable_roots` (config-loaded, enforced
      // at sandbox profile generation) and `additional_writable_root` (a
      // runtime-approval modification of the active permission profile).
      // `--add-dir` drives the latter, which in non-interactive `codex exec`
      // doesn't auto-approve, so the grant silently fails for paths outside
      // cwd. Setting `writable_roots` via `-c` puts the path into the
      // *config* before the seatbelt profile is built, which works.
      // Trade-off: `-c` REPLACES the user's per-machine `writable_roots` for
      // this dispatch. Acceptable here because crew owns the sandbox
      // contract for dispatched runs (the user's interactive codex config
      // doesn't need to leak into a worktree run).
      const writablePaths = (task.constraints?.writablePaths ?? [])
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      if (writablePaths.length > 0) {
        // TOML array literal: `["a", "b"]`. JSON.stringify produces the
        // exact same shape for string arrays, so reuse it rather than
        // hand-rolling a serializer (and risking quote-escape bugs on
        // paths with spaces or other unusual characters).
        const tomlArray = JSON.stringify(writablePaths);
        args.push('-c', `sandbox_workspace_write.writable_roots=${tomlArray}`);
      }
      if (task.constraints?.networkAccess) {
        // Default Codex `workspace-write` sandbox blocks localhost,
        // which silently turns "tests passed" into "tests didn't run"
        // for anything that touches a local DB/devserver. Toggle it on
        // for runs that need it. Harmless under `read-only` (the key
        // only affects workspace-write).
        args.push('-c', 'sandbox_workspace_write.network_access=true');
      }
      if (resumeSessionId) {
        // `codex exec resume --help` (checked 2026-07-05) names this a
        // Conversation/session id. Treat it as stable across resumed turns and
        // reject a different returned `thread.started.thread_id` as context
        // loss rather than silently continuing on a fresh thread.
        args.push(resumeSessionId, '-');
      }

      // No wall-clock timeout. Pre-2026-05 we passed `timeout: 300_000`
      // to execa and the kernel SIGKILL'd codex mid-edit on long
      // xhigh-effort runs (field report: a 5-minute cliff killed the
      // edit pass after Phase 1 completed cleanly). Cancellation is
      // captain-driven via `cancel_run` → AbortController, which
      // propagates here through `cancelSignal`. Hang protection is the
      // agent's own turn/token budget.
      const timeout = task.constraints?.timeout;
      logger.debug('[adapter:codex] starting execute', {
        cwd: task.context.workingDirectory,
        timeoutMs: timeout,
        outputFile,
        model: task.constraints?.model,
        promptChars: task.prompt.length,
      });

      let result;
      let flushBufferedLine: (() => void) | undefined;
      const reducer = createCodexTerminalReducer();
      const stderrCapture = createBoundedStderrCapture();
      try {
        const subprocess = execa(AgentId.CODEX, args, {
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
          const emitBufferedLine = (line: string) => {
            const event = reducer.feedLine(line);
            if (!event || !task.onOutput) return;
            try {
              const chunk = formatEventForStream(event);
              if (chunk) task.onOutput!(chunk);
            } catch {
              // Malformed or unexpected event — reducer already accounted for dropped parse lines.
            }
          };
          flushBufferedLine = () => {
            if (!buffer.trim()) {
              buffer = '';
              return;
            }
            emitBufferedLine(buffer);
            buffer = '';
          };

          subprocess.stdout.on('data', (buf: Buffer) => {
            buffer += buf.toString('utf-8');
            let newlineIdx: number;
            while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, newlineIdx);
              buffer = buffer.slice(newlineIdx + 1);
              emitBufferedLine(line);
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
                `[adapter:codex] stderr capture failed: ${
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
        const fallbackStdout = (result as unknown as { stdout?: unknown }).stdout;
        if (typeof fallbackStdout === 'string') {
          const snapshot = reducer.snapshot();
          if (!snapshot.capturedText) {
            reducer.feedText(fallbackStdout);
          }
        }
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : 'Unknown execution error';
        logger.error('[adapter:codex] process execution threw', {
          cwd: task.context.workingDirectory,
          timeoutMs: timeout,
          error: message,
        });
        const stderrText = stderrCapture.text();
        return {
          output: stderrText,
          filesModified: [],
          status: 'error',
          failure: classifyTextFailure(
            [message, stderrText].filter(Boolean).join('\n'),
            { defaultKind: 'process' },
          ),
          metadata: {
            rawEvents: [{ error: message, stderr: stderrText }],
          },
        };
      }

      const fallbackStderr = (result as unknown as { stderr?: unknown }).stderr;
      const stderrText = stderrCapture.text()
        || (typeof fallbackStderr === 'string' ? fallbackStderr : '');
      logger.debug('[adapter:codex] execute finished', {
        exitCode: result.exitCode,
        stdoutChars: reducer.snapshot().capturedText.length,
        stderrChars: stderrText.length,
      });

      const reduced = reducer.snapshot();

      if (resumeSessionId && reduced.threadId && reduced.threadId !== resumeSessionId) {
        const message =
          `codex resume invalidated: requested session ${resumeSessionId} but the CLI `
          + `returned ${reduced.threadId}. Re-dispatch without resume or start a new run.`;
        logger.warn('[adapter:codex] resume thread id mismatch', {
          requested: resumeSessionId,
          returned: reduced.threadId,
        });
        return {
          output: message,
          filesModified: [],
          status: 'error',
          sessionId: reduced.threadId,
          failure: {
            kind: 'unknown',
            confidence: 'high',
            providerCode: 'resume_invalidated',
            recommendation: 'ask_user',
            rawSignal: message,
          },
          metadata: {
            rawEvents: reduced.events,
            droppedLines: reduced.droppedLines,
          },
        };
      }

      if (result.exitCode !== 0 && !reduced.capturedText) {
        logger.error('[adapter:codex] command failed with no stdout', {
          exitCode: result.exitCode,
          stderrPreview: preview(stderrText),
        });
        return {
          output:
            stderrText ||
            `Codex command failed with exit code ${result.exitCode} and no JSONL output`,
          filesModified: [],
          status: 'error',
          failure: classifyTextFailure(
            stderrText || `Codex command failed with exit code ${result.exitCode} and no JSONL output`,
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

      // If stdout was non-empty but every line failed to parse, treat as error
      if (reduced.capturedText && reduced.events.length === 0) {
        logger.error('[adapter:codex] failed to parse any JSONL events', {
          droppedLines: reduced.droppedLines,
          stdoutPreview: preview(reduced.capturedText),
        });
        return {
          output: 'Failed to parse any events from Codex JSONL output',
          filesModified: [],
          status: 'error',
          failure: classifyTextFailure(reduced.capturedText, { defaultKind: 'unknown' }),
          metadata: {
            rawEvents: [],
            droppedLines: reduced.droppedLines,
          },
        };
      }

      // Check for errors in events
      if (reduced.errorMessage) {
        logger.error('[adapter:codex] runtime error event detected', {
          errorMessage: reduced.errorMessage,
          droppedLines: reduced.droppedLines,
        });
        return {
          output: reduced.errorMessage,
          filesModified: [],
          status: 'error',
          sessionId: reduced.threadId,
          failure: classifyCodexFailureEvent(reduced.failureEvent)
            ?? classifyTextFailure(reduced.errorMessage, { defaultKind: 'unknown' }),
          metadata: {
            rawEvents: reduced.events,
            droppedLines: reduced.droppedLines,
          },
        };
      }

      // Extract file changes
      const filesModified = reduced.filesModified;

      // Get output: prefer output file, fall back to last agent message
      let output = '';
      if (existsSync(outputFile)) {
        try {
          output = readFileSync(outputFile, 'utf-8');
        } catch {
          // Fall through to agent message
          logger.warn('[adapter:codex] could not read output file, falling back to event message', {
            outputFile,
          });
        }
      }
      if (!output) {
        output = reduced.lastAgentMessage;
      }

      if (result.exitCode !== 0) {
        logger.error('[adapter:codex] command failed after producing JSONL output', {
          exitCode: result.exitCode,
          stderrPreview: preview(stderrText),
          outputPreview: preview(output),
          droppedLines: reduced.droppedLines,
        });
        return {
          output:
            stderrText
            || output
            || `Codex command failed with exit code ${result.exitCode}`,
          filesModified,
          status: 'error',
          sessionId: reduced.threadId,
          failure: classifyTextFailure(
            stderrText || output || `Codex command failed with exit code ${result.exitCode}`,
            { defaultKind: 'process' },
          ),
          metadata: {
            rawEvents: reduced.events,
            droppedLines: reduced.droppedLines,
          },
        };
      }

      return {
        output,
        filesModified,
        status: reduced.hasFailedTurn ? 'error' : output ? 'success' : 'partial',
        sessionId: reduced.threadId,
        metadata: {
          rawEvents: reduced.events,
          droppedLines: reduced.droppedLines,
        },
      };
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
        unregisterTempDirForCleanup(tmpDir);
      } catch (err) {
        logBestEffortFailure('codex.tmp-cleanup', err);
      }
    }
  }

  async executeWithSchema<T extends z.ZodType>(
    prompt: string,
    schema: T,
    options?: ExecuteOptions,
  ): Promise<z.infer<T>> {
    const tmpDir = mkdtempSync(join(tmpdir(), 'codex-schema-'));
    registerTempDirForCleanup(tmpDir);
    try {
      const schemaFile = join(tmpDir, 'schema.json');
      const outputFile = join(tmpDir, 'output.json');

      const jsonSchema = z.toJSONSchema(schema);
      writeFileSync(schemaFile, JSON.stringify(jsonSchema, null, 2), 'utf-8');

      const args = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--output-schema',
        schemaFile,
        '-o',
        outputFile,
        ...(options?.model ? ['--model', options.model] : []),
      ];

      // No wall-clock timeout — see the matching comment on the
      // primary execute() path. The schema-mode call is bounded by
      // the captain-driven cancel signal; the agent's turn budget is
      // its own backstop.
      const timeout = options?.timeout;
      logger.debug('[adapter:codex] starting executeWithSchema', {
        cwd: options?.workingDirectory,
        timeoutMs: timeout,
        schemaFile,
        outputFile,
        model: options?.model,
        promptChars: prompt.length,
      });

      let result;
      try {
        result = await execa(AgentId.CODEX, args, {
          cwd: options?.workingDirectory,
          ...(timeout ? { timeout } : {}),
          cancelSignal: options?.signal,
          reject: false,
          input: prompt,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown execution error';
        logger.error('[adapter:codex] executeWithSchema process threw', {
          cwd: options?.workingDirectory,
          timeoutMs: timeout,
          error: message,
        });
        throw new Error(`Codex execution failed before producing JSON output: ${message}`);
      }

      logger.debug('[adapter:codex] executeWithSchema finished', {
        exitCode: result.exitCode,
        stdoutChars: result.stdout?.length ?? 0,
        stderrChars: result.stderr?.length ?? 0,
      });

      if (result.exitCode !== 0 && !result.stdout) {
        logger.error('[adapter:codex] executeWithSchema failed with no stdout', {
          exitCode: result.exitCode,
          stderrPreview: preview(result.stderr),
        });
        throw new Error(
          `Codex schema execution failed with exit code ${result.exitCode}: ${result.stderr}`,
        );
      }

      // Check for errors in JSONL output
      if (result.stdout) {
        const { events } = parseJsonl(result.stdout);
        const errorMessage = findError(events);
        if (errorMessage) {
          logger.error('[adapter:codex] executeWithSchema returned error event', {
            errorMessage,
          });
          throw new Error(`Codex returned an error: ${errorMessage}`);
        }
      }

      // Read structured output from the output file
      if (!existsSync(outputFile)) {
        logger.error('[adapter:codex] executeWithSchema missing output file', {
          outputFile,
          exitCode: result.exitCode,
          stderrPreview: preview(result.stderr),
        });
        throw new Error(
          `Codex did not produce output file (exit code ${result.exitCode}): ${result.stderr}`,
        );
      }

      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(outputFile, 'utf-8'));
      } catch {
        logger.error('[adapter:codex] executeWithSchema output file was invalid JSON', {
          outputFile,
        });
        throw new Error(`Failed to parse Codex output file: ${outputFile}`);
      }

      return schema.parse(raw) as z.infer<T>;
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
        unregisterTempDirForCleanup(tmpDir);
      } catch (err) {
        logBestEffortFailure('codex.schema-tmp-cleanup', err);
      }
    }
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

    context.onProviderSession?.({
      provider: 'codex',
      transport: 'adapter',
      cliVersion: await this.getCliVersionTag(),
      toolNamespace: context.toolNamespace ?? 'mcp__crew__',
      toolSchemaHash: context.toolSchemaHash ?? '',
      startedAt: context.providerSession?.startedAt ?? new Date().toISOString(),
      lastTurnAt: new Date().toISOString(),
    });
    return this.executeWithPromptLoop(tools, messages, onToolCall, context);
  }

  private async executeWithPromptLoop(
    tools: ToolDefinition[],
    messages: ToolLoopMessage[],
    onToolCall: (call: ToolCall) => Promise<ToolResult>,
    context?: ToolLoopContext,
  ): Promise<ToolLoopResult> {
    // Track codex thread_id across inner turns. The first call is a fresh
    // `codex exec`; subsequent calls use `codex exec resume <thread_id>`
    // so codex's server-side prefix cache can hit. Without this, each
    // inner turn is a brand-new thread and the whole ~80k-token built-in
    // preamble + our growing transcript has to be re-processed from
    // scratch — observed as 30s per turn. Sharing the thread typically
    // drops follow-up turns to ~5-10s.
    let threadId: string | undefined = context?.providerSession?.sessionId;

    return executePromptToolLoop(
      tools,
      messages,
      onToolCall,
      async (prompt) => {
        const { decision, threadId: nextThreadId } = await this.executeDecisionTurn(prompt, {
          threadId,
          signal: context?.signal,
          workingDirectory: context?.workingDirectory,
        });
        if (nextThreadId) threadId = nextThreadId;
        return decision;
      },
      {
        pathTaken: 'adapter',
        signal: context?.signal,
        onTranscriptUpdate: context?.onTranscriptUpdate,
      },
    );
  }

  /**
   * Codex-private wrapper around the `codex exec` structured-output invocation
   * used as the primary decision-making path for captain turns.
   * Differs from the public `executeWithSchema` in three ways:
   *
   *   1. Accepts an optional `threadId`; emits `exec resume <id>` when set
   *      so codex's prefix cache can hit across inner turns.
   *   2. Extracts the `thread_id` from the JSONL event stream and returns
   *      it to the caller for use on the next turn.
   *   3. Logs a decision-preview at INFO level (previously, only the raw
   *      duration was logged, so debugging "captain stuck in a loop" was
   *      blind without parsing events.log).
   */
  private async executeDecisionTurn(
    prompt: string,
    options: {
      threadId?: string;
      signal?: AbortSignal;
      workingDirectory?: string;
    },
  ): Promise<{ decision: ToolLoopDecision; threadId: string | undefined }> {
    const tmpDir = mkdtempSync(join(tmpdir(), 'codex-decision-'));
    registerTempDirForCleanup(tmpDir);
    try {
      const outputFile = join(tmpDir, 'output.json');
      const args = options.threadId
        ? [
            'exec',
            'resume',
            '--json',
            '--skip-git-repo-check',
            '--ignore-rules',
            '--output-last-message',
            outputFile,
            options.threadId,
            '-',
          ]
        : this.buildStructuredDecisionArgs(prompt, tmpDir, outputFile);

      const turnStartedAt = Date.now();
      logger.info('[adapter:codex] decision turn start', {
        resumedThreadId: options.threadId,
        structuredSchema: !options.threadId,
        promptChars: prompt.length,
        promptPreview: preview(prompt, 200),
      });
      const subprocess = execa(AgentId.CODEX, args, {
        cwd: options.workingDirectory,
        ...processGroupSpawnOptions(),
        cancelSignal: options.signal,
        reject: false,
        input: prompt,
        // No wall-clock timeout. Inner turns vary widely with reasoning
        // effort; field testing showed long xhigh runs were cliff-killed
        // mid-edit by the prior 5m cap. Cancellation comes via the
        // captain's cancelSignal.
      });
      const disposeProcessGroupAbort = terminateProcessGroupOnAbort(
        subprocess,
        options.signal,
      );
      let result;
      try {
        result = await subprocess;
      } finally {
        disposeProcessGroupAbort();
      }

      if (result.exitCode !== 0 && !result.stdout) {
        throw new Error(
          `Codex decision turn exited ${result.exitCode}: ${result.stderr || '(no stderr)'}`,
        );
      }

      const { events } = parseJsonl(result.stdout ?? '');
      const errorMessage = findError(events);
      if (errorMessage) {
        throw new Error(`Codex returned an error: ${errorMessage}`);
      }

      const outputText = existsSync(outputFile)
        ? readFileSync(outputFile, 'utf-8')
        : this.resolveDecisionOutputFromEvents(events, {
            exitCode: result.exitCode ?? -1,
            stderr: result.stderr,
          });

      if (!outputText) {
        const lastAssistantMessage = getLastAgentMessage(events);
        throw new Error(
          [
            `Codex did not produce decision output (exit ${result.exitCode}).`,
            result.stderr ? `stderr: ${preview(result.stderr)}` : undefined,
            lastAssistantMessage ? `last assistant message: ${preview(lastAssistantMessage)}` : undefined,
          ].filter(Boolean).join(' '),
        );
      }

      const decision = this.parseDecisionOutput(outputText);

      // thread_id appears on the `thread.started` event of the first
      // turn; subsequent resume turns reuse the same thread so the
      // extractor returns the same id (or undefined when nothing in the
      // stream carried it, e.g. a subprocess that failed before starting).
      const nextThreadId = this.extractThreadId(events) ?? options.threadId;

      logger.info('[adapter:codex] decision turn end', {
        elapsedMs: Date.now() - turnStartedAt,
        threadId: nextThreadId,
        decisionType: decision.type,
        tool: decision.tool ?? undefined,
        reasoningPreview: decision.reasoning ? preview(decision.reasoning, 160) : undefined,
        outputPreview: decision.output ? preview(decision.output, 160) : undefined,
      });

      return { decision, threadId: nextThreadId };
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
        unregisterTempDirForCleanup(tmpDir);
      } catch (err) {
        logBestEffortFailure('codex.decision-tmp-cleanup', err);
      }
    }
  }

  private extractThreadId(events: CodexEvent[]): string | undefined {
    for (const event of events) {
      if (typeof event.thread_id === 'string' && event.thread_id.length > 0) {
        return event.thread_id;
      }
    }
    return undefined;
  }

  private parseToolDecisionFromAssistant(text: string): ToolLoopDecision {
    return ToolLoopDecisionSchema.parse(extractJson(text));
  }

  private buildStructuredDecisionArgs(
    prompt: string,
    tmpDir: string,
    outputFile: string,
  ): string[] {
    const schemaFile = join(tmpDir, 'schema.json');
    const jsonSchema = z.toJSONSchema(ToolLoopDecisionSchema);
    writeFileSync(schemaFile, JSON.stringify(jsonSchema, null, 2), 'utf-8');

    return [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ignore-rules',
      '--sandbox',
      'read-only',
      '--output-schema',
      schemaFile,
      '--output-last-message',
      outputFile,
    ];
  }

  private parseDecisionOutput(text: string): ToolLoopDecision {
    try {
      return ToolLoopDecisionSchema.parse(JSON.parse(text)) as ToolLoopDecision;
    } catch {
      return this.parseToolDecisionFromAssistant(text);
    }
  }

  private resolveDecisionOutputFromEvents(
    events: CodexEvent[],
    result: { exitCode: number; stderr?: string },
  ): string | undefined {
    const lastAssistantMessage = getLastAgentMessage(events);
    if (!lastAssistantMessage) return undefined;

    try {
      this.parseDecisionOutput(lastAssistantMessage);
      logger.warn('[adapter:codex] decision output file missing; using JSONL assistant message fallback', {
        exitCode: result.exitCode,
        stderrPreview: preview(result.stderr),
        assistantPreview: preview(lastAssistantMessage),
      });
      return lastAssistantMessage;
    } catch {
      return undefined;
    }
  }

  async healthCheck(options?: HealthCheckOptions): Promise<HealthCheckResult> {
    return this.healthCheckCache.get(options, () => this.probeHealth());
  }

  private async probeHealth(): Promise<HealthCheckResult> {
    try {
      const result = await execa(AgentId.CODEX, ['--version'], {
        timeout: 10_000,
        reject: false,
        stdin: 'ignore',
      });

      if (result.exitCode === 0) {
        const versionMatch = `${result.stdout ?? ''} ${result.stderr ?? ''}`
          .match(/(\d+\.\d+\.\d+)/);
        return {
          available: true,
          version: versionMatch ? versionMatch[1] : undefined,
          authenticated: true, // Assumed: Codex CLI does not expose an auth-verification command; true means "not known to be unauthenticated"
        };
      }

      return {
        available: false,
        authenticated: false,
        error: result.stderr || 'codex --version failed',
      };
    } catch {
      return {
        available: false,
        authenticated: false,
        error: 'Codex CLI not found',
      };
    }
  }
}
