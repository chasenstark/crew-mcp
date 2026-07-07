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

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { CREW_MCP_VERSION } from '../version.js';
import { createBuiltinRegistry } from '../../adapters/registry.js';
import {
  seedAgentPrefsFile,
  type AgentPrefsMap,
} from '../../agent-prefs/store.js';
import { resolveCrewHome } from '../../utils/crew-home.js';
import {
  ALL_HOST_IDS,
  GLOBAL_HOST_IDS,
  HOST_ADAPTERS,
  PROJECT_HOST_IDS,
  isGlobalHostId,
  isProjectHostId,
  type HostAdapter,
  type HostId,
} from '../../install/hosts/index.js';
import {
  defaultCrewBinaryResolver,
  isCrewWaitOnPath,
  parseProjectCrewBinaryStrategy,
  projectCrewBinaryResolver,
  projectCrewWaitCommand,
  resolveCrewWaitBinary,
  type CrewBinaryResolver,
  type ProjectCrewBinaryStrategy,
} from '../../install/crew-binary.js';
import {
  readInstallManifest,
  recordInstalledTarget,
  type InstalledTarget,
} from '../../install/install-manifest.js';
import {
  absolutizeProjectTarget,
  readProjectInstallManifest,
  recordProjectInstalledTarget,
  relativizeProjectTarget,
  type ProjectInstalledTarget,
} from '../../install/project-install-manifest.js';
import { resolveGitRepoRoot } from '../../install/repo-root.js';
import { parseInstallScope, type InstallScope } from '../../install/scope.js';
import { withInstallLock, writeFileAtomic } from '../../install/atomic-write.js';
import {
  selectTargets as defaultSelectTargets,
  type DetectedHost,
} from '../../install/interactive-target.js';
import {
  captainSkillTools,
  renderSkill,
  resolvePackageRoot,
  SKILL_MANIFEST,
  templatePathForHost,
  type SkillInstallSpec,
  type SkillManifestEntry,
} from '../../install/skill-renderer.js';
import { CATALOG_TOOLS } from '../../install/tool-catalog.js';
import { logger } from '../../utils/logger.js';

const CAPTAIN_CATALOG_TOOLS = captainSkillTools(CATALOG_TOOLS);
const APPROVAL_CATALOG_TOOL_NAMES = CATALOG_TOOLS.map((t) => t.name);

/**
 * Test seam for the interactive target picker. Production uses
 * `defaultSelectTargets` from interactive-target.ts (readline-backed).
 * Tests inject a stub that returns canned selections without driving
 * a real TTY.
 */
export type TargetSelector = (hosts: readonly DetectedHost[]) => Promise<HostId[]>;

export interface InstallOptions {
  /** Install scope. Defaults to global for backward-compatible CLI behavior. */
  scope?: InstallScope | string;
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
  /**
   * Override `<crewHome>` (where `agents.json` is seeded). Tests pass a
   * tmpdir to avoid touching the real `~/.crew`. Production omits this
   * and falls through to `resolveCrewHome()`.
   */
  crewHome?: string;
  /** Override repository root for project-scope tests. */
  repoRoot?: string;
  /** Override the package root (tests; otherwise auto-detected). */
  packageRoot?: string;
  /** Portable project command strategy. Ignored for global scope. */
  binaryStrategy?: ProjectCrewBinaryStrategy | string;
  /** Platform seam for project binary resolver tests. */
  platform?: NodeJS.Platform;
  /** Override crew binary resolution (tests). */
  resolveCrewBinary?: CrewBinaryResolver;
  /** Test seam for Claude Code `crew-wait` PATH discoverability. */
  isCrewWaitOnPath?: () => boolean;
  /** Test seam for Claude Code absolute `crew-wait` fallback resolution. */
  resolveCrewWaitBinary?: () => string;
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
   * `mcp__crew__*` call. Defaults to true — running `crew-mcp install` IS
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
  const scope = parseInstallScope(opts.scope);
  if (scope === 'project') {
    return installProjectCommand(opts);
  }
  return installGlobalCommand(opts);
}

