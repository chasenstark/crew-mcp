import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  detectJitNudges,
  DETECTION_JOURNAL_TAIL_BYTES,
  JIT_NUDGE_MAX_BYTES,
  JIT_NUDGE_MAX_COUNT,
  TERMINAL_NUDGE_RECENCY_CEILING_MS,
  type ConfirmationAttempt,
} from '../../../src/orchestrator/detection/jit-nudges.js';
import type { RunStateV1 } from '../../../src/orchestrator/run-state.js';
import {
  isWaitingWaitParams,
  type ToolJournalRecord,
} from '../../../src/utils/tool-journal.js';
import type { WatchIndexRecord } from '../../../src/utils/watch-index.js';

const NOW_MS = Date.parse('2026-07-22T16:00:00.000Z');
const MINUTE_MS = 60 * 1_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

interface Fixture {
  readonly root: string;
  readonly crewHome: string;
  readonly repoRoot: string;
}

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe('detectJitNudges', () => {
  it('warns for a recent terminal write run with no current-generation watcher claim', () => {
    const fixture = makeFixture();
    writeState(fixture, stateFixture({
      runId: 'orphan-run',
      status: 'success',
      generationStartedAtMs: NOW_MS - 5 * MINUTE_MS,
      completedAtMs: NOW_MS - 3 * MINUTE_MS,
      runMode: 'write',
    }));

    const warnings = detect(fixture, { clientKind: 'claude-code' });
    expect(warnings).toContainEqual(expect.stringContaining('orphan_recovery: run "orphan-run"'));
  });

  it('suppresses stale orphan and unsurfaced terminal warnings beyond the recency ceiling', () => {
    const fixture = makeFixture();
    writeState(fixture, stateFixture({
      runId: 'stale-run',
      status: 'success',
      generationStartedAtMs: NOW_MS - TERMINAL_NUDGE_RECENCY_CEILING_MS - 2 * MINUTE_MS,
      completedAtMs: NOW_MS - TERMINAL_NUDGE_RECENCY_CEILING_MS - MINUTE_MS,
      runMode: 'write',
    }));

    const warnings = detect(fixture, { clientKind: 'claude-code' });
    expect(warnings).not.toContainEqual(expect.stringContaining('orphan_recovery'));
    expect(warnings).not.toContainEqual(expect.stringContaining('unsurfaced_terminal'));
  });

  it('suppresses orphan recovery for recent non-mergeable run modes', () => {
    for (const runMode of ['read_only', 'ephemeral_review'] as const) {
      const fixture = makeFixture();
      const runId = `recent-${runMode}`;
      writeState(fixture, stateFixture({
        runId,
        status: 'success',
        generationStartedAtMs: NOW_MS - 5 * MINUTE_MS,
        completedAtMs: NOW_MS - 3 * MINUTE_MS,
        runMode,
      }));

      expect(detect(fixture, { clientKind: 'claude-code' }))
        .not.toContainEqual(expect.stringContaining('orphan_recovery'));
    }
  });

  it('warns a Codex captain about a recent terminal write run with no watcher claim', () => {
    const fixture = makeFixture();
    writeState(fixture, stateFixture({
      runId: 'codex-orphan-run',
      status: 'success',
      generationStartedAtMs: NOW_MS - 5 * MINUTE_MS,
      completedAtMs: NOW_MS - 3 * MINUTE_MS,
      runMode: 'write',
    }));

    const warnings = detect(fixture, { clientKind: 'codex' });
    expect(warnings).toContainEqual(expect.stringContaining('orphan_recovery: run "codex-orphan-run"'));
  });

  it('warns a Codex captain about a running run whose current generation has no watcher', () => {
    const fixture = makeFixture();
    writeState(fixture, stateFixture({
      runId: 'codex-unwatched-run',
      status: 'running',
      generationStartedAtMs: NOW_MS - 5 * MINUTE_MS,
    }));

    const warnings = detect(fixture, { clientKind: 'codex' });
    expect(warnings).toContainEqual(
      expect.stringContaining('missing_watcher: running run "codex-unwatched-run"'),
    );
    // Only a Codex captain depends on crew-wait for wakes of running runs;
    // other hosts keep their existing terminal-side detections.
    for (const clientKind of ['claude-code', 'codex-legacy', 'unknown'] as const) {
      expect(detect(fixture, { clientKind }))
        .not.toContainEqual(expect.stringContaining('missing_watcher'));
    }
  });

  it('suppresses the missing-watcher nudge for watched, fresh, and stale running generations', () => {
    const watched = makeFixture();
    writeState(watched, stateFixture({
      runId: 'codex-watched-run',
      status: 'running',
      generationStartedAtMs: NOW_MS - 5 * MINUTE_MS,
    }));
    writeWatch(watched, [{
      event: 'start',
      ts: iso(NOW_MS - 4 * MINUTE_MS),
      run_id: 'codex-watched-run',
      watcher_pid: 100,
      watcher_instance: 'current-generation',
    }]);
    expect(detect(watched, { clientKind: 'codex' }))
      .not.toContainEqual(expect.stringContaining('missing_watcher'));

    const fresh = makeFixture();
    writeState(fresh, stateFixture({
      runId: 'codex-fresh-run',
      status: 'running',
      generationStartedAtMs: NOW_MS - 30_000,
    }));
    expect(detect(fresh, { clientKind: 'codex' }))
      .not.toContainEqual(expect.stringContaining('missing_watcher'));

    const stale = makeFixture();
    writeState(stale, stateFixture({
      runId: 'codex-stale-run',
      status: 'running',
      generationStartedAtMs: NOW_MS - TERMINAL_NUDGE_RECENCY_CEILING_MS - MINUTE_MS,
    }));
    expect(detect(stale, { clientKind: 'codex' }))
      .not.toContainEqual(expect.stringContaining('missing_watcher'));

    const priorGeneration = makeFixture();
    writeState(priorGeneration, stateFixture({
      runId: 'codex-continued-run',
      status: 'running',
      generationStartedAtMs: NOW_MS - 5 * MINUTE_MS,
      promptCount: 2,
    }));
    writeWatch(priorGeneration, [{
      event: 'start',
      ts: iso(NOW_MS - 20 * MINUTE_MS),
      run_id: 'codex-continued-run',
      watcher_pid: 100,
      watcher_instance: 'old-generation',
    }]);
    expect(detect(priorGeneration, { clientKind: 'codex' }))
      .toContainEqual(expect.stringContaining('missing_watcher: running run "codex-continued-run"'));
  });

  it('suppresses orphan recovery without watcher semantics, inside grace, and on continued running generations', () => {
    const nonWatcher = makeFixture();
    writeState(nonWatcher, stateFixture({
      runId: 'non-watcher-run',
      status: 'success',
      completedAtMs: NOW_MS - 3 * MINUTE_MS,
    }));
    for (const clientKind of ['unknown', 'codex-legacy'] as const) {
      expect(detect(nonWatcher, { clientKind }))
        .not.toContainEqual(expect.stringContaining('orphan_recovery'));
    }

    const grace = makeFixture();
    writeState(grace, stateFixture({
      runId: 'fast-run',
      status: 'success',
      completedAtMs: NOW_MS - MINUTE_MS,
    }));
    expect(detect(grace, { clientKind: 'claude-code' }))
      .not.toContainEqual(expect.stringContaining('orphan_recovery'));

    const continued = makeFixture();
    writeState(continued, stateFixture({
      runId: 'continued-run',
      status: 'running',
      generationStartedAtMs: NOW_MS - 30_000,
      promptCount: 2,
    }));
    writeWatch(continued, [{
      event: 'terminal_observed',
      ts: iso(NOW_MS - 10 * MINUTE_MS),
      run_id: 'continued-run',
      watcher_pid: 100,
      watcher_instance: 'old-generation',
      status: 'success',
      exit_outcome: 0,
      terminal_at: iso(NOW_MS - 10 * MINUTE_MS),
    }]);
    expect(detect(continued, { clientKind: 'claude-code' }))
      .not.toContainEqual(expect.stringContaining('orphan_recovery'));
  });

  it('accepts a watcher claim only for the current continued generation', () => {
    const fixture = makeFixture();
    writeState(fixture, stateFixture({
      runId: 'continued-terminal',
      status: 'success',
      generationStartedAtMs: NOW_MS - 5 * MINUTE_MS,
      completedAtMs: NOW_MS - 3 * MINUTE_MS,
      promptCount: 2,
    }));
    writeWatch(fixture, [
      {
        event: 'start',
        ts: iso(NOW_MS - 10 * MINUTE_MS),
        run_id: 'continued-terminal',
        watcher_pid: 100,
        watcher_instance: 'old-generation',
      },
      {
        event: 'start',
        ts: iso(NOW_MS - 4 * MINUTE_MS),
        run_id: 'continued-terminal',
        watcher_pid: 101,
        watcher_instance: 'current-generation',
      },
    ]);

    expect(detect(fixture, { clientKind: 'claude-code' }))
      .not.toContainEqual(expect.stringContaining('orphan_recovery'));
  });

  it('warns when a recent read-only terminal run stays unread while other calls arrive', () => {
    const fixture = makeFixture();
    writeState(fixture, stateFixture({
      runId: 'unread-run',
      status: 'error',
      completedAtMs: NOW_MS - 3 * MINUTE_MS,
      runMode: 'read_only',
    }));

    expect(detect(fixture, { currentTool: 'list_agents' }))
      .toContainEqual(expect.stringContaining('unsurfaced_terminal: run "unread-run"'));
  });

  it('suppresses the unsurfaced warning after a post-terminal get_run_status read', () => {
    const fixture = makeFixture();
    writeState(fixture, stateFixture({
      runId: 'read-run',
      status: 'error',
      completedAtMs: NOW_MS - 3 * MINUTE_MS,
    }));
    writeJournal(fixture, [journalRecord({
      tsMs: NOW_MS - 2 * MINUTE_MS,
      tool: 'get_run_status',
      runId: 'read-run',
    })]);

    expect(detect(fixture))
      .not.toContainEqual(expect.stringContaining('unsurfaced_terminal'));
  });

  it('warns on the third wait-bearing status call in the short window using a bounded tail', () => {
    const fixture = makeFixture();
    writeState(fixture, stateFixture({
      runId: 'poll-run',
      status: 'running',
      generationStartedAtMs: NOW_MS - 5 * MINUTE_MS,
    }));
    writeJournal(fixture, [
      journalRecord({ tsMs: NOW_MS - 40_000, tool: 'get_run_status', runId: 'poll-run', wait: true }),
      journalRecord({ tsMs: NOW_MS - 20_000, tool: 'get_run_status', runId: 'poll-run', wait: true }),
    ], 'x'.repeat(DETECTION_JOURNAL_TAIL_BYTES + 1_024) + '\n');

    const warnings = detect(fixture, {
      currentTool: 'get_run_status',
      currentRunId: 'poll-run',
      waitBearing: true,
    });
    expect(warnings).toContainEqual(expect.stringContaining('long_poll_loop: run "poll-run"'));
  });

  it('does not treat a single wait-bearing status call or immediate reads as long-polling', () => {
    const fixture = makeFixture();
    writeState(fixture, stateFixture({ runId: 'single-poll', status: 'running' }));
    writeJournal(fixture, [
      journalRecord({ tsMs: NOW_MS - 40_000, tool: 'get_run_status', runId: 'single-poll' }),
      journalRecord({ tsMs: NOW_MS - 20_000, tool: 'get_run_status', runId: 'single-poll' }),
    ]);

    expect(detect(fixture, {
      currentTool: 'get_run_status',
      currentRunId: 'single-poll',
      waitBearing: true,
    })).not.toContainEqual(expect.stringContaining('long_poll_loop'));
    expect(detect(fixture, {
      currentTool: 'get_run_status',
      currentRunId: 'single-poll',
      waitBearing: false,
    })).not.toContainEqual(expect.stringContaining('long_poll_loop'));
  });

  it('does not count explicit zero, false, or consent-only snapshot parameters', () => {
    const snapshotParams = [
      { wait_for_change_ms: 0 },
      { wait_for_terminal_only: false },
      { user_requested_wait: false },
    ] as const;
    for (const [index, waitParams] of snapshotParams.entries()) {
      const fixture = makeFixture();
      const runId = `explicit-snapshot-${index}`;
      writeState(fixture, stateFixture({ runId, status: 'running' }));
      writeJournal(fixture, [
        journalRecord({ tsMs: NOW_MS - 40_000, tool: 'get_run_status', runId, waitParams }),
        journalRecord({ tsMs: NOW_MS - 20_000, tool: 'get_run_status', runId, waitParams }),
      ]);

      expect(detect(fixture, {
        currentTool: 'get_run_status',
        currentRunId: runId,
        currentWaitParams: waitParams,
      })).not.toContainEqual(expect.stringContaining('long_poll_loop'));
    }
  });

  it('warns for an unresolved successful write run inside the GC warning margin', () => {
    const fixture = makeFixture();
    writeState(fixture, stateFixture({
      runId: 'aging-write',
      status: 'success',
      completedAtMs: NOW_MS - 28 * DAY_MS,
      generationStartedAtMs: NOW_MS - 29 * DAY_MS,
      runMode: 'write',
    }));

    expect(detect(fixture))
      .toContainEqual(expect.stringContaining('unmerged_run_gc_risk: successful write run "aging-write"'));
  });

  it('suppresses GC risk outside the margin and for structurally non-mergeable runs', () => {
    const fresh = makeFixture();
    writeState(fresh, stateFixture({
      runId: 'fresh-write',
      status: 'success',
      completedAtMs: NOW_MS - 26 * DAY_MS,
      generationStartedAtMs: NOW_MS - 27 * DAY_MS,
      runMode: 'write',
    }));
    expect(detect(fresh)).not.toContainEqual(expect.stringContaining('unmerged_run_gc_risk'));

    const readOnly = makeFixture();
    writeState(readOnly, stateFixture({
      runId: 'aging-read',
      status: 'success',
      completedAtMs: NOW_MS - 28 * DAY_MS,
      generationStartedAtMs: NOW_MS - 29 * DAY_MS,
      runMode: 'read_only',
    }));
    expect(detect(readOnly)).not.toContainEqual(expect.stringContaining('unmerged_run_gc_risk'));
  });

  it('uses the configured run-dir TTL so shorter retention warns earlier', () => {
    const fixture = makeFixture();
    writeRunDirTtlConfig(fixture, 7);
    writeState(fixture, stateFixture({
      runId: 'short-retention',
      status: 'success',
      completedAtMs: NOW_MS - 5 * DAY_MS,
      generationStartedAtMs: NOW_MS - 6 * DAY_MS,
      runMode: 'write',
    }));

    expect(detect(fixture)).toContainEqual(
      expect.stringContaining('short-retention" is nearing the 7-day run retention limit'),
    );
  });

  it('suppresses GC risk when run-dir retention is disabled', () => {
    const fixture = makeFixture();
    writeRunDirTtlConfig(fixture, -1);
    writeState(fixture, stateFixture({
      runId: 'retention-disabled',
      status: 'success',
      completedAtMs: NOW_MS - 100 * DAY_MS,
      generationStartedAtMs: NOW_MS - 101 * DAY_MS,
      runMode: 'write',
    }));

    expect(detect(fixture)).not.toContainEqual(expect.stringContaining('unmerged_run_gc_risk'));
  });

  it('warns only for a matching same-generation confirmed retry below one second', () => {
    const fixture = makeFixture();
    const attempt: ConfirmationAttempt = {
      tool: 'merge_run',
      runId: 'consent-run',
      confirmed: true,
      generation: '1:2026-07-22T15:00:00.000Z',
      attemptedAtMs: NOW_MS,
      previousRejection: {
        tool: 'merge_run',
        runId: 'consent-run',
        generation: '1:2026-07-22T15:00:00.000Z',
        rejectedAtMs: NOW_MS - 500,
      },
    };

    expect(detect(fixture, { confirmationAttempt: attempt }))
      .toContainEqual(expect.stringContaining('impossible_confirmation_latency: merge_run'));
  });

  it('suppresses multi-second, unconfirmed, and cross-generation confirmation retries', () => {
    const fixture = makeFixture();
    const base: ConfirmationAttempt = {
      tool: 'merge_run',
      runId: 'consent-run',
      confirmed: true,
      generation: '2:new',
      attemptedAtMs: NOW_MS,
      previousRejection: {
        tool: 'merge_run',
        runId: 'consent-run',
        generation: '2:new',
        rejectedAtMs: NOW_MS - 3_000,
      },
    };
    expect(detect(fixture, { confirmationAttempt: base }))
      .not.toContainEqual(expect.stringContaining('impossible_confirmation_latency'));
    expect(detect(fixture, { confirmationAttempt: { ...base, confirmed: false } }))
      .not.toContainEqual(expect.stringContaining('impossible_confirmation_latency'));
    expect(detect(fixture, {
      confirmationAttempt: {
        ...base,
        previousRejection: { ...base.previousRejection!, generation: '1:old' },
      },
    })).not.toContainEqual(expect.stringContaining('impossible_confirmation_latency'));
  });

  it('warns after repeated crew-wait exit-3 observations for the same run id', () => {
    const fixture = makeFixture();
    writeWatch(fixture, [
      unknownRunExit('typo-run', NOW_MS - 20_000, 'watch-a'),
      unknownRunExit('typo-run', NOW_MS - 10_000, 'watch-b'),
    ]);

    expect(detect(fixture))
      .toContainEqual(expect.stringContaining('watcher_unknown_run_respawn: crew-wait exited 3 for run "typo-run" 2 times'));
  });

  it('suppresses the crew-wait respawn warning after only one exit-3 observation', () => {
    const fixture = makeFixture();
    writeWatch(fixture, [unknownRunExit('one-miss', NOW_MS - 10_000, 'watch-a')]);

    expect(detect(fixture))
      .not.toContainEqual(expect.stringContaining('watcher_unknown_run_respawn'));
  });

  it('caps the warning count and aggregate UTF-8 bytes', () => {
    const fixture = makeFixture();
    writeWatch(fixture, Array.from({ length: 6 }, (_, index) => [
      unknownRunExit(`missing-${index}`, NOW_MS - 20_000, `watch-${index}-a`),
      unknownRunExit(`missing-${index}`, NOW_MS - 10_000, `watch-${index}-b`),
    ]).flat());

    const warnings = detect(fixture);
    expect(warnings).toHaveLength(JIT_NUDGE_MAX_COUNT);
    expect(Buffer.byteLength(warnings.join(''), 'utf-8')).toBeLessThanOrEqual(JIT_NUDGE_MAX_BYTES);
  });

  it('fails open on malformed bounded journal or run-state input', () => {
    const badJournal = makeFixture();
    mkdirSync(join(badJournal.crewHome, 'runs', '.meta'), { recursive: true });
    writeFileSync(join(badJournal.crewHome, 'runs', '.meta', 'tool-journal.jsonl'), '{bad json}\n');
    expect(detect(badJournal)).toEqual([]);

    const badState = makeFixture();
    mkdirSync(join(badState.crewHome, 'runs', 'broken'), { recursive: true });
    writeFileSync(join(badState.crewHome, 'runs', 'broken', 'state.json'), '{bad json}');
    expect(detect(badState)).toEqual([]);
  });
});

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'crew-jit-nudges-'));
  const fixture = {
    root,
    crewHome: join(root, 'crew-home'),
    repoRoot: join(root, 'repo'),
  };
  mkdirSync(fixture.crewHome, { recursive: true });
  mkdirSync(fixture.repoRoot, { recursive: true });
  fixtures.push(fixture);
  return fixture;
}

