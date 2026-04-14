import { describe, it, expect } from 'vitest';
import { getDefaultConfig } from '../src/workflow/loader.js';

describe('smoke test', () => {
  it('loads a default workflow with at least one step and agent', () => {
    const config = getDefaultConfig();
    expect(config.workflow.steps.length).toBeGreaterThan(0);
    expect(Object.keys(config.agents).length).toBeGreaterThan(0);
  });
});
