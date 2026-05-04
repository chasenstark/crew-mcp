/**
 * `crew verify` — sanity-check installed skill ↔ MCP tool catalog.
 *
 * Reads ~/.crew/install.json to learn what's installed, then for each
 * installed target:
 *
 *   1. Skill file still exists.
 *   2. Skill text references every tool in the static catalog (and no
 *      extras — those would be stale references).
 *   3. Host config still contains the crew MCP block.
 *
 * Drift produces a clear message and a non-zero exit code so CI / users
 * can wire this into pre-flight scripts. Idempotent and read-only — no
 * side effects.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

import { HOST_ADAPTERS, type HostId } from '../../install/hosts/index.js';
import { readInstallManifest } from '../../install/install-manifest.js';
import { CATALOG_TOOLS } from '../../install/tool-catalog.js';
import { logger } from '../../utils/logger.js';

export interface VerifyOptions {
  /** Override $HOME (tests). */
  home?: string;
}

export interface VerifyTargetReport {
  host: HostId;
  ok: boolean;
  issues: string[];
}

export interface VerifyReport {
  ok: boolean;
  targets: VerifyTargetReport[];
  /** Top-level note when the manifest itself is empty. */
  note?: string;
}

export async function verifyCommand(opts: VerifyOptions = {}): Promise<VerifyReport> {
  const home = opts.home ?? homedir();
  const manifest = await readInstallManifest(home);
  const installedTargets = Object.keys(manifest.targets) as HostId[];

  if (installedTargets.length === 0) {
    const note = 'No installed targets. Run `crew install --target <host>` first.';
    logger.info(note);
    return { ok: true, targets: [], note };
  }

  const expectedNames = CATALOG_TOOLS.map((t) => `mcp__crew__${t.name}`);
  const reports: VerifyTargetReport[] = [];

  for (const targetId of installedTargets) {
    const adapter = HOST_ADAPTERS[targetId];
    const entry = manifest.targets[targetId]!;
    const issues: string[] = [];

    // 1. Skill file present.
    if (!existsSync(entry.skillPath)) {
      issues.push(`skill file missing: ${entry.skillPath}`);
    } else {
      const skill = await readFile(entry.skillPath, 'utf-8');
      const referenced = extractToolReferences(skill);
      const missing = expectedNames.filter((name) => !referenced.has(name));
      const extras = [...referenced].filter((name) => !expectedNames.includes(name));
      if (missing.length > 0) {
        issues.push(`skill missing tool references: ${missing.join(', ')}`);
      }
      if (extras.length > 0) {
        issues.push(`skill references unknown tools: ${extras.join(', ')}`);
      }
    }

    // 2. Host config still has crew MCP block.
    if (!existsSync(entry.configPath)) {
      issues.push(`host config missing: ${entry.configPath}`);
    } else {
      const config = await readFile(entry.configPath, 'utf-8');
      if (!adapter.hasMcpBlock(config)) {
        issues.push(`host config missing crew MCP block: ${entry.configPath}`);
      }
    }

    const report: VerifyTargetReport = {
      host: targetId,
      ok: issues.length === 0,
      issues,
    };
    reports.push(report);

    if (report.ok) {
      logger.info(`crew verify: ${adapter.displayName} ✓`);
    } else {
      logger.warn(
        `crew verify: ${adapter.displayName} drift (${report.issues.length} issue${
          report.issues.length === 1 ? '' : 's'
        })`,
      );
      for (const issue of issues) {
        logger.warn(`  - ${issue}`);
      }
    }
  }

  const ok = reports.every((r) => r.ok);
  if (!ok) {
    logger.warn('crew verify: drift detected. Run `crew install --target <host>` to re-sync.');
  }
  return { ok, targets: reports };
}

/**
 * Extract every `mcp__crew__<name>` token referenced in the skill text.
 * Tokens are matched as whole words (no embedded substrings of larger
 * tool names from other servers). Returns a Set so callers can do
 * fast membership checks.
 */
export function extractToolReferences(skill: string): Set<string> {
  const re = /mcp__crew__[a-z0-9_]+/g;
  const out = new Set<string>();
  for (const match of skill.matchAll(re)) {
    out.add(match[0]);
  }
  return out;
}
