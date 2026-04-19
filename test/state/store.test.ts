import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../../src/state/store.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('StateStore', () => {
  let tmpDir: string;
  let store: StateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orchestra-test-'));
    store = new StateStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves and loads workflow state', () => {
    const state = {
      status: 'running' as const,
      userRequest: 'Build a thing',
      decomposition: {
        reasoning: 'test',
        tasks: [],
        suggestedOrder: [],
      },
      currentTaskIndex: 0,
      passes: [],
    };
    store.saveState(state);
    const loaded = store.loadState();
    expect(loaded).toEqual({ ...state, schemaVersion: 5 });
  });

  it('returns null for missing state', () => {
    expect(store.loadState()).toBeNull();
  });

  it('detects interrupted workflows', () => {
    expect(store.hasInterruptedWorkflow()).toBe(false);
    store.saveState({
      status: 'running',
      userRequest: 'test',
      decomposition: { reasoning: '', tasks: [], suggestedOrder: [] },
      currentTaskIndex: 0,
      passes: [],
    });
    expect(store.hasInterruptedWorkflow()).toBe(true);
  });

  it('detects explicitly interrupted workflows', () => {
    store.saveState({
      status: 'interrupted',
      userRequest: 'test',
      decomposition: { reasoning: '', tasks: [], suggestedOrder: [] },
      currentTaskIndex: 0,
      passes: [],
      interruptedAt: new Date().toISOString(),
    });
    expect(store.hasInterruptedWorkflow()).toBe(true);
  });

  it('saves and loads pass summaries in order', () => {
    store.addPassSummary({
      passNumber: 1,
      summary: 'First pass',
      unresolvedIssues: ['issue1'],
      contextForNextPass: 'ctx1',
      filesInScope: ['a.ts'],
    });
    store.addPassSummary({
      passNumber: 2,
      summary: 'Second pass',
      unresolvedIssues: [],
      contextForNextPass: 'ctx2',
      filesInScope: ['b.ts'],
    });
    const summaries = store.loadPassSummaries();
    expect(summaries).toHaveLength(2);
    expect(summaries[0].passNumber).toBe(1);
    expect(summaries[1].passNumber).toBe(2);
  });

  it('isolates pass summaries by runId', () => {
    store.saveState({
      runId: 'run-a',
      status: 'running',
      userRequest: 'run a',
      decomposition: { reasoning: '', tasks: [], suggestedOrder: [] },
      currentTaskIndex: 0,
      passes: [],
    });
    store.addPassSummary({
      passNumber: 1,
      summary: 'summary a',
      unresolvedIssues: [],
      contextForNextPass: 'ctx a',
      filesInScope: ['a.ts'],
    });

    store.saveState({
      runId: 'run-b',
      status: 'running',
      userRequest: 'run b',
      decomposition: { reasoning: '', tasks: [], suggestedOrder: [] },
      currentTaskIndex: 0,
      passes: [],
    });
    store.addPassSummary({
      passNumber: 1,
      summary: 'summary b',
      unresolvedIssues: [],
      contextForNextPass: 'ctx b',
      filesInScope: ['b.ts'],
    });

    const runASummaries = store.loadPassSummaries('run-a');
    const runBSummaries = store.loadPassSummaries('run-b');

    expect(runASummaries).toHaveLength(1);
    expect(runASummaries[0].summary).toBe('summary a');
    expect(runBSummaries).toHaveLength(1);
    expect(runBSummaries[0].summary).toBe('summary b');
  });

  it('clears all state', () => {
    store.saveState({
      status: 'running',
      userRequest: 'test',
      decomposition: { reasoning: '', tasks: [], suggestedOrder: [] },
      currentTaskIndex: 0,
      passes: [],
    });
    store.addPassSummary({
      passNumber: 1,
      summary: 'test',
      unresolvedIssues: [],
      contextForNextPass: '',
      filesInScope: [],
    });
    store.clear();
    expect(store.loadState()).toBeNull();
    expect(store.loadPassSummaries()).toEqual([]);
  });
});
