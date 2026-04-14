import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { AgentStatus, type AgentInfo } from '../../../src/cli/ui/AgentStatus.js';

describe('AgentStatus', () => {
  it('renders nothing when no agents', () => {
    const { lastFrame } = render(<AgentStatus agents={[]} />);
    expect(lastFrame()).toBe('');
  });

  it('renders a running agent with task description', () => {
    const agents: AgentInfo[] = [
      { name: 'codex', status: 'running', task: 'implement feature' },
    ];
    const { lastFrame } = render(<AgentStatus agents={agents} />);
    expect(lastFrame()).toContain('codex');
    expect(lastFrame()).toContain('implement feature');
  });

  it('shows checkmark for done status', () => {
    const agents: AgentInfo[] = [{ name: 'codex', status: 'done' }];
    const { lastFrame } = render(<AgentStatus agents={agents} />);
    expect(lastFrame()).toContain('\u2713');
  });

  it('shows cross for error status', () => {
    const agents: AgentInfo[] = [{ name: 'codex', status: 'error' }];
    const { lastFrame } = render(<AgentStatus agents={agents} />);
    expect(lastFrame()).toContain('\u2717');
  });

  it('updates when rerendered with new status', () => {
    const running: AgentInfo[] = [{ name: 'codex', status: 'running', task: 't1' }];
    const { lastFrame, rerender } = render(<AgentStatus agents={running} />);
    expect(lastFrame()).toContain('\u25CF');

    const done: AgentInfo[] = [{ name: 'codex', status: 'done', task: 't1' }];
    rerender(<AgentStatus agents={done} />);
    expect(lastFrame()).toContain('\u2713');
  });

  it('renders multiple agents', () => {
    const agents: AgentInfo[] = [
      { name: 'codex', status: 'done' },
      { name: 'claude-code', status: 'running' },
    ];
    const { lastFrame } = render(<AgentStatus agents={agents} />);
    expect(lastFrame()).toContain('codex');
    expect(lastFrame()).toContain('claude-code');
  });
});
