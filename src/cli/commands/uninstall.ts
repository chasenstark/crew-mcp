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
import {
  readInstallManifest,
  removeInstalledTarget,
} from '../../install/install-manifest.js';
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

  // Load the manifest once. We prefer the recorded skillPath over the
  // adapter's current skillPath so that an older crew version's install
  // (which may have written to a different path) is cleaned up correctly.
  // Surfaced by Finding 5: v0.2.0-dev wrote Codex skills to
  // ~/.codex/prompts/crew.md; the post-fix adapter writes to
  // ~/.codex/skills/crew/SKILL.md. Reading from the manifest ensures
  // smoke testers' old files don't orphan on uninstall.
  const manifest = await readInstallManifest(home);

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

      // 2. Delete skill file(s). Try the manifest-recorded path first
      // (truth for what we actually wrote), then the current adapter
      // path (for installs whose manifest entry was lost). Both are
      // idempotent — missing files are no-ops.
      const recorded = manifest.targets[targetId]?.skillPath;
      const current = adapter.skillPath(home);
      const skillPaths = recorded && recorded !== current ? [recorded, current] : [current];
      for (const skillPath of skillPaths) {
        if (existsSync(skillPath)) {
          rmSync(skillPath, { force: true });
        }
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
