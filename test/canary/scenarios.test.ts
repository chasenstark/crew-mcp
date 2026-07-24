import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ToolJournalRecord } from '../../src/utils/tool-journal.js';
import type { WatchIndexRecord } from '../../src/utils/watch-index.js';
import {
  loadCanaryScenarios,
  applyScenarioPreseed,
  STALE_RUN_ID,
  type CanaryTrace,
} from '../../src/canary/scenarios.js';

const BASE_TRACE: CanaryTrace = { journal: [], watches: [], jitNudges: [] };

describe('canary scenarios', () => {
  const scenarios = loadCanaryScenarios();

  it('loads the three declarative dogfood scenarios with unique ids', () => {
    expect(scenarios.map((scenario) => scenario.id)).toEqual([
      'dispatch-and-watch',
      'skipped-inbox',
      'stale-read-only-regression',
    ]);
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(scenarios.length);
    expect(scenarios.every((scenario) => scenario.captainPrompt.length > 0)).toBe(true);
    expect(scenarios.find((scenario) => scenario.id === 'stale-read-only-regression')?.preseed)
      .toMatchObject({ kind: 'stale-terminal-read-only', runId: STALE_RUN_ID });
  });

  it.each([
    {
      id: 'dispatch-and-watch',
      compliant: {
        ...BASE_TRACE,
        watches: [
          watchStart('run-1', '2026-07-23T12:00:01.000Z'),
          watchTerminal('run-1', '2026-07-23T12:00:02.000Z'),
        ],
        journal: [journal('get_run_status', '2026-07-23T12:00:02.000Z', 'run-1')],
      },
      violating: {
        ...BASE_TRACE,
        watches: [watchStart('run-1', '2026-07-23T12:00:01.000Z')],
        journal: [journal('get_run_status', '2026-07-23T12:00:02.000Z', 'run-1')],
      },
    },
    {
      id: 'skipped-inbox',
      compliant: {
        ...BASE_TRACE,
        journal: [journal('check_captain_inbox', '2026-07-23T12:00:02.000Z')],
      },
      violating: {
        ...BASE_TRACE,
        journal: [journal('get_run_status', '2026-07-23T12:00:02.000Z', 'run-2')],
      },
    },
    {
      id: 'stale-read-only-regression',
      compliant: {
        ...BASE_TRACE,
        journal: [journal('list_agents', '2026-07-23T12:00:01.000Z')],
      },
      violating: {
        ...BASE_TRACE,
        journal: [journal('list_agents', '2026-07-23T12:00:01.000Z')],
        jitNudges: [
          `orphan_recovery: run "${STALE_RUN_ID}" became terminal without a watcher claim.`,
        ],
      },
    },
  ])('$id passes compliant trace and fails violating trace', ({ id, compliant, violating }) => {
    const scenario = scenarios.find((candidate) => candidate.id === id);
    expect(scenario?.predicate(compliant).pass).toBe(true);
    expect(scenario?.predicate(violating).pass).toBe(false);
  });

  it('does not let an empty trace pass the absence-based stale regression', () => {
    const scenario = scenarios.find((candidate) => candidate.id === 'stale-read-only-regression')!;
    expect(scenario.predicate(BASE_TRACE)).toEqual({
      pass: false,
      detail: 'liveness failed: expected list_agents activity is absent',
    });
  });

  it('does not treat a pre-terminal status poll as the terminal read', () => {
    const scenario = scenarios.find((candidate) => candidate.id === 'dispatch-and-watch')!;
    expect(scenario.predicate({
      ...BASE_TRACE,
      watches: [
        watchStart('run-1', '2026-07-23T12:00:01.000Z'),
        watchTerminal('run-1', '2026-07-23T12:00:03.000Z'),
      ],
      journal: [journal('get_run_status', '2026-07-23T12:00:02.000Z', 'run-1')],
    }).pass).toBe(false);
  });

  it('preseeds the stale fixture from an injected clock', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-canary-seed-'));
    try {
      const scenario = scenarios.find((candidate) => candidate.id === 'stale-read-only-regression')!;
      const now = new Date('2026-07-23T12:00:00.000Z');
      applyScenarioPreseed({
        scenario,
        crewHome: join(root, 'crew-home'),
        repoRoot: join(root, 'repo'),
        now,
      });
      const state = JSON.parse(readFileSync(
        join(root, 'crew-home', 'runs', STALE_RUN_ID, 'state.json'),
        'utf-8',
      )) as { completedAt: string; runMode: string };
      expect(state.completedAt).toBe('2026-07-13T12:00:00.000Z');
      expect(state.runMode).toBe('read_only');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function journal(tool: string, ts: string, runId?: string): ToolJournalRecord {
  return {
    ts,
    tool,
    ...(runId ? { run_id: runId } : {}),
    args_digest: {},
    isError: false,
    duration_ms: 1,
    clientKind: 'claude-code',
    captainServeInstance: 'canary-test',
  };
}

function watchStart(runId: string, ts: string): WatchIndexRecord {
  return {
    event: 'start',
    ts,
    run_id: runId,
    watcher_pid: 123,
    watcher_instance: 'canary-test',
  };
}

function watchTerminal(runId: string, ts: string): WatchIndexRecord {
  return {
    event: 'terminal_observed',
    ts,
    run_id: runId,
    watcher_pid: 123,
    watcher_instance: 'canary-test',
    status: 'success',
    exit_outcome: 0,
    terminal_at: ts,
  };
}
