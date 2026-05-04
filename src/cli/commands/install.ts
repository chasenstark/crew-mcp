/**
 * `crew install --target <host|all>` — write the MCP block + skill file
 * for the named host CLI(s).
 *
 * Idempotent: re-running with the same args produces the same end state.
 * Each target step is tolerant of partial prior state — if the skill
 * file exists, it's overwritten; if the MCP block exists, it's replaced.
 *
 * Production flow per target:
 *   1. Render skill (canonical body + per-host template + tool list)
 *   2. Write skill file (mkdir -p)
 *   3. Read host config; merge MCP block; write back (mkdir -p)
 *   4. Append/update ~/.crew/install.json
 *   5. If host CLI is detected running, print restart warning
 *
 * `--target all` enumerates every registered host. Hosts whose binaries
 * aren't on PATH are skipped with a note (they can be installed without
 * the binary present, but most users won't want that).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

import { SERVE_VERSION } from './serve.js';
import {
  ALL_HOST_IDS,
  HOST_ADAPTERS,
  type HostAdapter,
  type HostId,
} from '../../install/hosts/index.js';
import {
  defaultCrewBinaryResolver,
  type CrewBinaryResolver,
} from '../../install/crew-binary.js';
import {
  recordInstalledTarget,
  type InstalledTarget,
} from '../../install/install-manifest.js';
import {
  selectTargets as defaultSelectTargets,
  type DetectedHost,
} from '../../install/interactive-target.js';
import {
  renderSkill,
  resolvePackageRoot,
  templatePathForHost,
} from '../../install/skill-renderer.js';
import { CATALOG_TOOLS } from '../../install/tool-catalog.js';
import { logger } from '../../utils/logger.js';

/**
 * Test seam for the interactive target picker. Production uses
 * `defaultSelectTargets` from interactive-target.ts (readline-backed).
 * Tests inject a stub that returns canned selections without driving
 * a real TTY.
 */
export type TargetSelector = (hosts: readonly DetectedHost[]) => Promise<HostId[]>;

export interface InstallOptions {
  /**
   * Comma-separated host ids, or 'all'. When omitted, the install
   * command falls back to interactive selection: detect every
   * registered host, prompt the user to pick (or auto-install all
   * detected when stdin is not a TTY). Pass an empty string or
   * undefined to trigger the fallback.
   */
  target?: string;
  /** Skip "host running, please restart" detection (CI/tests). */
  skipRunningCheck?: boolean;
  /** Override $HOME (tests). */
  home?: string;
  /** Override the package root (tests; otherwise auto-detected). */
  packageRoot?: string;
  /** Override crew binary resolution (tests). */
  resolveCrewBinary?: CrewBinaryResolver;
  /**
   * Test seam: override the interactive target selector. Defaults to
   * `selectTargets` from interactive-target.ts (readline-backed).
   * Only invoked when `target` is absent AND stdin is a TTY.
   */
  selectTargets?: TargetSelector;
  /**
   * Test seam: force the TTY/non-TTY branch when target is absent.
   * Defaults to `process.stdin.isTTY`. Tests pass `false` to exercise
   * the auto-install-all-detected fallback without a real terminal.
   */
  isInteractive?: boolean;
  /**
   * Force install even if the host CLI binary isn't detected on PATH.
   * Defaults to true for explicit single-target installs and false for
   * --target all (which uses detection to decide what to install).
   */
  forceWithoutBinary?: boolean;
  /**
   * Pre-approve crew tools so the host CLI doesn't prompt before each
   * `mcp__crew__*` call. Defaults to true — running `crew install` IS
   * the explicit consent action; per-call prompts after that are
   * friction without protection (the captain skill's "always confirm
   * before merge_run" remains the real safety gate at the model layer).
   *
   * Set to false (CLI flag `--no-auto-approve`) to leave host CLIs in
   * their default per-call-prompt mode. Calling install with
   * autoApprove: false on a host that already has auto-approval
   * enabled will REMOVE the auto-approval — the post-install state
   * always matches the flag.
   */
  autoApprove?: boolean;
}

export interface InstallResult {
  installed: HostId[];
  skipped: Array<{ host: HostId; reason: string }>;
}

