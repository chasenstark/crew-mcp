import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewRunner } from '../../../src/captain/runner.js';

const {
  mockCreateRunner,
  mockAssertRequiredAgentsReady,
  mockAttachRunnerEvents,
  mockAttachAskUserHandler,
  mockEnableFileLogging,
  mockInkRender,
} = vi.hoisted(() => ({
  mockCreateRunner: vi.fn(),
  mockAssertRequiredAgentsReady: vi.fn(),
  mockAttachRunnerEvents: vi.fn(() => ({ dispose: vi.fn() })),
  mockAttachAskUserHandler: vi.fn(),
  mockEnableFileLogging: vi.fn(() => '/tmp/run.log'),
  mockInkRender: vi.fn(() => ({ waitUntilExit: () => Promise.resolve() })),
}));

vi.mock('ink', () => ({
  render: mockInkRender,
}));

vi.mock('../../../src/cli/runtime/create-runner.js', () => ({
  createRunner: mockCreateRunner,
}));

vi.mock('../../../src/cli/runtime/preflight.js', () => ({
  assertRequiredAgentsReady: mockAssertRequiredAgentsReady,
}));

vi.mock('../../../src/cli/runtime/attach-runner-events.js', () => ({
  attachRunnerEvents: mockAttachRunnerEvents,
}));

vi.mock('../../../src/cli/runtime/ask-user.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/runtime/ask-user.js')>();
  return {
    ...actual,
    attachAskUserHandler: mockAttachAskUserHandler,
  };
});

vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  return {
    ...actual,
    enableFileLogging: mockEnableFileLogging,
  };
});

import { runCommand } from '../../../src/cli/commands/run.js';

function createMockRunner(): CrewRunner {
  return {
    run: vi.fn(async () => 'ok'),
    resume: vi.fn(async () => 'ok'),
    cancel: vi.fn(),
    markInterrupted: vi.fn(),
    on: vi.fn(() => undefined as unknown as CrewRunner),
    removeAllListeners: vi.fn(() => undefined as unknown as CrewRunner),
  };
}

describe('runCommand preflight behavior', () => {
  const config = {
    workflow: {
      name: 'default',
      execution: { mode: 'judgment' as const },
      steps: [],
      completion: { strategy: 'judge_approval' as const, fallback: 'max_passes' as const },
    },
    agents: {},
    captain: { cli: 'claude-code' },
    errorHandling: {
      default: {
        retry: 1,
        fallback: null,
        onExhausted: 'ask_user' as const,
      },
    },
  };
  const registry = { get: vi.fn(), listAvailable: vi.fn(() => []) };
  const stateStore = { loadState: vi.fn(() => null) };

  beforeEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('runs preflight checks by default', async () => {
    const runner = createMockRunner();
    mockCreateRunner.mockReturnValue({ runner, config, registry, stateStore });

    await runCommand('ship it');

    expect(mockAssertRequiredAgentsReady).toHaveBeenCalledTimes(1);
    expect(mockAssertRequiredAgentsReady).toHaveBeenCalledWith(registry, config);
    expect(runner.run).toHaveBeenCalledWith('ship it');
  });

  it('skips preflight checks when skipPreflight is true', async () => {
    const runner = createMockRunner();
    mockCreateRunner.mockReturnValue({ runner, config, registry, stateStore });

    await runCommand('ship it', { skipPreflight: true });

    expect(mockAssertRequiredAgentsReady).not.toHaveBeenCalled();
    expect(runner.run).toHaveBeenCalledWith('ship it');
  });

  it('threads an explicit profile into runner creation', async () => {
    const runner = createMockRunner();
    mockCreateRunner.mockReturnValue({ runner, config, registry, stateStore });

    await runCommand('ship it', { profile: 'codex-first', skipPreflight: true });

    expect(mockCreateRunner).toHaveBeenCalledWith(expect.any(String), { profile: 'codex-first' });
    expect(runner.run).toHaveBeenCalledWith('ship it');
  });

  it('defers interactive preflight checks into App startup lifecycle', async () => {
    const runner = createMockRunner();
    const session = { id: 'session' };
    const dispatcher = { id: 'dispatcher' };
    mockCreateRunner.mockReturnValue({ runner, config, registry, stateStore, session, dispatcher });

    await runCommand();

    expect(mockAssertRequiredAgentsReady).not.toHaveBeenCalled();
    expect(mockInkRender).toHaveBeenCalledTimes(1);
    const renderedApp = mockInkRender.mock.calls[0]?.[0] as { props?: Record<string, unknown> } | undefined;
    const startupHealthCheck = renderedApp?.props?.startupHealthCheck;
    expect(typeof startupHealthCheck).toBe('function');
    await (startupHealthCheck as () => Promise<void>)();
    expect(mockAssertRequiredAgentsReady).toHaveBeenCalledWith(registry, config);
  });

  it('omits interactive startup preflight when skipPreflight is true', async () => {
    const runner = createMockRunner();
    const session = { id: 'session' };
    const dispatcher = { id: 'dispatcher' };
    mockCreateRunner.mockReturnValue({ runner, config, registry, stateStore, session, dispatcher });

    await runCommand(undefined, { skipPreflight: true });

    expect(mockAssertRequiredAgentsReady).not.toHaveBeenCalled();
    const renderedApp = mockInkRender.mock.calls[0]?.[0] as { props?: Record<string, unknown> } | undefined;
    expect(renderedApp?.props?.startupHealthCheck).toBeUndefined();
  });
});
