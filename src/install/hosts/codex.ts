/**
 * Codex host adapter.
 *
 * Config: ~/.codex/config.toml (TOML, [mcp_servers.<name>] tables).
 * Skill:  ~/.codex/skills/crew/SKILL.md (frontmatter + body, mirrors
 *         Claude Code's convention).
 *
 * Skill path correction (Finding 5, 2026-05-04): v0.2.0-dev initially
 * wrote to ~/.codex/prompts/crew.md based on a misread of Codex's
 * skill mechanism. Real-host smoke against Codex 0.128.0 surfaced
 * that ~/.codex/prompts/ is not the load path — Codex auto-discovers
 * skills under ~/.codex/skills/<name>/SKILL.md with frontmatter
 * (`name` + `description`), identical in shape to Claude Code's
 * convention.
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
 * so `crew-mcp uninstall` clears the whole namespace, not just our own
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
 * Header line matching ONLY [mcp_servers.crew.tools.<X>] sub-blocks
 * (not the parent [mcp_servers.crew] block). Used by writeAutoApproval
 * + clearAutoApproval to manage the per-tool approval blocks without
 * disturbing the parent.
 */
const TOOLS_HEADER_RE = /^\[mcp_servers\.crew\.tools\.[^\]]+\][^\S\n]*$/gm;

/**
 * Any TOML section header — used to detect the END of a crew block
 * during scan-forward.
 */
const SECTION_HEADER_RE = /^\[[^\]]+\]/m;

export const codexAdapter: HostAdapter = {
  id: 'codex',
  displayName: 'Codex',

  configPath: (home) => join(home, '.codex', 'config.toml'),
  skillPath: (home) => join(home, '.codex', 'skills', 'crew', 'SKILL.md'),

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

  // Codex stores per-tool approval state alongside the MCP server config in
  // the same config.toml file (no separate permissions file), so we don't
  // implement permissionsPath. The auto-approval is N tool blocks adjacent
  // to the parent [mcp_servers.crew] block.

  writeAutoApproval(existing, tools) {
    // Strip any pre-existing crew-tools blocks (Codex auto-creates these
    // when the user clicks "approve" in a session — see Finding 9). The
    // user's `crew-mcp install` is the explicit consent action; we overwrite
    // session-state with the deliberate auto-approve choice.
    const cleared = removeCrewToolBlocks(existing);
    if (tools.length === 0) return cleared;
    const block = renderCrewToolsBlocks(tools);
    // Place the tool blocks immediately after the parent [mcp_servers.crew]
    // block for readability. If the parent isn't present (defensive — should
    // be impossible since install writes it first), append at end.
    const parent = locateCrewBlock(cleared);
    if (parent) {
      const before = cleared.slice(0, parent.end).replace(/\n*$/, '\n');
      const after = cleared.slice(parent.end);
      return before + block + (after.startsWith('\n') ? after : `\n${after}`);
    }
    const trimmed = cleared.replace(/\n*$/, '');
    return trimmed.length === 0 ? block : `${trimmed}\n\n${block}`;
  },

  clearAutoApproval(existing) {
    return removeCrewToolBlocks(existing);
  },
};

// Codex's per-tool approval_mode schema: auto | prompt | approve.
// `auto` = no prompt, always allowed (this is what `crew-mcp install`
// chooses by default — `--no-auto-approve` opts out by writing nothing).
// Codex previously accepted `always` as the auto-approve variant; that
// was renamed to `auto`. Writing `always` against current Codex now
// causes "Error loading config.toml: unknown variant `always`" at
// startup, so do not regress this constant.
const APPROVAL_MODE_AUTO = 'auto';

function renderCrewToolsBlocks(tools: readonly string[]): string {
  return tools
    .map((tool) =>
      `[mcp_servers.crew.tools.${tool}]\napproval_mode = ${tomlString(APPROVAL_MODE_AUTO)}\n`,
    )
    .join('\n');
}

/**
 * Remove every `[mcp_servers.crew.tools.<X>]` block from the TOML source.
 * Distinct from `removeMcpBlock`, which strips the parent + tools blocks
 * together on uninstall. This helper preserves the parent so install can
 * re-write the tools blocks during auto-approval setup.
 */
function removeCrewToolBlocks(raw: string): string {
  const spans = locateCrewToolsBlocks(raw);
  if (spans.length === 0) return raw;
  let out = raw;
  for (let i = spans.length - 1; i >= 0; i--) {
    const { start, end } = spans[i];
    out = out.slice(0, start) + out.slice(end);
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

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
/**
 * Find every `[mcp_servers.crew.tools.<X>]` sub-block in the TOML
 * source, sorted by start offset. Each span ends at the next section
 * header or EOF — same semantics as the namespace locator. Used by
 * writeAutoApproval / clearAutoApproval to manage just the tools
 * blocks while leaving the parent [mcp_servers.crew] block untouched.
 */
function locateCrewToolsBlocks(raw: string): BlockSpan[] {
  const spans: BlockSpan[] = [];
  TOOLS_HEADER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOLS_HEADER_RE.exec(raw)) !== null) {
    const start = match.index;
    const afterHeader = start + match[0].length;
    const rest = raw.slice(afterHeader);
    const nextSection = rest.search(SECTION_HEADER_RE);
    const end = nextSection === -1 ? raw.length : afterHeader + nextSection;
    spans.push({ start, end });
    if (TOOLS_HEADER_RE.lastIndex <= start) {
      TOOLS_HEADER_RE.lastIndex = start + 1;
    }
  }
  return spans;
}

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
  locateCrewToolsBlocks,
  renderCodexBlock,
  renderCrewToolsBlocks,
  tomlString,
};
