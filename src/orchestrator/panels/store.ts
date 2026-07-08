import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWrite } from '../../utils/atomic-write.js';
import { logger } from '../../utils/logger.js';
import {
  PANEL_SCHEMA_VERSION,
  panelStateSchemaV1,
  type PanelReviewerTerminalSnapshot,
  type PanelStateV1,
} from './schema.js';

// mtimeMs-keyed parse cache: get_panel_status re-reads panel.json per poll
// and run_panel re-reads it per reviewer transition, all of which zod-parse
// the whole file. Writers replace via rename, so a changed mtime (including
// from a sibling server process) invalidates; writePanelStateAtomic primes
// the cache with the just-written object so self-writes skip the re-parse.
// Callers treat panel state as immutable (all updates spread-copy).
const parsedPanelStateCache = new Map<string, { mtimeMs: number; state: PanelStateV1 }>();

export function panelDir(crewHome: string, panelId: string): string {
  return join(crewHome, 'panels', encodeURIComponent(panelId));
}

export function writePanelStateAtomic(targetPanelDir: string, state: PanelStateV1): void {
  const finalPath = join(targetPanelDir, 'panel.json');
  atomicWrite(finalPath, `${JSON.stringify(state, null, 2)}\n`, { makeDirs: false });
  try {
    parsedPanelStateCache.set(finalPath, { mtimeMs: statSync(finalPath).mtimeMs, state });
  } catch {
    parsedPanelStateCache.delete(finalPath);
  }
}

export function readPanelState(targetPanelDir: string): PanelStateV1 | undefined {
  const path = join(targetPanelDir, 'panel.json');
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch (err) {
    if (isEnoent(err)) {
      parsedPanelStateCache.delete(path);
      return undefined;
    }
    throw err;
  }
  const cached = parsedPanelStateCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.state;
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) {
      parsedPanelStateCache.delete(path);
      return undefined;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `run_panel.unparsable: failed to parse ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const schemaVersion = typeof parsed === 'object' && parsed !== null
    ? (parsed as { schemaVersion?: unknown }).schemaVersion
    : undefined;
  if (schemaVersion !== PANEL_SCHEMA_VERSION) {
    throw new Error(
      `run_panel.unknown_schema_version: expected ${PANEL_SCHEMA_VERSION}, got ${
        schemaVersion ?? 'undefined'
      }`,
    );
  }

  try {
    const state = panelStateSchemaV1.parse(parsed);
    parsedPanelStateCache.set(path, { mtimeMs, state });
    return state;
  } catch (err) {
    throw new Error(
      `run_panel.unparsable: invalid panel state at ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export function snapshotPanelReviewerTerminal(
  targetPanelDir: string,
  runId: string,
  snapshot: PanelReviewerTerminalSnapshot,
): PanelStateV1 {
  const current = readPanelState(targetPanelDir);
  if (!current) {
    throw new Error(`run_panel.snapshot_missing_panel: ${targetPanelDir}`);
  }
  let changed = false;
  const next: PanelStateV1 = {
    ...current,
    reviewers: current.reviewers.map((reviewer) => {
      if (!reviewer.dispatched || reviewer.runId !== runId) return reviewer;
      changed = true;
      return {
        ...reviewer,
        terminalSnapshot: snapshot,
      };
    }),
  };
  if (!changed) {
    throw new Error(`run_panel.snapshot_missing_reviewer: ${runId}`);
  }
  writePanelStateAtomic(targetPanelDir, next);
  return next;
}

export function gcPanelStates(
  crewHome: string,
  ttlMs: number,
  now = Date.now(),
): number {
  if (ttlMs === Number.POSITIVE_INFINITY) return 0;
  const root = join(crewHome, 'panels');
  if (!existsSync(root)) return 0;

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    logger.warn(
      `panel GC: failed to read ${root}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }

  let deleted = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    let state: PanelStateV1 | undefined;
    try {
      state = readPanelState(dir);
    } catch (err) {
      logger.warn(
        `panel GC: failed to read ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!state) continue;
    const completedAtMs = newestReviewerTerminalCompletedAtMs(state);
    if (completedAtMs === undefined) continue;
    const ageMs = now - completedAtMs;
    if (!Number.isFinite(ageMs) || ageMs < ttlMs) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      parsedPanelStateCache.delete(join(dir, 'panel.json'));
      deleted += 1;
    } catch (err) {
      logger.warn(
        `panel GC: failed to delete ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return deleted;
}

function newestReviewerTerminalCompletedAtMs(state: PanelStateV1): number | undefined {
  let newest: number | undefined;
  for (const reviewer of state.reviewers) {
    if (!reviewer.dispatched) return undefined;
    const completedAt = reviewer.terminalSnapshot?.completedAt;
    if (completedAt === undefined) return undefined;
    const ms = Date.parse(completedAt);
    if (!Number.isFinite(ms)) return undefined;
    newest = newest === undefined ? ms : Math.max(newest, ms);
  }
  return newest;
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}
