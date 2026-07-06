import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import {
  WORKER_READY_FILENAME,
  workerReadyMarkerSchema,
  type WorkerReadyMarker,
} from './sidecar-schema.js';
import type { RunStateStore } from '../run-state.js';
import { logger } from '../../utils/logger.js';

export function workerReadyMarkerPath(crewHome: string, runId: string): string {
  return join(crewHome, 'runs', runId, WORKER_READY_FILENAME);
}

export function writeWorkerReadyMarker(args: {
  readonly crewHome: string;
  readonly runId: string;
  readonly serverInstance: string;
  readonly registeredTools: readonly string[];
  readonly now?: Date;
}): WorkerReadyMarker {
  const marker: WorkerReadyMarker = {
    schema_version: 1,
    server_pid: process.pid,
    server_instance: args.serverInstance,
    started_at: (args.now ?? new Date()).toISOString(),
    registered_tools: [...args.registeredTools],
  };
  const path = workerReadyMarkerPath(args.crewHome, args.runId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(marker, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  chmodSync(path, 0o600);
  return marker;
}

export function readWorkerReadyMarker(
  crewHome: string,
  runId: string,
): WorkerReadyMarker | undefined {
  const path = workerReadyMarkerPath(crewHome, runId);
  if (!existsSync(path)) return undefined;
  const stat = statSync(path);
  if ((stat.mode & 0o777) !== 0o600) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  const result = workerReadyMarkerSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

export function deleteWorkerReadyMarker(crewHome: string, runId: string): void {
  rmSync(workerReadyMarkerPath(crewHome, runId), { force: true });
}

export function resolveWorkerReadyTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CREW_WORKER_READY_TIMEOUT_MS;
  if (raw === undefined) return 10_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 10_000;
  return Math.floor(parsed);
}

export function startWorkerReadyHandshake(args: {
  readonly crewHome: string;
  readonly runId: string;
  readonly runStateStore: RunStateStore;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}): void {
  const timeoutMs = args.timeoutMs ?? resolveWorkerReadyTimeoutMs();
  const intervalMs = args.intervalMs ?? 100;
  void observeWorkerReady(args, timeoutMs, intervalMs).catch((err) => {
    if (err instanceof Error && err.message.includes('state_lock_unavailable')) return;
    logger.warn(
      `worker-ready handshake failed for ${args.runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

async function observeWorkerReady(
  args: {
    readonly crewHome: string;
    readonly runId: string;
    readonly runStateStore: RunStateStore;
  },
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const marker = readWorkerReadyMarker(args.crewHome, args.runId);
    if (marker !== undefined) {
      await args.runStateStore.setWorkerReady(args.runId, {
        status: 'ready',
        markerObservedAt: new Date().toISOString(),
        markerServerPid: marker.server_pid,
        markerServerInstance: marker.server_instance,
      });
      return;
    }
    await sleep(Math.max(1, intervalMs));
  }
  const state = args.runStateStore.read(args.runId);
  if (state !== undefined && state.status !== 'running') return;
  await args.runStateStore.setWorkerReady(args.runId, { status: 'timeout' });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