function detect(
  fixture: Fixture,
  options: {
    readonly clientKind?: 'claude-code' | 'codex' | 'codex-legacy' | 'unknown';
    readonly currentTool?: string;
    readonly currentRunId?: string;
    readonly waitBearing?: boolean;
    readonly currentWaitParams?: Readonly<Record<string, number | boolean>>;
    readonly confirmationAttempt?: ConfirmationAttempt;
  } = {},
): string[] {
  return detectJitNudges({
    crewHome: fixture.crewHome,
    repoRoot: fixture.repoRoot,
    clientKind: options.clientKind ?? 'unknown',
    currentCall: {
      tsMs: NOW_MS,
      tool: options.currentTool ?? 'list_agents',
      ...(options.currentRunId ? { runId: options.currentRunId } : {}),
      waitBearing: options.currentWaitParams !== undefined
        ? isWaitingWaitParams(options.currentWaitParams)
        : options.waitBearing ?? false,
    },
    ...(options.confirmationAttempt ? { confirmationAttempt: options.confirmationAttempt } : {}),
    nowMs: NOW_MS,
  });
}

function stateFixture(options: {
  readonly runId: string;
  readonly status: RunStateV1['status'];
  readonly generationStartedAtMs?: number;
  readonly completedAtMs?: number;
  readonly promptCount?: number;
  readonly runMode?: RunStateV1['runMode'];
}): RunStateV1 {
  const generationStartedAtMs = options.generationStartedAtMs ?? NOW_MS - 10 * MINUTE_MS;
  const promptCount = options.promptCount ?? 1;
  const prompts = Array.from({ length: promptCount }, (_, index) => ({
    turn: index + 1,
    prompt: `turn ${index + 1}`,
    startedAt: iso(index === promptCount - 1
      ? generationStartedAtMs
      : generationStartedAtMs - (promptCount - index) * MINUTE_MS),
    ...(index === promptCount - 1 && options.completedAtMs !== undefined
      ? { completedAt: iso(options.completedAtMs) }
      : {}),
  }));
  return {
    schemaVersion: 1,
    runId: options.runId,
    agentId: 'fixture-agent',
    status: options.status,
    startedAt: prompts[0].startedAt,
    ...(options.completedAtMs !== undefined ? { completedAt: iso(options.completedAtMs) } : {}),
    worktreePath: `/tmp/${options.runId}`,
    runMode: options.runMode ?? 'write',
    prompts,
    filesChanged: [],
  };
}

