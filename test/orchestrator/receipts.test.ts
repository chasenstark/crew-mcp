import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  buildRunReceipt,
  renderRunSummaryMarkdown,
  writeRunReceipt,
  RUN_RECEIPT_FILENAME,
  RUN_SUMMARY_FILENAME,
  type RunReceiptV1,
} from '../../src/orchestrator/receipts.js';
import { RunStateStore, type RunStateV1 } from '../../src/orchestrator/run-state.js';

function makeState(overrides: Partial<RunStateV1> = {}): RunStateV1 {
  return {
    schemaVersion: 1,
    runId: 'r-1',
    agentId: 'claude-code',
    status: 'success',
    startedAt: '2026-06-02T10:00:00.000Z',
    completedAt: '2026-06-02T10:01:12.000Z',
    worktreePath: '/wt/r-1',
    repoRoot: '/repo',
    prompts: [
      { turn: 1, prompt: 'do the thing', startedAt: '2026-06-02T10:00:00.000Z', completedAt: '2026-06-02T10:01:12.000Z', summary: 'Done. Edited foo.ts.' },
    ],
    filesChanged: ['foo.ts'],
    ...overrides,
  };
}

describe('buildRunReceipt', () => {
  it('projects state into the stable receipt shape with computed duration + turns', () => {
    const receipt = buildRunReceipt(makeState());
    expect(receipt).toMatchObject<Partial<RunReceiptV1>>({
      schemaVersion: 1,
      runId: 'r-1',
      agentId: 'claude-code',
      status: 'success',
      readOnly: false,
      startedAt: '2026-06-02T10:00:00.000Z',
      completedAt: '2026-06-02T10:01:12.000Z',
      durationMs: 72_000,
      turns: 1,
      filesChanged: ['foo.ts'],
      repoRoot: '/repo',
      merge: null,
      error: null,
      warnings: [],
    });
  });

  it('falls back to the last prompt completion when top-level completedAt is absent', () => {
    const receipt = buildRunReceipt(
      makeState({ completedAt: undefined }),
    );
    expect(receipt.completedAt).toBe('2026-06-02T10:01:12.000Z');
    expect(receipt.durationMs).toBe(72_000);
  });

  it('reports null duration when no terminal timestamp is parseable', () => {
    const receipt = buildRunReceipt(
      makeState({ completedAt: undefined, prompts: [{ turn: 1, prompt: 'x', startedAt: '2026-06-02T10:00:00.000Z' }] }),
    );
    expect(receipt.completedAt).toBeNull();
    expect(receipt.durationMs).toBeNull();
  });

  it('surfaces error, read-only, warnings, and merge disposition', () => {
    const receipt = buildRunReceipt(
      makeState({
        status: 'merged',
        readOnly: true,
        lastError: 'boom',
        warnings: ['edited despite read_only'],
        mergeStatus: { target: 'main', commitSha: 'abc123' },
      }),
    );
    expect(receipt.status).toBe('merged');
    expect(receipt.readOnly).toBe(true);
    expect(receipt.error).toBe('boom');
    expect(receipt.warnings).toEqual(['edited despite read_only']);
    expect(receipt.merge).toEqual({ target: 'main', commitSha: 'abc123' });
  });
});

describe('renderRunSummaryMarkdown', () => {
  it('includes status, files, and the agent output', () => {
    const md = renderRunSummaryMarkdown(makeState());
    expect(md).toContain('# Run r-1');
    expect(md).toContain('**Status:** success');
    expect(md).toContain('**Duration:** 1m 12s');
    expect(md).toContain('- foo.ts');
    expect(md).toContain('## Output');
    expect(md).toContain('Done. Edited foo.ts.');
  });

  it('renders error + warnings sections and flags read-only mode', () => {
    const md = renderRunSummaryMarkdown(
      makeState({ status: 'error', readOnly: true, lastError: 'kaboom', warnings: ['w1'] }),
    );
    expect(md).toContain('**Mode:** read-only');
    expect(md).toContain('## Error');
    expect(md).toContain('kaboom');
    expect(md).toContain('## Warnings');
    expect(md).toContain('- w1');
  });
});

describe('writeRunReceipt (integration through RunStateStore)', () => {
  let crewHome: string;
  let repoRoot: string;
  let store: RunStateStore;

  beforeEach(() => {
    crewHome = mkdtempSync(join(tmpdir(), 'crew-receipt-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'crew-receipt-repo-'));
    store = new RunStateStore({ crewHome, repoRoot });
  });
  afterEach(() => {
    rmSync(crewHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function readReceipt(runId: string): RunReceiptV1 {
    return JSON.parse(readFileSync(join(store.runDir(runId), RUN_RECEIPT_FILENAME), 'utf-8'));
  }

  it('markTerminal writes run.json + summary.md into the run dir', async () => {
    await store.create({ runId: 'r-t', agentId: 'codex', worktreePath: '/wt', initialPrompt: 'go' });
    store.markTerminal('r-t', { status: 'success', summary: 'all good', filesChanged: ['a.ts'] });

    const dir = store.runDir('r-t');
    expect(existsSync(join(dir, RUN_RECEIPT_FILENAME))).toBe(true);
    expect(existsSync(join(dir, RUN_SUMMARY_FILENAME))).toBe(true);

    const receipt = readReceipt('r-t');
    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.status).toBe('success');
    expect(receipt.agentId).toBe('codex');
    expect(receipt.filesChanged).toEqual(['a.ts']);

    const md = readFileSync(join(dir, RUN_SUMMARY_FILENAME), 'utf-8');
    expect(md).toContain('all good');
  });

  it('refreshes the receipt status on merge and discard', async () => {
    await store.create({ runId: 'r-m', agentId: 'codex', worktreePath: '/wt', initialPrompt: 'go' });
    store.markTerminal('r-m', { status: 'success', summary: 'ok', filesChanged: [] });
    store.markMerged('r-m', { target: 'main', commitSha: 'deadbeef' });
    expect(readReceipt('r-m')).toMatchObject({
      status: 'merged',
      merge: { target: 'main', commitSha: 'deadbeef' },
    });

    await store.create({ runId: 'r-d', agentId: 'codex', worktreePath: '/wt', initialPrompt: 'go' });
    store.markTerminal('r-d', { status: 'success', summary: 'ok', filesChanged: [] });
    store.markDiscarded('r-d');
    expect(readReceipt('r-d').status).toBe('discarded');
  });
});
