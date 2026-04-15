import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initCommand } from '../../../src/cli/commands/init.js';
import { parseWorkflowYaml } from '../../../src/workflow/loader.js';

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

  it('writes a config schema compatible with the workflow loader', async () => {
    const projectDir = join(tmpDir, 'loader-compatible');
    mkdirSync(projectDir, { recursive: true });

    await initCommand({ project: true, cwd: projectDir });

    const { readFileSync } = await import('fs');
    const workflowFile = join(projectDir, '.orchestra', 'workflow.yaml');
    const raw = readFileSync(workflowFile, 'utf-8');
    const parsed = parseWorkflowYaml(raw);

    expect(parsed.workflow.name).toBe('default');
    expect(parsed.workflow.steps.length).toBeGreaterThan(0);
    expect(parsed.workflow.steps[0]?.agent).toBe('codex');
    expect(parsed.orchestrator.cli).toBe('claude-code');
    expect(parsed.agents['claude-code']).toBeDefined();
    expect(parsed.errorHandling.default.onExhausted).toBe('ask_user');
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
