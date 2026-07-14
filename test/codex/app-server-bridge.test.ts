import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CODEX_BRIDGE_SCHEMA_VERSION,
  CodexWakeBridgeError,
  decodeCodexBridgeFile,
  encodeCodexBridgeFile,
  readCodexBridgeDescriptor,
  wakeCodexThread,
} from '../../src/codex/app-server-bridge.js';
import { runClaimedCodexWake } from '../../src/codex/wake-delivery.js';

class FakeCodexSocket extends EventEmitter {
  readonly sent: Array<Record<string, unknown>> = [];
  private threadReads = 0;
  private turnStarts = 0;

  constructor(
    private readonly raceOnce = false,
    private readonly activeReadsBeforeIdle = 1,
  ) {
    super();
    queueMicrotask(() => this.emit('open'));
  }

  send(data: string): void {
    const message = JSON.parse(data) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    this.sent.push(message);
    if (message.id === undefined) return;

    let response: Record<string, unknown>;
    if (message.method === 'initialize') {
      response = { id: message.id, result: {} };
    } else if (message.method === 'thread/read') {
      this.threadReads += 1;
      const active = this.raceOnce
        ? this.threadReads === 1 || this.threadReads === 3
        : this.threadReads <= this.activeReadsBeforeIdle;
      response = {
        id: message.id,
        result: { thread: { status: { type: active ? 'active' : 'idle' } } },
      };
    } else if (message.method === 'turn/start') {
      this.turnStarts += 1;
      response = this.raceOnce && this.turnStarts === 1
        ? { id: message.id, error: { code: -32600, message: 'turn already active' } }
        : { id: message.id, result: { turn: { id: `turn-${this.turnStarts}` } } };
    } else {
      response = { id: message.id, error: { code: -32601, message: 'unknown method' } };
    }
    queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify(response))));
  }

  close(): void {
    queueMicrotask(() => this.emit('close'));
  }
}

class LostTurnStartResponseSocket extends EventEmitter {
  readonly sent: Array<Record<string, unknown>> = [];
  private threadReads = 0;
  private turnStarts = 0;

  constructor() {
    super();
    queueMicrotask(() => this.emit('open'));
  }

  send(data: string): void {
    const message = JSON.parse(data) as { id?: number; method: string };
    this.sent.push(message);
    if (message.id === undefined) return;
    if (message.method === 'turn/start') {
      this.turnStarts += 1;
      if (this.turnStarts === 1) return; // Accepted, but its response is lost.
    }
    const response = message.method === 'initialize'
      ? { id: message.id, result: {} }
      : message.method === 'thread/read'
        ? {
          id: message.id,
          result: {
            thread: {
              status: {
                // Initial idle, accepted synthetic turn active, then idle.
                type: ['idle', 'active', 'idle'][this.threadReads++] ?? 'idle',
              },
            },
          },
        }
        : { id: message.id, result: { turn: { id: `turn-${this.turnStarts}` } } };
    queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify(response))));
  }

  close(): void {
    queueMicrotask(() => this.emit('close'));
  }
}

