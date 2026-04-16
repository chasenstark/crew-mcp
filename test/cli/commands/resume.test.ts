import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CrewRunner } from '../../../src/captain/runner.js';
import type { WorkflowState } from '../../../src/state/types.js';
import { StateStore } from '../../../src/state/store.js';

const {
  mockCreateRunner,
  mockAssertRequiredAgentsReady,
  mockAttachRunnerEvents,
  mockAttachAskUserHandler,
  mockEnableFileLogging,
} = vi.hoisted(() => ({
  mockCreateRunner: vi.fn(),
  mockAssertRequiredAgentsReady: vi.fn(),
  mockAttachRunnerEvents: vi.fn(),
  mockAttachAskUserHandler: vi.fn(),
  mockEnableFileLogging: vi.fn(() => '/tmp/resume.log'),
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

import { resumeCommand } from '../../../src/cli/commands/resume.js';

function createMockRunner(): CrewRunner {
  return {
    run: vi.fn(async () => 'ok'),
    resume: vi.fn(async () => 'ok'),
    requestUserInput: vi.fn(async () => 'input'),
    provideUserInput: vi.fn(),
    cancel: vi.fn(),
    markInterrupted: vi.fn(),
    on: vi.fn(() => undefined as unknown as CrewRunner),
    removeAllListeners: vi.fn(() => undefined as unknown as CrewRunner),
  };
}

function createWorkflowState(): WorkflowState {
  return {
    executionMode: 'judgment',
    runId: 'run-123',
    status: 'interrupted',
    userRequest: 'Implement changes',
    decomposition: {
      reasoning: 'split task',
      tasks: [
        {
          id: 'task-1',
          description: 'Do work',
          agent: 'codex',
          role: 'implement',
          dependencies: [],
          scope: { description: 'repo', files: ['src/index.ts'] },
          estimatedComplexity: 'low',
        },
      ],
      suggestedOrder: ['task-1'],
    },
    currentTaskIndex: 0,
    passes: [],
    startedAt: new Date().toISOString(),
  };
}

describe('resumeCommand preflight behavior', () => {
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

  let tmpRoot: string;
  let previousCwd: string;

  beforeEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
    previousCwd = process.cwd();
    tmpRoot = join(tmpdir(), `captain-resume-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpRoot, { recursive: true });
    process.chdir(tmpRoot);
    const stateStore = new StateStore(tmpRoot);
    stateStore.saveState(createWorkflowState());
  });

  afterEach(() => {
    process.exitCode = undefined;
    process.chdir(previousCwd);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('runs preflight checks by default', async () => {
    const runner = createMockRunner();
    mockCreateRunner.mockReturnValue({ runner, config, registry, stateStore: new StateStore(tmpRoot) });

    await resumeCommand();

    expect(mockAssertRequiredAgentsReady).toHaveBeenCalledTimes(1);
    expect(mockAssertRequiredAgentsReady).toHaveBeenCalledWith(registry, config);
    expect(runner.resume).toHaveBeenCalledTimes(1);
  });

  it('skips preflight checks when skipPreflight is true', async () => {
    const runner = createMockRunner();
    mockCreateRunner.mockReturnValue({ runner, config, registry, stateStore: new StateStore(tmpRoot) });

    await resumeCommand({ skipPreflight: true });

    expect(mockAssertRequiredAgentsReady).not.toHaveBeenCalled();
    expect(runner.resume).toHaveBeenCalledTimes(1);
  });
});
