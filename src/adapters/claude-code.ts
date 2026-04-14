import { execa } from 'execa';
import { z } from 'zod';

import type {
  AgentAdapter,
  AgentCapability,
  ExecuteOptions,
  HealthCheckResult,
  Task,
  TaskResult,
} from './types.js';

/**
 * Schema for the JSON response from `claude -p ... --output-format json`.
 */
const ClaudeResponseSchema = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  result: z.string(),
  structured_output: z.unknown().optional(),
  session_id: z.string().optional(),
  total_cost_usd: z.number().optional(),
  cost_usd: z.number().optional(),
  duration_ms: z.number().optional(),
  num_turns: z.number().optional(),
  is_error: z.boolean().optional(),
});

type ClaudeResponse = z.infer<typeof ClaudeResponseSchema>;

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

  async execute(task: Task): Promise<TaskResult> {
    const args = [
      '-p',
      task.prompt,
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
    ];

    if (task.constraints?.maxTurns) {
      args.push('--max-turns', String(task.constraints.maxTurns));
    }

    const timeout = task.constraints?.timeout ?? 300_000; // 5 minutes default

    let result;
    try {
      result = await execa('claude', args, {
        cwd: task.context.workingDirectory,
        timeout,
        reject: false,
      });
    } catch (error: unknown) {
      // Timeout or other process-level errors
      const message =
        error instanceof Error ? error.message : 'Unknown execution error';
      return {
        output: '',
        filesModified: [],
        status: 'error',
        metadata: {
          rawEvents: [{ error: message }],
        },
      };
    }

    // CLI crash: non-zero exit code and no stdout
    if (!result.stdout && result.exitCode !== 0) {
      return {
        output: result.stderr || 'Claude CLI exited with no output',
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

    // Parse JSON response
    let parsed: ClaudeResponse;
    try {
      parsed = ClaudeResponseSchema.parse(JSON.parse(result.stdout));
    } catch (error: unknown) {
      return {
        output: result.stdout || 'Failed to parse Claude response',
        filesModified: [],
        status: 'error',
        metadata: {
          rawEvents: [
            {
              parseError:
                error instanceof Error ? error.message : 'JSON parse error',
              rawStdout: result.stdout,
            },
          ],
        },
      };
    }

    const filesModified = extractFilePaths(parsed.result);

    return {
      output: parsed.result,
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
    const jsonSchema = JSON.stringify(z.toJSONSchema(schema));

    const args = [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
      '--json-schema',
      jsonSchema,
      // --bare prevents user config (hooks, CLAUDE.md, output styles) from
      // interfering with structured JSON output.
      '--bare',
      '--max-turns',
      String(options?.maxTurns ?? 1),
    ];

    const timeout = options?.timeout ?? 300_000;

    const result = await execa('claude', args, {
      cwd: options?.workingDirectory,
      timeout,
      reject: false,
    });

    if (!result.stdout) {
      throw new Error(
        `Claude CLI returned no output (exit code ${result.exitCode}): ${result.stderr}`,
      );
    }

    let parsed: ClaudeResponse;
    try {
      parsed = ClaudeResponseSchema.parse(JSON.parse(result.stdout));
    } catch {
      throw new Error(`Failed to parse Claude response: ${result.stdout}`);
    }

    if (parsed.is_error) {
      throw new Error(`Claude returned an error: ${parsed.result}`);
    }

    // Prefer structured_output (populated when --json-schema is supported).
    // Fall back to parsing the result string as JSON — some CLI versions or
    // unsupported schema features may put the output there instead.
    let output: unknown = parsed.structured_output;
    if (output === undefined || output === null) {
      if (!parsed.result) {
        throw new Error('Claude returned neither structured_output nor a result string');
      }
      try {
        output = JSON.parse(parsed.result);
      } catch {
        throw new Error(
          `Claude returned no structured_output and result is not valid JSON: ${parsed.result.slice(0, 200)}`,
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
