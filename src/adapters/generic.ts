import { execa } from 'execa';
import type {
  AgentAdapter,
  AgentCapability,
  HealthCheckResult,
  Task,
  TaskResult,
} from './types.js';

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

    let result;
    try {
      result = await execa(this.command, args, {
        cwd: task.context.workingDirectory,
        timeout,
        reject: false,
      });
    } catch (error: unknown) {
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

    if (result.exitCode !== 0 && !result.stdout) {
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
