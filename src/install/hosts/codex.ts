/**
 * Codex host adapter.
 *
 * Config: ~/.codex/config.toml (TOML, [mcp_servers.<name>] tables).
 * Skill:  ~/.codex/prompts/crew.md (markdown prompt file).
 *
 * We deliberately avoid adding a TOML parser dependency. The
 * `[mcp_servers.crew]` block is a single self-contained section; we
 * locate it by header line and extract through the next `^[` or EOF,
 * preserving everything else verbatim. This preserves comments,
 * formatting, and unrelated sections that a real parse-then-stringify
 * round-trip would erase.
 *
 * Edge cases handled:
 *   - Empty / nonexistent config: write block as the entire file.
 *   - File without trailing newline: add a separator before our block.
 *   - Existing crew block at end of file: replace in place.
 *   - Existing crew block followed by another section: replace just
 *     our block; do not disturb the next section.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { HostAdapter } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Header line that opens the crew block. Anchored to start of line;
 * trailing whitespace tolerated.
 */
const HEADER_RE = /^\[mcp_servers\.crew\][^\S\n]*$/m;

/**
 * Any TOML section header — used to detect the END of the crew block
 * during scan-forward.
 */
const SECTION_HEADER_RE = /^\[[^\]]+\]/m;

export const codexAdapter: HostAdapter = {
  id: 'codex',
  displayName: 'Codex',

  configPath: (home) => join(home, '.codex', 'config.toml'),
  skillPath: (home) => join(home, '.codex', 'prompts', 'crew.md'),

  mergeMcpBlock(existing, crewBin, crewArgs) {
    const block = renderCodexBlock(crewBin, crewArgs);
    const span = locateCrewBlock(existing);
    if (span) {
      // Replace existing block, preserve surrounding content verbatim.
      return existing.slice(0, span.start) + block + existing.slice(span.end);
    }
    // Append. Ensure a blank line separator if the file has any content.
    if (existing.length === 0) return block;
    const trimmed = existing.replace(/[\n]*$/, '');
    return `${trimmed}\n\n${block}`;
  },

  removeMcpBlock(existing) {
    const span = locateCrewBlock(existing);
    if (!span) return existing;
    const before = existing.slice(0, span.start);
    const after = existing.slice(span.end);
    // Squeeze 3+ consecutive newlines that may result from removing a
    // mid-file block down to 2.
    return (before + after).replace(/\n{3,}/g, '\n\n');
  },

  hasMcpBlock(existing) {
    return locateCrewBlock(existing) !== null;
  },

  async detectInstalled() {
    return detectVersion('codex');
  },

  async detectRunning() {
    return detectProcessRunning(/(?:^|\/)codex(?:\s|$)/);
  },
};

interface BlockSpan {
  /** Start byte offset of the `[mcp_servers.crew]` line. */
  start: number;
  /**
   * End byte offset (exclusive) — points to the start of the next section
   * header, or to `existing.length` if no next section. Includes the
   * block's trailing newlines.
   */
  end: number;
}

/**
 * Find the [mcp_servers.crew] block's span in the TOML source. Returns
 * null if no such block exists. The end offset is the start of the next
 * `^[` line or end-of-file, so it INCLUDES whatever blank lines trail
 * the block — which keeps replace-in-place clean.
 */
function locateCrewBlock(raw: string): BlockSpan | null {
  const headerMatch = raw.match(HEADER_RE);
  if (!headerMatch || headerMatch.index === undefined) return null;
  const start = headerMatch.index;
  const afterHeader = start + headerMatch[0].length;
  // Scan forward for the next section header. Use a regex anchored to
  // line start; we need to skip the current line itself first.
  //
  // Search from one character past the matched header (so the same
  // header doesn't re-match). The body of the block is "everything up
  // to the next section or EOF."
  const rest = raw.slice(afterHeader);
  const nextSection = rest.search(SECTION_HEADER_RE);
  const end = nextSection === -1 ? raw.length : afterHeader + nextSection;
  return { start, end };
}

/**
 * Render the crew block as TOML. Uses double-quoted strings + escaped
 * backslashes (Windows paths). Trailing newline is part of the block so
 * concatenation never produces a missing-newline file.
 */
function renderCodexBlock(crewBin: string, crewArgs: readonly string[]): string {
  const argsLine = crewArgs.map((a) => tomlString(a)).join(', ');
  return `[mcp_servers.crew]\ncommand = ${tomlString(crewBin)}\nargs = [${argsLine}]\n`;
}

/**
 * TOML basic-string escape. Sufficient for paths + simple args; if a
 * future feature passes user-supplied content through here, expand to
 * include the rest of the spec's escape table.
 */
function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
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

// Internals exposed for tests to assert against directly.
export const _internals = {
  locateCrewBlock,
  renderCodexBlock,
  tomlString,
};
