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
    expect(loaded).toEqual(state);
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

  it('saves and loads conversation', () => {
    const messages = [
      { role: 'user' as const, content: 'Hello', timestamp: '2024-01-01T00:00:00Z' },
      { role: 'assistant' as const, content: 'Hi', timestamp: '2024-01-01T00:00:01Z' },
    ];
    store.saveConversation(messages);
    expect(store.loadConversation()).toEqual(messages);
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
