import { describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../../src/workflow/config-codec.js';
import {
  resolveConfigPath,
  SUPPORTED_CONFIG_SET_PATHS,
} from '../../src/workflow/config-path-registry.js';

describe('config path registry', () => {
  it('exposes the supported set paths list', () => {
    expect(SUPPORTED_CONFIG_SET_PATHS).toEqual([
      'orchestrator.cli',
      'orchestrator.model',
      'workflow.execution.mode',
      'workflow.roleModels.<role>',
      'agents.<name>.adapter',
      'agents.<name>.model',
      'agents.<name>.command',
      'agents.<name>.args',
      'agents.<name>.capabilities',
      'workflow.reviewer.maxPasses',
      'errorHandling.default.retry',
    ]);
  });

  it('resolves dynamic role-model path descriptors', () => {
    const resolved = resolveConfigPath('workflow.roleModels.reviewer');
    expect(resolved).not.toBeNull();
    expect(resolved?.params.role).toBe('reviewer');
  });

  it('parses and writes execution mode via descriptor contract', () => {
    const config = getDefaultConfig();
    const resolved = resolveConfigPath('workflow.execution.mode');
    expect(resolved).not.toBeNull();

    const descriptor = resolved!.descriptor;
    const parsed = descriptor.parse('judgment', config, resolved!.params, 'workflow.execution.mode');
    descriptor.write(config, resolved!.params, parsed, 'workflow.execution.mode');

    expect(descriptor.read(config, resolved!.params)).toBe('judgment');
  });

  it('returns null for unsupported paths', () => {
    expect(resolveConfigPath('workflow.name')).toBeNull();
  });
});