export async function installCommand(opts: InstallOptions): Promise<InstallResult> {
  const home = opts.home ?? homedir();
  const packageRoot = resolvePackageRoot(opts.packageRoot);
  const resolveBin = opts.resolveCrewBinary ?? defaultCrewBinaryResolver;
  const { command: crewBin, args: crewArgs } = resolveBin();

  // Resolve targets either from --target (explicit) or via the
  // detect+prompt fallback (no --target). The fallback path is the
  // empty-string / undefined case.
  const targetInput = (opts.target ?? '').trim();
  let targets: HostId[];
  let camethroughInteractive = false;
  if (targetInput.length === 0) {
    targets = await resolveTargetsInteractively(opts);
    camethroughInteractive = true;
    if (targets.length === 0) {
      // User cancelled or no detected hosts — exit cleanly without an error.
      // The interactive helper already explained what happened.
      return { installed: [], skipped: [] };
    }
  } else {
    targets = resolveTargets(targetInput);
  }

  // For --target all (and the interactive fallback) we only install where
  // we detect the host. For an explicit --target codex, we install
  // regardless (the user knows what they want; they may be installing in
  // advance of the host CLI).
  const isExplicitAll = targetInput === 'all';
  const forceWithoutBinary =
    opts.forceWithoutBinary ?? !(isExplicitAll || camethroughInteractive);

  const result: InstallResult = { installed: [], skipped: [] };

  for (const targetId of targets) {
    const adapter = HOST_ADAPTERS[targetId];
    try {
      // Decide whether to install based on detection vs force flag.
      if (!forceWithoutBinary) {
        const detected = await adapter.detectInstalled();
        if (!detected.installed) {
          logger.info(`crew install: skipping ${adapter.displayName} (binary not on PATH)`);
          result.skipped.push({ host: targetId, reason: 'binary-not-found' });
          continue;
        }
      }

      await installSingleTarget({
        adapter,
        home,
        packageRoot,
        crewBin,
        crewArgs,
        autoApprove: opts.autoApprove ?? true,
      });

      if (!opts.skipRunningCheck) {
        const running = await adapter.detectRunning();
        if (running) {
          logger.warn(
            `${adapter.displayName} appears to be running. Restart any open sessions to pick up the new MCP server.`,
          );
        }
      }

      result.installed.push(targetId);
      logger.info(`crew install: ${adapter.displayName} ✓`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`crew install: ${adapter.displayName} failed — ${message}`);
      result.skipped.push({ host: targetId, reason: message });
    }
  }

  return result;
}

/**
 * One-shot install logic for a single host. Pulled out so tests can
 * exercise the per-host write path without the higher-level target
 * resolution and detection logic.
 */
export async function installSingleTarget(args: {
  adapter: HostAdapter;
  home: string;
  packageRoot: string;
  crewBin: string;
  crewArgs: readonly string[];
  /**
   * Whether to pre-approve crew tools so the host CLI doesn't prompt
   * before each `mcp__crew__*` call. See InstallOptions.autoApprove.
   */
  autoApprove: boolean;
}): Promise<InstalledTarget> {
  const { adapter, home, packageRoot, crewBin, crewArgs, autoApprove } = args;

  // 1. Render skill.
  const templatePath = templatePathForHost(packageRoot, adapter.id);
  const skillContent = await renderSkill({
    templatePath,
    tools: CATALOG_TOOLS,
    packageRoot,
  });

  // 2. Write skill file.
  const skillPath = adapter.skillPath(home);
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, skillContent, 'utf-8');

  // 3. Merge MCP block into host config.
  const configPath = adapter.configPath(home);
  const existing = existsSync(configPath) ? await readFile(configPath, 'utf-8') : '';
  const merged = adapter.mergeMcpBlock(existing, crewBin, crewArgs);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, merged, 'utf-8');

  // 4. Apply auto-approval (or clear it if the user opted out). The
  // post-install state matches the flag regardless of prior state, so
  // re-running install with --no-auto-approve removes any pre-approval
  // from a previous default install. Adapters that don't implement
  // writeAutoApproval/clearAutoApproval skip this step.
  if (adapter.writeAutoApproval && adapter.clearAutoApproval) {
    const approvalFile = adapter.permissionsPath ? adapter.permissionsPath(home) : configPath;
    const approvalExisting = existsSync(approvalFile)
      ? await readFile(approvalFile, 'utf-8')
      : '';
    const approvalUpdated = autoApprove
      ? adapter.writeAutoApproval(approvalExisting, CATALOG_TOOLS.map((t) => t.name))
      : adapter.clearAutoApproval(approvalExisting);
    if (approvalUpdated !== approvalExisting) {
      mkdirSync(dirname(approvalFile), { recursive: true });
      writeFileSync(approvalFile, approvalUpdated, 'utf-8');
    }
  }

  // 5. Update install manifest.
  const entry: InstalledTarget = {
    configPath,
    skillPath,
    version: SERVE_VERSION,
    installedAt: new Date().toISOString(),
    serverCommand: crewBin,
    serverArgs: [...crewArgs],
    autoApproved: autoApprove,
  };
  await recordInstalledTarget(home, adapter.id, entry);

  return entry;
}

