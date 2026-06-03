import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { terminateProcessGroupOnAbort } from '../../src/adapters/process-group.js';

describe('terminateProcessGroupOnAbort', () => {
  const originalForceKillAfter = process.env.CREW_PROCESS_GROUP_FORCE_KILL_AFTER_MS;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (originalForceKillAfter === undefined) {
      delete process.env.CREW_PROCESS_GROUP_FORCE_KILL_AFTER_MS;
    } else {
      process.env.CREW_PROCESS_GROUP_FORCE_KILL_AFTER_MS = originalForceKillAfter;
    }
  });

  it('escalates cancellation to SIGKILL for the child process group', async () => {
    if (process.platform === 'win32') return;
    vi.useFakeTimers();
    process.env.CREW_PROCESS_GROUP_FORCE_KILL_AFTER_MS = '25';
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const controller = new AbortController();

    terminateProcessGroupOnAbort({ pid: 12345 }, controller.signal);
    controller.abort('test cancellation');

    expect(kill).toHaveBeenCalledWith(-12345, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(25);
    expect(kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
    expect(kill).not.toHaveBeenCalledWith(0, expect.anything());
  });

  it('treats ESRCH as success for SIGTERM and SIGKILL', async () => {
    if (process.platform === 'win32') return;
    vi.useFakeTimers();
    process.env.CREW_PROCESS_GROUP_FORCE_KILL_AFTER_MS = '25';
    const kill = vi
      .spyOn(process, 'kill')
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      })
      .mockImplementationOnce(() => true)
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      });
    const goneOnTerm = new AbortController();

    terminateProcessGroupOnAbort({ pid: 12345 }, goneOnTerm.signal);
    goneOnTerm.abort('test cancellation');
    await vi.advanceTimersByTimeAsync(25);

    const goneOnKill = new AbortController();
    terminateProcessGroupOnAbort({ pid: 67890 }, goneOnKill.signal);
    goneOnKill.abort('test cancellation');
    await vi.advanceTimersByTimeAsync(25);

    expect(kill.mock.calls).toEqual([
      [-12345, 'SIGTERM'],
      [-67890, 'SIGTERM'],
      [-67890, 'SIGKILL'],
    ]);
  });

  it('does not leave a force-kill timer after normal child exit', async () => {
    if (process.platform === 'win32') return;
    vi.useFakeTimers();
    process.env.CREW_PROCESS_GROUP_FORCE_KILL_AFTER_MS = '25';
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      off(event: 'exit', listener: () => void): EventEmitter;
      once(event: 'exit', listener: () => void): EventEmitter;
    };
    child.pid = 12345;
    const controller = new AbortController();

    terminateProcessGroupOnAbort(child, controller.signal);
    child.emit('exit');
    controller.abort('late cancellation');
    await vi.advanceTimersByTimeAsync(100);

    expect(kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the force-kill timer when a terminated child exits before escalation', async () => {
    if (process.platform === 'win32') return;
    vi.useFakeTimers();
    process.env.CREW_PROCESS_GROUP_FORCE_KILL_AFTER_MS = '25';
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      off(event: 'exit', listener: () => void): EventEmitter;
      once(event: 'exit', listener: () => void): EventEmitter;
    };
    child.pid = 12345;
    const controller = new AbortController();

    terminateProcessGroupOnAbort(child, controller.signal);
    controller.abort('test cancellation');
    expect(kill.mock.calls).toEqual([[-12345, 'SIGTERM']]);
    expect(vi.getTimerCount()).toBe(1);

    child.emit('exit');
    await vi.advanceTimersByTimeAsync(100);

    expect(kill.mock.calls).toEqual([[-12345, 'SIGTERM']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('SIGKILLs a long-lived descendant that ignores SIGTERM', async () => {
    if (process.platform === 'win32') return;
    process.env.CREW_PROCESS_GROUP_FORCE_KILL_AFTER_MS = '100';
    const parentScript = `
      const { spawn } = require('node:child_process');
      const descendant = spawn(process.execPath, [
        '-e',
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
      ], { stdio: 'ignore' });
      process.send({ descendantPid: descendant.pid });
      setInterval(() => {}, 1000);
    `;
    const parent = spawn(process.execPath, ['-e', parentScript], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const controller = new AbortController();
    const dispose = terminateProcessGroupOnAbort(parent, controller.signal);
    let descendantPid: number | undefined;

    try {
      const message = await waitForChildMessage(parent);
      descendantPid = message.descendantPid;
      expect(isProcessAlive(descendantPid)).toBe(true);

      controller.abort('test cancellation');
      await waitForProcessGone(descendantPid, 2_000);
    } finally {
      dispose();
      cleanupProcessGroup(parent.pid, descendantPid);
    }
  });
});

async function waitForChildMessage(
  child: ChildProcess,
): Promise<{ descendantPid: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('child did not report descendant pid'));
    }, 2_000);
    child.once('message', (message) => {
      clearTimeout(timeout);
      if (
        typeof message === 'object' &&
        message !== null &&
        'descendantPid' in message &&
        typeof message.descendantPid === 'number'
      ) {
        resolve({ descendantPid: message.descendantPid });
      } else {
        reject(new Error('child reported invalid descendant pid'));
      }
    });
    child.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error('child exited before reporting descendant pid'));
    });
  });
}

async function waitForProcessGone(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`process ${pid} stayed alive past ${timeoutMs}ms`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = typeof err === 'object' && err && 'code' in err ? err.code : undefined;
    if (code === 'ESRCH') return false;
    throw err;
  }
}

function cleanupProcessGroup(parentPid?: number, descendantPid?: number): void {
  for (const pid of [parentPid, descendantPid]) {
    if (typeof pid !== 'number') continue;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Best-effort cleanup for failed process-group tests.
      }
    }
  }
}
