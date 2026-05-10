import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { listRuns } from '../../../src/orchestrator/tools/list-runs.js';
import type { RunStateV1, RunStatus } from '../../../src/orchestrator/run-state.js';

describe('listRuns', () => {
  let crewHome: string;
  let repoRoot: string;
  let otherRepoRoot: string;

  beforeEach(() => {
    crewHome = mkdtempSync(join(tmpdir(), 'crew-list-runs-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'crew-list-runs-repo-'));
    otherRepoRoot = mkdtempSync(join(tmpdir(), 'crew-list-runs-other-'));
  });

  afterEach(() => {
    rmSync(crewHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(otherRepoRoot, { recursive: true, force: true });
  });

  it('filters by status when given a single status or an array', () => {
    writeState({ runId: 'run-running', status: 'running', repoRoot });
    writeState({ runId: 'run-success', status: 'success', repoRoot, completedAt: iso(2) });
    writeState({ runId: 'run-error', status: 'error', repoRoot, completedAt: iso(3) });

    expect(
      listRuns({ status: 'running' }, { crewHome, repoRoot }).runs.map((run) => run.run_id),
    ).toEqual(['run-running']);

    expect(
      listRuns({ status: ['success', 'error'] }, { crewHome, repoRoot })
        .runs.map((run) => run.run_id),
    ).toEqual(['run-error', 'run-success']);
  });

  it('implicitly filters to the current repoRoot', () => {
    writeState({ runId: 'current-repo-run', status: 'running', repoRoot });
    writeState({ runId: 'other-repo-run', status: 'running', repoRoot: otherRepoRoot });

    const out = listRuns({}, { crewHome, repoRoot });

    expect(out.runs.map((run) => run.run_id)).toEqual(['current-repo-run']);
  });

  it('includes legacy records missing repoRoot only when include_unknown_repo is true', () => {
    writeState({ runId: 'known-repo-run', status: 'running', repoRoot });
    writeState({ runId: 'unknown-repo-run', status: 'running', repoRoot: undefined });

    expect(
      listRuns({}, { crewHome, repoRoot }).runs.map((run) => run.run_id),
    ).toEqual(['known-repo-run']);

    expect(
      listRuns({ include_unknown_repo: true }, { crewHome, repoRoot })
        .runs.map((run) => run.run_id),
    ).toEqual(['unknown-repo-run', 'known-repo-run']);
  });

  it('filters terminal runs by completedAfter', () => {
    writeState({ runId: 'old-terminal', status: 'success', repoRoot, completedAt: iso(1) });
    writeState({ runId: 'equal-terminal', status: 'success', repoRoot, completedAt: iso(2) });
    writeState({ runId: 'new-terminal', status: 'error', repoRoot, completedAt: iso(3) });
    writeState({ runId: 'running-after', status: 'running', repoRoot, startedAt: iso(4) });

    const out = listRuns({ completedAfter: iso(2) }, { crewHome, repoRoot });

    expect(out.runs.map((run) => run.run_id)).toEqual(['new-terminal']);
  });

  it('applies limit after newest-first sorting', () => {
    writeState({ runId: 'run-1', status: 'success', repoRoot, completedAt: iso(1) });
    writeState({ runId: 'run-2', status: 'success', repoRoot, completedAt: iso(2) });
    writeState({ runId: 'run-3', status: 'success', repoRoot, completedAt: iso(3) });

    const out = listRuns({ limit: 2 }, { crewHome, repoRoot });

    expect(out.runs.map((run) => run.run_id)).toEqual(['run-3', 'run-2']);
  });

  it('sorts by completedAt, falls back to startedAt, and breaks ties by run_id descending', () => {
    writeState({ runId: 'run-a', status: 'success', repoRoot, completedAt: iso(3) });
    writeState({ runId: 'run-b', status: 'error', repoRoot, completedAt: iso(3) });
    writeState({ runId: 'run-c', status: 'success', repoRoot, completedAt: iso(2) });
    writeState({ runId: 'run-running', status: 'running', repoRoot, startedAt: iso(4) });

    const out = listRuns({}, { crewHome, repoRoot });

    expect(out.runs.map((run) => run.run_id)).toEqual([
      'run-running',
      'run-b',
      'run-a',
      'run-c',
    ]);
  });

  it('falls back to lastError when the latest prompt has no summary', () => {
    writeState({
      runId: 'sweeper-marked-error',
      status: 'error',
      repoRoot,
      completedAt: iso(2),
      lastError: 'abandoned (server restart)',
      promptSummary: undefined,
    });
    writeState({
      runId: 'adapter-error',
      status: 'error',
      repoRoot,
      completedAt: iso(1),
      lastError: 'adapter failed',
      promptSummary: 'adapter summary wins',
    });

    const out = listRuns({ status: 'error' }, { crewHome, repoRoot });

    expect(out.runs).toMatchObject([
      { run_id: 'sweeper-marked-error', summary: 'abandoned (server restart)' },
      { run_id: 'adapter-error', summary: 'adapter summary wins' },
    ]);
  });

  function writeState(args: {
    runId: string;
    status: RunStatus;
    repoRoot?: string;
    startedAt?: string;
    completedAt?: string;
    lastError?: string;
    promptSummary?: string;
  }): void {
    const startedAt = args.startedAt ?? iso(0);
    const state: RunStateV1 = {
      schemaVersion: 1,
      runId: args.runId,
      agentId: 'codex',
      status: args.status,
      startedAt,
      ...(args.completedAt ? { completedAt: args.completedAt } : {}),
      worktreePath: `/tmp/${args.runId}`,
      ...(args.repoRoot ? { repoRoot: realpathSync(args.repoRoot) } : {}),
      prompts: [
        {
          turn: 1,
          prompt: 'do work',
          startedAt,
          ...(args.completedAt ? { completedAt: args.completedAt } : {}),
          ...(args.promptSummary ? { summary: args.promptSummary } : {}),
        },
      ],
      filesChanged: [],
      ...(args.lastError ? { lastError: args.lastError } : {}),
    };
    const dir = join(crewHome, 'runs', args.runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');
  }
});

function iso(minute: number): string {
  return `2026-05-09T00:${String(minute).padStart(2, '0')}:00.000Z`;
}
