import { spawn, type ChildProcess } from 'node:child_process';

const DEFAULT_PROVIDER_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface ProviderCommandSpec {
  readonly binary: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

export interface ProviderCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface ProviderCommandRunner {
  run(
    spec: ProviderCommandSpec,
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<ProviderCommandResult>;
}

export class ProviderCommandError extends Error {
  constructor(
    readonly code: 'timeout' | 'cancelled' | 'spawn_failed' | 'output_too_large' | 'nonzero_exit',
    message: string,
    readonly result?: ProviderCommandResult,
  ) {
    super(`pr_watch.provider_${code}: ${message}`);
    this.name = 'ProviderCommandError';
  }
}

export class SubprocessProviderCommandRunner implements ProviderCommandRunner {
  async run(
    spec: ProviderCommandSpec,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): Promise<ProviderCommandResult> {
    if (options.signal?.aborted) throw new ProviderCommandError('cancelled', 'request aborted');
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      throw new Error('pr_watch.invalid_provider_timeout');
    }
    const child = spawn(spec.binary, [...spec.args], {
      env: spec.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    return collect(child, timeoutMs, options.signal);
  }
}

async function collect(
  child: ChildProcess,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProviderCommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let forcedKill: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (forcedKill) clearTimeout(forcedKill);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const terminate = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      forcedKill = setTimeout(() => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, 1000);
      forcedKill.unref?.();
    };
    const rejectBound = (code: 'timeout' | 'cancelled', message: string): void => {
      if (settled) return;
      terminate();
      settle(() => reject(new ProviderCommandError(code, message)));
    };
    const onAbort = (): void => rejectBound('cancelled', 'request aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => rejectBound('timeout', `exceeded ${timeoutMs}ms`), timeoutMs);
    timeout.unref?.();

    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (settled) return;
      if (target === 'stdout') stdout = Buffer.concat([stdout, chunk]);
      else stderr = Buffer.concat([stderr, chunk]);
      if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
        terminate();
        settle(() => reject(new ProviderCommandError('output_too_large', 'provider output exceeded 4 MiB')));
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.once('error', (error) => settle(() => reject(
      new ProviderCommandError('spawn_failed', error.message),
    )));
    child.once('exit', (exitCode) => settle(() => {
      const result: ProviderCommandResult = {
        stdout: stdout.toString('utf-8'),
        stderr: stderr.toString('utf-8'),
        exitCode: exitCode ?? 1,
      };
      if (result.exitCode !== 0) {
        reject(new ProviderCommandError('nonzero_exit', `exited ${result.exitCode}`, result));
      } else {
        resolve(result);
      }
    }));
  });
}