async function installGlobalCommand(opts: InstallOptions): Promise<InstallResult> {
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
    targets = await resolveTargetsInteractively(opts, 'global');
    camethroughInteractive = true;
    if (targets.length === 0) {
      // User cancelled or no detected hosts — exit cleanly without an error.
      // The interactive helper already explained what happened.
      return { installed: [], skipped: [] };
    }
  } else {
    targets = resolveTargets(targetInput, 'global');
  }

  // For --target all (and the interactive fallback) we only install where
  // we detect the host. For an explicit --target codex, we install
  // regardless (the user knows what they want; they may be installing in
  // advance of the host CLI).
  const isExplicitAll = targetInput === 'all';
  const forceWithoutBinary =
    opts.forceWithoutBinary ?? !(isExplicitAll || camethroughInteractive);

  const result: InstallResult = { installed: [], skipped: [] };

  // Per-home install lock serializes concurrent `crew-mcp install`
  // invocations against the same HOME, so two installs can't race on
  // the manifest or the skill directory. Stale locks from crashed
  // holders are detected via PID liveness check (see atomic-write.ts).
  await withInstallLock(home, async () => {
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
          isCrewWaitOnPath: opts.isCrewWaitOnPath ?? isCrewWaitOnPath,
          resolveCrewWaitBinary: opts.resolveCrewWaitBinary ?? resolveCrewWaitBinary,
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
  });

  // After at least one successful install, seed the per-machine agent
  // prefs file (`<crewHome>/agents.json`) with every registered
  // adapter's defaults. Idempotent: existing files are never
  // overwritten — only the first install creates the file. Done here
  // (not in installSingleTarget) because the file is per-machine, not
  // per-host.
  if (result.installed.length > 0) {
    // Test seam: when callers override `home` (a tmpdir) but not
    // `crewHome`, derive crewHome under that tmpdir to keep the seed
    // off the developer's real `~/.crew`. Production passes neither
    // and falls through to `resolveCrewHome()`.
    const crewHome = opts.crewHome
      ?? (opts.home ? join(opts.home, '.crew') : resolveCrewHome());
    const seeded = seedAgentPrefsFile(crewHome, collectAdapterDefaults());
    if (seeded) {
      logger.info(
        `crew install: seeded ${crewHome}/agents.json with adapter defaults. `
        + 'Edit it (or run `crew agents edit`) to tune per-agent useWhen/strengths/effort.',
      );
    } else {
      logger.info(
        `crew install: existing ${crewHome}/agents.json preserved; pre-existing strengths/useWhen reflect prior defaults until edited.`,
      );
    }
    logger.info(
      'Run `crew-mcp agents add` to register additional models (Ollama, LM Studio, OpenAI-compatible endpoints).',
    );
  }

  return result;
}

async function installProjectCommand(opts: InstallOptions): Promise<InstallResult> {
  const repoRoot = await resolveGitRepoRoot({ repoRoot: opts.repoRoot });
  const packageRoot = resolvePackageRoot(opts.packageRoot);
  const strategy = parseProjectCrewBinaryStrategy(opts.binaryStrategy);
  const { command: crewBin, args: crewArgs } = projectCrewBinaryResolver({
    repoRoot,
    strategy,
    platform: opts.platform,
  });

  const targetInput = (opts.target ?? '').trim();
  let targets: HostId[];
  if (targetInput.length === 0) {
    targets = await resolveTargetsInteractively(opts, 'project');
    if (targets.length === 0) {
      return { installed: [], skipped: [] };
    }
  } else {
    targets = resolveTargets(targetInput, 'project');
  }

  const result: InstallResult = { installed: [], skipped: [] };

  await withInstallLock(repoRoot, async () => {
    for (const targetId of targets) {
      const adapter = HOST_ADAPTERS[targetId];
      try {
        assertProjectCapable(adapter);
        await installSingleProjectTarget({
          adapter,
          repoRoot,
          packageRoot,
          crewBin,
          crewArgs,
          autoApprove: opts.autoApprove ?? true,
          strategy,
          platform: opts.platform,
        });

        if (!opts.skipRunningCheck) {
          const running = await adapter.detectRunning();
          if (running) {
            logger.warn(
              `${adapter.displayName} appears to be running. Restart any open sessions to pick up the new project MCP config.`,
            );
          }
        }

        result.installed.push(targetId);
        logger.info(`crew install: ${adapter.displayName} project scope ✓`);
        for (const note of adapter.projectInstallNotes?.(repoRoot) ?? []) {
          logger.info(note);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`crew install: ${adapter.displayName} project scope failed — ${message}`);
        result.skipped.push({ host: targetId, reason: message });
      }
    }
  });

  if (result.installed.length > 0) {
    logger.info(
      'Project install written. Commit the generated host config, skills, and .crew/install.project.json, then restart each host session.',
    );
  }

  return result;
}

