import { describe, expect, it } from 'vitest';

import {
  ProviderModelDefaultsScreen,
  ProviderModelInputScreen,
  ProviderModelSelectScreen,
} from '../../../../src/cli/commands/config-tui/provider-model-defaults-screen.js';
import { ProviderModelDefaultsState } from '../../../../src/cli/commands/config-tui/provider-model-defaults-state.js';
import { isPushResult } from '../../../../src/cli/commands/config-tui/screen.js';

describe('provider model defaults screens', () => {
  it('lists each provider and opens its exact model picker', () => {
    const state = makeState();
    const screen = new ProviderModelDefaultsScreen(state);

    expect(screen.render()).toContain(
      '> Claude Code (claude-code)       (provider CLI default)',
    );
    const result = screen.onKey({ name: 'space' });
    expect(isPushResult(result)).toBe(true);
    if (!isPushResult(result)) throw new Error('expected model picker');
    expect(result.push).toBeInstanceOf(ProviderModelSelectScreen);
  });

  it('selects a catalog model or restores the provider CLI default', () => {
    const state = makeState();
    const picker = new ProviderModelSelectScreen({
      providerName: 'claude-code',
      state,
    });

    picker.onKey({ name: 'down' });
    expect(picker.onKey({ name: 'space' })).toBe('pop');
    expect(state.getModel('claude-code')).toBe('opus');

    const clearPicker = new ProviderModelSelectScreen({
      providerName: 'claude-code',
      state,
    });
    expect(clearPicker.onKey({ name: 'space' })).toBe('pop');
    expect(state.getModel('claude-code')).toBeUndefined();
  });

  it('preserves and labels a configured model missing from the current catalog', () => {
    const state = makeState('claude-opus-5-20260801');
    const picker = new ProviderModelSelectScreen({
      providerName: 'claude-code',
      state,
    });

    expect(picker.render()).toContain(
      '  (•) claude-opus-5-20260801  (configured; not in current catalog)',
    );
  });

  it('opens a free-form exact-id editor for provider-valid models outside the catalog', () => {
    const state = makeState();
    const picker = new ProviderModelSelectScreen({
      providerName: 'claude-code',
      state,
    });
    picker.onKey({ name: 'down' }); // opus
    picker.onKey({ name: 'down' }); // custom

    const result = picker.onKey({ name: 'space' });
    expect(isPushResult(result)).toBe(true);
    if (!isPushResult(result)) throw new Error('expected exact-id editor');
    expect(result.push).toBeInstanceOf(ProviderModelInputScreen);
  });

  it('saves a trimmed custom model id into state', () => {
    const state = makeState();
    const input = new ProviderModelInputScreen({
      providerName: 'claude-code',
      state,
    });
    for (const char of ' claude-opus-5 ') {
      input.onKey({ name: char === ' ' ? 'space' : char, sequence: char });
    }

    expect(input.onKey({ name: 'return' })).toBe('save');
    expect(state.getModel('claude-code')).toBe('claude-opus-5');
  });
});

function makeState(configuredModel?: string): ProviderModelDefaultsState {
  return new ProviderModelDefaultsState([
    {
      name: 'claude-code',
      displayName: 'Claude Code',
      ...(configuredModel ? { configuredModel } : {}),
      models: [{
        model: 'opus',
        displayName: 'Claude Opus (latest alias)',
        isDefault: true,
      }],
    },
  ]);
}
