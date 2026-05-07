/**
 * Unit tests for the per-run state store.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { RunStateStore } from '../../src/orchestrator/run-state.js';

describe('RunStateStore', () => {
  let crewHome: string;
  let repoRoot: string;
  let store: RunStateStore;

  beforeEach(() => {
    crewHome = mkdtempSync(join(tmpdir(), 'crew-runstate-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'crew-runstate-repo-'));
    store = new RunStateStore({ crewHome, repoRoot });
  });
  afterEach(() => {
    rmSync(crewHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('create() writes a state.json with status: running under crewHome/runs/', () => {
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
    expect(existsSync(join(crewHome, 'runs', 'r-1', 'state.json'))).toBe(true);
  });

  it('create() persists repoRoot (symlink-resolved) on the state', () => {
    const state = store.create({
      runId: 'r-1',
      agentId: 'a',
      worktreePath: '/x',
      initialPrompt: 'p',
    });
    // realpath because macOS tmpdir is a symlink (/var/... → /private/var/...)
    expect(state.repoRoot).toBe(realpathSync(repoRoot));
  });

  it('create() does NOT write under the host repoRoot (host repo stays clean)', () => {
    store.create({
      runId: 'r-1',
      agentId: 'a',
      worktreePath: '/x',
      initialPrompt: 'p',
    });
    expect(existsSync(join(repoRoot, '.crew'))).toBe(false);
  });

  it('create() drops an executable tail.command helper next to events.log', () => {
    // The tail.command file is the user-facing progress channel — a
    // tiny shell script that, when opened (macOS double-click /
    // Linux `bash <path>`), follows the run's events.log live in a
    // side terminal. We assert: existence, expected path
    // (`tailCommandPath` returns the canonical location), executable
    // bit, shebang, and that the embedded path matches the run's
    // events.log.
    store.create({
      runId: 'r-1',
      agentId: 'a',
      worktreePath: '/x',
      initialPrompt: 'p',
    });
    const tailPath = store.tailCommandPath('r-1');
    expect(tailPath).toBe(join(crewHome, 'runs', 'r-1', 'tail.command'));
    expect(existsSync(tailPath)).toBe(true);
    expect(statSync(tailPath).mode & 0o100).toBe(0o100);

    const contents = readFileSync(tailPath, 'utf-8');
    expect(contents.startsWith('#!/bin/bash\n')).toBe(true);
    expect(contents).toContain(`exec tail -F '${store.eventsLogPath('r-1')}'`);
  });

  it('tail.command embeds the events.log path with single-quote escaping', () => {
    // Defense against a run id that contains a single quote (rare but
    // not impossible if a future runId scheme uses unusual characters).
    // The script wraps the path in single quotes and `'\''` -escapes
    // any quote in the path itself.
    const trickyRunId = "r'1";
    store.create({
      runId: trickyRunId,
      agentId: 'a',
      worktreePath: '/x',
      initialPrompt: 'p',
    });
    const tailPath = store.tailCommandPath(trickyRunId);
    const contents = readFileSync(tailPath, 'utf-8');
    // The single quote in the runId becomes part of the events.log
    // path, which is then `'\''`-escaped inside the outer single
    // quotes — confirming the path can't break out of the quoting.
    expect(contents).toContain("'\\''");
    // Sanity: the script can be parsed by bash without breaking out
    // of the quoting (bash -n).
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:child_process').execSync(`bash -n ${JSON.stringify(tailPath)}`);
    }).not.toThrow();
  });

  it('read() returns undefined for unknown runs', () => {
    expect(store.read('nope')).toBeUndefined();
  });

  it('read() throws for unknown schemaVersion', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    writeFileSync(
      join(crewHome, 'runs', 'r-1', 'state.json'),
      JSON.stringify({ schemaVersion: 99 }),
      'utf-8',
    );
    expect(() => store.read('r-1')).toThrow(/schemaVersion/);
  });

  it('read() tolerates legacy v1 records without repoRoot (no throw, undefined field)', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    writeFileSync(
      join(crewHome, 'runs', 'r-1', 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId: 'r-1',
        agentId: 'a',
        status: 'running',
        startedAt: '2026-05-04T00:00:00Z',
        worktreePath: '/x',
        prompts: [{ turn: 1, prompt: 'p', startedAt: '2026-05-04T00:00:00Z' }],
        filesChanged: [],
      }),
      'utf-8',
    );
    const state = store.read('r-1');
    expect(state).toBeDefined();
    expect(state?.repoRoot).toBeUndefined();
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
