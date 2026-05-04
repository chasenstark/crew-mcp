/**
 * Unit tests for the per-run state store.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { RunStateStore } from '../../src/orchestrator/run-state.js';

describe('RunStateStore', () => {
  let root: string;
  let store: RunStateStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-runstate-'));
    store = new RunStateStore(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('create() writes a state.json with status: running', () => {
    const state = store.create({
      runId: 'r-1',
      agentId: 'mock-coder',
      worktreePath: '/tmp/wt',
      initialPrompt: 'do a thing',
    });
    expect(state.status).toBe('running');
    expect(state.prompts).toHaveLength(1);
    expect(state.prompts[0].turn).toBe(1);
    expect(state.prompts[0].prompt).toBe('do a thing');
    expect(existsSync(join(root, '.crew', 'runs', 'r-1', 'state.json'))).toBe(true);
  });

  it('read() returns undefined for unknown runs', () => {
    expect(store.read('nope')).toBeUndefined();
  });

  it('read() throws for unknown schemaVersion', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    writeFileSync(
      join(root, '.crew', 'runs', 'r-1', 'state.json'),
      JSON.stringify({ schemaVersion: 99 }),
      'utf-8',
    );
    expect(() => store.read('r-1')).toThrow(/schemaVersion/);
  });

  it('appendPrompt() resets status to running and grows prompts', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'first' });
    store.markTerminal('r-1', { status: 'success', summary: 'ok', filesChanged: [] });
    const next = store.appendPrompt('r-1', 'second');
    expect(next.status).toBe('running');
    expect(next.completedAt).toBeUndefined();
    expect(next.prompts).toHaveLength(2);
    expect(next.prompts[1].turn).toBe(2);
    expect(next.prompts[1].prompt).toBe('second');
  });

  it('markTerminal() sets status + completedAt + summary on the last prompt', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    const next = store.markTerminal('r-1', {
      status: 'success',
      summary: 'all done',
      filesChanged: ['src/a.ts', 'src/b.ts'],
    });
    expect(next.status).toBe('success');
    expect(next.completedAt).toBeDefined();
    expect(next.filesChanged).toEqual(['src/a.ts', 'src/b.ts']);
    expect(next.prompts[0].completedAt).toBeDefined();
    expect(next.prompts[0].summary).toBe('all done');
  });

  it('markTerminal() unions filesChanged across turns', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    store.markTerminal('r-1', {
      status: 'success',
      summary: 'first',
      filesChanged: ['a.ts', 'b.ts'],
    });
    store.appendPrompt('r-1', 'second turn');
    const next = store.markTerminal('r-1', {
      status: 'success',
      summary: 'second',
      filesChanged: ['b.ts', 'c.ts'],
    });
    expect(next.filesChanged.slice().sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('markMerged() / markMergeConflict() / markDiscarded() transition status', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    store.markTerminal('r-1', { status: 'success', summary: 'ok', filesChanged: [] });

    const merged = store.markMerged('r-1', { target: 'main', commitSha: 'abc123' });
    expect(merged.status).toBe('merged');
    expect(merged.mergeStatus).toEqual({ target: 'main', commitSha: 'abc123' });

    store.create({ runId: 'r-2', agentId: 'a', worktreePath: '/y', initialPrompt: 'q' });
    const conflict = store.markMergeConflict('r-2', {
      target: 'main',
      conflicts: ['src/a.ts'],
    });
    expect(conflict.status).toBe('merge_conflict');
    expect(conflict.mergeStatus?.conflicts).toEqual(['src/a.ts']);

    const discarded = store.markDiscarded('r-2');
    expect(discarded?.status).toBe('discarded');
  });

  it('markDiscarded() returns undefined for unknown runs (idempotent)', () => {
    expect(store.markDiscarded('nope')).toBeUndefined();
  });

  it('appendEvent() / tailEvents() roundtrip', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    store.appendEvent('r-1', 'line one');
    store.appendEvent('r-1', 'line two\n'); // trailing newline tolerated
    store.appendEvent('r-1', 'line three');
    const tail = store.tailEvents('r-1', 2);
    expect(tail).toEqual(['line two', 'line three']);
  });

  it('tailEvents() returns [] when log does not exist', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    expect(store.tailEvents('r-1')).toEqual([]);
  });
});
