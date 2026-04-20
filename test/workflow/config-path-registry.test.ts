import { describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../../src/workflow/config-codec.js';
import {
  resolveConfigPath,
  SUPPORTED_CONFIG_SET_PATHS,
} from '../../src/workflow/config-path-registry.js';

describe('config path registry', () => {
  it('exposes the supported set paths list', () => {
    expect(SUPPORTED_CONFIG_SET_PATHS).toEqual([
      'captain.cli',
      'captain.model',
      'captain.preset',
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

  describe('captain.preset (M5-5a)', () => {
    it('parses + writes via descriptor contract', () => {
      const config = getDefaultConfig();
      const resolved = resolveConfigPath('captain.preset');
      expect(resolved).not.toBeNull();
      const descriptor = resolved!.descriptor;

      const parsed = descriptor.parse(
        'thorough-review',
        config,
        resolved!.params,
        'captain.preset',
      );
      descriptor.write(config, resolved!.params, parsed, 'captain.preset');
      expect(config.captain.preset).toBe('thorough-review');
      expect(descriptor.read(config, resolved!.params)).toBe('thorough-review');
    });

    it('rejects the empty string', () => {
      const config = getDefaultConfig();
      const resolved = resolveConfigPath('captain.preset');
      expect(() =>
        resolved!.descriptor.parse('', config, resolved!.params, 'captain.preset'),
      ).toThrow(/non-empty string/);
    });

    it('options() enumerates declared presets plus the current value', () => {
      const config = getDefaultConfig();
      const resolved = resolveConfigPath('captain.preset');
      const descriptor = resolved!.descriptor;
      const options = descriptor.options(config, resolved!.params);
      // All three built-ins declared in defaults/workflow.yaml.
      expect(options).toContain('default');
      expect(options).toContain('thorough-review');
      expect(options).toContain('read-only');
    });

    it('options() includes the current value even when it names an unknown preset', () => {
      const config = getDefaultConfig();
      config.captain.preset = 'user-custom';
      config.presets = { ...(config.presets ?? {}) };
      delete (config.presets as Record<string, unknown>)['user-custom'];
      const resolved = resolveConfigPath('captain.preset');
      const descriptor = resolved!.descriptor;
      const options = descriptor.options(config, resolved!.params);
      expect(options).toContain('user-custom');
    });
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

  describe('captain.model write semantics', () => {
    it('replaces a scalar captain.model with a new scalar', () => {
      const config = getDefaultConfig();
      config.captain.cli = 'claude-code';
      config.captain.model = 'claude-opus-4-7';
      const resolved = resolveConfigPath('captain.model');
      const descriptor = resolved!.descriptor;
      const parsed = descriptor.parse(
        'claude-sonnet-4-7',
        config,
        resolved!.params,
        'captain.model',
      );
      descriptor.write(config, resolved!.params, parsed, 'captain.model');
      expect(config.captain.model).toBe('claude-sonnet-4-7');
    });

    it('preserves the per-CLI map when writing; only updates the current CLI entry', () => {
      const config = getDefaultConfig();
      config.captain.cli = 'claude-code';
      config.captain.model = {
        'claude-code': 'claude-sonnet-4-7',
        codex: 'gpt-5.4',
        'gemini-cli': 'qwen3:32b',
      };
      const resolved = resolveConfigPath('captain.model');
      const descriptor = resolved!.descriptor;
      const parsed = descriptor.parse(
        'claude-opus-4-7',
        config,
        resolved!.params,
        'captain.model',
      );
      descriptor.write(config, resolved!.params, parsed, 'captain.model');

      const map = config.captain.model as Record<string, string>;
      expect(map['claude-code']).toBe('claude-opus-4-7');
      expect(map.codex).toBe('gpt-5.4');
      expect(map['gemini-cli']).toBe('qwen3:32b');
    });
  });
});