describe('Codex App Server wake bridge', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const path of cleanup.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('waits until the thread is idle and starts a synthetic completion turn', async () => {
    const bridge = await makeBridge(cleanup);
    let socket!: FakeCodexSocket;
    let connectedUrl = '';
    let connectedToken = '';
    const sleeps: number[] = [];

    const result = await wakeCodexThread({
      bridgeFile: bridge.bridgeFile,
      threadId: '019f5d0f-a60c-7d53-9f35-2036d92d71ec',
      runIds: ['run-one', 'run-two'],
      statusPollMs: 7,
      sleep: async (ms) => { sleeps.push(ms); },
      createSocket: (url, token) => {
        connectedUrl = url;
        connectedToken = token;
        socket = new FakeCodexSocket();
        return socket;
      },
    });

    expect(result).toEqual({ turnId: 'turn-1' });
    expect(connectedUrl).toBe('ws://127.0.0.1:43123');
    expect(connectedToken).toBe(bridge.token);
    expect(sleeps).toEqual([7]);
    expect(socket.sent.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'thread/read',
      'thread/read',
      'turn/start',
    ]);
    const turnStart = socket.sent.at(-1);
    expect(JSON.stringify(turnStart)).toContain('run-one, run-two');
    expect(JSON.stringify(turnStart)).toContain('not authorization to merge or discard');
  });

  it('retries when a user turn wins the idle-to-start race', async () => {
    const bridge = await makeBridge(cleanup);
    let socket!: FakeCodexSocket;

    const result = await wakeCodexThread({
      bridgeFile: bridge.bridgeFile,
      threadId: '019f5d0f-a60c-7d53-9f35-2036d92d71ec',
      runIds: ['run-race'],
      statusPollMs: 1,
      sleep: async () => undefined,
      createSocket: () => {
        socket = new FakeCodexSocket(true);
        return socket;
      },
    });

    expect(result).toEqual({ turnId: 'turn-2' });
    expect(socket.sent.filter((message) => message.method === 'turn/start')).toHaveLength(2);
  });

  it('lets the delivery guard suppress a stale or duplicate turn before turn/start', async () => {
    const bridge = await makeBridge(cleanup);
    let socket!: FakeCodexSocket;
    let guardCalls = 0;

    const result = await wakeCodexThread({
      bridgeFile: bridge.bridgeFile,
      threadId: '019f5d0f-a60c-7d53-9f35-2036d92d71ec',
      runIds: ['run-stale'],
      sleep: async () => undefined,
      createSocket: () => {
        socket = new FakeCodexSocket(false, 0);
        return socket;
      },
      guardTurnStart: async () => {
        guardCalls += 1;
        return { action: 'skip' };
      },
    });

    expect(result).toEqual({ skipped: true });
    expect(guardCalls).toBe(1);
    expect(socket.sent.filter((message) => message.method === 'turn/start')).toHaveLength(0);
  });

  it('does not duplicate a turn when App Server accepts it but its response is lost', async () => {
    const bridge = await makeBridge(cleanup);
    const crewHome = await makeTerminalCrewHome(cleanup, 'run-lost-response');
    let socket!: LostTurnStartResponseSocket;

    const result = await wakeCodexThread({
      bridgeFile: bridge.bridgeFile,
      threadId: '019f5d0f-a60c-7d53-9f35-2036d92d71ec',
      runIds: ['run-lost-response'],
      requestTimeoutMs: 1,
      statusPollMs: 1,
      sleep: async () => undefined,
      createSocket: () => {
        socket = new LostTurnStartResponseSocket();
        return socket;
      },
      guardTurnStart: async (startTurn) => {
        const claim = await runClaimedCodexWake({
          crewHome,
          threadId: '019f5d0f-a60c-7d53-9f35-2036d92d71ec',
          runIds: ['run-lost-response'],
          runGenerations: [1],
          startTurn,
        });
        return claim.started
          ? { action: 'start', result: claim.result }
          : { action: 'skip' };
      },
    });

    expect(result).toEqual({ skipped: true });
    expect(socket.sent.filter((message) => message.method === 'turn/start')).toHaveLength(1);
  });

  it('rejects a guarded start result that omits the accepted turn id', async () => {
    const bridge = await makeBridge(cleanup);

    await expect(wakeCodexThread({
      bridgeFile: bridge.bridgeFile,
      threadId: '019f5d0f-a60c-7d53-9f35-2036d92d71ec',
      runIds: ['run-malformed-result'],
      sleep: async () => undefined,
      createSocket: () => new FakeCodexSocket(false, 0),
      guardTurnStart: async () => ({ action: 'start', result: undefined }),
    })).rejects.toThrow(/accepted wake without a turn id/);
  });

  it('keeps waiting through a long active turn without an absolute wake deadline', async () => {
    const bridge = await makeBridge(cleanup);
    const sleeps: number[] = [];

    const result = await wakeCodexThread({
      bridgeFile: bridge.bridgeFile,
      threadId: '019f5d0f-a60c-7d53-9f35-2036d92d71ec',
      runIds: ['run-after-long-turn'],
      requestTimeoutMs: 1,
      statusPollMs: 120_001,
      sleep: async (ms) => { sleeps.push(ms); },
      createSocket: () => new FakeCodexSocket(false, 3),
    });

    expect(result).toEqual({ turnId: 'turn-1' });
    expect(sleeps).toEqual([120_001, 120_001, 120_001]);
  });

  it('rejects non-loopback endpoints and bridge files with loose permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crew-codex-bridge-invalid-'));
    cleanup.push(root);
    const tokenFile = join(root, 'bridge.token');
    const bridgeFile = join(root, 'bridge.json');
    writeFileSync(tokenFile, `${'a'.repeat(43)}\n`, { mode: 0o600 });
    writeFileSync(bridgeFile, JSON.stringify({
      schemaVersion: CODEX_BRIDGE_SCHEMA_VERSION,
      url: 'ws://localhost:43123',
      tokenFile,
    }), { mode: 0o600 });

    await expect(readCodexBridgeDescriptor(bridgeFile)).rejects.toThrow(
      /ws:\/\/127\.0\.0\.1/,
    );

    writeFileSync(bridgeFile, JSON.stringify({
      schemaVersion: CODEX_BRIDGE_SCHEMA_VERSION,
      url: 'ws://127.0.0.1:43123',
      tokenFile,
    }));
    chmodSync(bridgeFile, 0o644);
    await expect(readCodexBridgeDescriptor(bridgeFile)).rejects.toThrow(/group or other users/);
  });

  it('round-trips canonical base64url bridge paths and rejects malformed input', () => {
    const path = '/tmp/Crew bridge/bridge.json';
    expect(decodeCodexBridgeFile(encodeCodexBridgeFile(path))).toBe(path);
    expect(() => decodeCodexBridgeFile('not+base64')).toThrow(CodexWakeBridgeError);
  });
});

async function makeBridge(cleanup: string[]): Promise<{
  bridgeFile: string;
  tokenFile: string;
  token: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'crew-codex-bridge-'));
  cleanup.push(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const token = 'abcdefghijklmnopqrstuvwxyzABCDEFGH0123456789_-';
  const tokenFile = join(root, 'bridge.token');
  const bridgeFile = join(root, 'bridge.json');
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  writeFileSync(bridgeFile, JSON.stringify({
    schemaVersion: CODEX_BRIDGE_SCHEMA_VERSION,
    url: 'ws://127.0.0.1:43123',
    tokenFile,
  }), { mode: 0o600 });
  return { bridgeFile, tokenFile, token };
}

async function makeTerminalCrewHome(cleanup: string[], runId: string): Promise<string> {
  const crewHome = await mkdtemp(join(tmpdir(), 'crew-codex-bridge-state-'));
  cleanup.push(crewHome);
  const runDir = join(crewHome, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'state.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    status: 'success',
    prompts: [{ turn: 1 }],
  }));
  return crewHome;
}
