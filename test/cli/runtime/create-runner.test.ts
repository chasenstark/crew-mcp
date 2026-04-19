import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRunner } from '../../../src/cli/runtime/create-runner.js';
import { Pipeline } from '../../../src/captain/pipeline.js';
import { JudgmentRunner } from '../../../src/captain/judgment-runner.js';
import { __resetPreflightWarningLatchForTest } from '../../../src/cli/runtime/preflight.js';
import { logger } from '../../../src/utils/logger.js';

function writeProjectWorkflow(projectRoot: string, yaml: string): void {
  const crewDir = join(projectRoot, '.crew');
  mkdirSync(crewDir, { recursive: true });
  writeFileSync(join(crewDir, 'workflow.yaml'), yaml, 'utf-8');
}

describe('createRunner', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = join(tmpdir(), `captain-create-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(projectRoot, { recursive: true });
    __resetPreflightWarningLatchForTest();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('creates a linear Pipeline when mode is linear', () => {
    const { runner } = createRunner(projectRoot, { mode: 'linear' });
    expect(runner).toBeInstanceOf(Pipeline);
  });

  it('creates a JudgmentRunner when mode is judgment', () => {
    const { runner } = createRunner(projectRoot, { mode: 'judgment' });
    expect(runner).toBeInstanceOf(JudgmentRunner);
  });

  it('clears an incompatible captain.model scalar before the runner captures it', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      writeProjectWorkflow(
        projectRoot,
        [
          'workflow:',
          '  name: test',
          '  execution:',
          '    mode: judgment',
          '  steps: []',
          '  completion:',
          '    strategy: judge_approval',
          '    fallback: max_passes',
          'agents:',
          '  codex:',
          '    adapter: codex',
          'captain:',
          '  cli: codex',
          '  model: claude-sonnet-4-7',
          'error_handling:',
          '  default:',
          '    retry: 1',
          '    fallback: null',
          '    on_exhausted: ask_user',
          '',
        ].join('\n'),
      );

      const { runner, config } = createRunner(projectRoot);

      // Config mutated in-place: the mismatched scalar is gone.
      expect(config.captain.model).toBeUndefined();
      // Warn fired exactly once.
      const modelWarns = warnSpy.mock.calls.filter(([msg]) =>
        typeof msg === 'string' && msg.includes('captain.model'),
      );
      expect(modelWarns).toHaveLength(1);
      // The runner inherited the resolved (undefined) model, not the stale scalar.
      const captured = (runner as unknown as { captainModel?: string }).captainModel;
      expect(captured).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('clears only the mismatched map entry and hands the runner undefined', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      writeProjectWorkflow(
        projectRoot,
        [
          'workflow:',
          '  name: test',
          '  execution:',
          '    mode: judgment',
          '  steps: []',
          '  completion:',
          '    strategy: judge_approval',
          '    fallback: max_passes',
          'agents:',
          '  codex:',
          '    adapter: codex',
          '  claude-code:',
          '    adapter: claude-code',
          'captain:',
          '  cli: codex',
          '  model:',
          '    claude-code: CLAUDE_SONNET',
          '    codex: CLAUDE_SONNET',
          'error_handling:',
          '  default:',
          '    retry: 1',
          '    fallback: null',
          '    on_exhausted: ask_user',
          '',
        ].join('\n'),
      );

      const { runner, config } = createRunner(projectRoot);

      const map = config.captain.model as Record<string, string>;
      expect(map.codex).toBeUndefined();
      expect(map['claude-code']).toBe('claude-sonnet-4-7');

      const captured = (runner as unknown as { captainModel?: string }).captainModel;
      expect(captured).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
