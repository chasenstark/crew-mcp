import { execa } from 'execa';
import { z } from 'zod';
import { extractJson } from '../utils/json-parse.js';

import type {
  AgentAdapter,
  AgentCapability,
  ExecuteOptions,
  HealthCheckResult,
  Task,
  TaskResult,
} from './types.js';
import { logger } from '../utils/logger.js';

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
});

type ClaudeResponse = z.infer<typeof ClaudeResponseSchema>;

function preview(text: string | undefined, max = 600): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}...`;
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
  readonly name = 'claude-code';
  readonly capabilities: AgentCapability[] = [
    'implement',
    'review',
    'refactor',
    'test',
    'document',
    'analyze',
  ];
  readonly supportsJsonSchema = true;
  readonly orchestratorCapabilities = {
    supportsToolLoop: false,
    supportsStructuredDecisions: true,
    supportsPauseForUserInput: false,
  };

  async execute(task: Task): Promise<TaskResult> {
    const streaming = Boolean(task.onOutput);
    const args = [
      '-p',
      task.prompt,
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

    const timeout = task.constraints?.timeout ?? 300_000; // 5 minutes default
    logger.debug('[adapter:claude-code] starting execute', {
      cwd: task.context.workingDirectory,
      timeoutMs: timeout,
      maxTurns: task.constraints?.maxTurns,
      model: task.constraints?.model,
      promptChars: task.prompt.length,
    });

    let result;
    try {
      const subprocess = execa('claude', args, {
        cwd: task.context.workingDirectory,
        timeout,
        cancelSignal: task.constraints?.signal,
        reject: false,
      });

      if (streaming && subprocess.stdout) {
        let buffer = '';
        subprocess.stdout.on('data', (buf: Buffer) => {
          buffer += buf.toString('utf-8');
          let newlineIdx: number;
          while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (!line) continue;
            const chunk = extractAssistantTextFromStreamLine(line);
            if (chunk) task.onOutput!(chunk);
          }
        });
      }

      result = await subprocess;
    } catch (error: unknown) {
      // Timeout or other process-level errors
      const message =
        error instanceof Error ? error.message : 'Unknown execution error';
      logger.error('[adapter:claude-code] process execution threw', {
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

    const stdoutText = result.stdout ?? '';
    const stderrText = result.stderr ?? '';
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
      parsed = extractStreamEnvelope(stdoutText);
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
      fullPrompt,
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
      // Disable all tools — orchestrator steps only need to analyze the prompt
      // and return JSON, never browse files or run commands.
      '--tools',
      '',
    ];

    if (options?.maxTurns) {
      args.push('--max-turns', String(options.maxTurns));
    }

    const timeout = options?.timeout ?? 300_000;
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
        timeout,
        cancelSignal: options?.signal,
        reject: false,
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

  async healthCheck(): Promise<HealthCheckResult> {
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
        },
      );

      if (authResult.exitCode === 0 && authResult.stdout) {
        return {
          available: true,
          version,
          authenticated: true,
        };
      }

      return {
        available: true,
        version,
        authenticated: false,
        error: authResult.stderr || 'Authentication check failed',
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
