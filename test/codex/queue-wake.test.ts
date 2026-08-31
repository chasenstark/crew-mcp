import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  CODEX_BRIDGE_FILE_ENV,
  CODEX_THREAD_ID_ENV,
  codexWakePrompt,
} from '../../src/codex/app-server-bridge.js';
import { CODEX_REMOTE_TOKEN_ENV } from '../../src/codex/environment.js';
import {
  CodexQueueWakeError,
  queueCodexThread,
} from '../../src/codex/queue-wake.js';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signalCode = signal;
    return true;
  }

  finish(code: number): void {
    this.exitCode = code;
    queueMicrotask(() => this.emit('exit', code, null));
  }
}

describe('queueCodexThread', () => {
  const threadId = '019f5d0f-a60c-7d53-9f35-2036d92d71ec';

  it('queues the Crew completion prompt and strips captain capabilities', async () => {
    const child = new FakeChild();
    const calls: Array<{
      command: string;
      args: readonly string[];
      options: { env?: NodeJS.ProcessEnv; stdio?: unknown };
    }> = [];
    const spawnProcess = ((command: string, args: readonly string[], options: {
      env?: NodeJS.ProcessEnv;
      stdio?: unknown;
    }) => {
      calls.push({ command, args, options });
      queueMicrotask(() => child.finish(0));
      return child;
    }) as unknown as typeof spawn;

    await expect(queueCodexThread({
      threadId,
      runIds: ['run-a', 'run-b'],
      codexBinary: '/opt/bin/codex',
      spawnProcess,
      env: {
        PATH: '/opt/bin',
        [CODEX_THREAD_ID_ENV]: threadId,
        [CODEX_BRIDGE_FILE_ENV]: '/tmp/bridge.json',
        [CODEX_REMOTE_TOKEN_ENV]: 'secret',
      },
    })).resolves.toEqual({ queued: true });

    expect(calls).toEqual([{
      command: '/opt/bin/codex',
      args: [
        'queue',
        '--thread',
        threadId,
        '--message',
        codexWakePrompt(['run-a', 'run-b']),
      ],
      options: {
        env: { PATH: '/opt/bin' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    }]);
  });

  it('surfaces bounded command output on failure', async () => {
    const child = new FakeChild();
    const spawnProcess = (() => {
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('unknown thread'));
        child.finish(7);
      });
      return child;
    }) as unknown as typeof spawn;

    await expect(queueCodexThread({
      threadId,
      runIds: ['run-a'],
      spawnProcess,
    })).rejects.toThrow('codex queue exited with code 7: unknown thread');
  });

  it('queues a periodic check-in prompt that requires status reporting and re-arm', async () => {
    const child = new FakeChild();
    const calls: Array<{ args: readonly string[] }> = [];
    const spawnProcess = ((_command: string, args: readonly string[]) => {
      calls.push({ args });
      queueMicrotask(() => child.finish(0));
      return child;
    }) as unknown as typeof spawn;

    await queueCodexThread({
      threadId,
      runIds: ['run-check-in'],
      wakeKind: 'check_in',
      spawnProcess,
    });

    const prompt = calls[0].args.at(-1);
    expect(prompt).toContain('periodic check-in event');
    expect(prompt).toContain('report a concise status update to the user now');
    expect(prompt).toContain('launch the returned required_next_action');
    expect(prompt).toContain('Do not start review until the implementer is terminal');
  });

  it('terminates a queue command that does not exit', async () => {
    const child = new FakeChild();
    const spawnProcess = (() => child) as unknown as typeof spawn;

    await expect(queueCodexThread({
      threadId,
      runIds: ['run-a'],
      spawnProcess,
      timeoutMs: 5,
    })).rejects.toThrow('codex queue timed out after 5ms');
    expect(child.signalCode).toBe('SIGTERM');
  });

  it('rejects invalid thread and run ids before spawning', async () => {
    await expect(queueCodexThread({
      threadId: 'not-a-thread',
      runIds: ['run-a'],
    })).rejects.toThrow('CODEX_THREAD_ID is missing or invalid');
    await expect(queueCodexThread({
      threadId,
      runIds: ['contains spaces'],
    })).rejects.toBeInstanceOf(CodexQueueWakeError);
  });
});
