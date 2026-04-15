import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRunner } from '../../../src/cli/runtime/create-runner.js';
import { Pipeline } from '../../../src/captain/pipeline.js';
import { JudgmentRunner } from '../../../src/captain/judgment-runner.js';

describe('createRunner', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = join(tmpdir(), `captain-create-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(projectRoot, { recursive: true });
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
});
