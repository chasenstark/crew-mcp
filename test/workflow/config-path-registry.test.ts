import { describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../../src/workflow/config-codec.js';
import {
  resolveConfigPath,
  SUPPORTED_CONFIG_SET_PATHS,
} from '../../src/workflow/config-path-registry.js';
import { ModelId } from '../../src/workflow/models.js';

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

    it('rejects names that are not declared in config.presets (symmetry with /preset)', () => {
      // `/config set captain.preset bogus` should fail at parse time, not
      // silently persist a broken reference that only surfaces as a
      // preflight warn on the next `crew run`. Matches the `/preset bogus`
      // slash-command contract.
      const config = getDefaultConfig();
      const resolved = resolveConfigPath('captain.preset');
      expect(() =>
        resolved!.descriptor.parse('bogus-preset', config, resolved!.params, 'captain.preset'),
      ).toThrow(/declared preset/);
    });

    it('accepts any string when no presets are declared (no spec to validate against)', () => {
      const config = getDefaultConfig();
      config.presets = undefined;
      const resolved = resolveConfigPath('captain.preset');
      // Without a presets map we can't validate — fall through to accepting
      // the parse (preflight will warn at load time when the reference
      // remains unresolvable).
      expect(() =>
        resolved!.descriptor.parse('anything', config, resolved!.params, 'captain.preset'),
      ).not.toThrow();
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
      config.captain.model = ModelId.CLAUDE_OPUS;
      const resolved = resolveConfigPath('captain.model');
      const descriptor = resolved!.descriptor;
      const parsed = descriptor.parse(
        ModelId.CLAUDE_SONNET,
        config,
        resolved!.params,
        'captain.model',
      );
      descriptor.write(config, resolved!.params, parsed, 'captain.model');
      expect(config.captain.model).toBe(ModelId.CLAUDE_SONNET);
    });

    it('preserves the per-CLI map when writing; only updates the current CLI entry', () => {
      const config = getDefaultConfig();
      config.captain.cli = 'claude-code';
      config.captain.model = {
        'claude-code': ModelId.CLAUDE_SONNET,
        codex: ModelId.GPT,
        'gemini-cli': 'qwen3:32b',
      };
      const resolved = resolveConfigPath('captain.model');
      const descriptor = resolved!.descriptor;
      const parsed = descriptor.parse(
        ModelId.CLAUDE_OPUS,
        config,
        resolved!.params,
        'captain.model',
      );
      descriptor.write(config, resolved!.params, parsed, 'captain.model');

      const map = config.captain.model as Record<string, string>;
      expect(map['claude-code']).toBe(ModelId.CLAUDE_OPUS);
      expect(map.codex).toBe(ModelId.GPT);
      expect(map['gemini-cli']).toBe('qwen3:32b');
    });
  });
});
