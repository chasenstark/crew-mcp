import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { HOST_ADAPTERS, type HostId } from './hosts/index.js';
import type { InstalledTarget } from './install-manifest.js';
import type { InstallScope } from './scope.js';
import { CATALOG_TOOLS } from './tool-catalog.js';
import {
  captainSkillTools,
  renderSkill,
  SKILL_MANIFEST,
  templatePathForHost,
} from './skill-renderer.js';

export const CAPTAIN_CATALOG_TOOLS = captainSkillTools(CATALOG_TOOLS);

export interface CanonicalSkillVerificationOptions {
  readonly targetId: HostId;
  readonly entry: InstalledTarget;
  readonly installRoot: string;
  readonly packageRoot: string;
  readonly scope: InstallScope;
}

export interface SkillStalenessResult {
  readonly stale: boolean;
  readonly issues: readonly string[];
  readonly installedPaths: readonly string[];
  readonly fixCommand: string;
}

/** Shared render-and-byte-compare core used by both verify and serve. */
export async function verifyCanonicalSkillContent(
  args: CanonicalSkillVerificationOptions,
): Promise<string[]> {
  const result = await compareCanonicalSkillContent(args);
  return [...result.issues];
}

export async function computeSkillStaleness(
  args: CanonicalSkillVerificationOptions,
): Promise<SkillStalenessResult> {
  const result = await compareCanonicalSkillContent(args);
  const scopeArg = args.scope === 'project' ? ' --scope project' : '';
  return {
    stale: result.issues.length > 0,
    issues: result.issues,
    installedPaths: result.installedPaths,
    fixCommand: `crew-mcp install${scopeArg} -t ${args.targetId}`,
  };
}

async function compareCanonicalSkillContent(
  args: CanonicalSkillVerificationOptions,
): Promise<{ readonly issues: string[]; readonly installedPaths: string[] }> {
  const adapter = HOST_ADAPTERS[args.targetId];
  const issues: string[] = [];
  const installedPaths: string[] = [];
  for (const skill of SKILL_MANIFEST) {
    const spec = args.scope === 'project'
      ? adapter.projectSkillInstallSpecFor?.(args.installRoot, skill)
      : adapter.skillInstallSpecFor(args.installRoot, skill);
    if (!spec || spec.skip) continue;
    const installedPath = args.entry.skills?.[skill.id];
    if (!installedPath) {
      issues.push(`install manifest missing expected skill ${skill.id}: ${spec.skillPath}`);
      continue;
    }
    installedPaths.push(installedPath);
    if (installedPath !== spec.skillPath) {
      issues.push(
        `install manifest skill path mismatch for ${skill.id}: expected ${spec.skillPath}, got ${installedPath}`,
      );
      continue;
    }
    if (!existsSync(installedPath)) {
      // The general verify pass reports missing files. Serve treats a missing
      // file/read as a fail-open check error rather than a stale warning.
      continue;
    }
    const expected = await renderSkill({
      templatePath: templatePathForHost(args.packageRoot, args.targetId),
      hostId: args.targetId,
      skill,
      spec,
      tools: CAPTAIN_CATALOG_TOOLS,
      crewWaitCommand: args.entry.crewWaitCommand,
      packageRoot: args.packageRoot,
    });
    const actual = await readFile(installedPath, 'utf-8');
    if (actual !== expected) {
      issues.push(`skill content stale: ${installedPath}`);
    }
  }
  return { issues, installedPaths };
}