/**
 * Walk the built-in registry to capture each adapter's default
 * useWhen + strengths + effort for the agents.json seed. The registry already
 * canonicalizes adapter names, so this is the right source for the
 * seeded keys (matches what list_agents emits).
 */
function collectAdapterDefaults(): AgentPrefsMap {
  const registry = createBuiltinRegistry();
  const defaults: AgentPrefsMap = {};
  for (const adapter of registry.listAvailable()) {
    defaults[adapter.name] = {
      strengths: [...adapter.strengths],
      ...(adapter.useWhen ? { useWhen: adapter.useWhen } : {}),
      ...(adapter.defaultEffort ? { effort: adapter.defaultEffort } : {}),
    };
  }
  return defaults;
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
  isCrewWaitOnPath?: () => boolean;
  resolveCrewWaitBinary?: () => string;
}): Promise<InstalledTarget> {
  const { adapter, home, packageRoot, crewBin, crewArgs, autoApprove } = args;

  // Resolve the crew-wait command up front so the skill body and the
  // Claude allowlist entry stay in lockstep. The skill embeds this
  // literal as `{{CREW_WAIT_COMMAND}} <run_id>`, and the allowlist is
  // `Bash(<this>:*)` — the two MUST match exactly or the captain's
  // Bash invocation won't pass the matcher.
  //
  // Only Claude Code actually uses the watcher; for the other hosts we
  // pass the bare name so the rendered prose still reads correctly,
  // but those captains default to the portable baseline anyway.
  let crewWaitCommand = 'crew-wait';
  if (adapter.id === 'claude-code') {
    const pathVisible = (args.isCrewWaitOnPath ?? isCrewWaitOnPath)();
    crewWaitCommand = pathVisible
      ? 'crew-wait'
      : (args.resolveCrewWaitBinary ?? resolveCrewWaitBinary)();
  }

  // 1+2. Render + write each skill in the manifest via the helper
  // (single seam for preflight + legacy-removal + atomic-write).
  const { skillsMap, writtenPaths, skillPath, sharedSkills } = await renderAndWriteSkills({
    adapter,
    home,
    packageRoot,
    crewWaitCommand,
  });

  // 3. Merge MCP block into host config.
  const configPath = adapter.configPath(home);
  const existing = existsSync(configPath) ? await readFile(configPath, 'utf-8') : '';
  const merged = adapter.mergeMcpBlock(existing, crewBin, crewArgs);
  writeFileAtomic(configPath, merged);

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
    // Approval consent is per-install for the whole crew surface. Worker-only
    // tools are inert in captain serve, but Codex workers share this installed
    // entry and need their approval blocks for headless sends.
    const approvalUpdated = autoApprove
      ? adapter.writeAutoApproval(approvalExisting, APPROVAL_CATALOG_TOOL_NAMES)
      : adapter.clearAutoApproval(approvalExisting);
    if (approvalUpdated !== approvalExisting) {
      writeFileAtomic(approvalFile, approvalUpdated);
    }
  }

  if (adapter.id === 'claude-code') {
    const approvalFile = adapter.permissionsPath ? adapter.permissionsPath(home) : configPath;
    const approvalExisting = existsSync(approvalFile)
      ? await readFile(approvalFile, 'utf-8')
      : '';
    // crewWaitCommand was resolved above the skill render so the
    // allowlist entry matches the skill body exactly.
    const approvalUpdated = addClaudePermission(
      approvalExisting,
      `Bash(${crewWaitCommand}:*)`,
    );
    if (approvalUpdated !== approvalExisting) {
      writeFileAtomic(approvalFile, approvalUpdated);
    }
    logger.info(
      `crew install: Claude Code crew-wait watcher allowlisted as Bash(${crewWaitCommand}:*). `
      + 'Skill body uses the same command.',
    );
  }

  // 5. Update install manifest.
  const entry: InstalledTarget = {
    configPath,
    skillPath,
    skills: skillsMap,
    writtenPaths,
    ...(Object.keys(sharedSkills).length > 0 ? { sharedSkills } : {}),
    version: CREW_MCP_VERSION,
    installedAt: new Date().toISOString(),
    serverCommand: crewBin,
    serverArgs: [...crewArgs],
    crewWaitCommand,
    autoApproved: autoApprove,
  };
  await recordInstalledTarget(home, adapter.id, entry);

  return entry;
}

