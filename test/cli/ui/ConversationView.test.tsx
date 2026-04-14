import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ConversationView, type ChatMessage } from '../../../src/cli/ui/ConversationView.js';

describe('ConversationView', () => {
  it('renders user messages with a prompt arrow', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    const { lastFrame } = render(<ConversationView messages={messages} />);
    expect(lastFrame()).toContain('hello');
    expect(lastFrame()).toMatch(/\u2192/);
  });

  it('renders assistant messages as plain text', () => {
    const messages: ChatMessage[] = [{ role: 'assistant', content: 'world' }];
    const { lastFrame } = render(<ConversationView messages={messages} />);
    expect(lastFrame()).toContain('world');
  });

  it('renders stream messages with an agent header', () => {
    const messages: ChatMessage[] = [
      { role: 'stream', content: 'partial...', agentName: 'codex' },
    ];
    const { lastFrame } = render(<ConversationView messages={messages} />);
    expect(lastFrame()).toContain('codex');
    expect(lastFrame()).toContain('streaming');
    expect(lastFrame()).toContain('partial...');
  });

  it('renders multiple messages preserving order', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'system', content: 'third' },
    ];
    const { lastFrame } = render(<ConversationView messages={messages} />);
    const frame = lastFrame()!;
    expect(frame.indexOf('first')).toBeLessThan(frame.indexOf('second'));
    expect(frame.indexOf('second')).toBeLessThan(frame.indexOf('third'));
  });
});
