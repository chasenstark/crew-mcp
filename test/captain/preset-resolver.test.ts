import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetPresetWarnLatchForTest,
  resolveActivePreset,
} from '../../src/captain/preset-resolver.js';
import { logger } from '../../src/utils/logger.js';
import type { PresetConfig } from '../../src/workflow/types.js';

const DEFAULT_PRESET: PresetConfig = {
  name: 'default',
  description: 'default preset',
  hint: 'the default hint',
};
const THOROUGH_PRESET: PresetConfig = {
  name: 'thorough-review',
  description: 'thorough reviewer',
  hint: 'always review twice',
};

function presets(): Record<string, PresetConfig> {
  return {
    default: DEFAULT_PRESET,
    'thorough-review': THOROUGH_PRESET,
  };
}

describe('resolveActivePreset', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetPresetWarnLatchForTest();
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('resolves the default preset by name', () => {
    const result = resolveActivePreset({
      presets: presets(),
      defaultPresetName: 'default',
    });
    expect(result?.name).toBe('default');
    expect(result?.preset.hint).toBe('the default hint');
  });

  it('returns undefined for an unknown config default', () => {
    const result = resolveActivePreset({
      presets: presets(),
      defaultPresetName: 'does-not-exist',
    });
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('session override beats the config default when both are valid + distinct', () => {
    const result = resolveActivePreset({
      presets: presets(),
      defaultPresetName: 'default',
      sessionOverride: 'thorough-review',
    });
    expect(result?.name).toBe('thorough-review');
  });

  it('session override pointing at an unknown name returns undefined WITHOUT silent fallback', () => {
    const result = resolveActivePreset({
      presets: presets(),
      defaultPresetName: 'default',
      sessionOverride: 'bogus',
    });
    expect(result).toBeUndefined();
    // The runner decides the next-tier fallback policy; the resolver does not
    // silently hand back the config default.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('empty-string session override is treated as "no override" (falls through to config default)', () => {
    const result = resolveActivePreset({
      presets: presets(),
      defaultPresetName: 'default',
      sessionOverride: '',
    });
    expect(result?.name).toBe('default');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns undefined when presets map is undefined, regardless of names', () => {
    const result = resolveActivePreset({
      presets: undefined,
      defaultPresetName: 'default',
      sessionOverride: 'thorough-review',
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when both inputs are absent', () => {
    expect(resolveActivePreset({})).toBeUndefined();
    expect(resolveActivePreset({ presets: presets() })).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warn is throttled per-name (repeated unknown calls log once)', () => {
    resolveActivePreset({
      presets: presets(),
      sessionOverride: 'bogus',
    });
    resolveActivePreset({
      presets: presets(),
      sessionOverride: 'bogus',
    });
    resolveActivePreset({
      presets: presets(),
      sessionOverride: 'bogus',
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('warn latches separately for session vs config source', () => {
    // Same name, different source; both should warn once.
    resolveActivePreset({ presets: presets(), sessionOverride: 'bogus' });
    resolveActivePreset({ presets: presets(), defaultPresetName: 'bogus' });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('warn does not fire for known names (no false positive)', () => {
    resolveActivePreset({ presets: presets(), defaultPresetName: 'default' });
    resolveActivePreset({
      presets: presets(),
      defaultPresetName: 'default',
      sessionOverride: 'thorough-review',
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  describe('against defaults/workflow.yaml (M5-3 integration)', () => {
    it('resolves default, thorough-review, and read-only from the defaults', async () => {
      const { getDefaultConfig } = await import('../../src/workflow/config-codec.js');
      const config = getDefaultConfig();
      expect(resolveActivePreset({
        presets: config.presets,
        defaultPresetName: 'default',
      })?.name).toBe('default');
      expect(resolveActivePreset({
        presets: config.presets,
        defaultPresetName: 'thorough-review',
      })?.name).toBe('thorough-review');
      expect(resolveActivePreset({
        presets: config.presets,
        defaultPresetName: 'read-only',
      })?.name).toBe('read-only');
    });
  });
});
