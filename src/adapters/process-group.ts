import { logger } from '../utils/logger.js';

type ExecaSubprocess = {
  readonly pid?: number;
  once?(event: 'exit', listener: () => void): unknown;
  off?(event: 'exit', listener: () => void): unknown;
  removeListener?(event: 'exit', listener: () => void): unknown;
};

type ProcessGroupSignalResult = 'sent' | 'gone' | 'failed';

const DEFAULT_PROCESS_GROUP_FORCE_KILL_AFTER_MS = 5_000;
const pendingProcessGroupTerminations = new Set<Promise<void>>();

export function processGroupSpawnOptions(): { detached?: true } {
  return process.platform === 'win32' ? {} : { detached: true };
}

export function terminateProcessGroupOnAbort(
  subprocess: ExecaSubprocess,
  signal?: AbortSignal,
): () => void {
  if (process.platform === 'win32' || !signal) return () => undefined;

  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  let terminationPromise: Promise<void> | undefined;
  let resolveTermination: (() => void) | undefined;
  let abortListenerInstalled = false;
  let exitListenerInstalled = false;
  let terminationStarted = false;
  let childExited = false;

  const clearForceKillTimer = (): void => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = undefined;
    }
  };

  const removeExitListener = (): void => {
    if (!exitListenerInstalled) return;
    exitListenerInstalled = false;
    if (subprocess.off) {
      subprocess.off('exit', onExit);
    } else {
      subprocess.removeListener?.('exit', onExit);
    }
  };

  const removeAbortListener = (): void => {
    if (!abortListenerInstalled) return;
    abortListenerInstalled = false;
    signal.removeEventListener('abort', terminate);
  };

  const dispose = (): void => {
    removeAbortListener();
    removeExitListener();
    if (!terminationStarted || childExited || isProcessGroupGone(subprocess.pid)) {
      childExited = true;
      clearForceKillTimer();
      resolveTermination?.();
    }
  };

  function onExit(): void {
    childExited = true;
    clearForceKillTimer();
    resolveTermination?.();
    dispose();
  }

  const trackTermination = (): void => {
    if (terminationPromise !== undefined) return;
    terminationPromise = new Promise<void>((resolve) => {
      resolveTermination = resolve;
    }).finally(() => {
      if (terminationPromise !== undefined) {
        pendingProcessGroupTerminations.delete(terminationPromise);
      }
    });
    pendingProcessGroupTerminations.add(terminationPromise);
  };

  const armForceKill = (pid: number): void => {
    if (forceKillTimer) return;
    forceKillTimer = setTimeout(() => {
      forceKillTimer = undefined;
      if (childExited) return;
      const result = sendProcessGroupSignal(pid, 'SIGKILL');
      if (result === 'gone' || result === 'failed') {
        childExited = true;
        resolveTermination?.();
      }
    }, resolveProcessGroupForceKillAfterMs());
    forceKillTimer.unref?.();
  };

  const terminate = (): void => {
    terminationStarted = true;
    trackTermination();
    const pid = subprocess.pid;
    if (typeof pid !== 'number') {
      childExited = true;
      resolveTermination?.();
      return;
    }
    const result = sendProcessGroupSignal(pid, 'SIGTERM');
    if (result === 'sent') armForceKill(pid);
    if (result === 'gone' || result === 'failed') {
      childExited = true;
      resolveTermination?.();
    }
  };

  if (subprocess.once) {
    subprocess.once('exit', onExit);
    exitListenerInstalled = true;
  }

  if (signal.aborted) {
    terminate();
    return dispose;
  }

  signal.addEventListener('abort', terminate, { once: true });
  abortListenerInstalled = true;
  return dispose;
}

function sendProcessGroupSignal(
  pid: number,
  signal: NodeJS.Signals,
): ProcessGroupSignalResult {
  try {
    process.kill(-pid, signal);
    return 'sent';
  } catch (err) {
    const code = typeof err === 'object' && err && 'code' in err ? err.code : undefined;
    if (code === 'ESRCH') return 'gone';
    logger.warn(
      `failed to ${signal === 'SIGKILL' ? 'force-kill' : 'terminate'} adapter process group ${pid}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 'failed';
  }
}

function isProcessGroupGone(pid: number | undefined): boolean {
  if (typeof pid !== 'number') return true;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (err) {
    const code = typeof err === 'object' && err && 'code' in err ? err.code : undefined;
    return code === 'ESRCH';
  }
}

export async function drainProcessGroupTerminations(options: {
  readonly maxWaitMs: number;
}): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, options.maxWaitMs);
  while (pendingProcessGroupTerminations.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const snapshot = Array.from(pendingProcessGroupTerminations);
    const result = await waitForTerminationsOrTimeout(snapshot, remaining);
    if (result === 'timeout') return pendingProcessGroupTerminations.size === 0;
  }
  return true;
}

async function waitForTerminationsOrTimeout(
  terminations: Array<Promise<void>>,
  timeoutMs: number,
): Promise<'settled' | 'timeout'> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => resolve('timeout'), timeoutMs);
      timeout.unref?.();
    });
    const settled = Promise.allSettled(terminations).then(() => 'settled' as const);
    return await Promise.race([settled, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function resolveProcessGroupForceKillAfterMs(): number {
  const raw = process.env.CREW_PROCESS_GROUP_FORCE_KILL_AFTER_MS;
  if (raw === undefined) return DEFAULT_PROCESS_GROUP_FORCE_KILL_AFTER_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_PROCESS_GROUP_FORCE_KILL_AFTER_MS;
  }
  return Math.floor(parsed);
}
