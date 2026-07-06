import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWrite } from '../../utils/atomic-write.js';
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

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}
