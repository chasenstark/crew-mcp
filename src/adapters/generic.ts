import { execa } from 'execa';
import type {
  AgentAdapter,
  AgentStrength,
  HealthCheckResult,
  Task,
  TaskResult,
} from './types.js';
import { logger } from '../utils/logger.js';
import {
  processGroupSpawnOptions,
  terminateProcessGroupOnAbort,
} from './process-group.js';
import { argvPromptTooLargeResult } from './prompt-transport.js';
import { classifyTextFailure } from './failure-classifier.js';
import { boundFailureText } from './failure-output.js';
import { codexSafeSpawnEnvironment } from '../codex/environment.js';

const PROMPT_VALUE_FLAGS = new Set(['--prompt']);

function preview(text: string | undefined, max = 600): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}...`;
}

function renderFailureOutput(
  command: string,
  exitCode: number | undefined,
  stdout: string,
  stderr: string,
): string {
  let output: string;
  if (stderr && stdout) {
    output = `${stderr}\n\n${stdout}`;
  } else if (stderr) {
    output = stderr;
  } else if (stdout) {
    output = stdout;
  } else {
    output = `${command} exited with code ${exitCode ?? 'unknown'}`;
  }
  return boundFailureText(output);
}

export interface GenericAdapterOptions {
  name: string;
  command: string;
  argsTemplate: string[];
  strengths: AgentStrength[];
  useWhen?: string;
}

/**
 * GenericAdapter wraps an arbitrary CLI tool as an agent. It intentionally
 * does not advertise JSON-schema support: generic CLI tools have no universal
 * mechanism for structured output enforcement because each tool's flags and
 * output guarantees differ. Callers should treat generic agents as
 * unstructured workers.
 *
 * Reliability limitations:
 *   - Depends on the underlying tool being able to produce well-formed JSON
 *     given instructions in the prompt.
 *   - Tools that prepend prose, wrap JSON in markdown fences, or truncate
 *     output will fail validation and trigger retries.
 *   - For captain steps (decompose/ingest/etc.), agents backed by a
 *     GenericAdapter are best used for non-structured work; prefer Codex or
 *     Claude Code for the captain role itself.
 */
export class GenericAdapter implements AgentAdapter {
  readonly name: string;
  readonly strengths: AgentStrength[];
  readonly useWhen?: string;
  readonly supportsJsonSchema = false;
  readonly enforcesReadOnly = false;
  readonly unmetered = true;
  // Arbitrary CLI commands have no uniform terminal file-change reporting.
  readonly filesModifiedReliable = false;
  readonly captainCapabilities = {
    supportsStructuredDecisions: true,
    supportsPauseForUserInput: false,
  };

  private readonly command: string;
  private readonly argsTemplate: string[];

  constructor(options: GenericAdapterOptions) {
    this.name = options.name;
    this.command = options.command;
    this.argsTemplate = options.argsTemplate;
    this.strengths = options.strengths;
    this.useWhen = options.useWhen;
  }

  /**
   * Builds the argument list by replacing `{{prompt}}` placeholders.
   *
   * Leading-dash prompts are only neutralized when the prompt occupies its
   * own argv element. For positional prompt templates (`{{prompt}}`, or no
   * placeholder so Crew appends it), Crew inserts `--` before the prompt.
   * For long-option value templates (`--prompt {{prompt}}`), Crew rewrites to
   * `--prompt=<prompt>`. Templates that embed `{{prompt}}` inside a larger
   * argument are left intact; authors should use `--flag={{prompt}}` or a
   * standalone `{{prompt}}` if leading-dash prompt safety matters.
   */
  private buildArgs(prompt: string): string[] {
    const promptStartsWithDash = prompt.startsWith('-');
    const hasPlaceholder = this.argsTemplate.some((arg) =>
      arg.includes('{{prompt}}'),
    );

    if (hasPlaceholder) {
      const args: string[] = [];
      for (let i = 0; i < this.argsTemplate.length; i++) {
        const arg = this.argsTemplate[i];
        if (arg === '{{prompt}}') {
          const previous = args.at(-1);
          if (
            promptStartsWithDash
            && previous
            && PROMPT_VALUE_FLAGS.has(previous)
          ) {
            args[args.length - 1] = `${previous}=${prompt}`;
          } else {
            if (promptStartsWithDash && previous !== '--') args.push('--');
            args.push(prompt);
          }
          continue;
        }
        args.push(arg.replace('{{prompt}}', prompt));
      }
      return args;
    }

    return [
      ...this.argsTemplate,
      ...(promptStartsWithDash && this.argsTemplate.at(-1) !== '--' ? ['--'] : []),
      prompt,
    ];
  }

  async execute(task: Task): Promise<TaskResult> {
    const promptTooLarge = argvPromptTooLargeResult(this.name, task.prompt);
    if (promptTooLarge) return promptTooLarge;

    const args = this.buildArgs(task.prompt);
    // No wall-clock timeout. Generic adapters target arbitrary CLIs
    // whose runtime varies wildly; a hardcoded 5m cap killed long runs
    // unfairly. Cancellation comes through cancelSignal.
    const timeout = task.constraints?.timeout;
    logger.debug(`[adapter:${this.name}] starting execute`, {
      command: this.command,
      args,
      cwd: task.context.workingDirectory,
      timeoutMs: timeout,
      promptChars: task.prompt.length,
    });

    let result;
    try {
      const subprocess = execa(this.command, args, {
        ...codexSafeSpawnEnvironment(),
        cwd: task.context.workingDirectory,
        ...(timeout ? { timeout } : {}),
        ...processGroupSpawnOptions(),
        cancelSignal: task.constraints?.signal,
        reject: false,
      });
      const disposeProcessGroupAbort = terminateProcessGroupOnAbort(
        subprocess,
        task.constraints?.signal,
      );
      if (task.onOutput && subprocess.stdout) {
        subprocess.stdout.on('data', (buf: Buffer) => {
          try {
            task.onOutput!(buf.toString('utf-8'));
          } catch (err) {
            logger.warn(
              `[adapter:${this.name}] onOutput listener failed: ${
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
        failure: classifyTextFailure(message, { defaultKind: 'process' }),
        metadata: {
          rawEvents: [{ error: message }],
        },
      };
    }

    const stdoutText = result.stdout ?? '';
    const stderrText = result.stderr ?? '';
    logger.debug(`[adapter:${this.name}] execute finished`, {
      exitCode: result.exitCode,
      stdoutChars: stdoutText.length,
      stderrChars: stderrText.length,
    });

    if (result.exitCode !== 0) {
      logger.error(`[adapter:${this.name}] command failed`, {
        command: this.command,
        args,
        exitCode: result.exitCode,
        stdoutPreview: preview(stdoutText),
        stderrPreview: preview(stderrText),
      });
      const failureOutput = renderFailureOutput(
        this.command,
        result.exitCode,
        stdoutText,
        stderrText,
      );
      return {
        output: failureOutput,
        filesModified: [],
        status: 'error',
        failure: classifyTextFailure(failureOutput, {
          defaultKind: 'process',
          providerCode: result.exitCode !== undefined ? String(result.exitCode) : undefined,
        }),
        metadata: {
          rawEvents: [
            {
              exitCode: result.exitCode,
              stdout: stdoutText,
              stderr: stderrText,
            },
          ],
        },
      };
    }

    return {
      output: stdoutText,
      filesModified: [],
      status: 'success',
      metadata: {},
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const result = await execa(cmd, [this.command], {
        ...codexSafeSpawnEnvironment(),
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
