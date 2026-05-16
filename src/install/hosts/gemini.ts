/**
 * Gemini CLI host adapter.
 *
 * Config: ~/.gemini/settings.json (top-level JSON, mcpServers.<name>).
 * Skill:  ~/.gemini/extensions/crew/SKILL.md (extension directory).
 *
 * Same MCP block shape as Claude Code. Different config path; different
 * skill location.
 *
 * Auto-approval lives inside the same `mcpServers.crew` object as the
 * MCP config — Gemini supports a server-wide `"trust": true` flag that
 * bypasses all confirmation dialogs for that server (per Gemini's MCP
 * docs). No per-tool granularity; the trust is whole-server.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { HostAdapter } from './types.js';
import type { SkillInstallSpec, SkillManifestEntry } from '../skill-renderer.js';

const execFileAsync = promisify(execFile);

const MCP_BLOCK_KEY = 'crew';

interface GeminiConfigShape {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export const geminiAdapter: HostAdapter = {
  id: 'gemini',
  displayName: 'Gemini CLI',

  configPath: (home) => join(home, '.gemini', 'settings.json'),
  // skillPath here points at the NEW canonical location post-Phase-1
  // (sibling-flat user-skills layout, ~/.gemini/skills/crew/SKILL.md).
  // The legacy `~/.gemini/extensions/crew/SKILL.md` path is migrated
  // via `skillInstallSpecFor`'s `legacyPathsToRemove`. Old install
  // manifests still pointing at the extensions path get cleaned up
  // through the manifest-recorded `skillPath` consulted by uninstall.
  skillPath: (home) => join(home, '.gemini', 'skills', 'crew', 'SKILL.md'),
  skillInstallSpecFor: geminiSkillInstallSpecFor,

  mergeMcpBlock(existing, crewBin, crewArgs) {
    const parsed = parseGeminiConfig(existing);
    const mcpServers = (parsed.mcpServers as Record<string, unknown> | undefined) ?? {};
    mcpServers[MCP_BLOCK_KEY] = {
      command: crewBin,
      args: [...crewArgs],
    };
    parsed.mcpServers = mcpServers;
    return stringifyGeminiConfig(parsed);
  },

  removeMcpBlock(existing) {
    if (existing.trim().length === 0) return existing;
    const parsed = parseGeminiConfig(existing);
    const mcpServers = parsed.mcpServers as Record<string, unknown> | undefined;
    if (!mcpServers || !(MCP_BLOCK_KEY in mcpServers)) {
      return existing;
    }
    delete mcpServers[MCP_BLOCK_KEY];
    if (Object.keys(mcpServers).length === 0) {
      delete parsed.mcpServers;
    }
    return stringifyGeminiConfig(parsed);
  },

  hasMcpBlock(existing) {
    if (existing.trim().length === 0) return false;
    try {
      const parsed = parseGeminiConfig(existing);
      const mcp = parsed.mcpServers as Record<string, unknown> | undefined;
      return Boolean(mcp && MCP_BLOCK_KEY in mcp);
    } catch {
      return false;
    }
  },

  async detectInstalled() {
    return detectVersion('gemini');
  },

  async detectRunning() {
    return detectProcessRunning(/(?:^|\/)gemini(?:\s|$)/);
  },

  // Gemini stores the trust flag inside the same mcpServers.crew object
  // as the MCP config — no separate permissions file, so we don't
  // implement permissionsPath. The `tools` arg is ignored (server-wide).

  writeAutoApproval(existing, _tools) {
    const parsed = parseGeminiConfig(existing);
    const mcpServers = (parsed.mcpServers as Record<string, unknown> | undefined) ?? {};
    const crew = (mcpServers[MCP_BLOCK_KEY] as Record<string, unknown> | undefined) ?? {};
    crew.trust = true;
    mcpServers[MCP_BLOCK_KEY] = crew;
    parsed.mcpServers = mcpServers;
    return stringifyGeminiConfig(parsed);
  },

  clearAutoApproval(existing) {
    if (existing.trim().length === 0) return existing;
    const parsed = parseGeminiConfig(existing);
    const mcpServers = parsed.mcpServers as Record<string, unknown> | undefined;
    const crew = mcpServers?.[MCP_BLOCK_KEY] as Record<string, unknown> | undefined;
    if (!crew || !('trust' in crew)) {
      return existing; // already absent
    }
    delete crew.trust;
    mcpServers![MCP_BLOCK_KEY] = crew;
    return stringifyGeminiConfig(parsed);
  },
};

/**
 * Resolve the per-skill install spec. Sibling-flat user-skills layout
 * (Phase 0 outcome): `~/.gemini/skills/<dir>/SKILL.md` where `<dir>` is
 * the skill's id with `:` replaced by `-`. Frontmatter `name:` uses the
 * same hyphenated form.
 *
 * Gemini RELOCATES the umbrella `crew` skill from the deprecated
 * `~/.gemini/extensions/crew/SKILL.md` path (which never loaded due to
 * the missing `gemini-extension.json`; see Phase 0 probe 1). The
 * sub-skill `crew-iterate` doesn't have a legacy path. Both share the
 * same `legacyPathsToRemove` rule by convention — anything at the old
 * `~/.gemini/extensions/<dir>/SKILL.md` location gets cleaned up.
 */
function geminiSkillInstallSpecFor(
  home: string,
  skill: SkillManifestEntry,
): SkillInstallSpec {
  const dir = skill.id.replace(':', '-');
  return {
    skillPath: join(home, '.gemini', 'skills', dir, 'SKILL.md'),
    frontmatterName: dir,
    legacyPathsToRemove: [
      join(home, '.gemini', 'extensions', dir, 'SKILL.md'),
    ],
  };
}

function parseGeminiConfig(raw: string): GeminiConfigShape {
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Gemini config root is not a JSON object');
    }
    return parsed as GeminiConfigShape;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse Gemini config as JSON: ${message}`);
  }
}

function stringifyGeminiConfig(value: GeminiConfigShape): string {
  return JSON.stringify(value, null, 2) + '\n';
}

async function detectVersion(
  binaryName: string,
): Promise<{ installed: boolean; version?: string }> {
  try {
    const { stdout } = await execFileAsync(binaryName, ['--version'], {
      timeout: 3_000,
    });
    const trimmed = stdout.trim();
    return { installed: true, version: trimmed.length > 0 ? trimmed : undefined };
  } catch {
    return { installed: false };
  }
}

async function detectProcessRunning(pattern: RegExp): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('ps', ['-Ao', 'comm='], { timeout: 2_000 });
    return stdout.split('\n').some((line) => pattern.test(line));
  } catch {
    return false;
  }
}
