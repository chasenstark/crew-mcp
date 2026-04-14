import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initCommand } from '../../../src/cli/commands/init.js';

describe('initCommand', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `orchestrator-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('writes to project directory with --project flag', async () => {
    const projectDir = join(tmpDir, 'my-project');
    mkdirSync(projectDir, { recursive: true });

    await initCommand({ project: true, cwd: projectDir });

    const workflowFile = join(projectDir, '.orchestra', 'workflow.yaml');
    expect(existsSync(workflowFile)).toBe(true);
  });

  it('does not overwrite existing config', async () => {
    const projectDir = join(tmpDir, 'existing');
    const orchestraDir = join(projectDir, '.orchestra');
    mkdirSync(orchestraDir, { recursive: true });

    const { writeFileSync, readFileSync } = await import('fs');
    writeFileSync(join(orchestraDir, 'workflow.yaml'), 'original content', 'utf-8');

    await initCommand({ project: true, cwd: projectDir });

    const content = readFileSync(join(orchestraDir, 'workflow.yaml'), 'utf-8');
    expect(content).toBe('original content');
  });
});