export async function installSingleProjectTarget(args: {
  adapter: HostAdapter;
  repoRoot: string;
  packageRoot: string;
  crewBin: string;
  crewArgs: readonly string[];
  autoApprove: boolean;
  strategy: ProjectCrewBinaryStrategy;
  platform?: NodeJS.Platform;
}): Promise<ProjectInstalledTarget> {
  const {
    adapter,
    repoRoot,
    packageRoot,
    crewBin,
    crewArgs,
    autoApprove,
    strategy,
  } = args;
  assertProjectCapable(adapter);

  const crewWaitCommand = projectCrewWaitCommand({
    strategy,
    platform: args.platform,
  });

  const { skillsMap, writtenPaths: skillWrittenPaths, skillPath, sharedSkills } =
    await renderAndWriteSkills({
      adapter,
      home: repoRoot,
      packageRoot,
      crewWaitCommand,
      skillInstallSpecFor: (skill) => adapter.projectSkillInstallSpecFor!(repoRoot, skill),
      fallbackSkillPath: adapter.projectSkillPath!(repoRoot),
      ownedPaths: await collectProjectCrewOwnedPaths(repoRoot),
    });

  const configPath = adapter.projectConfigPath(repoRoot);
  const existing = existsSync(configPath) ? await readFile(configPath, 'utf-8') : '';
  const merged = adapter.mergeMcpBlock(existing, crewBin, crewArgs);
  writeFileAtomic(configPath, merged);

  const writtenPaths = [...skillWrittenPaths, configPath];
  const permissionsPath = adapter.projectPermissionsPath?.(repoRoot);

  if (adapter.writeAutoApproval && adapter.clearAutoApproval) {
    const approvalFile = permissionsPath ?? configPath;
    const approvalExisting = existsSync(approvalFile)
      ? await readFile(approvalFile, 'utf-8')
      : '';
    // Approval consent is per-install for the whole crew surface. Worker-only
    // tools are inert in captain serve, but Codex workers share this installed
    // entry and need their approval blocks for headless sends.
    const approvalUpdated = autoApprove
      ? adapter.writeAutoApproval(approvalExisting, APPROVAL_CATALOG_TOOL_NAMES)
      : adapter.clearAutoApproval(approvalExisting);
    if (approvalUpdated !== approvalExisting) {
      writeFileAtomic(approvalFile, approvalUpdated);
    }
    if (approvalFile !== configPath) {
      writtenPaths.push(approvalFile);
    }
  }

  if (adapter.id === 'claude-code') {
    const approvalFile = permissionsPath ?? configPath;
    const approvalExisting = existsSync(approvalFile)
      ? await readFile(approvalFile, 'utf-8')
      : '';
    const approvalUpdated = addClaudePermission(
      approvalExisting,
      `Bash(${crewWaitCommand}:*)`,
    );
    if (approvalUpdated !== approvalExisting) {
      writeFileAtomic(approvalFile, approvalUpdated);
    }
    if (approvalFile !== configPath && !writtenPaths.includes(approvalFile)) {
      writtenPaths.push(approvalFile);
    }
    logger.info(
      `crew install: Claude Code project crew-wait watcher allowlisted as Bash(${crewWaitCommand}:*). `
      + 'Skill body uses the same command.',
    );
  }

  const absoluteEntry: ProjectInstalledTarget = {
    configPath,
    skillPath,
    skills: skillsMap,
    writtenPaths,
    ...(Object.keys(sharedSkills).length > 0 ? { sharedSkills } : {}),
    ...(permissionsPath ? { permissionsPath } : {}),
    version: CREW_MCP_VERSION,
    installedAt: new Date().toISOString(),
    serverCommand: crewBin,
    serverArgs: [...crewArgs],
    crewWaitCommand,
    autoApproved: autoApprove,
  };
  const relativeEntry = relativizeProjectTarget(repoRoot, absoluteEntry);
  await recordProjectInstalledTarget(repoRoot, adapter.id, relativeEntry);

  return relativeEntry;
}

