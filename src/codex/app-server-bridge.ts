import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';

import WebSocket, { type RawData } from 'ws';

export const CODEX_BRIDGE_FILE_ENV = 'CREW_CODEX_BRIDGE_FILE';
export const CODEX_THREAD_ID_ENV = 'CODEX_THREAD_ID';
export const CODEX_BRIDGE_SCHEMA_VERSION = 1;

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_STATUS_POLL_MS = 250;

export interface CodexBridgeDescriptor {
  readonly schemaVersion: typeof CODEX_BRIDGE_SCHEMA_VERSION;
  readonly url: string;
  readonly tokenFile: string;
}

export interface WakeCodexThreadOptions {
  readonly bridgeFile: string;
  readonly threadId: string;
  readonly runIds: readonly string[];
  /** Per-connection/request timeout. Waiting for the thread itself to become idle is unbounded. */
  readonly requestTimeoutMs?: number;
  readonly statusPollMs?: number;
  readonly createSocket?: CodexSocketFactory;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly guardTurnStart?: (
    startTurn: () => Promise<unknown>,
  ) => Promise<CodexTurnStartGuardResult>;
}

export type CodexTurnStartGuardResult =
  | { readonly action: 'start'; readonly result: unknown }
  | { readonly action: 'skip' };

export type WakeCodexThreadResult =
  | { readonly turnId: string; readonly skipped?: never }
  | { readonly turnId?: never; readonly skipped: true };

interface CodexSocket {
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  send(data: string): void;
  close(): void;
}

export type CodexSocketFactory = (url: string, token: string) => CodexSocket;

interface JsonRpcError {
  readonly code?: number;
  readonly message?: string;
}

interface JsonRpcMessage {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

export class CodexWakeBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexWakeBridgeError';
  }
}

/** A definitive JSON-RPC rejection: App Server replied and did not accept the request. */
export class CodexWakeRpcError extends CodexWakeBridgeError {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'CodexWakeRpcError';
  }
}

export function encodeCodexBridgeFile(path: string): string {
  return Buffer.from(path, 'utf-8').toString('base64url');
}

export function decodeCodexBridgeFile(encoded: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new CodexWakeBridgeError('invalid Codex bridge path encoding');
  }
  const decoded = Buffer.from(encoded, 'base64url').toString('utf-8');
  if (
    decoded.length === 0
    || Buffer.from(decoded, 'utf-8').toString('base64url') !== encoded
  ) {
    throw new CodexWakeBridgeError('invalid Codex bridge path encoding');
  }
  return decoded;
}

export function codexWakePrompt(runIds: readonly string[]): string {
  return [
    'Crew watcher completion event from the local crew-mcp bridge.',
    `Terminal run ids: ${runIds.join(', ')}`,
    'Continue the active Crew workflow now. Call get_run_status for each run; '
      + 'for a review panel, call get_panel_status and enforce the full-panel terminal gate '
      + 'before aggregate_panel.',
    'This event is not authorization to merge or discard any run.',
  ].join('\n');
}

export async function wakeCodexThread(
  options: WakeCodexThreadOptions,
): Promise<WakeCodexThreadResult> {
  validateThreadId(options.threadId);
  validateRunIds(options.runIds);
  const descriptor = await readCodexBridgeDescriptor(options.bridgeFile);
  const token = await readBridgeToken(descriptor, options.bridgeFile);
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const statusPollMs = options.statusPollMs ?? DEFAULT_STATUS_POLL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const socketFactory = options.createSocket ?? defaultSocketFactory;
  const client = new CodexAppServerClient(socketFactory(descriptor.url, token));

  try {
    await client.connect(requestTimeoutMs);
    await client.request('initialize', {
      clientInfo: {
        name: 'crew_mcp_watcher',
        title: 'Crew MCP watcher',
        version: '1',
      },
    }, requestTimeoutMs);
    client.notify('initialized', {});

    for (;;) {
      await waitForIdleThread(
        client,
        options.threadId,
        requestTimeoutMs,
        statusPollMs,
        sleep,
      );
      try {
        const startTurn = (): Promise<unknown> => client.request('turn/start', {
          threadId: options.threadId,
          input: [{ type: 'text', text: codexWakePrompt(options.runIds) }],
        }, requestTimeoutMs);
        let result: unknown;
        if (options.guardTurnStart) {
          const guarded = await options.guardTurnStart(startTurn);
          if (guarded.action === 'skip') return { skipped: true };
          result = guarded.result;
        } else {
          result = await startTurn();
        }
        const typedResult = result as { turn?: { id?: unknown } };
        const turnId = typedResult?.turn?.id;
        if (typeof turnId !== 'string' || turnId.length === 0) {
          throw new CodexWakeBridgeError('Codex App Server accepted wake without a turn id');
        }
        return { turnId };
      } catch (error) {
        // A real user can start a turn in the narrow gap between our idle
        // read and turn/start. Retry only when the server confirms that race;
        // preserve all other protocol and authorization failures.
        const status = await readThreadStatus(client, options.threadId, requestTimeoutMs);
        if (status !== 'active') throw error;
        await sleep(statusPollMs);
      }
    }
  } finally {
    client.close();
  }
}

