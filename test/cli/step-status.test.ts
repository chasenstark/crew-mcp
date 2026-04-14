import { describe, expect, it } from 'vitest';
import { formatStepComplete, formatStepStart, getStepLabel } from '../../src/cli/step-status.js';

describe('step-status formatter', () => {
  it('returns a known running label for known steps', () => {
    expect(getStepLabel('decompose')).toBe('Decomposing request into tasks...');
  });

  it('falls back to generic running label for unknown steps', () => {
    expect(getStepLabel('custom-step')).toBe('Running custom-step...');
  });

  it('formats dispatch start details with task and pass', () => {
    expect(formatStepStart('dispatch', { taskId: 'task-2', pass: 3 }))
      .toContain('"task-2" (pass 3)');
  });

  it('prefers the task description over the id when both are provided', () => {
    const line = formatStepStart('dispatch', {
      taskId: 'task-2',
      taskDescription: 'Analyze the existing codebase',
      pass: 1,
    });
    expect(line).toContain('"Analyze the existing codebase"');
    expect(line).not.toContain('task-2');
  });

  it('formats decompose completion with task count', () => {
    expect(formatStepComplete('decompose', { taskCount: 2 }))
      .toBe('planned 2 tasks');
  });

  it('formats ingest completion with status and summary', () => {
    const line = formatStepComplete('ingest', {
      status: 'partial',
      summary: 'Updated API validation but one integration test still fails in CI.',
    });

    expect(line).toContain('status: partial');
    expect(line).toContain('Updated API validation');
  });

  it('formats summarize completion with unresolved count', () => {
    const line = formatStepComplete('summarize', {
      summary: 'Refactor completed for parser and lexer boundaries.',
      unresolvedIssueCount: 1,
    });

    expect(line).toContain('1 unresolved issue');
    expect(line).toContain('Refactor completed');
  });

  it('formats judge completion with decision and loop info', () => {
    const line = formatStepComplete('judge', {
      decision: 'iterate',
      reasoning: 'Critical review findings remain open.',
      isLooping: true,
    });

    expect(line).toContain('decision: iterate');
    expect(line).toContain('Critical review findings remain open.');
    expect(line).toContain('loop detected');
  });

  it('formats report completion with pass count', () => {
    expect(formatStepComplete('report', { passCount: 1 }))
      .toBe('final report generated from 1 pass');
  });
});
