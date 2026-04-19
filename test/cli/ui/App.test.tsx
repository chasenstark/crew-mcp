import React from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { EventEmitter } from 'eventemitter3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { PipelineEvents } from '../../../src/captain/events.js';
import type { CrewRunner } from '../../../src/captain/runner.js';
import { CaptainSession } from '../../../src/captain/session.js';
import { ToolDispatcher } from '../../../src/captain/tool-dispatcher.js';

let latestSubmit: ((value: string) => void) | null = null;
let latestDisabled: boolean | undefined;

const mockHandleConfigSlashCommand = vi.fn((input: string, context: { sessionBusy: boolean }) => {
  if (!input.startsWith('/config')) return null;
  if (context.sessionBusy && input.startsWith('/config set')) {
    return 'Cannot mutate config while subagent tool calls are in flight.';
  }
  if (input === '/config show') {
    return 'config show output';
  }
  return 'config help output';
});

vi.mock('../../../src/cli/ui/PromptInput.js', () => ({
  PromptInput: (props: { onSubmit: (v: string) => void; disabled?: boolean; statusText?: string }) => {
    latestSubmit = props.onSubmit;
    latestDisabled = props.disabled;
    return (
      <Text>[input disabled={String(Boolean(props.disabled))} status="{props.statusText ?? ''}"]</Text>
    );
  },
}));

vi.mock('../../../src/cli/ui/config/command-handler.js', () => ({
  handleConfigSlashCommand: (input: string, context: { sessionBusy: boolean }) =>
    mockHandleConfigSlashCommand(input, context),
}));

const { App } = await import('../../../src/cli/ui/App.js');

