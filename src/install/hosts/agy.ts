/**
 * Antigravity CLI (agy) host adapter — PROJECT SCOPE ONLY.
 *
 * agy is unique among the host adapters: it does NOT load MCP servers
 * from any global config file. Empirically (agy v1.0.14, see the
 * reference-agy-install-host-contract memory), the ONLY location that
 * agy reads `mcpServers` from is a PROJECT-LOCAL
 * `<repo>/.agents/mcp_config.json`. Every global candidate
 * (`~/.gemini/**`, `~/.agents/mcp_config.json`, …) returned MCP=none.
 *
 * Because the MCP config is the point of the install, agy is registered
 * as a project-only host: it appears in PROJECT_HOST_IDS but NOT in
 * GLOBAL_HOST_IDS. `crew install --target agy` (global) is rejected with
 * a "use --scope project" message before any adapter method runs; the
 * global-only interface methods (`configPath`, `skillPath`,
 * `skillInstallSpecFor`) are therefore never reached and throw a clear
 * project-only error if they ever were.
 *
 * Config: <repo>/.agents/mcp_config.json — top-level JSON,
 *   `{ "mcpServers": { "crew": { command, args } } }`. Same block shape
 *   as Claude Code / Gemini, so the merge/remove/has logic mirrors the
 *   Gemini adapter's JSON handling.
 * Skills: <repo>/.agents/skills/<dir>/SKILL.md — agy auto-discovers
 *   SKILL.md from the project `.agents/skills/` root (it also scans
 *   `~/.gemini/skills/` and `~/.gemini/antigravity-cli/skills/`, but
 *   NOT the shared `~/.agents/skills/` dir the other hosts dedupe on,
 *   so a project-local copy is the reliable, self-contained choice).
 *
 * Auto-approval: agy has NO per-server `trust` key in the mcp_config
 * schema (unlike Gemini). Its only bypass is the `--dangerously-skip-
 * permissions` launch flag, applied by the USER when they start agy as
 * the captain. There is nothing to write into the config, so this
 * adapter deliberately does NOT implement writeAutoApproval /
 * clearAutoApproval; `projectInstallNotes` tells the user about the
 * launch flag instead.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { HostAdapter } from './types.js';
import type { SkillInstallSpec, SkillManifestEntry } from '../skill-renderer.js';

const execFileAsync = promisify(execFile);

const MCP_BLOCK_KEY = 'crew';

const PROJECT_ONLY_MESSAGE =
  'agy is a project-scoped host: it has no global MCP config. '
  + 'Use `crew-mcp install --scope project --target agy` (writes <repo>/.agents/mcp_config.json).';

interface AgyConfigShape {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export const agyAdapter: HostAdapter = {
  id: 'agy',
  displayName: 'Antigravity CLI (agy)',

  // Global-only interface methods. agy is project-only, so these are
  // never invoked in normal flow (agy is excluded from every global
  // target-resolution path). They throw rather than return a bogus
  // global path so a future miswiring fails loudly instead of writing
  // a config agy will never load.
  configPath() {
    throw new Error(PROJECT_ONLY_MESSAGE);
  },
  skillPath() {
    throw new Error(PROJECT_ONLY_MESSAGE);
  },
  skillInstallSpecFor() {
    throw new Error(PROJECT_ONLY_MESSAGE);
  },

  projectConfigPath: (repoRoot) => join(repoRoot, '.agents', 'mcp_config.json'),
  projectSkillPath: (repoRoot) => join(repoRoot, '.agents', 'skills', 'crew', 'SKILL.md'),
  projectSkillInstallSpecFor: agyProjectSkillInstallSpecFor,

  projectInstallNotes: (repoRoot) => [
    `agy project install written to ${join(repoRoot, '.agents')}. agy loads mcpServers ONLY from `
    + '<repo>/.agents/mcp_config.json, so start agy inside this repo to pick up crew.',
    'agy has no config-level tool-approval flag; launch it with `--dangerously-skip-permissions` '
    + 'so crew MCP tool calls run without a prompt.',
  ],

  mergeMcpBlock(existing, crewBin, crewArgs) {
    const parsed = parseAgyConfig(existing);
    const mcpServers = (parsed.mcpServers as Record<string, unknown> | undefined) ?? {};
    mcpServers[MCP_BLOCK_KEY] = {
      command: crewBin,
      args: [...crewArgs],
    };
    parsed.mcpServers = mcpServers;
    return stringifyAgyConfig(parsed);
  },

  removeMcpBlock(existing) {
    if (existing.trim().length === 0) return existing;
    const parsed = parseAgyConfig(existing);
    const mcpServers = parsed.mcpServers as Record<string, unknown> | undefined;
    if (!mcpServers || !(MCP_BLOCK_KEY in mcpServers)) {
      return existing;
    }
    delete mcpServers[MCP_BLOCK_KEY];
    if (Object.keys(mcpServers).length === 0) {
      delete parsed.mcpServers;
    }
    return stringifyAgyConfig(parsed);
  },

  hasMcpBlock(existing) {
    if (existing.trim().length === 0) return false;
    try {
      const parsed = parseAgyConfig(existing);
      const mcp = parsed.mcpServers as Record<string, unknown> | undefined;
      return Boolean(mcp && MCP_BLOCK_KEY in mcp);
    } catch {
      return false;
    }
  },

  async detectInstalled() {
    return detectVersion('agy');
  },

  async detectRunning() {
    return detectProcessRunning(/(?:^|\/)agy(?:\s|$)/);
  },

  // No writeAutoApproval / clearAutoApproval: agy's mcp_config has no
  // `trust` key; auto-approval is the user's `--dangerously-skip-
  // permissions` launch flag (see projectInstallNotes).
};

/**
 * Resolve the per-skill project install spec. Sibling-flat layout under
 * the project `.agents/skills/` root: `<repo>/.agents/skills/<dir>/SKILL.md`
 * where `<dir>` is the skill's id with `:` replaced by `-`. Frontmatter
 * `name:` uses the same hyphenated form. No legacy paths — agy is a v1
 * host with a single canonical location.
 */
function agyProjectSkillInstallSpecFor(
  repoRoot: string,
  skill: SkillManifestEntry,
): SkillInstallSpec {
  const dir = skill.id.replace(':', '-');
  return {
    skillPath: join(repoRoot, '.agents', 'skills', dir, 'SKILL.md'),
    frontmatterName: dir,
    legacyPathsToRemove: [],
  };
}

function parseAgyConfig(raw: string): AgyConfigShape {
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('agy config root is not a JSON object');
    }
    return parsed as AgyConfigShape;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse agy config as JSON: ${message}`);
  }
}

function stringifyAgyConfig(value: AgyConfigShape): string {
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
