import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import {
  discoverCodexModels,
  parseCodexModelListPage,
  StdioJsonLineRpcSession,
  type CodexModelRpcSession,
} from '../../src/adapters/codex-models.js';

function fakeChild(): ChildProcessWithoutNullStreams & {
  readonly kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & {
    kill: ReturnType<typeof vi.fn>;
  };
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: vi.fn((signal?: NodeJS.Signals) => {
      Object.assign(child, {
        killed: true,
        exitCode: signal === 'SIGKILL' ? 137 : 0,
        signalCode: signal ?? 'SIGTERM',
      });
      queueMicrotask(() => child.emit('exit', child.exitCode, child.signalCode));
      return true;
    }),
  });
  return child;
}

describe('Codex App Server model discovery', () => {
  it('parses model/list display metadata and defaults', () => {
    expect(parseCodexModelListPage({
      data: [
        { id: 'legacy-id', model: 'gpt-5.6-sol', displayName: 'GPT 5.6 Sol', isDefault: true },
        { id: 'gpt-5.6-terra' },
        { id: '', model: '' },
      ],
      nextCursor: 'cursor-2',
    })).toEqual({
      models: [
        { model: 'gpt-5.6-sol', displayName: 'GPT 5.6 Sol', isDefault: true },
        { model: 'gpt-5.6-terra', displayName: 'gpt-5.6-terra' },
      ],
      nextCursor: 'cursor-2',
    });
  });

  it('initializes, follows bounded pages, deduplicates, and closes', async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'initialize') return {};
      if (params.cursor === undefined) {
        return {
          data: [{ model: 'gpt-5.6-sol', displayName: 'Sol', isDefault: true }],
          nextCursor: 'next',
        };
      }
      return {
        data: [
          { model: 'gpt-5.6-sol', displayName: 'duplicate' },
          { model: 'gpt-5.6-terra', displayName: 'Terra' },
        ],
      };
    });
    const notify = vi.fn();
    const close = vi.fn(async () => undefined);
    const session: CodexModelRpcSession = { request, notify, close };

    await expect(discoverCodexModels({
      openSession: async () => session,
    })).resolves.toEqual([
      { model: 'gpt-5.6-sol', displayName: 'Sol', isDefault: true },
      { model: 'gpt-5.6-terra', displayName: 'Terra' },
    ]);
    expect(notify).toHaveBeenCalledWith('initialized', {});
    expect(request).toHaveBeenCalledWith('model/list', { limit: 100, cursor: 'next' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes when provider pagination fails', async () => {
    const close = vi.fn(async () => undefined);
    const session: CodexModelRpcSession = {
      request: vi.fn(async (method: string) => {
        if (method === 'initialize') return {};
        throw new Error('provider failed');
      }),
      notify: vi.fn(),
      close,
    };
    await expect(discoverCodexModels({ openSession: async () => session }))
      .rejects.toThrow('provider failed');
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects provider JSON-RPC errors and closes the child explicitly', async () => {
    const child = fakeChild();
    const session = new StdioJsonLineRpcSession(child, { closeTimeoutMs: 20 });
    const request = session.request('model/list', {});
    child.stdout.write(`${JSON.stringify({
      id: 1,
      error: { code: -32603, message: 'catalog unavailable' },
    })}\n`);

    await expect(request).rejects.toThrow(/Codex App Server error:.*catalog unavailable/);
    await session.close();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects malformed JSON and terminates the child', async () => {
    const child = fakeChild();
    const session = new StdioJsonLineRpcSession(child, { closeTimeoutMs: 20 });
    const request = session.request('model/list', {});
    child.stdout.write('{not-json}\n');

    await expect(request).rejects.toThrow('emitted malformed JSON');
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGTERM'));
  });

  it('bounds request time and cleanup', async () => {
    const child = fakeChild();
    const session = new StdioJsonLineRpcSession(child, {
      requestTimeoutMs: 5,
      closeTimeoutMs: 20,
    });

    await expect(session.request('model/list', {})).rejects.toThrow(
      'model/list timed out after 5ms',
    );
    await session.close();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