export async function readCodexBridgeDescriptor(
  bridgeFile: string,
): Promise<CodexBridgeDescriptor> {
  if (!isAbsolute(bridgeFile)) {
    throw new CodexWakeBridgeError('Codex bridge file path must be absolute');
  }
  await requirePrivateFile(bridgeFile, 'Codex bridge file');

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(bridgeFile, 'utf-8'));
  } catch (error) {
    throw new CodexWakeBridgeError(
      `failed to read Codex bridge file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CodexWakeBridgeError('Codex bridge file must contain a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== CODEX_BRIDGE_SCHEMA_VERSION) {
    throw new CodexWakeBridgeError('unsupported Codex bridge schema version');
  }
  if (typeof record.url !== 'string') {
    throw new CodexWakeBridgeError('Codex bridge URL is missing');
  }
  validateLoopbackWebSocketUrl(record.url);
  if (typeof record.tokenFile !== 'string' || !isAbsolute(record.tokenFile)) {
    throw new CodexWakeBridgeError('Codex bridge token file path must be absolute');
  }
  return {
    schemaVersion: CODEX_BRIDGE_SCHEMA_VERSION,
    url: record.url,
    tokenFile: record.tokenFile,
  };
}

async function readBridgeToken(
  descriptor: CodexBridgeDescriptor,
  bridgeFile: string,
): Promise<string> {
  const bridgeRealPath = await realpath(bridgeFile);
  const tokenRealPath = await realpath(descriptor.tokenFile);
  if (!pathIsWithin(dirname(bridgeRealPath), tokenRealPath)) {
    throw new CodexWakeBridgeError('Codex bridge token file must be beside the bridge file');
  }
  await requirePrivateFile(tokenRealPath, 'Codex bridge token file');
  const token = (await readFile(tokenRealPath, 'utf-8')).trim();
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) {
    throw new CodexWakeBridgeError('Codex bridge token is invalid');
  }
  return token;
}

async function requirePrivateFile(path: string, label: string): Promise<void> {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new CodexWakeBridgeError(`${label} is not a regular file`);
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new CodexWakeBridgeError(`${label} must not be accessible by group or other users`);
  }
}

function validateLoopbackWebSocketUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CodexWakeBridgeError('Codex bridge URL is invalid');
  }
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.port.length === 0) {
    throw new CodexWakeBridgeError(
      'Codex bridge URL must be an authenticated ws://127.0.0.1:<port> endpoint',
    );
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new CodexWakeBridgeError('Codex bridge URL must not contain credentials or a path');
  }
}

function validateThreadId(threadId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) {
    throw new CodexWakeBridgeError('CODEX_THREAD_ID is missing or invalid');
  }
}

function validateRunIds(runIds: readonly string[]): void {
  if (runIds.length === 0) {
    throw new CodexWakeBridgeError('at least one run id is required for Codex wake');
  }
  if (runIds.some((runId) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId))) {
    throw new CodexWakeBridgeError('invalid run id in Codex wake request');
  }
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel.length === 0
    || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function readThreadStatus(
  client: CodexAppServerClient,
  threadId: string,
  requestTimeoutMs: number,
): Promise<'notLoaded' | 'idle' | 'systemError' | 'active'> {
  const result = await client.request('thread/read', {
    threadId,
    includeTurns: false,
  }, requestTimeoutMs) as { thread?: { status?: unknown } };
  const status = result?.thread?.status;
  const type = typeof status === 'string'
    ? status
    : status && typeof status === 'object'
      ? (status as { type?: unknown }).type
      : undefined;
  if (type === 'notLoaded' || type === 'idle' || type === 'systemError' || type === 'active') {
    return type;
  }
  throw new CodexWakeBridgeError('Codex App Server returned an unknown thread status');
}

async function waitForIdleThread(
  client: CodexAppServerClient,
  threadId: string,
  requestTimeoutMs: number,
  statusPollMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  for (;;) {
    const status = await readThreadStatus(client, threadId, requestTimeoutMs);
    if (status === 'idle') return;
    if (status === 'notLoaded') {
      throw new CodexWakeBridgeError(
        `Codex thread ${threadId} is not loaded by the bridge App Server`,
      );
    }
    if (status === 'systemError') {
      throw new CodexWakeBridgeError(
        `Codex thread ${threadId} is in systemError state`,
      );
    }
    await sleep(statusPollMs);
  }
}

function defaultSocketFactory(url: string, token: string): CodexSocket {
  return new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function rawMessageToString(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf-8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf-8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf-8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf-8');
  }
  return String(data as RawData);
}

class CodexAppServerClient {
  private nextId = 1;
  private opened = false;
  private closed = false;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly socket: CodexSocket) {
    socket.on('message', (data) => this.handleMessage(data));
    socket.on('error', (error) => this.failAll(error));
    socket.on('close', () => {
      this.closed = true;
      this.failAll(new CodexWakeBridgeError('Codex App Server connection closed'));
    });
  }

  async connect(timeoutMs: number): Promise<void> {
    if (this.opened) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new CodexWakeBridgeError('timed out connecting to Codex App Server'));
      }, timeoutMs);
      this.socket.on('open', () => {
        clearTimeout(timer);
        this.opened = true;
        resolve();
      });
      this.socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.opened || this.closed) {
      return Promise.reject(new CodexWakeBridgeError('Codex App Server is not connected'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexWakeBridgeError(`timed out waiting for Codex ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ method, id, params }));
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.opened || this.closed) {
      throw new CodexWakeBridgeError('Codex App Server is not connected');
    }
    this.socket.send(JSON.stringify({ method, params }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
    this.failAll(new CodexWakeBridgeError('Codex App Server connection closed'));
  }

  private handleMessage(data: unknown): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(rawMessageToString(data)) as JsonRpcMessage;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new CodexWakeRpcError(
        `Codex App Server error${message.error.code === undefined ? '' : ` ${message.error.code}`}: `
          + (message.error.message ?? 'unknown error'),
        message.error.code,
      ));
      return;
    }
    pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