function createFakeRunner() {
  const emitter = new EventEmitter<PipelineEvents>();
  const fake = {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    removeAllListeners: emitter.removeAllListeners.bind(emitter),
    run: vi.fn((_input: string) => new Promise<string>(() => { /* pending */ })),
    resume: vi.fn(() => new Promise<string>(() => { /* pending */ })),
    cancel: vi.fn(),
    markInterrupted: vi.fn(),
  };
  return { runner: fake as unknown as CrewRunner, emitter, fake };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

function submit(text: string) {
  if (!latestSubmit) throw new Error('PromptInput mock not mounted');
  latestSubmit(text);
}

describe('App (M1.5 post-rewrite)', () => {
  let root: string;
  let session: CaptainSession;
  let dispatcher: ToolDispatcher;
  let activeUnmount: (() => void) | null = null;

  function renderApp(
    element: React.ReactElement,
  ): ReturnType<typeof render> {
    const result = render(element);
    activeUnmount = result.unmount;
    return result;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-app-test-'));
    session = CaptainSession.create({ projectRoot: root });
    dispatcher = new ToolDispatcher();
    latestSubmit = null;
    latestDisabled = undefined;
  });

  afterEach(() => {
    if (activeUnmount) activeUnmount();
    activeUnmount = null;
    dispatcher.cancelAll('test cleanup');
    rmSync(root, { recursive: true, force: true });
  });

  it('renders the initial UI header', async () => {
    const { runner } = createFakeRunner();
    const { lastFrame } = renderApp(
      <App pipeline={runner} session={session} dispatcher={dispatcher} />,
    );
    await flush();
    expect(lastFrame()).toContain('captain');
    expect(lastFrame()).toContain('multi-agent coding crew');
  });

  it('PromptInput is never rendered with disabled={true} in M1.5 mode', async () => {
    const { runner } = createFakeRunner();
    renderApp(<App pipeline={runner} session={session} dispatcher={dispatcher} />);
    await flush();
    expect(latestDisabled).toBe(false);
  });

  it('submitting input appends a user_message session event on first submission', async () => {
    const { runner, fake } = createFakeRunner();
    renderApp(<App pipeline={runner} session={session} dispatcher={dispatcher} />);
    await flush();
    submit('build a thing');
    await flush();
    // First submission triggers pipeline.run + session append.
    expect(fake.run).toHaveBeenCalledWith('build a thing');
    expect(session.getMessages().length).toBeGreaterThanOrEqual(1);
    expect(session.getMessages()[0].role).toBe('user');
  });

  it('typing a message during an active run appends a user_message without re-running', async () => {
    const { runner, fake } = createFakeRunner();
    renderApp(<App pipeline={runner} session={session} dispatcher={dispatcher} />);
    await flush();
    submit('start');
    await flush();
    expect(fake.run).toHaveBeenCalledTimes(1);

    submit('follow-up');
    await flush();
    // pipeline.run must NOT be called again — session-loop handles the next turn
    expect(fake.run).toHaveBeenCalledTimes(1);
    const userMessages = session.getMessages().filter((m) => m.role === 'user');
    expect(userMessages.length).toBe(2);
  });

  it('boots pipeline.run on submit when session is persisted (B3 regression)', async () => {
    const { runner, fake, emitter } = createFakeRunner();
    // Seed a persisted session: messages + a completed report.
    session.appendUserMessage('prior', '2026-04-19T00:00:00.000Z');
    session.appendAssistantMessage('prior report', '2026-04-19T00:00:01.000Z');
    session.persist();

    renderApp(<App pipeline={runner} session={session} dispatcher={dispatcher} />);
    await flush();
    // A persisted session has messages but runner isn't active. Submitting
    // MUST call pipeline.run so the session-loop boots.
    submit('next request');
    await flush();
    expect(fake.run).toHaveBeenCalledWith('next request');

    // Simulate workflow completing.
    emitter.emit('report', 'final');
    await flush();

    // Another submit after the workflow done should boot pipeline.run again.
    submit('and another');
    await flush();
    expect(fake.run).toHaveBeenCalledTimes(2);
    expect(fake.run).toHaveBeenLastCalledWith('and another');
  });

  it('does not re-boot pipeline.run during active session (second submit just appends)', async () => {
    const { runner, fake } = createFakeRunner();
    renderApp(<App pipeline={runner} session={session} dispatcher={dispatcher} />);
    await flush();
    submit('initial');
    await flush();
    expect(fake.run).toHaveBeenCalledTimes(1);

    // While runnerActive = true, subsequent submits just append.
    submit('intermediate');
    submit('another intermediate');
    await flush();
    expect(fake.run).toHaveBeenCalledTimes(1);
    // All three user messages are in the session.
    const users = session.getMessages().filter((m) => m.role === 'user');
    expect(users.length).toBe(3);
  });

  it('PromptInput is never disabled even while tool calls are in flight', async () => {
    const { runner } = createFakeRunner();
    renderApp(<App pipeline={runner} session={session} dispatcher={dispatcher} />);
    await flush();

    // Start an in-flight dispatched task
    dispatcher.start({
      toolCallId: 'tc-1',
      toolName: 'run_agent',
      run: async (ctx) =>
        new Promise((_r, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await flush();
    expect(latestDisabled).toBe(false);
  });

  it('/cancel <id> dispatches cancel for a specific toolCallId', async () => {
    const { runner } = createFakeRunner();
    const cancelSpy = vi.spyOn(dispatcher, 'cancel');
    renderApp(<App pipeline={runner} session={session} dispatcher={dispatcher} />);
    await flush();
    // Start a task so there's something to cancel
    dispatcher.start({
      toolCallId: 'tc-xyz',
      toolName: 'run_agent',
      run: async (ctx) =>
        new Promise((_r, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await flush();
    submit('/cancel tc-xyz');
    await flush();
    expect(cancelSpy).toHaveBeenCalledWith('tc-xyz', expect.any(String));
  });

  it('/cancel-all dispatches cancelAll', async () => {
    const { runner } = createFakeRunner();
    const cancelAllSpy = vi.spyOn(dispatcher, 'cancelAll');
    renderApp(<App pipeline={runner} session={session} dispatcher={dispatcher} />);
    await flush();
    submit('/cancel-all');
    await flush();
    expect(cancelAllSpy).toHaveBeenCalledWith('user /cancel-all');
  });

  it('/cancel with no argument calls runner.cancel()', async () => {
    const { runner, fake } = createFakeRunner();
    renderApp(<App pipeline={runner} session={session} dispatcher={dispatcher} />);
    await flush();
    submit('/cancel');
    await flush();
    expect(fake.cancel).toHaveBeenCalledWith(expect.stringContaining('Cancelled'));
  });

  it('concurrent tool calls render as distinct progress strips', async () => {
    const { runner } = createFakeRunner();
    const { lastFrame } = renderApp(
      <App pipeline={runner} session={session} dispatcher={dispatcher} />,
    );
    await flush();

    dispatcher.start({
      toolCallId: 'alpha',
      toolName: 'run_agent',
      run: async (ctx) =>
        new Promise((_r, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    dispatcher.start({
      toolCallId: 'beta',
      toolName: 'run_agent',
      run: async (ctx) =>
        new Promise((_r, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('alpha');
    expect(frame).toContain('beta');
  });

  it('/config set blocked when tool calls are in flight (sessionBusy)', async () => {
    const { runner } = createFakeRunner();
    const { lastFrame } = renderApp(
      <App pipeline={runner} session={session} dispatcher={dispatcher} />,
    );
    await flush();

    dispatcher.start({
      toolCallId: 'tc',
      toolName: 'run_agent',
      run: async (ctx) =>
        new Promise((_r, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await flush();

    submit('/config set captain.cli codex');
    await flush();

    expect(lastFrame()).toContain('Cannot mutate config while subagent tool calls are in flight');
  });

  it('shows /config show output regardless of session busy state', async () => {
    const { runner } = createFakeRunner();
    const { lastFrame } = renderApp(
      <App pipeline={runner} session={session} dispatcher={dispatcher} />,
    );
    await flush();
    submit('/config show');
    await flush();
    expect(lastFrame()).toContain('config show output');
  });

  // Deleted in M1.5-11: slot-based provideUserInput / ask_user runner event
  // are retired. Legacy mode (Pipeline without session) now just runs once;
  // no queueing, no ask_user pause. Linear mode dies with pipeline.ts in M3.
});
