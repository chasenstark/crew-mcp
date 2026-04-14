import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { EventEmitter } from 'eventemitter3';
import type { Pipeline, PipelineEvents } from '../../../src/orchestrator/pipeline.js';

// Shared handle to the latest PromptInput onSubmit callback, set by the mock.
let latestSubmit: ((value: string) => void) | null = null;

vi.mock('../../../src/cli/ui/PromptInput.js', () => ({
  PromptInput: (props: { onSubmit: (v: string) => void; disabled?: boolean; statusText?: string }) => {
    latestSubmit = props.onSubmit;
    return (
      <Text>[input disabled={String(Boolean(props.disabled))} status="{props.statusText ?? ''}"]</Text>
    );
  },
}));

// Import App after the mock
const { App } = await import('../../../src/cli/ui/App.js');

function createFakePipeline() {
  const emitter = new EventEmitter<PipelineEvents>();

  const fake = {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    removeAllListeners: emitter.removeAllListeners.bind(emitter),
    run: vi.fn((_input: string) => new Promise<string>(() => { /* pending */ })),
    provideUserInput: vi.fn(),
    cancel: vi.fn(),
    markInterrupted: vi.fn(),
  };

  return { pipeline: fake as unknown as Pipeline, emitter, fake };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

function submit(text: string) {
  if (!latestSubmit) throw new Error('PromptInput mock not mounted');
  latestSubmit(text);
}

describe('App', () => {
  it('sends user input to pipeline.run when idle', async () => {
    const { pipeline, fake } = createFakePipeline();
    render(<App pipeline={pipeline} />);
    await flush();

    submit('do a thing');
    await flush();

    expect(fake.run).toHaveBeenCalledWith('do a thing');
  });

  it('queues input while running and reflects the queue count in statusText', async () => {
    const { pipeline, fake } = createFakePipeline();
    const { lastFrame } = render(<App pipeline={pipeline} />);
    await flush();

    submit('start');
    await flush();
    expect(fake.run).toHaveBeenCalledTimes(1);

    submit('queued one');
    await flush();
    submit('queued two');
    await flush();

    expect(lastFrame()).toContain('(queued) queued one');
    expect(lastFrame()).toMatch(/2 queued/);
  });

  it('clears the queue on /clear-queue without cancelling the run', async () => {
    const { pipeline, fake, emitter } = createFakePipeline();
    const { lastFrame } = render(<App pipeline={pipeline} />);
    await flush();

    submit('start');
    await flush();
    submit('queued');
    await flush();
    expect(lastFrame()).toMatch(/1 queued/);

    submit('/clear-queue');
    await flush();
    expect(lastFrame()).toContain('Cleared 1 queued message');
    expect(fake.run).toHaveBeenCalledTimes(1);
    expect(emitter.listenerCount('report')).toBeGreaterThan(0);
  });

  it('routes queued input to pipeline.provideUserInput on ask_user', async () => {
    const { pipeline, fake, emitter } = createFakePipeline();
    const { lastFrame } = render(<App pipeline={pipeline} />);
    await flush();

    submit('start');
    await flush();
    submit('my answer');
    await flush();

    emitter.emit('ask_user', 'What next?');
    await flush();

    expect(fake.provideUserInput).toHaveBeenCalledWith('my answer');
    expect(lastFrame()).toContain('What next?');
    expect(lastFrame()).toContain('(queued) my answer');
  });

  it('transitions agent status from running to done on agent:complete', async () => {
    const { pipeline, emitter } = createFakePipeline();
    const { lastFrame } = render(<App pipeline={pipeline} />);
    await flush();
    submit('start');
    await flush();

    emitter.emit('agent:start', 'codex', 'task-1', 'Implement the auth middleware');
    await flush();
    expect(lastFrame()).toContain('codex');
    expect(lastFrame()).toContain('Implement the auth middleware');
    expect(lastFrame()).toContain('\u25CF');

    emitter.emit('agent:complete', 'codex', 'task-1', {
      output: 'done',
      filesModified: [],
      status: 'success',
      metadata: {},
    });
    await flush();
    expect(lastFrame()).toContain('\u2713');
  });

  it('appends agent:output chunks into a single live streaming message', async () => {
    const { pipeline, emitter } = createFakePipeline();
    const { lastFrame } = render(<App pipeline={pipeline} />);
    await flush();
    submit('start');
    await flush();

    emitter.emit('agent:output', 'codex', 'task-1', 'hello ');
    await flush();
    emitter.emit('agent:output', 'codex', 'task-1', 'world');
    await flush();

    // Only the latest chunk is rendered live (full content is kept on the
    // message for a future expand affordance).
    expect(lastFrame()).toContain('world');
    expect(lastFrame()).toContain('streaming');
  });

  it('cancels the active run on /cancel and clears queue + streaming state', async () => {
    const { pipeline, fake, emitter } = createFakePipeline();
    const { lastFrame } = render(<App pipeline={pipeline} />);
    await flush();

    submit('start');
    await flush();

    // Start streaming and queue one message
    emitter.emit('agent:output', 'codex', 'task-1', 'partial ');
    await flush();
    submit('queued');
    await flush();
    expect(lastFrame()).toMatch(/1 queued/);

    submit('/cancel');
    await flush();

    expect(fake.cancel).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain('Cancelled');
    expect(lastFrame()).not.toMatch(/\d+ queued/);

    // After cancel the app should be idle — a new submission triggers a fresh run
    submit('try again');
    await flush();
    expect(fake.run).toHaveBeenCalledTimes(2);
    expect(fake.run).toHaveBeenLastCalledWith('try again');
  });

  it('resets running state on report and accepts a new run', async () => {
    const { pipeline, fake, emitter } = createFakePipeline();
    const { lastFrame } = render(<App pipeline={pipeline} />);
    await flush();
    submit('start');
    await flush();

    emitter.emit('report', 'final answer');
    await flush();

    expect(lastFrame()).toContain('final answer');

    submit('another');
    await flush();
    expect(fake.run).toHaveBeenCalledTimes(2);
  });
});
