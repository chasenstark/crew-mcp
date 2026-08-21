import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { withoutCodexCaptainEnvironment } from '../codex/environment.js';
import { CREW_MCP_VERSION } from '../cli/version.js';
import type { ModelDescriptor } from './types.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 500;
const MAX_LINE_BUFFER_BYTES = 1024 * 1024;
const MAX_PAGES = 32;
const MAX_MODELS = 2_000;

export interface CodexModelRpcSession {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): void;
  close(): Promise<void>;
}

export interface CodexModelDiscoveryOptions {
  readonly openSession?: () => Promise<CodexModelRpcSession>;
}

export interface CodexModelPage {
  readonly models: readonly ModelDescriptor[];
  readonly nextCursor?: string;
}

export function parseCodexModelListPage(value: unknown): CodexModelPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Codex model/list returned a non-object response');
  }
  const source = value as { data?: unknown; nextCursor?: unknown };
  if (!Array.isArray(source.data)) {
    throw new Error('Codex model/list response did not contain a data array');
  }
  const models: ModelDescriptor[] = [];
  for (const item of source.data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const model = typeof record.model === 'string' && record.model.trim().length > 0
      ? record.model.trim()
      : typeof record.id === 'string' && record.id.trim().length > 0
        ? record.id.trim()
        : undefined;
    if (!model) continue;
    const displayName = typeof record.displayName === 'string' && record.displayName.trim().length > 0
      ? record.displayName.trim()
      : model;
    models.push({
      model,
      displayName,
      ...(record.isDefault === true ? { isDefault: true } : {}),
    });
  }
  const nextCursor = typeof source.nextCursor === 'string' && source.nextCursor.length > 0
    ? source.nextCursor
    : undefined;
  return { models, ...(nextCursor ? { nextCursor } : {}) };
}

export async function discoverCodexModels(
  options: CodexModelDiscoveryOptions = {},
): Promise<ModelDescriptor[]> {
  const session = await (options.openSession ?? openCodexAppServerSession)();
  try {
    await session.request('initialize', {
      clientInfo: {
        name: 'crew_mcp_model_discovery',
        title: 'Crew MCP model discovery',
        version: CREW_MCP_VERSION,
      },
    });
    session.notify('initialized', {});

    const seen = new Set<string>();
    const models: ModelDescriptor[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const response = await session.request('model/list', {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      const page = parseCodexModelListPage(response);
      for (const model of page.models) {
        if (seen.has(model.model)) continue;
        seen.add(model.model);
        models.push(model);
        if (models.length >= MAX_MODELS) {
          throw new Error(`Codex model/list exceeded ${MAX_MODELS} models`);
        }
      }
      if (!page.nextCursor) return models;
      cursor = page.nextCursor;
    }
    throw new Error(`Codex model/list exceeded ${MAX_PAGES} pages`);
  } finally {
    await session.close();
  }
}

export async function openCodexAppServerSession(): Promise<CodexModelRpcSession> {
  const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
    env: withoutCodexCaptainEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new StdioJsonLineRpcSession(child);
}

export interface StdioJsonLineRpcSessionOptions {
  readonly requestTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
}

export class StdioJsonLineRpcSession implements CodexModelRpcSession {
  private nextId = 1;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private closed = false;
  private exited = false;
  private readonly pending = new Map<number, {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();

  private readonly requestTimeoutMs: number;
  private readonly closeTimeoutMs: number;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    options: StdioJsonLineRpcSessionOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer = boundTail(this.stderrBuffer + chunk, 64 * 1024);
    });
    child.once('error', (err) => this.failAll(err));
    child.once('exit', (code, signal) => {
      this.exited = true;
      if (!this.closed) {
        this.failAll(new Error(
          `Codex App Server exited before model discovery completed (code=${code ?? 'null'}, signal=${signal ?? 'null'}): ${this.stderrBuffer}`.trim(),
        ));
      }
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed || this.exited) {
      return Promise.reject(new Error('Codex App Server session is closed'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server ${method} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (err) => {
        if (!err) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(err);
      });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.closed || this.exited) return;
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('Codex App Server session closed'));
    this.child.stdin.end();
    if (this.exited) return;
    this.child.kill('SIGTERM');
    await waitForExit(this.child, this.closeTimeoutMs);
    if (!this.exited && this.child.exitCode === null) {
      this.child.kill('SIGKILL');
      await waitForExit(this.child, this.closeTimeoutMs);
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > MAX_LINE_BUFFER_BYTES) {
      this.failAll(new Error(`Codex App Server stdout line exceeded ${MAX_LINE_BUFFER_BYTES} bytes`));
      void this.close();
      return;
    }
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.failAll(new Error('Codex App Server emitted malformed JSON'));
        void this.close();
        return;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
      const record = message as { id?: unknown; result?: unknown; error?: unknown };
      if (typeof record.id !== 'number') continue;
      const pending = this.pending.get(record.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(record.id);
      if (record.error !== undefined) {
        pending.reject(new Error(`Codex App Server error: ${safeJson(record.error)}`));
      } else {
        pending.resolve(record.result);
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function boundTail(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
