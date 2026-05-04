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
 * Header line that opens the primary crew block (used by mergeMcpBlock
 * to find/replace the `command` + `args` section we own). Anchored to
 * start of line; trailing whitespace tolerated.
 */
const HEADER_RE = /^\[mcp_servers\.crew\][^\S\n]*$/m;

/**
 * Header line that opens any block in the crew namespace — including
 * sub-blocks Codex creates for per-tool approval-mode persistence
 * (e.g., `[mcp_servers.crew.tools.run_agent]`). Used by removeMcpBlock
 * so `crew uninstall` clears the whole namespace, not just our own
 * `command`/`args` block.
 *
 * Surfaced by Finding 9 in `docs/status/v0.2-smoke-2026-05-04.md`:
 * Codex auto-creates these sub-blocks when the user grants per-tool
 * approvals during a session. If our uninstall left them behind,
 * Codex would refuse to load on the next launch ("invalid transport
 * in mcp_servers.crew") because the parent block (which holds
 * command + args) was gone but its children still referenced it.
 */
const NAMESPACE_HEADER_RE = /^\[mcp_servers\.crew(?:\.[^\]]*)?\][^\S\n]*$/gm;

/**
 * Any TOML section header — used to detect the END of a crew block
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
    // Remove every block whose header is in the crew namespace —
    // [mcp_servers.crew] AND any [mcp_servers.crew.<...>] sub-block
    // (Codex creates [mcp_servers.crew.tools.<tool>] for per-tool
    // approval persistence; leaving those orphaned makes Codex refuse
    // to load on next launch). Splice spans out in reverse so indices
    // stay valid as we mutate.
    const spans = locateAllCrewNamespaceBlocks(existing);
    if (spans.length === 0) return existing;
    let out = existing;
    for (let i = spans.length - 1; i >= 0; i--) {
      const { start, end } = spans[i];
      out = out.slice(0, start) + out.slice(end);
    }
    return out.replace(/\n{3,}/g, '\n\n');
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
 * Find every block in the `mcp_servers.crew` namespace — the main
 * `[mcp_servers.crew]` block AND any `[mcp_servers.crew.<...>]`
 * sub-block. Returns spans sorted by start offset. Used by
 * `removeMcpBlock` to clean up Codex's auto-created per-tool
 * approval sub-blocks alongside our own block on uninstall.
 *
 * Each span's `end` points at the next section header (anywhere — not
 * just other crew-namespace headers), or at end-of-file. That
 * matches the v1 single-block locator's contract; spans of adjacent
 * crew-namespace blocks naturally end at the next crew header, so
 * splicing them all out leaves no gaps.
 */
function locateAllCrewNamespaceBlocks(raw: string): BlockSpan[] {
  const spans: BlockSpan[] = [];
  // Reset the global regex's lastIndex; sharing a /g regex across
  // calls keeps cumulative state otherwise.
  NAMESPACE_HEADER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NAMESPACE_HEADER_RE.exec(raw)) !== null) {
    const start = match.index;
    const afterHeader = start + match[0].length;
    const rest = raw.slice(afterHeader);
    const nextSection = rest.search(SECTION_HEADER_RE);
    const end = nextSection === -1 ? raw.length : afterHeader + nextSection;
    spans.push({ start, end });
    // Advance lastIndex past this header to avoid an infinite loop on
    // zero-width matches (defensive; shouldn't happen with our regex).
    if (NAMESPACE_HEADER_RE.lastIndex <= start) {
      NAMESPACE_HEADER_RE.lastIndex = start + 1;
    }
  }
  return spans;
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
  locateAllCrewNamespaceBlocks,
  renderCodexBlock,
  tomlString,
};
