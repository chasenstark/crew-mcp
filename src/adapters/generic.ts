import { execa } from 'execa';
import type {
  AgentAdapter,
  AgentCapability,
  HealthCheckResult,
  Task,
  TaskResult,
} from './types.js';
import { logger } from '../utils/logger.js';

function preview(text: string | undefined, max = 600): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}...`;
}

export interface GenericAdapterOptions {
  name: string;
  command: string;
  argsTemplate: string[];
  capabilities: AgentCapability[];
}

export class GenericAdapter implements AgentAdapter {
  readonly name: string;
  readonly capabilities: AgentCapability[];
  readonly supportsJsonSchema = false;

  private readonly command: string;
  private readonly argsTemplate: string[];

  constructor(options: GenericAdapterOptions) {
    this.name = options.name;
    this.command = options.command;
    this.argsTemplate = options.argsTemplate;
    this.capabilities = options.capabilities;
  }

  /**
   * Builds the argument list by replacing `{{prompt}}` placeholders in the
   * template. If no placeholder is found, the prompt is appended as the
   * last argument.
   */
  private buildArgs(prompt: string): string[] {
    const hasPlaceholder = this.argsTemplate.some((arg) =>
      arg.includes('{{prompt}}'),
    );

    if (hasPlaceholder) {
      return this.argsTemplate.map((arg) =>
        arg.replace('{{prompt}}', prompt),
      );
    }

    return [...this.argsTemplate, prompt];
  }

  async execute(task: Task): Promise<TaskResult> {
    const args = this.buildArgs(task.prompt);
    const timeout = task.constraints?.timeout ?? 300_000;
    logger.debug(`[adapter:${this.name}] starting execute`, {
      command: this.command,
      args,
      cwd: task.context.workingDirectory,
      timeoutMs: timeout,
      promptChars: task.prompt.length,
    });

    let result;
    try {
      result = await execa(this.command, args, {
        cwd: task.context.workingDirectory,
        timeout,
        signal: task.constraints?.signal,
        reject: false,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Unknown execution error';
      logger.error(`[adapter:${this.name}] process execution threw`, {
        command: this.command,
        args,
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

    logger.debug(`[adapter:${this.name}] execute finished`, {
      exitCode: result.exitCode,
      stdoutChars: result.stdout.length,
      stderrChars: result.stderr.length,
    });

    if (result.exitCode !== 0 && !result.stdout) {
      logger.error(`[adapter:${this.name}] command failed with no stdout`, {
        command: this.command,
        args,
        exitCode: result.exitCode,
        stderrPreview: preview(result.stderr),
      });
      return {
        output: result.stderr || `${this.command} exited with code ${result.exitCode}`,
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

    return {
      output: result.stdout || '',
      filesModified: [],
      status: result.exitCode === 0 ? 'success' : 'partial',
      metadata: {},
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const result = await execa(cmd, [this.command], {
        timeout: 5_000,
        reject: false,
      });

      if (result.exitCode === 0 && result.stdout) {
        return {
          available: true,
          authenticated: true, // Generic adapters don't have auth
        };
      }

      return {
        available: false,
        authenticated: false,
        error: `${this.command} not found in PATH`,
      };
    } catch {
      return {
        available: false,
        authenticated: false,
        error: `Failed to locate ${this.command}`,
      };
    }
  }
}
