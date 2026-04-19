import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { attachAskUserHandler, normalizeAskUserPolicy } from '../../../src/cli/runtime/ask-user.js';
import { CaptainSession } from '../../../src/captain/session.js';
import { ToolDispatcher } from '../../../src/captain/tool-dispatcher.js';
import { dispatchAskUser } from '../../../src/captain/tools/ask-user.js';
import type { CrewRunner } from '../../../src/captain/runner.js';

describe('normalizeAskUserPolicy', () => {
  it('uses fallback policy when option is not provided', () => {
    expect(normalizeAskUserPolicy(undefined, 'fail')).toBe('fail');
    expect(normalizeAskUserPolicy(undefined, 'prompt')).toBe('prompt');
  });

  it('accepts explicit fail/prompt values', () => {
    expect(normalizeAskUserPolicy('fail', 'prompt')).toBe('fail');
    expect(normalizeAskUserPolicy('prompt', 'fail')).toBe('prompt');
  });

  it('rejects unknown policy values', () => {
    expect(() => normalizeAskUserPolicy('invalid', 'fail')).toThrow(/Invalid --on-ask-user policy/);
  });
});

describe('attachAskUserHandler (M1.5-11 rewire)', () => {
  let root: string;
  let session: CaptainSession;
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-ask-user-handler-'));
    session = CaptainSession.create({ projectRoot: root });
    dispatcher = new ToolDispatcher();
  });

  afterEach(() => {
    dispatcher.cancelAll('test-cleanup');
    rmSync(root, { recursive: true, force: true });
  });

  it('fail policy: cancels the runner when an ask_user tool-call starts', async () => {
    const runner = {
      cancel: vi.fn(),
    } as unknown as CrewRunner;

    attachAskUserHandler({
      runner,
      session,
      dispatcher,
      policy: 'fail',
      failPrefix: 'test-prefix',
    });

    // Fire a dispatched ask_user — the handler should see it and call cancel.
    const pending = dispatchAskUser({
      session,
      dispatcher,
      question: 'pick one',
    });
    // Let the subscription fire and runner.cancel execute.
    await new Promise((r) => setImmediate(r));
    expect(runner.cancel).toHaveBeenCalled();
    dispatcher.cancelAll('cleanup');
    try {
      await pending;
    } catch {
      // expected — ask_user was cancelled
    }
  });

  it('no-op when session/dispatcher are not provided (linear mode)', () => {
    const runner = { cancel: vi.fn() } as unknown as CrewRunner;
    const sub = attachAskUserHandler({
      runner,
      policy: 'fail',
      failPrefix: 'test',
    });
    expect(typeof sub.dispose).toBe('function');
    // Disposing is safe and doesn't throw.
    sub.dispose();
  });
});
