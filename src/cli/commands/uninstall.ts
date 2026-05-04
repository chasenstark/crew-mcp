/**
 * `crew uninstall --target <host|all>` — reverse of install.
 *
 * For each target:
 *   1. Remove crew MCP block from host config (preserve other keys).
 *   2. Delete skill file.
 *   3. Remove target from ~/.crew/install.json.
 *
 * Idempotent — missing files / blocks are not errors. Targets that
 * aren't in the install manifest still run the removal logic in case
 * the manifest is out of sync (defensive cleanup).
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

import {
  HOST_ADAPTERS,
  type HostId,
} from '../../install/hosts/index.js';
import { removeInstalledTarget } from '../../install/install-manifest.js';
import { logger } from '../../utils/logger.js';
import { resolveTargets } from './install.js';

export interface UninstallOptions {
  /** Comma-separated host ids, or 'all'. Required. */
  target: string;
  /** Override $HOME (tests). */
  home?: string;
}

export interface UninstallResult {
  removed: HostId[];
  skipped: Array<{ host: HostId; reason: string }>;
}

export async function uninstallCommand(opts: UninstallOptions): Promise<UninstallResult> {
  const home = opts.home ?? homedir();
  const targets = resolveTargets(opts.target);

  const result: UninstallResult = { removed: [], skipped: [] };

  for (const targetId of targets) {
    const adapter = HOST_ADAPTERS[targetId];
    try {
      // 1. Remove MCP block from config (if file exists).
      const configPath = adapter.configPath(home);
      if (existsSync(configPath)) {
        const existing = readFileSync(configPath, 'utf-8');
        const stripped = adapter.removeMcpBlock(existing);
        if (stripped !== existing) {
          writeFileSync(configPath, stripped, 'utf-8');
        }
      }

      // 2. Delete skill file (if it exists).
      const skillPath = adapter.skillPath(home);
      if (existsSync(skillPath)) {
        rmSync(skillPath, { force: true });
      }

      // 3. Remove from install manifest.
      await removeInstalledTarget(home, targetId);

      result.removed.push(targetId);
      logger.info(`crew uninstall: ${adapter.displayName} ✓`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`crew uninstall: ${adapter.displayName} failed — ${message}`);
      result.skipped.push({ host: targetId, reason: message });
    }
  }

  return result;
}
