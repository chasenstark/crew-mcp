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
import type {
  AgentAdapter,
  AgentCapability,
  ExecuteOptions,
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
import { toCodexConfigOverrides, type ToolCatalog } from '../captain/mcp-registration.js';
import { executePromptToolLoop } from './tool-loop/controller.js';
import {
  ToolLoopDecisionSchema,
  type ToolLoopDecision,
} from './tool-loop/decision.js';
import { TOOL_LOOP_MAX_TURNS } from './tool-loop/constants.js';
import { buildDecisionPrompt } from './tool-loop/transcript.js';

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
  exit_code?: number;
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

function numberField(
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
 * Formats a single Codex event as a user-visible chunk for streaming.
 * Only forwards final `item.completed` content events; envelope/meta events
 * (thread.*, turn.*) are intentionally dropped from the live view.
 */
export function formatEventForStream(event: CodexEvent): string {
  const agentMessage = getItemOfType(event, 'agent_message');
  if (agentMessage && typeof agentMessage.text === 'string') {
    return agentMessage.text;
  }
  const reasoning = getItemOfType(event, 'reasoning');
  if (reasoning && typeof reasoning.text === 'string') {
    return `\u2502 ${reasoning.text}\n`;
  }
  return '';
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

/**
 * Locked argv ordering for `codex exec` invocations under the resume path.
 *
 * Shape:
 *   codex exec [resume <sid>] --json --skip-git-repo-check <prompt> [-c k=v ...]
 *
 * `--skip-git-repo-check` is always present — Codex 0.121 refuses to run in
 * untrusted cwds (including /tmp worktrees) without it. Additional
 * `-c k=v` overrides, if any, are appended after the prompt so argv order
 * stays predictable when M0.5-3's MCP-server override builder feeds in.
 */
export function buildCodexResumeArgs(
  session: { sessionId?: string; threadId?: string },
  prompt: string,
  overrideFlags: readonly string[] = [],
): string[] {
  const sessionId = session.sessionId ?? session.threadId;
  const base = sessionId ? ['exec', 'resume', sessionId] : ['exec'];
  return [
    ...base,
    '--json',
    '--skip-git-repo-check',
    prompt,
    ...overrideFlags,
  ];
}

export class CodexAdapter implements AgentAdapter {
  readonly name = AgentId.CODEX;
  readonly capabilities: AgentCapability[] = [
    'implement',
    'review',
    'refactor',
    'test',
    'analyze',
  ];
  readonly supportsJsonSchema = true;
  readonly captainCapabilities = {
    supportsToolLoop: true,
    supportsStructuredDecisions: true,
    supportsPauseForUserInput: true,
  };

  recognizesModel(modelId: string): boolean {
    return typeof modelId === 'string' && /^(gpt-|o\d)/.test(modelId);
  }

  async getCliVersionTag(): Promise<string | undefined> {
    const versionResult = await execa(AgentId.CODEX, ['--version'], {
      timeout: 10_000,
      reject: false,
    });
    if (versionResult.exitCode !== 0) return undefined;
    const match = `${versionResult.stdout ?? ''} ${versionResult.stderr ?? ''}`
      .match(/(\d+\.\d+\.\d+)/);
    if (!match) return undefined;
    return buildCliVersionTag(AgentId.CODEX, match[1]);
  }

  async execute(task: Task): Promise<TaskResult> {
    const tmpDir = mkdtempSync(join(tmpdir(), 'codex-'));
    try {
      const outputFile = join(tmpDir, 'output.json');

      const args = [
        'exec',
        task.prompt,
        '--json',
        '--skip-git-repo-check',
        '-o',
        outputFile,
      ];
      if (task.constraints?.model) {
        args.push('--model', task.constraints.model);
      }

      const timeout = task.constraints?.timeout ?? 300_000;
      logger.debug('[adapter:codex] starting execute', {
        cwd: task.context.workingDirectory,
        timeoutMs: timeout,
        outputFile,
        model: task.constraints?.model,
        promptChars: task.prompt.length,
      });

      let result;
      let flushBufferedLine: (() => void) | undefined;
      try {
        const subprocess = execa(AgentId.CODEX, args, {
          cwd: task.context.workingDirectory,
          timeout,
          cancelSignal: task.constraints?.signal,
          reject: false,
        });

        if (task.onOutput && subprocess.stdout) {
          let buffer = '';
          const emitBufferedLine = (line: string) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            try {
              const event = parseJsonlEvent(trimmed);
              if (!event) return;
              const chunk = formatEventForStream(event);
              if (chunk) task.onOutput!(chunk);
            } catch {
              // Malformed or non-object line — already accounted for by the final parseJsonl pass.
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

        result = await subprocess;
        flushBufferedLine?.();
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : 'Unknown execution error';
        logger.error('[adapter:codex] process execution threw', {
          cwd: task.context.workingDirectory,
          timeoutMs: timeout,
          error: message,
        });
        return {
          output: '',
          filesModified: [],
          status: 'error',
          metadata: {
            rawEvents: [{ error: message }],
          },
        };
      }

      logger.debug('[adapter:codex] execute finished', {
        exitCode: result.exitCode,
        stdoutChars: result.stdout?.length ?? 0,
        stderrChars: result.stderr?.length ?? 0,
      });

      if (result.exitCode !== 0 && !result.stdout) {
        logger.error('[adapter:codex] command failed with no stdout', {
          exitCode: result.exitCode,
          stderrPreview: preview(result.stderr),
        });
        return {
          output:
            result.stderr ||
            `Codex command failed with exit code ${result.exitCode} and no JSONL output`,
          filesModified: [],
          status: 'error',
          metadata: {
            rawEvents: [
              {
                exitCode: result.exitCode,
                stderr: result.stderr,
              },
            ],
          },
        };
      }

      // Parse JSONL from stdout
      const { events, droppedLines } = result.stdout
        ? parseJsonl(result.stdout)
        : { events: [], droppedLines: 0 };

      // If stdout was non-empty but every line failed to parse, treat as error
      if (result.stdout && events.length === 0) {
        logger.error('[adapter:codex] failed to parse any JSONL events', {
          droppedLines,
          stdoutPreview: preview(result.stdout),
        });
        return {
          output: 'Failed to parse any events from Codex JSONL output',
          filesModified: [],
          status: 'error',
          metadata: {
            rawEvents: [],
            droppedLines,
          },
        };
      }

      // Check for errors in events
      const errorMessage = findError(events);
      if (errorMessage) {
        logger.error('[adapter:codex] runtime error event detected', {
          errorMessage,
          droppedLines,
        });
        return {
          output: errorMessage,
          filesModified: [],
          status: 'error',
          metadata: {
            rawEvents: events,
            droppedLines,
          },
        };
      }

      // Extract file changes
      const filesModified = extractFileChanges(events);

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
        output = getLastAgentMessage(events);
      }

      if (result.exitCode !== 0) {
        logger.error('[adapter:codex] command failed after producing JSONL output', {
          exitCode: result.exitCode,
          stderrPreview: preview(result.stderr),
          outputPreview: preview(output),
          droppedLines,
        });
        return {
          output:
            result.stderr
            || output
            || `Codex command failed with exit code ${result.exitCode}`,
          filesModified,
          status: 'error',
          metadata: {
            rawEvents: events,
            droppedLines,
          },
        };
      }

      const hasFailedTurn = events.some((e) => e.type === 'turn.failed');

      return {
        output,
        filesModified,
        status: hasFailedTurn ? 'error' : output ? 'success' : 'partial',
        metadata: {
          rawEvents: events,
          droppedLines,
        },
      };
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
    }
  }

  async executeWithSchema<T extends z.ZodType>(
    prompt: string,
    schema: T,
    options?: ExecuteOptions,
  ): Promise<z.infer<T>> {
    const tmpDir = mkdtempSync(join(tmpdir(), 'codex-schema-'));
    try {
      const schemaFile = join(tmpDir, 'schema.json');
      const outputFile = join(tmpDir, 'output.json');

      const jsonSchema = z.toJSONSchema(schema);
      writeFileSync(schemaFile, JSON.stringify(jsonSchema, null, 2), 'utf-8');

      const args = [
        'exec',
        prompt,
        '--json',
        '--skip-git-repo-check',
        '--output-schema',
        schemaFile,
        '-o',
        outputFile,
        ...(options?.model ? ['--model', options.model] : []),
      ];

      const timeout = options?.timeout ?? 300_000;
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
          timeout,
          cancelSignal: options?.signal,
          reject: false,
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
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
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

    let latestTranscript = messages.map((message) => ({ ...message }));
    const wrappedContext: ToolLoopContext = {
      ...context,
      onTranscriptUpdate: (transcript) => {
        latestTranscript = transcript.map((message) => ({ ...message }));
        context.onTranscriptUpdate?.(latestTranscript);
      },
    };

    try {
      return await this.executeWithResumeSession(tools, messages, onToolCall, wrappedContext);
    } catch (error: unknown) {
      if (context.signal?.aborted) {
        return {
          status: 'interrupted',
          transcript: latestTranscript,
          pathTaken: 'fallback',
          error: String(context.signal.reason ?? 'Cancelled'),
        };
      }
      logger.warn('[adapter:codex] stateful resume path failed; falling back to adapter loop', {
        error: error instanceof Error ? error.message : String(error),
      });
      context.onProviderSession?.({
        provider: 'codex',
        transport: 'adapter',
        cliVersion: await this.getCliVersionTag(),
        toolNamespace: context.toolNamespace ?? 'mcp__crew__',
        toolSchemaHash: context.toolSchemaHash ?? '',
        startedAt: context.providerSession?.startedAt ?? new Date().toISOString(),
        lastTurnAt: new Date().toISOString(),
      });
      const fallbackResult = await this.executeWithPromptLoop(
        tools,
        latestTranscript,
        onToolCall,
        wrappedContext,
      );
      return {
        ...fallbackResult,
        pathTaken: 'adapter',
      };
    }
  }

  private async executeWithPromptLoop(
    tools: ToolDefinition[],
    messages: ToolLoopMessage[],
    onToolCall: (call: ToolCall) => Promise<ToolResult>,
    context?: ToolLoopContext,
  ): Promise<ToolLoopResult> {
    return executePromptToolLoop(
      tools,
      messages,
      onToolCall,
      (prompt) =>
        this.executeWithSchema(prompt, ToolLoopDecisionSchema, {
          signal: context?.signal,
          workingDirectory: context?.workingDirectory,
        }),
      {
        pathTaken: 'adapter',
        signal: context?.signal,
        onTranscriptUpdate: context?.onTranscriptUpdate,
      },
    );
  }

  private async executeWithResumeSession(
    tools: ToolDefinition[],
    messages: ToolLoopMessage[],
    onToolCall: (call: ToolCall) => Promise<ToolResult>,
    context: ToolLoopContext,
  ): Promise<ToolLoopResult> {
    const transcript: ToolLoopMessage[] = [...messages];
    const publishTranscript = () => {
      context.onTranscriptUpdate?.(transcript.map((message) => ({ ...message })));
    };
    const cliVersion = await this.getCliVersionTag();
    // M3-8: if the session-loop supplied a `codex`-kind mcpRegistration, its
    // `configOverrideArgv` is the already-serialized `-c mcp_servers.*=...`
    // list that `toCodexConfigOverrides(catalog)` emits. Threading it
    // through here replaces M0.5's empty stub.
    const configFlags =
      context.mcpRegistration?.kind === 'codex'
        ? [...context.mcpRegistration.configOverrideArgv]
        : this.buildPerRunConfigFlags();

    let providerSession = {
      provider: 'codex' as const,
      transport: 'stateful-resume' as const,
      sessionId: context.providerSession?.sessionId,
      threadId: context.providerSession?.threadId,
      cliVersion,
      toolNamespace: context.toolNamespace ?? 'mcp__crew__',
      toolSchemaHash: context.toolSchemaHash ?? '',
      startedAt: context.providerSession?.startedAt ?? new Date().toISOString(),
      lastTurnAt: new Date().toISOString(),
    };
    context.onProviderSession?.(providerSession);
    let pendingPrompt = buildDecisionPrompt(tools, transcript);

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedInputTokens = 0;
    let turnCount = 0;

    for (let turn = 1; turn <= TOOL_LOOP_MAX_TURNS; turn++) {
      const args = this.buildResumeArgs(providerSession, pendingPrompt, configFlags);
      // Log parity with the claude-code stream path so users can see the
      // captain is actually making progress — codex `exec` buffers output
      // until the API responds, so without this signal the terminal +
      // log file both look hung for the whole first-turn API latency.
      logger.info('[adapter:codex] resume turn start', {
        turn,
        resumedSessionId: providerSession.sessionId,
        promptPreview: preview(pendingPrompt, 200),
      });
      const turnStartedAt = Date.now();
      const result = await execa(AgentId.CODEX, args, {
        cwd: context.workingDirectory,
        cancelSignal: context.signal,
        reject: false,
      });

      if (result.exitCode !== 0 && !result.stdout) {
        logger.warn('[adapter:codex] resume turn failed with no stdout', {
          turn,
          exitCode: result.exitCode,
          stderrPreview: preview(result.stderr),
        });
        throw new Error(result.stderr || `codex exited with code ${result.exitCode}`);
      }

      const { events, droppedLines } = parseJsonl(result.stdout ?? '');
      const errorMessage = findError(events);
      if (errorMessage) {
        throw new Error(errorMessage);
      }
      if (events.length === 0) {
        throw new Error('Codex returned no JSONL events.');
      }

      turnCount = turn;
      const usage = this.extractResumeUsage(events);
      totalInputTokens += usage.inputTokens ?? 0;
      totalOutputTokens += usage.outputTokens ?? 0;
      totalCachedInputTokens += usage.cachedInputTokens ?? 0;

      const threadId = this.extractThreadId(events);
      if (threadId && threadId !== providerSession.threadId) {
        providerSession = {
          ...providerSession,
          sessionId: threadId,
          threadId,
          lastTurnAt: new Date().toISOString(),
        };
        context.onProviderSession?.(providerSession);
      }

      const assistantMessage = getLastAgentMessage(events);
      if (!assistantMessage) {
        throw new Error('Codex did not emit an agent message for controller decision.');
      }
      logger.info('[adapter:codex] resume turn end', {
        turn,
        elapsedMs: Date.now() - turnStartedAt,
        threadId,
        assistantPreview: preview(assistantMessage, 200),
      });

      const parsedDecision = this.parseToolDecisionFromAssistant(assistantMessage);
      if (parsedDecision.reasoning) {
        transcript.push({
          role: 'assistant',
          content: parsedDecision.reasoning,
        });
        publishTranscript();
      }

      if (parsedDecision.type === 'finish') {
        return {
          status: 'completed',
          transcript,
          output: parsedDecision.output ?? parsedDecision.reasoning ?? '',
          pathTaken: 'stateful-resume',
          providerSession,
          telemetry: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cachedInputTokens: totalCachedInputTokens,
            totalTurns: turnCount,
          },
        };
      }

      if (parsedDecision.type === 'fail') {
        return {
          status: 'failed',
          transcript,
          error: parsedDecision.error ?? parsedDecision.reasoning ?? 'Controller requested fail',
          pathTaken: 'stateful-resume',
          providerSession,
          telemetry: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cachedInputTokens: totalCachedInputTokens,
            totalTurns: turnCount,
          },
        };
      }

      const toolName = parsedDecision.tool?.trim();
      if (!toolName) {
        throw new Error('Tool call missing tool name.');
      }

      const knownTool = tools.find((tool) => tool.name === toolName);
      if (!knownTool) {
        throw new Error(`Unknown tool "${toolName}".`);
      }

      const toolInput = parsedDecision.input ?? {};
      transcript.push({
        role: 'assistant',
        content: JSON.stringify({
          type: 'tool_call',
          tool: toolName,
          input: toolInput,
        }),
      });
      publishTranscript();

      const toolResult = await onToolCall({ name: toolName, input: toolInput });
      transcript.push({
        role: 'tool',
        name: toolName,
        content: JSON.stringify(toolResult.output),
      });
      publishTranscript();

      pendingPrompt = [
        `Tool ${toolName} returned:`,
        JSON.stringify(toolResult.output),
        'Choose the next action as a JSON object.',
      ].join('\n');

      if (droppedLines > 0) {
        logger.warn('[adapter:codex] dropped malformed JSONL lines while parsing stateful turn', {
          droppedLines,
        });
      }
    }

    return {
      status: 'failed',
      transcript,
      error: `Exceeded maximum native tool-loop turns (${TOOL_LOOP_MAX_TURNS}).`,
      pathTaken: 'stateful-resume',
      providerSession,
      telemetry: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cachedInputTokens: totalCachedInputTokens,
        totalTurns: turnCount,
      },
    };
  }

  /**
   * Returns the argv fragment for per-run Codex overrides.
   *
   * Historical behavior wrote `--config <path>` from the `CREW_CODEX_CONFIG`
   * env var, but Codex's `-c/--config` flag takes `key=value` TOML overrides,
   * not a file path — so that wiring always errored. The env var is kept
   * readable here only so M0.5-8 preflight can surface a one-time deprecation
   * notice when it is set; it no longer contributes to argv.
   *
   * Per-session MCP-server overrides (`-c mcp_servers.<name>.*`) are projected
   * via `toCodexConfigOverrides`. For M0.5 the catalog seam returns `[]` for
   * an empty catalog; M3 will populate it with the captain's real tool set.
   */
  private buildPerRunConfigFlags(catalog: ToolCatalog = {}): string[] {
    return toCodexConfigOverrides(catalog);
  }

  private buildResumeArgs(
    session: { sessionId?: string; threadId?: string },
    prompt: string,
    overrideFlags: string[],
  ): string[] {
    return buildCodexResumeArgs(session, prompt, overrideFlags);
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

  private extractResumeUsage(events: CodexEvent[]): {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  } {
    const usage = this.findUsagePayload(events);
    if (!usage) return {};
    return {
      inputTokens: numberField(usage, ['input_tokens']),
      outputTokens: numberField(usage, ['output_tokens']),
      cachedInputTokens: numberField(usage, ['cached_input_tokens', 'cache_read_input_tokens']),
    };
  }

  private findUsagePayload(events: CodexEvent[]): Record<string, unknown> | undefined {
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index] as Record<string, unknown>;
      const usage = event.usage;
      if (usage && typeof usage === 'object') {
        return usage as Record<string, unknown>;
      }

      const eventPayload = event.event;
      if (eventPayload && typeof eventPayload === 'object') {
        const nestedUsage = (eventPayload as Record<string, unknown>).usage;
        if (nestedUsage && typeof nestedUsage === 'object') {
          return nestedUsage as Record<string, unknown>;
        }
      }
    }

    return undefined;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const result = await execa(AgentId.CODEX, ['--version'], {
        timeout: 10_000,
        reject: false,
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
