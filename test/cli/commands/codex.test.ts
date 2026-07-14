import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CODEX_REMOTE_TOKEN_ENV,
  buildCodexAppServerArgs,
  buildCodexTuiArgs,
  codexCommand,
  createCodexBridgeRuntime,
} from '../../../src/cli/commands/codex.js';
import {
  CODEX_BRIDGE_FILE_ENV,
  CODEX_THREAD_ID_ENV,
} from '../../../src/codex/app-server-bridge.js';

class FakeChild extends EventEmitter {
  readonly pid = 123;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();

  constructor(exitCode: number | null) {
    super();
    this.exitCode = exitCode;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signalCode = signal;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }

  finish(code: number): void {
    this.exitCode = code;
    queueMicrotask(() => this.emit('exit', code, null));
  }
}

class SlowExitFakeChild extends FakeChild {
  override kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signalCode = signal;
    setTimeout(() => this.emit('exit', null, signal), 5);
    return true;
  }
}

describe('crew-mcp codex', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const path of cleanup.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('creates private bridge credentials and removes them idempotently', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-codex-command-'));
    cleanup.push(crewHome);
    const runtime = createCodexBridgeRuntime(crewHome, 43123);
    const descriptor = JSON.parse(readFileSync(runtime.bridgeFile, 'utf-8')) as {
      schemaVersion: number;
      url: string;
      tokenFile: string;
    };

    expect(descriptor).toEqual({
      schemaVersion: 1,
      url: 'ws://127.0.0.1:43123',
      tokenFile: runtime.tokenFile,
    });
    expect(readFileSync(runtime.tokenFile, 'utf-8').trim()).toBe(runtime.token);
    if (process.platform !== 'win32') {
      expect(statSync(join(crewHome, 'codex-host')).mode & 0o777).toBe(0o700);
      expect(statSync(runtime.bridgeFile).mode & 0o777).toBe(0o600);
      expect(statSync(runtime.tokenFile).mode & 0o777).toBe(0o600);
    }

    runtime.cleanup();
    runtime.cleanup();
    expect(existsSync(runtime.bridgeFile)).toBe(false);
    expect(existsSync(runtime.tokenFile)).toBe(false);
  });

  it('launches an authenticated App Server and forwards arguments to the remote TUI', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-codex-launch-'));
    cleanup.push(crewHome);
    const server = new FakeChild(null);
    const tui = new FakeChild(0);
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
      return calls.length === 1 ? server : tui;
    }) as unknown as typeof spawn;
    let readyUrl = '';

    const code = await codexCommand({
      args: ['--no-alt-screen', '-C', '/tmp/project'],
      crewHome,
      codexBinary: '/opt/bin/codex',
      env: {
        PATH: '/opt/bin',
        [CODEX_BRIDGE_FILE_ENV]: '/tmp/stale-bridge.json',
        [CODEX_REMOTE_TOKEN_ENV]: 'stale-token',
        [CODEX_THREAD_ID_ENV]: 'stale-thread',
      },
      reservePort: async () => 43123,
      spawnProcess,
      waitForReady: async (url) => { readyUrl = url; },
    });

    expect(code).toBe(0);
    expect(readyUrl).toBe('ws://127.0.0.1:43123');
    expect(calls).toHaveLength(2);
    expect(calls[0].command).toBe('/opt/bin/codex');
    expect(calls[0].args).toEqual([
      'app-server', '-c', expect.stringMatching(
        /^mcp_servers\.crew\.env\.CREW_CODEX_BRIDGE_FILE=".*\.json"$/,
      ), '--listen', 'ws://127.0.0.1:43123',
      '--ws-auth', 'capability-token', '--ws-token-file', expect.any(String),
    ]);
    expect(calls[0].options.env?.[CODEX_BRIDGE_FILE_ENV]).toBeUndefined();
    expect(calls[0].options.env?.[CODEX_REMOTE_TOKEN_ENV]).toBeUndefined();
    expect(calls[0].options.env?.[CODEX_THREAD_ID_ENV]).toBeUndefined();
    expect(calls[0].options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(calls[1].args).toEqual([
      '--remote', 'ws://127.0.0.1:43123',
      '--remote-auth-token-env', CODEX_REMOTE_TOKEN_ENV,
      '--no-alt-screen', '-C', '/tmp/project',
    ]);
    expect(calls[1].options.env?.[CODEX_REMOTE_TOKEN_ENV]).toEqual(expect.any(String));
    expect(calls[1].options.env?.[CODEX_BRIDGE_FILE_ENV]).toBeUndefined();
    expect(calls[1].options.env?.[CODEX_THREAD_ID_ENV]).toBeUndefined();
    expect(calls[1].options.stdio).toBe('inherit');
    expect(server.signalCode).toBe('SIGTERM');
    expect(existsSync(join(crewHome, 'codex-host'))).toBe(false);
  });

  it('terminates the TUI and cleans credentials when App Server crashes', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-codex-server-crash-'));
    cleanup.push(crewHome);
    const server = new FakeChild(null);
    const tui = new FakeChild(null);
    let calls = 0;
    const spawnProcess = ((_command: string, _args: readonly string[]) => {
      calls += 1;
      if (calls === 2) {
        queueMicrotask(() => {
          server.stderr.emit('data', Buffer.from('server exploded'));
          server.finish(7);
        });
      }
      return calls === 1 ? server : tui;
    }) as unknown as typeof spawn;

    await expect(codexCommand({
      crewHome,
      reservePort: async () => 43124,
      spawnProcess,
      waitForReady: async () => undefined,
    })).rejects.toThrow(/exited unexpectedly with code 7[\s\S]*server exploded/);

    expect(tui.signalCode).toBe('SIGTERM');
    expect(existsSync(join(crewHome, 'codex-host'))).toBe(false);
  });

  it('does not hang when a child was already terminated by signal', async () => {
    const crewHome = await mkdtemp(join(tmpdir(), 'crew-codex-pre-signalled-'));
    cleanup.push(crewHome);
    const server = new FakeChild(null);
    const tui = new FakeChild(null);
    tui.signalCode = 'SIGTERM';
    let calls = 0;
    const spawnProcess = ((_command: string, _args: readonly string[]) => {
      calls += 1;
      return calls === 1 ? server : tui;
    }) as unknown as typeof spawn;

    await expect(codexCommand({
      crewHome,
      reservePort: async () => 43128,
      spawnProcess,
      waitForReady: async () => undefined,
    })).resolves.toBe(1);

    expect(server.signalCode).toBe('SIGTERM');
    expect(existsSync(join(crewHome, 'codex-host'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'forwards SIGHUP and cleans credentials',
    async () => {
      const crewHome = await mkdtemp(join(tmpdir(), 'crew-codex-sighup-'));
      cleanup.push(crewHome);
      const server = new FakeChild(null);
      const tui = new FakeChild(null);
      let calls = 0;
      const spawnProcess = ((_command: string, _args: readonly string[]) => {
        calls += 1;
        if (calls === 2) queueMicrotask(() => process.emit('SIGHUP', 'SIGHUP'));
        return calls === 1 ? server : tui;
      }) as unknown as typeof spawn;

      await expect(codexCommand({
        crewHome,
        reservePort: async () => 43125,
        spawnProcess,
        waitForReady: async () => undefined,
      })).resolves.toBe(1);

      expect(tui.signalCode).toBe('SIGHUP');
      expect(server.signalCode).toBe('SIGHUP');
      expect(existsSync(join(crewHome, 'codex-host'))).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'treats a forwarded signal during App Server readiness as normal shutdown',
    async () => {
      const crewHome = await mkdtemp(join(tmpdir(), 'crew-codex-startup-signal-'));
      cleanup.push(crewHome);
      const server = new FakeChild(null);
      let calls = 0;
      const spawnProcess = ((_command: string, _args: readonly string[]) => {
        calls += 1;
        return server;
      }) as unknown as typeof spawn;

      await expect(codexCommand({
        crewHome,
        reservePort: async () => 43127,
        spawnProcess,
        waitForReady: async () => {
          process.emit('SIGHUP', 'SIGHUP');
          throw new Error('readiness interrupted');
        },
      })).resolves.toBe(1);

      expect(calls).toBe(1);
      expect(server.signalCode).toBe('SIGHUP');
      expect(existsSync(join(crewHome, 'codex-host'))).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'treats App Server exiting first after a forwarded signal as normal shutdown',
    async () => {
      const crewHome = await mkdtemp(join(tmpdir(), 'crew-codex-signal-race-'));
      cleanup.push(crewHome);
      const server = new FakeChild(null);
      const tui = new SlowExitFakeChild(null);
      let calls = 0;
      const spawnProcess = ((_command: string, _args: readonly string[]) => {
        calls += 1;
        if (calls === 2) queueMicrotask(() => process.emit('SIGHUP', 'SIGHUP'));
        return calls === 1 ? server : tui;
      }) as unknown as typeof spawn;

      await expect(codexCommand({
        crewHome,
        reservePort: async () => 43126,
        spawnProcess,
        waitForReady: async () => undefined,
      })).resolves.toBe(1);

      expect(tui.signalCode).toBe('SIGHUP');
      expect(server.signalCode).toBe('SIGHUP');
      expect(existsSync(join(crewHome, 'codex-host'))).toBe(false);
    },
  );

  it('owns the remote flags', async () => {
    await expect(codexCommand({ args: ['--remote', 'ws://127.0.0.1:1'] }))
      .rejects.toThrow(/owns --remote/);
  });

  it('builds stable App Server and TUI argument vectors', () => {
    const runtime = {
      url: 'ws://127.0.0.1:43123',
      token: 'token',
      tokenFile: '/tmp/token',
      bridgeFile: '/tmp/bridge',
      cleanup: () => undefined,
    };
    expect(buildCodexAppServerArgs(runtime)).toContain('/tmp/token');
    expect(buildCodexTuiArgs(runtime.url, ['resume'])).toEqual([
      '--remote', runtime.url,
      '--remote-auth-token-env', CODEX_REMOTE_TOKEN_ENV,
      'resume',
    ]);
  });
});
