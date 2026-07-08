import { execa } from 'execa';
import { z } from 'zod';

import { mkdtemp, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
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
  HealthCheckOptions,
  HealthCheckResult,
  Task,
  TaskResult,
} from './types.js';
import { logger } from '../utils/logger.js';
import { buildCliVersionTag } from '../provider-session.js';
import { AgentId } from '../workflow/agents.js';
import {
  processGroupSpawnOptions,
  terminateProcessGroupOnAbort,
} from './process-group.js';
import { classifyTextFailure } from './failure-classifier.js';
import type { TaskFailure } from './types.js';
import { redactRunToken } from '../utils/redaction.js';

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

function isEnoent(value: unknown): boolean {
  return value instanceof Error && 'code' in value && (value as NodeJS.ErrnoException).code === 'ENOENT';
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
    supportsStructuredDecisions: true,
    supportsPauseForUserInput: false,
  };
  private readonly healthCheckCache = new HealthCheckCache();

  recognizesModel(modelId: string): boolean {
    // OpenAI-family ids, plus any provider-qualified slug ("openrouter/…")
    // — codex config.toml model_providers can route arbitrary models we
    // can't enumerate here, and the '/' marks that intent. Keep in
    // lockstep with the registry proxy metadata (proxy/instance parity).
    return typeof modelId === 'string'
      && (/^(gpt-|o\d)/.test(modelId) || modelId.includes('/'));
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
    const tmpDir = await mkdtemp(join(tmpdir(), 'codex-'));
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
        // String values mirror Codex's sandbox enum. Fresh `exec` accepts
        // `--sandbox`; `exec resume` accepts the same value only through a
        // config override.
        if (resumeSessionId) {
          args.push('-c', `sandbox_mode="${task.constraints.sandbox}"`);
        } else {
          args.push('--sandbox', task.constraints.sandbox);
        }
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
      if (task.dispatchMcpEnv) {
        // Env-only overlay assumes the worker host already has a crew MCP
        // server table installed; if not, the partial table fails closed.
        // The token rides in argv under the single-UID local threat model.
        args.push(
          '-c',
          `mcp_servers.crew.env.CREW_RUN_ID="${task.dispatchMcpEnv.CREW_RUN_ID}"`,
          '-c',
          `mcp_servers.crew.env.CREW_RUN_TOKEN="${task.dispatchMcpEnv.CREW_RUN_TOKEN}"`,
          '-c',
          'mcp_servers.crew.tools.send_message.approval_mode="approve"',
        );
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
        const runToken = task.dispatchMcpEnv?.CREW_RUN_TOKEN;
        const message = redactRunToken(
          error instanceof Error ? error.message : 'Unknown execution error',
          runToken,
        );
        logger.error('[adapter:codex] process execution threw', {
          cwd: task.context.workingDirectory,
          timeoutMs: timeout,
          error: message,
        });
        const stderrText = redactRunToken(stderrCapture.text(), runToken);
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

      if (resumeSessionId && !reduced.threadId) {
        const message = [
          `resume_id_missing: codex was asked to resume provider session `
            + `${resumeSessionId} but returned no session id for this turn.`,
          `Subprocess exit code: ${result.exitCode}.`,
          stderrText ? `stderr tail:\n${stderrText}` : undefined,
        ].filter((part): part is string => Boolean(part)).join('\n');
        logger.error('[adapter:codex] resume produced no thread id', {
          requested: resumeSessionId,
          exitCode: result.exitCode,
          stderrPreview: preview(stderrText),
        });
        return {
          output: message,
          filesModified: [],
          status: 'error',
          failure: {
            kind: 'unknown',
            confidence: 'high',
            providerCode: 'resume_id_missing',
            recommendation: 'ask_user',
            rawSignal: message,
          },
          metadata: {
            rawEvents: reduced.events,
            droppedLines: reduced.droppedLines,
          },
        };
      }

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
      try {
        output = await readFile(outputFile, 'utf-8');
      } catch (err) {
        if (!isEnoent(err)) {
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
        await rm(tmpDir, { recursive: true, force: true });
        unregisterTempDirForCleanup(tmpDir);
      } catch (err) {
        logBestEffortFailure('codex.tmp-cleanup', err);
      }
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
