import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveCrewHome } from '../utils/crew-home.js';

const POLL_INTERVAL_MS = 1_000;
const TERMINAL_STATUSES = new Set([
  'success',
  'partial',
  'error',
  'cancelled',
  'merged',
  'merge_conflict',
  'discarded',
]);

interface PersistedRunState {
  readonly runId?: unknown;
  readonly agentId?: unknown;
  readonly status?: unknown;
  readonly worktreePath?: unknown;
}

export interface WaitForRunTerminalOptions {
  readonly runId: string;
  readonly crewHome?: string;
  readonly pollIntervalMs?: number;
  readonly writeStdout?: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

export async function waitForRunTerminal(
  options: WaitForRunTerminalOptions,
): Promise<void> {
  const crewHome = options.crewHome ?? resolveCrewHome();
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const writeStdout = options.writeStdout ?? ((line) => process.stdout.write(`${line}\n`));
  const statePath = join(crewHome, 'runs', options.runId, 'state.json');

  for (;;) {
    const state = await readStateIfPresent(statePath);
    if (state && typeof state.status === 'string' && TERMINAL_STATUSES.has(state.status)) {
      const runId = typeof state.runId === 'string' ? state.runId : options.runId;
      const agent = typeof state.agentId === 'string' ? state.agentId : '';
      const worktree = typeof state.worktreePath === 'string' ? state.worktreePath : '';
      writeStdout(
        `CREW_WAIT_TERMINAL run_id=${runId} agent=${agent} status=${state.status} worktree=${worktree}`,
      );
      return;
    }

    await sleep(pollIntervalMs);
  }
}

export function usage(): string {
  return [
    'Usage: crew-wait <run_id>',
    '',
    'Wait for a crew run to reach a terminal state and print one terminal metadata line.',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  if (argv.length !== 1 || argv[0].startsWith('-')) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  await waitForRunTerminal({ runId: argv[0] });
  return 0;
}

async function readStateIfPresent(path: string): Promise<PersistedRunState | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return undefined;
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid crew run state at ${path}: expected JSON object`);
  }
  return parsed as PersistedRunState;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`crew-wait: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
