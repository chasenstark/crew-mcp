import { spawn, type ChildProcess } from 'node:child_process';

import {
  codexPrWatchWakePrompt,
  codexWakePrompt,
  type WakeCodexPrWatchThreadOptions,
  validateCodexThreadId,
} from './app-server-bridge.js';
import { withoutCodexCaptainEnvironment } from './environment.js';

const DEFAULT_QUEUE_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_CHARS = 8_000;

export interface QueueCodexThreadOptions {
  readonly threadId: string;
  readonly runIds: readonly string[];
  readonly wakeKind?: 'terminal' | 'check_in';
  readonly codexBinary?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly spawnProcess?: typeof spawn;
}

export interface QueueCodexThreadResult {
  readonly queued: true;
}

export interface QueueCodexPrWatchThreadOptions {
  readonly threadId: string;
  readonly watchId: string;
  readonly generation: number;
  readonly status: WakeCodexPrWatchThreadOptions['status'];
  readonly actionBatchId?: string;
  readonly codexBinary?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly spawnProcess?: typeof spawn;
}

export class CodexQueueWakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexQueueWakeError';
  }
}

/**
 * Enqueue Crew's synthetic completion prompt through Codex's durable thread
 * queue. A loaded App Server observes external queue writes and starts the
 * queued turn when the thread is idle, so this works without Crew owning the
 * host's App Server transport.
 */
export async function queueCodexThread(
  options: QueueCodexThreadOptions,
): Promise<QueueCodexThreadResult> {
  validateCodexThreadId(options.threadId);
  validateRunIds(options.runIds);
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CodexQueueWakeError('Codex queue timeout must be positive');
  }

  return queueCodexPrompt(
    options,
    codexWakePrompt(options.runIds, options.wakeKind),
  );
}

export async function queueCodexPrWatchThread(
  options: QueueCodexPrWatchThreadOptions,
): Promise<QueueCodexThreadResult> {
  validateCodexThreadId(options.threadId);
  if (!/^pw-[0-9a-f]{32}$/.test(options.watchId)) {
    throw new CodexQueueWakeError('Codex queue wake requires a valid PR-watch id');
  }
  if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
    throw new CodexQueueWakeError('Codex queue wake requires a valid PR-watch generation');
  }
  return queueCodexPrompt(options, codexPrWatchWakePrompt(options));
}

async function queueCodexPrompt(
  options: Pick<QueueCodexThreadOptions, 'threadId' | 'codexBinary' | 'env' | 'timeoutMs' | 'spawnProcess'>,
  prompt: string,
): Promise<QueueCodexThreadResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CodexQueueWakeError('Codex queue timeout must be positive');
  }
  const child = (options.spawnProcess ?? spawn)(
    options.codexBinary ?? 'codex',
    [
      'queue',
      '--thread',
      options.threadId,
      '--message',
      prompt,
    ],
    {
      env: withoutCodexCaptainEnvironment(options.env ?? process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const output = captureOutputTail(child);
  const exitCode = await waitForExit(child, timeoutMs);
  if (exitCode !== 0) {
    const detail = output().trim();
    throw new CodexQueueWakeError(
      `codex queue exited with code ${exitCode}${detail ? `: ${detail}` : ''}`,
    );
  }
  return { queued: true };
}

function validateRunIds(runIds: readonly string[]): void {
  if (
    runIds.length === 0
    || runIds.some((runId) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId))
  ) {
    throw new CodexQueueWakeError('Codex queue wake requires valid run ids');
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  if (child.signalCode !== null) return Promise.resolve(1);
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new CodexQueueWakeError(`codex queue timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    child.once('error', (error) => finish(() => reject(
      new CodexQueueWakeError(`failed to start codex queue: ${error.message}`),
    )));
    child.once('exit', (code) => finish(() => resolve(code ?? 1)));
  });
}

function captureOutputTail(child: ChildProcess): () => string {
  let output = '';
  const append = (chunk: unknown): void => {
    output += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
    if (output.length > MAX_OUTPUT_CHARS) output = output.slice(-MAX_OUTPUT_CHARS);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return () => output;
}
