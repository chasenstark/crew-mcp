/**
 * HostAdapter — per-host CLI install/uninstall surface.
 *
 * Each host (Claude Code, Codex, Gemini) has its own config-file format
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

export interface HostAdapter {
  /** Stable id used in CLI args (--target=<id>) and install.json. */
  readonly id: 'claude-code' | 'codex' | 'gemini';

  /** Human-readable name for log output. */
  readonly displayName: string;

  /** Path to host's MCP config file, e.g. ~/.codex/config.toml. */
  configPath(home: string): string;

  /** Path to host's skill / prompt file. */
  skillPath(home: string): string;

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
   * Code returns a value here (`~/.claude/settings.json`); Codex and
   * Gemini co-locate approval state inside `configPath` and leave this
   * undefined. The install command reads the right file based on what
   * the adapter returns.
   */
  permissionsPath?(home: string): string;

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
