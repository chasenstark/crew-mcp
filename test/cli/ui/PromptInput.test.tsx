import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { PromptInput } from '../../../src/cli/ui/PromptInput.js';

const flush = () => new Promise((r) => setTimeout(r, 20));

describe('PromptInput', () => {
  it('shows placeholder when enabled', () => {
    const { lastFrame } = render(<PromptInput onSubmit={() => {}} placeholder="Say something" />);
    expect(lastFrame()).toContain('Say something');
  });

  it('shows status text when disabled', () => {
    const { lastFrame } = render(
      <PromptInput onSubmit={() => {}} disabled statusText="Running..." />,
    );
    expect(lastFrame()).toContain('Running...');
  });

  it('calls onSubmit with typed value on enter', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<PromptInput onSubmit={onSubmit} />);
    for (const ch of 'hello') {
      stdin.write(ch);
      await flush();
    }
    stdin.write('\r');
    await flush();
    expect(onSubmit).toHaveBeenCalledWith('hello');
  });

  it('trims whitespace before submit', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<PromptInput onSubmit={onSubmit} />);
    for (const ch of '  hi  ') {
      stdin.write(ch);
      await flush();
    }
    stdin.write('\r');
    await flush();
    expect(onSubmit).toHaveBeenCalledWith('hi');
  });

  it('does not submit empty input', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<PromptInput onSubmit={onSubmit} />);
    stdin.write('\r');
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