/**
 * Resolve the --target arg to a list of host ids. Supports:
 *   - 'all' → every registered host
 *   - 'claude-code,codex' → comma-separated list
 *   - 'codex' → single host
 *
 * Throws on unknown ids; throws on empty target string. Deduplicates.
 */
export function resolveTargets(input: string): HostId[] {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error('crew install: --target is required (e.g., codex, claude-code, gemini, all)');
  }
  if (trimmed === 'all') return [...ALL_HOST_IDS];
  const parts = trimmed
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const seen = new Set<HostId>();
  const out: HostId[] = [];
  for (const part of parts) {
    if (!isHostId(part)) {
      throw new Error(
        `crew install: unknown target "${part}". Known: ${ALL_HOST_IDS.join(', ')}, all`,
      );
    }
    if (!seen.has(part)) {
      seen.add(part);
      out.push(part);
    }
  }
  return out;
}

function isHostId(value: string): value is HostId {
  return (ALL_HOST_IDS as readonly string[]).includes(value);
}

/**
 * Fallback when `--target` was omitted. Detects every registered host;
 * branches on TTY:
 *   - TTY:     prompt the user via the interactive selector.
 *   - non-TTY: auto-install to all detected hosts (no prompt possible).
 *
 * Returns an empty array on cancel, no detected hosts, or non-TTY with
 * nothing detected — caller treats as "exit cleanly, do nothing." A
 * helpful note is logged in each case so the user knows why nothing
 * happened.
 */
async function resolveTargetsInteractively(opts: InstallOptions): Promise<HostId[]> {
  const detected = await detectAllHosts();
  const detectedCount = detected.filter((h) => h.installed).length;
  const isInteractive = opts.isInteractive ?? Boolean(process.stdin.isTTY);

  if (!isInteractive) {
    if (detectedCount === 0) {
      logger.info(
        'crew install: no host CLIs detected on PATH and no --target given; nothing to install. '
        + `Try \`crew install --target <${ALL_HOST_IDS.join(' | ')}>\`.`,
      );
      return [];
    }
    const ids = detected.filter((h) => h.installed).map((h) => h.id);
    logger.info(
      `crew install: no --target given (non-interactive); installing detected hosts: ${ids.join(', ')}.`,
    );
    return ids;
  }

  if (detectedCount === 0) {
    logger.info(
      'crew install: no host CLIs detected on PATH. '
      + `Force-install one with \`crew install --target <${ALL_HOST_IDS.join(' | ')}>\`.`,
    );
    return [];
  }

  const selector: TargetSelector = opts.selectTargets
    ?? ((hosts) => defaultSelectTargets({ hosts }));
  return selector(detected);
}

/**
 * Run `detectInstalled` against every registered host adapter.
 * Concurrent so a slow detection can't block the others. Errors are
 * absorbed (treated as "not detected") — `detectInstalled` is best-
 * effort by contract.
 */
async function detectAllHosts(): Promise<DetectedHost[]> {
  const results = await Promise.all(
    ALL_HOST_IDS.map(async (id): Promise<DetectedHost> => {
      const adapter = HOST_ADAPTERS[id];
      try {
        const detection = await adapter.detectInstalled();
        return {
          id,
          displayName: adapter.displayName,
          installed: detection.installed,
          version: detection.version,
        };
      } catch {
        return { id, displayName: adapter.displayName, installed: false };
      }
    }),
  );
  return results;
}
