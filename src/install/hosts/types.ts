/**
 * HostAdapter — per-host CLI install/uninstall surface.
 *
 * Each host (Claude Code, Codex, agy) has its own config-file format
 * and skill location. The adapter pattern lets `crew-mcp install` and
 * `crew-mcp uninstall` stay generic; each adapter knows:
 *
 *   - where its config + skill files live
 *   - how to merge / remove the crew MCP block from the config
 *   - how to detect whether the host CLI is installed and running
 *
 * All path-returning methods take `home` so tests can swap in a tmpdir
 * for filesystem isolation. All config-mutation methods are pure on
 * strings (parse → mutate → stringify); the install command handles I/O.
 *
 * `mergeMcpBlock` and `removeMcpBlock` MUST be idempotent. Re-running
 * `crew-mcp install` or `crew-mcp uninstall` is a supported workflow; both
 * commands ship as "do the right thing regardless of current state."
 */

import type { SkillInstallSpec, SkillManifestEntry } from '../skill-renderer.js';

export interface HostAdapter {
  /** Stable id used in CLI args (--target=<id>) and install.json. */
  readonly id: 'claude-code' | 'codex' | 'agy';

  /** Human-readable name for log output. */
  readonly displayName: string;

  /**
   * Path to host's MCP config file, e.g. ~/.codex/config.toml.
   * Project-only hosts (not in GLOBAL_HOST_IDS, e.g. agy) have no global
   * MCP config and throw here; they are excluded from every global
   * target-resolution path, so this is never reached in normal flow.
   */
  configPath(home: string): string;

  /**
   * Path to the umbrella `crew` skill file. Kept for back-compat
   * (uninstall consults the install manifest's recorded path, but
   * old call sites and tests still reach for this directly). New
   * code should call `skillInstallSpecFor` for the multi-skill spec.
   */
  skillPath(home: string): string;

  /**
   * Per-skill install spec — where to write the rendered SKILL.md and
   * which frontmatter `name:` to bake in. Plus any legacy on-disk
   * paths the install must remove (stale copies at deprecated
   * locations from earlier layouts). Adapters compute this from
   * the skill's `slug` plus host-specific path conventions.
   */
  skillInstallSpecFor(home: string, skill: SkillManifestEntry): SkillInstallSpec;

  /** Project-local host MCP config path, when this host supports project scope. */
  projectConfigPath?(repoRoot: string): string;

  /**
   * Project-local umbrella `crew` skill path. Kept parallel to skillPath
   * for adapters that support project scope.
   */
  projectSkillPath?(repoRoot: string): string;

  /**
   * Project-local per-skill install spec. Optional so new hosts can be
   * global-only until their project config surface is known.
   */
  projectSkillInstallSpecFor?(
    repoRoot: string,
    skill: SkillManifestEntry,
  ): SkillInstallSpec;

  /**
   * Merge the crew MCP block into the host's config. `existing` is the
   * current file content (empty string if file doesn't exist). Returns
   * the new content. Must be idempotent: calling twice with the same
   * args produces the same output.
   */
  mergeMcpBlock(
    existing: string,
    crewBin: string,
    crewArgs: readonly string[],
  ): string;

  /**
   * Remove the crew MCP block from the host's config. Idempotent:
   * if the block isn't present, returns `existing` unchanged.
   */
  removeMcpBlock(existing: string): string;

  /**
   * Best-effort check whether the host's config currently registers
   * crew. Used by `crew-mcp verify`.
   */
  hasMcpBlock(existing: string): boolean;

  /**
   * Best-effort detection: is this host CLI installed on PATH? Returns
   * a version string when it can detect one; `installed: false` if
   * the binary isn't on PATH at all.
   */
  detectInstalled(): Promise<{ installed: boolean; version?: string }>;

  /**
   * Best-effort detection: is this host CLI currently running? Used to
   * print a restart-warning at install time. Returning `false` is
   * always safe (worst case the user sees no warning).
   */
  detectRunning(): Promise<boolean>;

  /**
   * Path to a SECOND file holding tool-approval state, when the host
   * stores approval separately from the MCP config. Today only Claude
   * Code returns a value here (`~/.claude/settings.json`); Codex
   * co-locates approval state inside `configPath` and leaves this
   * undefined. The install command reads the right file based on what
   * the adapter returns.
   */
  permissionsPath?(home: string): string;

  /** Project-local approval/permissions path, if separate from projectConfigPath. */
  projectPermissionsPath?(repoRoot: string): string;

  /** Host-specific residual setup notes printed after a project install. */
  projectInstallNotes?(repoRoot: string): readonly string[];

  /**
   * Pre-approve the listed crew tools so the host CLI doesn't prompt
   * the user before each `mcp__crew__*` call. The user's running
   * `crew-mcp install` is the explicit consent action; per-call prompts
   * after that point are friction without protection (the captain
   * skill's "always confirm before merge_run" is the real safety
   * gate, model-level, unaffected by this).
   *
   * `existing` is the current content of `permissionsPath()` if the
   * adapter defines one, else `configPath()`. `tools` is the catalog
   * of `mcp__crew__*` tools to pre-approve (server-wide hosts ignore
   * the list and trust the whole server).
   *
   * Idempotent: re-running with the same inputs produces the same
   * output. Adapters that don't implement this opt out of the
   * auto-approve flow entirely (their `crew-mcp install` will leave per-
   * call prompts in place).
   */
  writeAutoApproval?(existing: string, tools: readonly string[]): string;

  /**
   * Reverse `writeAutoApproval`. Called on `crew-mcp uninstall` and on
   * `crew install --no-auto-approve` so the end state is predictable
   * regardless of how the user previously installed. Idempotent: a
   * no-op if no auto-approval state is present.
   */
  clearAutoApproval?(existing: string): string;
}
