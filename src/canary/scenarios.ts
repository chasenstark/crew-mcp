import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunStateV1 } from '../orchestrator/run-state.js';
import { toolJournalPath, type ToolJournalRecord } from '../utils/tool-journal.js';
import { watchIndexPath, type WatchIndexRecord } from '../utils/watch-index.js';

export const STALE_RUN_ID = 'canary-stale-read-only';
const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1_000;

export interface CanaryTrace {
  readonly journal: readonly ToolJournalRecord[];
  readonly watches: readonly WatchIndexRecord[];
  /** JIT warnings extracted only from structured host tool_result events. */
  readonly jitNudges: readonly string[];
}

export interface ScenarioAssertion {
  readonly pass: boolean;
  readonly detail: string;
}

export interface CanaryPreseed {
  readonly kind: 'stale-terminal-read-only';
  readonly runId: string;
  readonly ageMs: number;
}

export interface CanaryScenario {
  readonly id: 'dispatch-and-watch' | 'skipped-inbox' | 'stale-read-only-regression';
  readonly captainPrompt: string;
  readonly preseed?: CanaryPreseed;
  readonly predicate: (trace: CanaryTrace) => ScenarioAssertion;
}

export const CANARY_SCENARIOS: readonly CanaryScenario[] = [
  {
    id: 'dispatch-and-watch',
    captainPrompt: [
      'Run this Crew compliance canary exactly once.',
      'Dispatch agent_id "canary-stub-write" in write mode with a short task.',
      'Immediately launch the crew-wait watcher command from the dispatch envelope.',
      'When it reports terminal, call get_run_status for that run, then end the turn.',
      'Do not merge or discard the run.',
    ].join(' '),
    predicate: (trace) => {
      const starts = trace.watches.filter((record) => record.event === 'start');
      const terminals = trace.watches.filter((record) => record.event === 'terminal_observed');
      const completedStarts = starts.filter((start) => terminals.some((terminal) => (
        terminal.run_id === start.run_id
        && Date.parse(terminal.ts) >= Date.parse(start.ts)
      )));
      const livenessFailure = requireLiveness(
        completedStarts.length > 0,
        'no watched run reached terminal_observed',
      );
      if (livenessFailure) return livenessFailure;
      const ordered = completedStarts.some((start) => terminals.some((terminal) => (
        terminal.run_id === start.run_id
        && trace.journal.some((record) => (
          record.tool === 'get_run_status'
          && record.run_id === start.run_id
          && !record.isError
          && Date.parse(record.ts) >= Date.parse(terminal.ts)
        ))
      )));
      const orphaned = trace.jitNudges.some((warning) => warning.includes('orphan_recovery:'));
      return {
        pass: ordered && !orphaned,
        detail: ordered
          ? (orphaned ? 'watch/status observed, but orphan_recovery fired' : 'watch start preceded terminal status read')
          : 'missing ordered watch start and get_run_status read',
      };
    },
  },
  {
    id: 'skipped-inbox',
    captainPrompt: [
      'Run this Crew compliance canary exactly once.',
      'Dispatch agent_id "canary-stub-message" in write mode with a short task.',
      'Read the run at terminal, then surface its worker message with check_captain_inbox',
      'and acknowledge that message before ending the turn. Do not merge or discard.',
    ].join(' '),
    predicate: (trace) => {
      const surfaced = trace.journal.some((record) => (
        (record.tool === 'check_captain_inbox' || record.tool === 'acknowledge_messages')
        && !record.isError
      ));
      return {
        pass: surfaced,
        detail: surfaced ? 'captain inbox was surfaced' : 'no inbox check or acknowledgement',
      };
    },
  },
  {
    id: 'stale-read-only-regression',
    captainPrompt: [
      'Call the Crew list_agents tool once, then end the turn.',
      'This is an unrelated-tool regression probe: do not inspect, recover, merge,',
      'discard, or mention any existing run.',
    ].join(' '),
    preseed: {
      kind: 'stale-terminal-read-only',
      runId: STALE_RUN_ID,
      ageMs: TEN_DAYS_MS,
    },
    predicate: (trace) => {
      const livenessFailure = requireLiveness(
        trace.journal.some((record) => record.tool === 'list_agents' && !record.isError),
        'expected list_agents activity is absent',
      );
      if (livenessFailure) return livenessFailure;
      const overfire = trace.jitNudges.some((warning) => (
        warning.includes(STALE_RUN_ID)
        && (
          warning.includes('orphan_recovery:')
          || warning.includes('unsurfaced_terminal:')
        )
      ));
      return {
        pass: !overfire,
        detail: overfire
          ? 'stale read-only run triggered orphan/unsurfaced recovery'
          : 'stale read-only run produced no recovery nudge',
      };
    },
  },
] as const;

function requireLiveness(
  satisfied: boolean,
  detail: string,
): ScenarioAssertion | undefined {
  return satisfied ? undefined : { pass: false, detail: `liveness failed: ${detail}` };
}

export function loadCanaryScenarios(): readonly CanaryScenario[] {
  const ids = new Set<string>();
  for (const scenario of CANARY_SCENARIOS) {
    if (ids.has(scenario.id)) throw new Error(`Duplicate canary scenario id: ${scenario.id}`);
    ids.add(scenario.id);
  }
  return CANARY_SCENARIOS;
}

export function readCanaryTrace(
  crewHome: string,
  jitNudges: readonly string[] = [],
): CanaryTrace {
  return {
    journal: readJsonl<ToolJournalRecord>(toolJournalPath(crewHome)),
    watches: readJsonl<WatchIndexRecord>(watchIndexPath(crewHome)),
    jitNudges: [...jitNudges],
  };
}

export function applyScenarioPreseed(args: {
  readonly scenario: CanaryScenario;
  readonly crewHome: string;
  readonly repoRoot: string;
  readonly now: Date;
}): void {
  const seed = args.scenario.preseed;
  if (!seed) return;
  const completedAt = new Date(args.now.getTime() - seed.ageMs);
  const startedAt = new Date(completedAt.getTime() - 60_000);
  const state: RunStateV1 = {
    schemaVersion: 1,
    runId: seed.runId,
    agentId: 'canary-stub-read-only',
    status: 'success',
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    worktreePath: args.repoRoot,
    repoRoot: args.repoRoot,
    runMode: 'read_only',
    readOnly: true,
    prompts: [{
      turn: 1,
      prompt: 'Synthetic stale read-only canary fixture.',
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      summary: 'Synthetic terminal fixture.',
    }],
    filesChanged: [],
  };
  const runDir = join(args.crewHome, 'runs', seed.runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}
