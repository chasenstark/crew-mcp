import { logger } from '../utils/logger.js';

type ExecaSubprocess = {
  readonly pid?: number;
  once?(event: 'exit', listener: () => void): unknown;
  off?(event: 'exit', listener: () => void): unknown;
  removeListener?(event: 'exit', listener: () => void): unknown;
};

type ProcessGroupSignalResult = 'sent' | 'gone' | 'failed';

const DEFAULT_PROCESS_GROUP_FORCE_KILL_AFTER_MS = 5_000;

export function processGroupSpawnOptions(): { detached?: true } {
  return process.platform === 'win32' ? {} : { detached: true };
}

export function terminateProcessGroupOnAbort(
  subprocess: ExecaSubprocess,
  signal?: AbortSignal,
): () => void {
  if (process.platform === 'win32' || !signal) return () => undefined;

  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
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
    if (!terminationStarted) clearForceKillTimer();
  };

  function onExit(): void {
    childExited = true;
    clearForceKillTimer();
    dispose();
  }

  const armForceKill = (pid: number): void => {
    if (forceKillTimer) return;
    forceKillTimer = setTimeout(() => {
      forceKillTimer = undefined;
      if (childExited) return;
      sendProcessGroupSignal(pid, 'SIGKILL');
    }, resolveProcessGroupForceKillAfterMs());
    forceKillTimer.unref?.();
  };

  const terminate = (): void => {
    terminationStarted = true;
    const pid = subprocess.pid;
    if (typeof pid !== 'number') return;
    const result = sendProcessGroupSignal(pid, 'SIGTERM');
    if (result === 'sent') armForceKill(pid);
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

function resolveProcessGroupForceKillAfterMs(): number {
  const raw = process.env.CREW_PROCESS_GROUP_FORCE_KILL_AFTER_MS;
  if (raw === undefined) return DEFAULT_PROCESS_GROUP_FORCE_KILL_AFTER_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_PROCESS_GROUP_FORCE_KILL_AFTER_MS;
  }
  return Math.floor(parsed);
}
