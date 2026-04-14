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
 * Represents a single event line in the Codex JSONL output.
 */
interface CodexEvent {
  type: string;
  thread_id?: string;
  turn_id?: string;
  content?: string;
  command?: string;
  exit_code?: number;
  path?: string;
  action?: string;
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

/**
 * Parses newline-delimited JSON (JSONL) into an array of events.
 * Malformed lines are logged at warn level and counted.
 */
function parseJsonl(text: string): ParseJsonlResult {
  const events: CodexEvent[] = [];
  const lines = text.split('\n');
  let droppedLines = 0;
  let nonEmptyLineCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    nonEmptyLineCount++;
    try {
      events.push(JSON.parse(trimmed) as CodexEvent);
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
 * Extracts file paths that were changed from Codex events.
 */
function extractFileChanges(events: CodexEvent[]): string[] {
  const files: string[] = [];
  for (const event of events) {
    if (
      event.type === 'item.file_change' &&
      event.path &&
      event.action !== 'none'
    ) {
      files.push(event.path);
    }
  }
  return files;
}

/**
 * Gets the final agent message from events.
 */
function getLastAgentMessage(events: CodexEvent[]): string {
  let lastMessage = '';
  for (const event of events) {
    if (event.type === 'item.agent_message' && event.content) {
      lastMessage = event.content;
    }
  }
  return lastMessage;
}

/**
 * Checks if the events contain an error.
 */
function findError(events: CodexEvent[]): string | undefined {
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

export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex';
  readonly capabilities: AgentCapability[] = [
    'implement',
    'review',
    'refactor',
    'test',
    'analyze',
  ];
  readonly supportsJsonSchema = true;

  async execute(task: Task): Promise<TaskResult> {
    const tmpDir = mkdtempSync(join(tmpdir(), 'codex-'));
    try {
      const outputFile = join(tmpDir, 'output.json');

      const args = ['exec', task.prompt, '--json', '-o', outputFile];

      const timeout = task.constraints?.timeout ?? 300_000;

      let result;
      try {
        result = await execa('codex', args, {
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

      // Parse JSONL from stdout
      const { events, droppedLines } = result.stdout
        ? parseJsonl(result.stdout)
        : { events: [], droppedLines: 0 };

      // If stdout was non-empty but every line failed to parse, treat as error
      if (result.stdout && events.length === 0) {
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
        }
      }
      if (!output) {
        output = getLastAgentMessage(events);
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
        '--output-schema',
        schemaFile,
        '-o',
        outputFile,
      ];

      const timeout = options?.timeout ?? 300_000;

      const result = await execa('codex', args, {
        cwd: options?.workingDirectory,
        timeout,
        reject: false,
      });

      // Check for errors in JSONL output
      if (result.stdout) {
        const { events } = parseJsonl(result.stdout);
        const errorMessage = findError(events);
        if (errorMessage) {
          throw new Error(`Codex returned an error: ${errorMessage}`);
        }
      }

      // Read structured output from the output file
      if (!existsSync(outputFile)) {
        throw new Error(
          `Codex did not produce output file (exit code ${result.exitCode}): ${result.stderr}`,
        );
      }

      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(outputFile, 'utf-8'));
      } catch {
        throw new Error(`Failed to parse Codex output file: ${outputFile}`);
      }

      return schema.parse(raw) as z.infer<T>;
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const result = await execa('codex', ['--help'], {
        timeout: 10_000,
        reject: false,
      });

      if (result.exitCode === 0) {
        // Try to extract version from help output
        const versionMatch = result.stdout?.match(/v?(\d+\.\d+\.\d+)/);
        return {
          available: true,
          version: versionMatch ? versionMatch[1] : undefined,
          authenticated: true, // Assumed: Codex CLI does not expose an auth-verification command; true means "not known to be unauthenticated"
        };
      }

      return {
        available: false,
        authenticated: false,
        error: result.stderr || 'codex --help failed',
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
