import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { PromptInput } from '../../../src/cli/ui/PromptInput.js';

const flush = () => new Promise((r) => setTimeout(r, 20));

async function typeText(stdin: { write: (value: string) => void }, text: string) {
  for (const ch of text) {
    stdin.write(ch);
    await flush();
  }
}

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
    await typeText(stdin, 'hello');
    stdin.write('\r');
    await flush();
    expect(onSubmit).toHaveBeenCalledWith('hello');
  });

  it('trims whitespace before submit', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<PromptInput onSubmit={onSubmit} />);
    await typeText(stdin, '  hi  ');
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

  it('recalls submitted history with up arrow', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<PromptInput onSubmit={onSubmit} />);

    await typeText(stdin, 'first');
    stdin.write('\r');
    await flush();

    await typeText(stdin, 'second');
    stdin.write('\r');
    await flush();

    stdin.write('\u001B[A');
    await flush();
    stdin.write('\u001B[A');
    await flush();
    stdin.write('\r');
    await flush();

    expect(onSubmit).toHaveBeenNthCalledWith(3, 'first');
  });

  it('navigates down through history and restores draft at newest', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<PromptInput onSubmit={onSubmit} />);

    await typeText(stdin, 'first');
    stdin.write('\r');
    await flush();

    await typeText(stdin, 'second');
    stdin.write('\r');
    await flush();

    await typeText(stdin, 'xxxx');
    stdin.write('\u001B[A');
    await flush();
    stdin.write('\u001B[B');
    await flush();
    stdin.write('\u001B[A');
    await flush();
    stdin.write('\r');
    await flush();

    expect(onSubmit).toHaveBeenNthCalledWith(3, 'second');
  });

  it('does not add consecutive duplicate history entries', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<PromptInput onSubmit={onSubmit} />);

    await typeText(stdin, 'same');
    stdin.write('\r');
    await flush();

    await typeText(stdin, 'same');
    stdin.write('\r');
    await flush();

    await typeText(stdin, 'next');
    stdin.write('\r');
    await flush();

    stdin.write('\u001B[A');
    await flush();
    stdin.write('\u001B[A');
    await flush();
    await typeText(stdin, '!');

    stdin.write('\u001B[A');
    await flush();
    stdin.write('\r');
    await flush();

    expect(onSubmit.mock.calls[3]?.[0]).toContain('!');
  });

  it('keeps current draft when pressing up with empty history', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={() => {}} />);
    await typeText(stdin, 'draft');
    stdin.write('\u001B[A');
    await flush();
    expect(lastFrame()).toContain('draft');
  });
});
