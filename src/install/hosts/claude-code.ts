/**
 * Claude Code host adapter.
 *
 * Config: ~/.claude.json (top-level JSON, mcpServers.<name>).
 * Skill:  ~/.claude/skills/crew/SKILL.md.
 *
 * The config file may contain unrelated keys we MUST preserve — Claude
 * Code reads many settings from it. We parse, splice in our key, and
 * re-serialize with stable indentation.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { HostAdapter } from './types.js';

const execFileAsync = promisify(execFile);

const MCP_BLOCK_KEY = 'crew';

interface ClaudeConfigShape {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export const claudeCodeAdapter: HostAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',

  configPath: (home) => join(home, '.claude.json'),
  skillPath: (home) => join(home, '.claude', 'skills', 'crew', 'SKILL.md'),

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
};

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
