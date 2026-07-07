import { describe, it, expect } from 'vitest';
import { getDefaultConfig } from '../src/workflow/loader.js';

describe('smoke test', () => {
  it('loads minimal code-defined defaults without the retired workflow DSL', () => {
    const config = getDefaultConfig();
    expect(config).toEqual({ workflow: {} });
  });
});
