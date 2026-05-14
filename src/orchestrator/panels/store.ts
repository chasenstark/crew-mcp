import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PANEL_SCHEMA_VERSION,
  panelStateSchemaV1,
  type PanelStateV1,
} from './schema.js';

export function panelDir(crewHome: string, panelId: string): string {
  return join(crewHome, 'panels', encodeURIComponent(panelId));
}

export function writePanelStateAtomic(targetPanelDir: string, state: PanelStateV1): void {
  const tmpPath = join(
    targetPanelDir,
    `panel.json.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  const finalPath = join(targetPanelDir, 'panel.json');
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, finalPath);
}

export function readPanelState(targetPanelDir: string): PanelStateV1 | undefined {
  const path = join(targetPanelDir, 'panel.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return undefined;
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
    return panelStateSchemaV1.parse(parsed);
  } catch (err) {
    throw new Error(
      `run_panel.unparsable: invalid panel state at ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export function ensurePanelRoot(crewHome: string): void {
  mkdirSync(join(crewHome, 'panels'), { recursive: true });
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}
