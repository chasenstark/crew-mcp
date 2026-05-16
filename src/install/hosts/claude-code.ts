/**
 * Claude Code host adapter.
 *
 * Config:      ~/.claude.json          (top-level JSON, mcpServers.<name>).
 * Skill:       ~/.claude/skills/crew/SKILL.md.
 * Permissions: ~/.claude/settings.json (top-level JSON,
 *              permissions.allow array of patterns).
 *
 * The config file may contain unrelated keys we MUST preserve — Claude
 * Code reads many settings from it. We parse, splice in our key, and
 * re-serialize with stable indentation.
 *
 * Auto-approval lives in a SEPARATE file from the MCP config (the
 * settings.json file Claude Code's own permission UI writes to). We
 * append the wildcard `mcp__crew__*` to `permissions.allow` so the
 * host doesn't prompt before each `mcp__crew__*` tool call. Single
 * wildcard covers all six tools and any future additions.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { HostAdapter } from './types.js';
import type { SkillInstallSpec, SkillManifestEntry } from '../skill-renderer.js';

const execFileAsync = promisify(execFile);

const MCP_BLOCK_KEY = 'crew';
const PERMISSION_PATTERN = 'mcp__crew__*';

interface ClaudeConfigShape {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ClaudePermissionsShape {
  permissions?: { allow?: unknown[]; [key: string]: unknown };
  [key: string]: unknown;
}

export const claudeCodeAdapter: HostAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',

  configPath: (home) => join(home, '.claude.json'),
  skillPath: (home) => join(home, '.claude', 'skills', 'crew', 'SKILL.md'),
  skillInstallSpecFor: claudeCodeSkillInstallSpecFor,

  mergeMcpBlock(existing, crewBin, crewArgs) {
    const parsed = parseClaudeConfig(existing);
    const mcpServers = (parsed.mcpServers as Record<string, unknown> | undefined) ?? {};
    mcpServers[MCP_BLOCK_KEY] = {
      command: crewBin,
      args: [...crewArgs],
    };
    parsed.mcpServers = mcpServers;
    return stringifyClaudeConfig(parsed);
  },

  removeMcpBlock(existing) {
    if (existing.trim().length === 0) return existing;
    const parsed = parseClaudeConfig(existing);
    const mcpServers = parsed.mcpServers as Record<string, unknown> | undefined;
    if (!mcpServers || !(MCP_BLOCK_KEY in mcpServers)) {
      return existing; // already absent, return verbatim
    }
    delete mcpServers[MCP_BLOCK_KEY];
    if (Object.keys(mcpServers).length === 0) {
      delete parsed.mcpServers;
    }
    return stringifyClaudeConfig(parsed);
  },

  hasMcpBlock(existing) {
    if (existing.trim().length === 0) return false;
    try {
      const parsed = parseClaudeConfig(existing);
      const mcp = parsed.mcpServers as Record<string, unknown> | undefined;
      return Boolean(mcp && MCP_BLOCK_KEY in mcp);
    } catch {
      return false;
    }
  },

  async detectInstalled() {
    return detectFromBinary('claude');
  },

  async detectRunning() {
    return detectProcessRunning(/(?:^|\/)claude(?:-code)?(?:\s|$)/);
  },

  permissionsPath: (home) => join(home, '.claude', 'settings.json'),

  writeAutoApproval(existing, _tools) {
    // Wildcard covers all 6 tools and any future additions; per-tool
    // entries would be redundant and would drift from the MCP catalog.
    const parsed = parsePermissions(existing);
    const permissions = parsed.permissions ?? {};
    const allow: unknown[] = Array.isArray(permissions.allow)
      ? [...permissions.allow]
      : [];
    if (!allow.includes(PERMISSION_PATTERN)) {
      allow.push(PERMISSION_PATTERN);
    }
    permissions.allow = allow;
    parsed.permissions = permissions;
    return stringifyPermissions(parsed);
  },

  clearAutoApproval(existing) {
    if (existing.trim().length === 0) return existing;
    const parsed = parsePermissions(existing);
    const permissions = parsed.permissions;
    if (!permissions || !Array.isArray(permissions.allow)) {
      return existing; // already absent
    }
    const filtered = permissions.allow.filter((p) => p !== PERMISSION_PATTERN);
    if (filtered.length === permissions.allow.length) {
      return existing; // pattern wasn't there
    }
    if (filtered.length === 0) {
      delete permissions.allow;
    } else {
      permissions.allow = filtered;
    }
    if (Object.keys(permissions).length === 0) {
      delete parsed.permissions;
    } else {
      parsed.permissions = permissions;
    }
    return stringifyPermissions(parsed);
  },
};

/**
 * Resolve the per-skill install spec. Sibling-flat personal-skills
 * layout (Phase 0 outcome): `~/.claude/skills/<dir>/SKILL.md` where
 * `<dir>` is the skill's id with `:` replaced by `-`. Frontmatter
 * `name:` uses the same hyphenated form so the slash command works
 * cleanly (`/crew-iterate`). The v1 umbrella path IS canonical, so
 * `legacyPathsToRemove` is empty on Claude Code.
 */
function claudeCodeSkillInstallSpecFor(
  home: string,
  skill: SkillManifestEntry,
): SkillInstallSpec {
  const dir = skill.id.replace(':', '-');
  return {
    skillPath: join(home, '.claude', 'skills', dir, 'SKILL.md'),
    frontmatterName: dir,
    legacyPathsToRemove: [],
  };
}

function parseClaudeConfig(raw: string): ClaudeConfigShape {
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Claude config root is not a JSON object');
    }
    return parsed as ClaudeConfigShape;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse Claude config as JSON: ${message}`);
  }
}

function stringifyClaudeConfig(value: ClaudeConfigShape): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function parsePermissions(raw: string): ClaudePermissionsShape {
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Claude permissions root is not a JSON object');
    }
    return parsed as ClaudePermissionsShape;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse Claude permissions as JSON: ${message}`);
  }
}

function stringifyPermissions(value: ClaudePermissionsShape): string {
  return JSON.stringify(value, null, 2) + '\n';
}

async function detectFromBinary(
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