/**
 * Render every skill in the manifest and write each into its
 * adapter-resolved location. Strict two-phase commit per plan
 * §"Per-host migration":
 *
 *   1. Preflight collision check across ALL specs (refuse if any
 *      target SKILL.md exists AND is not crew-owned per the current
 *      install manifest).
 *   2. Phase 1 — render every skill into a sibling staging file
 *      (`<finalPath>.crew-staging-<pid>-<ts>`). A render failure here
 *      throws BEFORE any final-path mutation; staging files are
 *      cleaned up in finally.
 *   3. Remove `legacyPathsToRemove` (different paths from finals —
 *      stale copies at deprecated locations). Doing this after Phase 1
 *      means a render failure never trashes the legacy file.
 *   4. Phase 2 — atomic-swap each staging file into its final
 *      destination. For each swap: back up any existing destination,
 *      then rename staging → final. Track every step in a rollback
 *      ledger so a mid-loop rename failure restores prior content.
 *   5. Clean up backups on success.
 *
 * Returns the per-skill paths so the caller can record them in the
 * install manifest entry.
 */
async function renderAndWriteSkills(args: {
  readonly adapter: HostAdapter;
  readonly home: string;
  readonly packageRoot: string;
  readonly crewWaitCommand: string;
  readonly skillInstallSpecFor?: (skill: SkillManifestEntry) => SkillInstallSpec;
  readonly fallbackSkillPath?: string;
  readonly ownedPaths?: Set<string>;
}): Promise<{
  readonly skillsMap: Record<string, string>;
  readonly writtenPaths: string[];
  readonly skillPath: string;
  readonly sharedSkills: Record<string, string>;
}> {
  const { adapter, home, packageRoot, crewWaitCommand } = args;
  const templatePath = templatePathForHost(packageRoot, adapter.id);
  const skillInstallSpecFor = args.skillInstallSpecFor
    ?? ((skill: SkillManifestEntry) => adapter.skillInstallSpecFor(home, skill));

  // Resolve all specs up front so the preflight check sees every
  // target before we touch anything on disk.
  const specs = SKILL_MANIFEST.map((skill) => ({
    skill,
    spec: skillInstallSpecFor(skill),
  }));

  // Preflight: refuse if any destination SKILL.md exists AND wasn't
  // written by a prior crew install. Plan §"Atomicity & locking
  // requirements" — preflight collision check.
  const ownedPaths = args.ownedPaths ?? await collectCrewOwnedPaths(home);
  for (const { spec } of specs) {
    if (spec.skip) continue;
    if (existsSync(spec.skillPath) && !ownedPaths.has(spec.skillPath)) {
      throw new Error(
        `crew install: refusing to overwrite ${spec.skillPath} — `
        + 'a file exists at that path but was not written by a prior crew install. '
        + 'Move or delete the file, then re-run install.',
      );
    }
  }

  // Phase 1: render all skills into sibling staging files. Using a
  // sibling guarantees same-FS rename in Phase 2 (POSIX atomic).
  // A failure here throws before any final-dest mutation; the finally
  // cleans up partial staging files.
  const stagingSuffix = `.crew-staging-${process.pid}-${Date.now()}`;
  const staged: Array<{
    skill: SkillManifestEntry;
    spec: SkillInstallSpec;
    stagingPath: string;
  }> = [];
  try {
    for (const { skill, spec } of specs) {
      // Skipped skills render nothing — the host already discovers
      // them from a shared search-path location (~/.agents/skills/).
      // No current host adapter produces skip:true (the retired gemini
      // host did); the machinery stays because install manifests on
      // disk may still carry sharedSkills entries that verify/uninstall
      // read. Their legacyPathsToRemove still runs below, and the
      // shared path they load from is recorded as a sharedSkill.
      if (spec.skip) {
        logger.info(
          `crew install: ${adapter.displayName} — '${skill.id}' already on the host's shared skill `
          + `search path (${spec.skillPath}); using the shared copy and removing any per-host duplicate`,
        );
        continue;
      }
      const skillContent = await renderSkill({
        templatePath,
        skill,
        spec,
        tools: CAPTAIN_CATALOG_TOOLS,
        crewWaitCommand,
        packageRoot,
      });
      const stagingPath = `${spec.skillPath}${stagingSuffix}`;
      mkdirSync(dirname(stagingPath), { recursive: true });
      writeFileSync(stagingPath, skillContent, 'utf-8');
      staged.push({ skill, spec, stagingPath });
    }

    // Legacy removal AFTER Phase 1 (so a render failure doesn't trash
    // the legacy file) and BEFORE Phase 2 (so the swap loop sees a
    // consistent destination layout). Iterate ALL specs (not just
    // staged) so a skipped skill's stale per-host duplicate is still
    // cleaned up.
    for (const { spec } of specs) {
      for (const legacy of spec.legacyPathsToRemove) {
        if (existsSync(legacy)) {
          rmSync(legacy, { force: true });
          // Prune the now-empty parent dir (e.g. ~/.gemini/skills/crew/
          // after removing its SKILL.md) so a skipped/relocated skill
          // doesn't leave an empty directory behind. Best-effort.
          const parent = dirname(legacy);
          try {
            if (readdirSync(parent).length === 0) {
              rmdirSync(parent);
            }
          } catch {
            // Parent missing or non-empty — leave it.
          }
        }
      }
    }

    // Phase 2: per-skill swap with rollback ledger. Each entry records
    // what we need to undo if a later swap fails. Backup paths use
    // `.crew-backup-...` to avoid colliding with Phase 1's staging
    // suffix or writeFileAtomic's `.tmp` suffix.
    interface LedgerEntry {
      readonly finalPath: string;
      readonly backupPath: string | null;
    }
    const ledger: LedgerEntry[] = [];
    try {
      for (const { spec, stagingPath } of staged) {
        const backupPath = existsSync(spec.skillPath)
          ? `${spec.skillPath}.crew-backup-${process.pid}-${Date.now()}-${ledger.length}`
          : null;
        if (backupPath !== null) {
          renameSync(spec.skillPath, backupPath);
        }
        try {
          renameSync(stagingPath, spec.skillPath);
        } catch (renameErr) {
          // Inner-swap failure: the destination is empty (we already
          // moved the original to backup, and the new file didn't
          // land). Restore the backup before re-throwing so the outer
          // rollback only has to undo COMPLETED swaps (those already
          // in the ledger).
          if (backupPath !== null && existsSync(backupPath)) {
            try {
              renameSync(backupPath, spec.skillPath);
            } catch {
              // Best-effort; if restore fails too, the user is in a
              // degraded state and `verify` will surface it.
            }
          }
          throw renameErr;
        }
        ledger.push({ finalPath: spec.skillPath, backupPath });
      }
    } catch (swapErr) {
      // Roll back completed swaps in reverse order. Each entry either
      // had a prior file (restore backup) or didn't (delete the new).
      for (let i = ledger.length - 1; i >= 0; i--) {
        const { finalPath, backupPath } = ledger[i];
        try {
          if (backupPath !== null) {
            try {
              unlinkSync(finalPath);
            } catch {
              // The replaced file may already be gone — fine.
            }
            if (existsSync(backupPath)) {
              renameSync(backupPath, finalPath);
            }
          } else {
            try {
              unlinkSync(finalPath);
            } catch {
              // Already gone — fine.
            }
          }
        } catch (rollbackErr) {
          // Don't mask the original swap error; log loudly so the
          // user knows manual cleanup may be needed.
          const msg = rollbackErr instanceof Error
            ? rollbackErr.message
            : String(rollbackErr);
          logger.error(
            `crew install: rollback of ${finalPath} failed during multi-skill swap recovery — manual cleanup may be needed: ${msg}`,
          );
        }
      }
      throw swapErr;
    }

    // Phase 2 success — clean up backups. Best-effort; a leftover
    // `.crew-backup-*` file is harmless (verify ignores them, the
    // path is unique per install) but we tidy up so the host's
    // skills/ dir stays clean.
    for (const { backupPath } of ledger) {
      if (backupPath !== null && existsSync(backupPath)) {
        try {
          unlinkSync(backupPath);
        } catch {
          // ignore — backup cleanup is best-effort
        }
      }
    }

    const skillsMap: Record<string, string> = {};
    const writtenPaths: string[] = [];
    for (const { skill, spec } of staged) {
      skillsMap[skill.id] = spec.skillPath;
      writtenPaths.push(spec.skillPath);
    }
    // Skills served from a shared search-path location (skip === true):
    // record where the host loads them so verify can confirm presence,
    // but keep them OUT of skillsMap/writtenPaths so uninstall never
    // removes a file another host owns.
    const sharedSkills: Record<string, string> = {};
    for (const { skill, spec } of specs) {
      if (spec.skip) sharedSkills[skill.id] = spec.skillPath;
    }
    // Back-compat `skillPath` (umbrella crew) for older callers that
    // haven't migrated to the multi-skill map. When `crew` is served
    // from a shared location (skipped), leave this empty: the manifest
    // reader back-fills `skills['crew']` from a non-empty skillPath, and
    // that path would be the per-host copy we deliberately didn't write.
    const skillPath = skillsMap['crew']
      ?? (sharedSkills['crew'] ? '' : (args.fallbackSkillPath ?? adapter.skillPath(home)));
    return { skillsMap, writtenPaths, skillPath, sharedSkills };
  } finally {
    // Always clean up leftover staging files (render-failure or
    // swap-failure paths). On full success they've already been
    // renamed and existsSync is false.
    for (const { stagingPath } of staged) {
      if (existsSync(stagingPath)) {
        try {
          unlinkSync(stagingPath);
        } catch {
          // ignore — best-effort cleanup
        }
      }
    }
  }
}

