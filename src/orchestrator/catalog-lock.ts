/**
 * Catalog lock — persists `ToolCatalog.getToolSchemaHash()` to
 * `.crew/config.lock.json` so Gemini's file-based settings.json only gets
 * regenerated when the catalog actually drifts.
 *
 * Claude and Codex self-heal via per-invocation wiring (every turn passes
 * its own --mcp-config / -c mcp_servers.* flags), so the lockfile is a
 * pure Gemini-path optimization — but it lives here so future file-based
 * adapters can piggyback on the same machinery.
 *
 * The lockfile survives `crew state reset` because it is NOT listed in
 * state-reset's RESET_ENTRIES. Regenerating the hash is cheap, but
 * preserving it lets users who run state-reset routinely avoid
 * Gemini-settings churn between the reset and the next catalog change.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';

export const CATALOG_LOCK_FILE = 'config.lock.json';

interface CatalogLockRecord {
  readonly schemaVersion: number;
  readonly catalogHash: string;
  readonly updatedAt: string;
}

const CURRENT_SCHEMA_VERSION = 1;

export class CatalogLock {
  static loadHash(projectRoot: string): string | undefined {
    const path = join(projectRoot, '.crew', CATALOG_LOCK_FILE);
    if (!existsSync(path)) return undefined;
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<CatalogLockRecord>;
      if (typeof parsed.catalogHash !== 'string' || parsed.catalogHash.length === 0) {
        return undefined;
      }
      return parsed.catalogHash;
    } catch (err: unknown) {
      // Partial write / malformed lock — treat as absent so the next compare
      // triggers a regen. The atomic-write pattern makes a truly-partial
      // observation rare but possible during a crash mid-rename.
      logger.debug('[catalog-lock] failed to parse lockfile; treating as absent', {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  static writeHash(projectRoot: string, hash: string): void {
    const record: CatalogLockRecord = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      catalogHash: hash,
      updatedAt: new Date().toISOString(),
    };
    atomicWrite(
      join(projectRoot, '.crew', CATALOG_LOCK_FILE),
      JSON.stringify(record, null, 2),
    );
  }
}