function writeState(fixture: Fixture, state: RunStateV1): void {
  const runDir = join(fixture.crewHome, 'runs', state.runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'state.json'),
    JSON.stringify({ ...state, repoRoot: fixture.repoRoot }),
  );
}

function journalRecord(options: {
  readonly tsMs: number;
  readonly tool: string;
  readonly runId?: string;
  readonly wait?: boolean;
  readonly waitParams?: Readonly<Record<string, number | boolean>>;
}): ToolJournalRecord {
  const waitParams = options.waitParams
    ?? (options.wait ? { wait_for_change_ms: 1_000 } : undefined);
  return {
    ts: iso(options.tsMs),
    tool: options.tool,
    ...(options.runId ? { run_id: options.runId } : {}),
    args_digest: {},
    ...(waitParams ? { wait_params: waitParams } : {}),
    isError: false,
    duration_ms: 1,
    clientKind: 'unknown',
    captainServeInstance: 'fixture-serve',
  };
}

function writeRunDirTtlConfig(fixture: Fixture, runDirTtlDays: number): void {
  writeFileSync(join(fixture.crewHome, 'config.json'), JSON.stringify({
    cleanup: {
      worktreeTtlDays: 7,
      runDirTtlDays,
      criteriaSetTtlDays: 30,
    },
  }));
}

function writeJournal(
  fixture: Fixture,
  records: readonly ToolJournalRecord[],
  prefix = '',
): void {
  const metaDir = join(fixture.crewHome, 'runs', '.meta');
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(
    join(metaDir, 'tool-journal.jsonl'),
    `${prefix}${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
}

function writeWatch(fixture: Fixture, records: readonly WatchIndexRecord[]): void {
  const metaDir = join(fixture.crewHome, 'runs', '.meta');
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(
    join(metaDir, 'watch-index.jsonl'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
}

function unknownRunExit(
  runId: string,
  tsMs: number,
  watcherInstance: string,
): WatchIndexRecord {
  return {
    event: 'terminal_observed',
    ts: iso(tsMs),
    run_id: runId,
    watcher_pid: 100,
    watcher_instance: watcherInstance,
    status: 'unknown',
    exit_outcome: 3,
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