/**
 * Collect every path the current install manifest records as written
 * by crew. Used by the preflight collision check to decide whether an
 * existing file at a target SKILL.md path is safe to overwrite.
 */
async function collectCrewOwnedPaths(home: string): Promise<Set<string>> {
  const owned = new Set<string>();
  try {
    const manifest = await readInstallManifest(home);
    for (const target of Object.values(manifest.targets)) {
      if (!target) continue;
      for (const p of target.writtenPaths) owned.add(p);
      for (const p of Object.values(target.skills)) owned.add(p);
      if (target.skillPath) owned.add(target.skillPath);
    }
  } catch {
    // If the manifest is unreadable, treat NO paths as owned. The
    // preflight will then refuse any existing target SKILL.md — safest
    // default. The user can clean up + retry.
  }
  return owned;
}

async function collectProjectCrewOwnedPaths(repoRoot: string): Promise<Set<string>> {
  const owned = new Set<string>();
  try {
    const manifest = await readProjectInstallManifest(repoRoot);
    for (const target of Object.values(manifest.targets)) {
      if (!target) continue;
      const absoluteTarget = absolutizeProjectTarget(repoRoot, target);
      for (const p of absoluteTarget.writtenPaths) owned.add(p);
      for (const p of Object.values(absoluteTarget.skills)) owned.add(p);
      if (absoluteTarget.skillPath) owned.add(absoluteTarget.skillPath);
    }
  } catch {
    // Same safety rule as global installs: an unreadable manifest means
    // no path is considered crew-owned, so preflight refuses collisions.
  }
  return owned;
}

