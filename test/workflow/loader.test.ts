import { describe, it, expect } from 'vitest';
import { parseWorkflowYaml, getDefaultConfig } from '../../src/workflow/loader.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('Workflow Loader', () => {
  it('parses default workflow YAML', () => {
    const yaml = readFileSync(join(__dirname, '../../defaults/workflow.yaml'), 'utf-8');
    const config = parseWorkflowYaml(yaml);

    expect(config.workflow.name).toBe('default');
    expect(config.workflow.steps).toHaveLength(4);
    expect(config.workflow.steps[0].role).toBe('coder');
    expect(config.workflow.steps[1].role).toBe('reviewer');
    expect(config.workflow.steps[1].maxPasses).toBe(3);
    expect(config.agents['claude-code']).toBeDefined();
    expect(config.agents['codex']).toBeDefined();
    expect(config.orchestrator.cli).toBe('claude-code');
  });

  it('returns default config', () => {
    const config = getDefaultConfig();
    expect(config.workflow.name).toBe('default');
    expect(config.workflow.steps.length).toBeGreaterThan(0);
  });

  it('handles minimal YAML', () => {
    const yaml = 'workflow:\n  name: minimal\n  steps: []';
    const config = parseWorkflowYaml(yaml);
    expect(config.workflow.name).toBe('minimal');
    expect(config.workflow.steps).toEqual([]);
  });
});