function assertProjectCapable(
  adapter: HostAdapter,
): asserts adapter is HostAdapter & {
  projectConfigPath(repoRoot: string): string;
  projectSkillPath(repoRoot: string): string;
  projectSkillInstallSpecFor(repoRoot: string, skill: SkillManifestEntry): SkillInstallSpec;
} {
  if (
    !adapter.projectConfigPath
    || !adapter.projectSkillPath
    || !adapter.projectSkillInstallSpecFor
  ) {
    throw new Error(
      `${adapter.displayName} does not support project-scope install. `
      + `Project-scope targets: ${PROJECT_HOST_IDS.join(', ')}`,
    );
  }
}

function addClaudePermission(existing: string, pattern: string): string {
  const parsed = parseJsonObject(existing, 'Claude permissions');
  const permissions = getObjectField(parsed, 'permissions');
  const allow = Array.isArray(permissions.allow) ? [...permissions.allow] : [];
  if (!allow.includes(pattern)) {
    allow.push(pattern);
  }
  permissions.allow = allow;
  parsed.permissions = permissions;
  return JSON.stringify(parsed, null, 2) + '\n';
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('root is not a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${label} as JSON: ${message}`);
  }
}

function getObjectField(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = parent[key];
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    return {};
  }
  return current as Record<string, unknown>;
}

/**
 * Resolve the --target arg to a list of host ids. Supports:
 *   - 'all' → every registered host
 *   - 'claude-code,codex' → comma-separated list
 *   - 'codex' → single host
 *
 * Throws on unknown ids; throws on empty target string. Deduplicates.
 */
export function resolveTargets(input: string, scope: InstallScope = 'global'): HostId[] {
  const trimmed = input.trim();
  const allowed = scope === 'project' ? PROJECT_HOST_IDS : GLOBAL_HOST_IDS;
  if (trimmed.length === 0) {
    throw new Error('crew install: --target is required (e.g., codex, claude-code, all)');
  }
  if (trimmed === 'all') return [...allowed];
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
    if (scope === 'project' && !isProjectHostId(part)) {
      throw new Error(
        `crew install: target "${part}" does not support project scope. `
        + `Project-scope targets: ${PROJECT_HOST_IDS.join(', ')}, all`,
      );
    }
    if (scope === 'global' && !isGlobalHostId(part)) {
      throw new Error(
        `crew install: target "${part}" does not support global scope. `
        + `Global-scope targets: ${GLOBAL_HOST_IDS.join(', ')}, all. `
        + `(agy is project-scope only — use \`--scope project --target ${part}\`.)`,
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
async function resolveTargetsInteractively(
  opts: InstallOptions,
  scope: InstallScope,
): Promise<HostId[]> {
  if (scope === 'project') {
    return resolveProjectTargetsInteractively(opts);
  }

  const detected = await detectAllHosts();
  const detectedCount = detected.filter((h) => h.installed).length;
  const isInteractive = opts.isInteractive ?? Boolean(process.stdin.isTTY);

  if (!isInteractive) {
    if (detectedCount === 0) {
      logger.info(
        'crew install: no host CLIs detected on PATH and no --target given; nothing to install. '
        + `Try \`crew install --target <${GLOBAL_HOST_IDS.join(' | ')}>\`.`,
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
      + `Force-install one with \`crew install --target <${GLOBAL_HOST_IDS.join(' | ')}>\`.`,
    );
    return [];
  }

  const selector: TargetSelector = opts.selectTargets
    ?? ((hosts) => defaultSelectTargets({ hosts }));
  return selector(detected);
}

async function resolveProjectTargetsInteractively(opts: InstallOptions): Promise<HostId[]> {
  const hosts = PROJECT_HOST_IDS.map((id): DetectedHost => {
    const adapter = HOST_ADAPTERS[id];
    return {
      id,
      displayName: adapter.displayName,
      installed: true,
      version: 'project scope',
    };
  });
  const isInteractive = opts.isInteractive ?? Boolean(process.stdin.isTTY);

  if (!isInteractive) {
    logger.info(
      `crew install: no --target given for project scope (non-interactive); installing project-capable hosts: ${PROJECT_HOST_IDS.join(', ')}.`,
    );
    return [...PROJECT_HOST_IDS];
  }

  const selector: TargetSelector = opts.selectTargets
    ?? ((selectableHosts) => defaultSelectTargets({ hosts: selectableHosts }));
  return selector(hosts);
}

/**
 * Run `detectInstalled` against every registered host adapter.
 * Concurrent so a slow detection can't block the others. Errors are
 * absorbed (treated as "not detected") — `detectInstalled` is best-
 * effort by contract.
 */
async function detectAllHosts(): Promise<DetectedHost[]> {
  const results = await Promise.all(
    // Global scope only: agy (project-only) is excluded — it has no
    // global MCP config to install into, so the global picker must not
    // offer it.
    GLOBAL_HOST_IDS.map(async (id): Promise<DetectedHost> => {
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
