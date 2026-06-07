/**
 * `crew-mcp config` — interactive TUI for per-machine settings.
 *
 * Renders the config entries as a checkbox list. Up/down (or j/k)
 * moves the cursor; space toggles; Enter saves and exits; q or Ctrl+C
 * cancels without writing. Designed to grow: add an entry to
 * `buildEntries()` and the list picks it up.
 *
 * The TUI requires a TTY on both stdin and stdout. In non-TTY contexts
 * (CI, piped output) we print the current state + a hint and exit 1,
 * so scripted callers don't hang on a prompt that can't be answered.
 *
 * Hand-rolled raw-mode reader rather than a prompt-library dep — same
 * approach as `interactive-target.ts` for `crew-mcp install`.
 */

import { emitKeypressEvents } from 'node:readline';

import {
  CheckboxListScreen,
  type CheckboxListEntry,
} from './config-tui/checkbox-list-screen.js';
import {
  AgentDefaultsScreen,
  type AgentInventory,
} from './config-tui/agent-defaults-screen.js';
import {
  AgentDefaultsState,
  applyAgentDefaultsState,
} from './config-tui/agent-defaults-state.js';
import { CleanupScreen } from './config-tui/cleanup-screen.js';
import {
  isPushResult,
  type Screen,
} from './config-tui/screen.js';
import { cleanupCommand } from './cleanup.js';
import { readAgentPrefsFile } from '../../agent-prefs/store.js';
import {
  BUILTIN_ADAPTER_NAMES,
  createBuiltinRegistry,
  mergeCustomAgents,
} from '../../adapters/registry.js';
import { listAgents } from '../../orchestrator/tools/list-agents.js';
import { resolveCrewHome } from '../../utils/crew-home.js';
import {
  type CrewConfig,
  DEFAULT_CONFIG,
  readConfigFile,
  resolveConfigPath,
  writeConfigFile,
} from '../../utils/config-store.js';
import {
  setConfigValue,
  showConfig as showWorkflowConfig,
  unsetConfigValue,
} from '../../workflow/config-service.js';
import type { WorkflowAgentDefaultsConfig } from '../../workflow/types.js';
import { logger } from '../../utils/logger.js';

export type MutableCrewConfig = {
  notifications: {
    success: boolean;
    error: boolean;
  };
  confirmBeforeMerge: boolean;
  cleanup: {
    worktreeTtlDays: number;
    runDirTtlDays: number;
    criteriaSetTtlDays: number;
  };
};

interface ConfigEntry {
  readonly label: string;
  readonly description: string;
  readonly get: (state: CrewConfig | MutableCrewConfig) => boolean;
  readonly set: (state: MutableCrewConfig, value: boolean) => void;
}

/**
 * Order matters — first entry is highlighted on open.
 */
function buildEntries(): readonly ConfigEntry[] {
  return [
    {
      label: 'notifications.success',
      description: 'OS toast on successful runs',
      get: (state) => state.notifications.success,
      set: (state, value) => {
        state.notifications.success = value;
      },
    },
    {
      label: 'notifications.error',
      description: 'OS toast on failed or partial runs',
      get: (state) => state.notifications.error,
      set: (state, value) => {
        state.notifications.error = value;
      },
    },
    {
      label: 'confirmBeforeMerge',
      description: 'Ask before merging dispatched runs (off = auto-merge)',
      get: (state) => state.confirmBeforeMerge,
      set: (state, value) => {
        state.confirmBeforeMerge = value;
      },
    },
  ];
}

export interface ConfigCommandOptions {
  /** Test seam — override the TTY assumption. */
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly cwd?: string;
  readonly crewHome?: string;
  /** Test seam — override list_agents discovery. Called once per TUI startup. */
  readonly listAgentInventory?: () => Promise<AgentInventory>;
}

export async function configCommand(opts: ConfigCommandOptions = {}): Promise<number> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const cwd = opts.cwd ?? process.cwd();
  const crewHome = opts.crewHome ?? resolveCrewHome();
  const configPath = resolveConfigPath(crewHome);
  const entries = buildEntries();
  const current = readConfigFile(crewHome);

  if (!stdin.isTTY || !stdout.isTTY) {
    // Non-interactive surface: print the current state so users in CI
    // can at least see what's configured, plus an actionable hint.
    stdout.write('crew-mcp config (current settings):\n\n');
    for (const entry of entries) {
      const value = entry.get(current);
      stdout.write(`  ${entry.label}: ${value ? 'on' : 'off'}\n`);
    }
    stdout.write(`  cleanup.worktreeTtlDays: ${fmtTtlDays(current.cleanup.worktreeTtlDays)}\n`);
    stdout.write(`  cleanup.runDirTtlDays: ${fmtTtlDays(current.cleanup.runDirTtlDays)}\n`);
    stdout.write(`  cleanup.criteriaSetTtlDays: ${fmtTtlDays(current.cleanup.criteriaSetTtlDays)}\n`);
    writeAgentDefaultsSummary(stdout, showWorkflowConfig(cwd).effectiveConfig.workflow.agentDefaults);
    stdout.write(
      `\nInteractive editing requires a TTY. Edit ${configPath} directly,\n`
      + 'or run `crew-mcp config` in a real terminal.\n',
    );
    return 1;
  }

  const state: MutableCrewConfig = {
    notifications: {
      success: current.notifications.success,
      error: current.notifications.error,
    },
    confirmBeforeMerge: current.confirmBeforeMerge,
    cleanup: {
      worktreeTtlDays: current.cleanup.worktreeTtlDays,
      runDirTtlDays: current.cleanup.runDirTtlDays,
      criteriaSetTtlDays: current.cleanup.criteriaSetTtlDays,
    },
  };
  const agentInventory = await loadAgentInventory({
    crewHome,
    listAgentInventory: opts.listAgentInventory,
  });
  const agentDefaultsState = new AgentDefaultsState(
    showWorkflowConfig(cwd).effectiveConfig.workflow.agentDefaults,
  );
  const agentDefaultsScreen = new AgentDefaultsScreen(agentDefaultsState, agentInventory);
  const cleanupScreen = new CleanupScreen(state.cleanup);
  const rootScreen = createRootScreen({
    entries,
    state,
    beforeSave: () => agentDefaultsState.validateForSave(),
    extraEntries: [
      {
        kind: 'action',
        label: 'Agent defaults...',
        description: 'Configure default agents for iterate and panel workflows',
        onActivate: () => ({ push: agentDefaultsScreen }),
      },
      {
        kind: 'action',
        label: 'Cleanup & retention...',
        description: 'Set GC retention windows and reclaim stale worktrees/run-dirs now',
        onActivate: () => ({ push: cleanupScreen }),
      },
    ],
  });
  const result = await driveTui({ stdin, stdout, screens: [rootScreen] });

  // A "Run cleanup now" / "Preview" pick in the submenu exits the TUI via
  // `save` (cleanup is async and can't run inside the key handler). Treat
  // that as a save so any TTL edits persist, then run the GC after teardown.
  const cleanupRequested = cleanupScreen.requested;

  if (result === 'cancelled' && cleanupRequested === undefined) {
    stdout.write('\ncrew-mcp config: cancelled (no changes written).\n');
    return 0;
  }

  // Only write if something actually changed — avoids touching the
  // file mtime on a no-op save.
  const crewChanged = !sameConfig(current, state, entries)
    || current.cleanup.worktreeTtlDays !== state.cleanup.worktreeTtlDays
    || current.cleanup.runDirTtlDays !== state.cleanup.runDirTtlDays
    || current.cleanup.criteriaSetTtlDays !== state.cleanup.criteriaSetTtlDays;
  const agentDefaultsChanged = agentDefaultsState.hasChanges();
  if (crewChanged) {
    writeConfigFile(crewHome, state);
  }
  if (agentDefaultsChanged) {
    applyAgentDefaultsState(cwd, agentDefaultsState);
  }
  if (crewChanged && !agentDefaultsChanged) {
    stdout.write(`\ncrew-mcp config: saved to ${configPath}\n`);
  } else if (crewChanged || agentDefaultsChanged) {
    stdout.write('\ncrew-mcp config: saved.\n');
  } else if (cleanupRequested === undefined) {
    stdout.write('\ncrew-mcp config: no changes.\n');
  }

  if (cleanupRequested !== undefined) {
    stdout.write('\n');
    await cleanupCommand({
      cwd,
      crewHome,
      dryRun: cleanupRequested === 'dry',
      stdout,
    });
  }
  return 0;
}

function fmtTtlDays(days: number): string {
  return days < 0 ? 'off' : `${days}d`;
}

export interface ConfigSubcommandOptions {
  readonly stdout?: Pick<NodeJS.WriteStream, 'write'>;
  readonly cwd?: string;
  readonly crewHome?: string;
}

export async function configShowCommand(
  path?: string,
  opts: ConfigSubcommandOptions = {},
): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const payload = buildShowPayload(opts);
  const value = path ? readShowPath(payload, path) : payload;
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  return 0;
}

export async function configSetCommand(
  path: string,
  rawValue: string,
  opts: ConfigSubcommandOptions = {},
): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  if (isCrewSettingPath(path)) {
    const crewHome = opts.crewHome ?? resolveCrewHome();
    const next = mutableConfig(readConfigFile(crewHome));
    writeCrewSetting(next, path, parseBooleanValue(path, rawValue));
    writeConfigFile(crewHome, next);
    stdout.write(`${path}: ${JSON.stringify(readCrewSetting(next, path))}\n`);
    return 0;
  }

  const scope = isAgentDefaultsPath(path) ? { scope: 'global' as const } : {};
  const result = setConfigValue(opts.cwd ?? process.cwd(), path, rawValue, scope);
  stdout.write(`${path}: ${JSON.stringify(result.nextValue)}\n`);
  return 0;
}

export async function configUnsetCommand(
  path: string,
  opts: ConfigSubcommandOptions = {},
): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  if (isCrewSettingPath(path)) {
    const crewHome = opts.crewHome ?? resolveCrewHome();
    const next = mutableConfig(readConfigFile(crewHome));
    writeCrewSetting(next, path, readCrewSetting(DEFAULT_CONFIG, path));
    writeConfigFile(crewHome, next);
    stdout.write(`${path}: ${JSON.stringify(readCrewSetting(next, path))}\n`);
    return 0;
  }

  const scope = isAgentDefaultsPath(path) ? { scope: 'global' as const } : {};
  const result = unsetConfigValue(opts.cwd ?? process.cwd(), path, scope);
  stdout.write(`${path}: ${JSON.stringify(result.nextValue)}\n`);
  return 0;
}

function buildShowPayload(opts: ConfigSubcommandOptions): Record<string, unknown> {
  const crewHome = opts.crewHome ?? resolveCrewHome();
  const workflow = showWorkflowConfig(opts.cwd ?? process.cwd());
  const crewConfig = readConfigFile(crewHome);
  return {
    notifications: crewConfig.notifications,
    confirmBeforeMerge: crewConfig.confirmBeforeMerge,
    cleanup: crewConfig.cleanup,
    ...workflow.effectiveConfig,
  };
}

function readShowPath(payload: Record<string, unknown>, path: string): unknown {
  if (isCrewSettingPath(path)) {
    return readCrewSetting(payload as unknown as CrewConfig, path);
  }
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, payload);
}

function isCrewSettingPath(path: string): path is 'notifications.success' | 'notifications.error' | 'confirmBeforeMerge' {
  return path === 'notifications.success'
    || path === 'notifications.error'
    || path === 'confirmBeforeMerge';
}

function readCrewSetting(config: CrewConfig, path: string): boolean {
  switch (path) {
    case 'notifications.success':
      return config.notifications.success;
    case 'notifications.error':
      return config.notifications.error;
    case 'confirmBeforeMerge':
      return config.confirmBeforeMerge;
    default:
      throw new Error(`Unsupported config path "${path}".`);
  }
}

function writeCrewSetting(
  config: MutableCrewConfig,
  path: string,
  value: boolean,
): void {
  switch (path) {
    case 'notifications.success':
      config.notifications.success = value;
      return;
    case 'notifications.error':
      config.notifications.error = value;
      return;
    case 'confirmBeforeMerge':
      config.confirmBeforeMerge = value;
      return;
    default:
      throw new Error(`Unsupported config path "${path}".`);
  }
}

function parseBooleanValue(path: string, raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (['true', 'on', '1', 'yes'].includes(normalized)) return true;
  if (['false', 'off', '0', 'no'].includes(normalized)) return false;
  throw new Error(`Invalid value for ${path}: expected boolean, received "${raw}".`);
}

function mutableConfig(config: CrewConfig): MutableCrewConfig {
  return {
    notifications: {
      success: config.notifications.success,
      error: config.notifications.error,
    },
    confirmBeforeMerge: config.confirmBeforeMerge,
    cleanup: {
      worktreeTtlDays: config.cleanup.worktreeTtlDays,
      runDirTtlDays: config.cleanup.runDirTtlDays,
      criteriaSetTtlDays: config.cleanup.criteriaSetTtlDays,
    },
  };
}

function sameConfig(
  a: CrewConfig,
  b: CrewConfig | MutableCrewConfig,
  entries: readonly ConfigEntry[],
): boolean {
  return JSON.stringify(entries.map((entry) => entry.get(a)))
    === JSON.stringify(entries.map((entry) => entry.get(b)));
}

function writeAgentDefaultsSummary(
  stdout: Pick<NodeJS.WriteStream, 'write'>,
  defaults: WorkflowAgentDefaultsConfig | undefined,
): void {
  stdout.write('\n');
  stdout.write(
    `  ${AGENT_DEFAULT_PATH_LABELS.iterateImplementer}: ${defaults?.iterate?.implementer ?? '(unset)'}\n`,
  );
  stdout.write(
    `  ${AGENT_DEFAULT_PATH_LABELS.iterateReviewers}: ${formatList(defaults?.iterate?.reviewers)}\n`,
  );
  stdout.write(
    `  ${AGENT_DEFAULT_PATH_LABELS.iterateBanList}: ${formatList(defaults?.iterate?.banList)}\n`,
  );
  stdout.write(
    `  ${AGENT_DEFAULT_PATH_LABELS.panelReviewers}: ${formatList(defaults?.panel?.reviewers)}\n`,
  );
  stdout.write(
    `  ${AGENT_DEFAULT_PATH_LABELS.panelBanList}: ${formatList(defaults?.panel?.banList)}\n`,
  );
}

const AGENT_DEFAULT_PATH_LABELS = {
  iterateImplementer: 'workflow.agentDefaults.iterate.implementer',
  iterateReviewers: 'workflow.agentDefaults.iterate.reviewers',
  iterateBanList: 'workflow.agentDefaults.iterate.banList',
  panelReviewers: 'workflow.agentDefaults.panel.reviewers',
  panelBanList: 'workflow.agentDefaults.panel.banList',
} as const;

function formatList(values: readonly string[] | undefined): string {
  return values && values.length > 0 ? values.join(', ') : '(empty)';
}

interface TuiArgs {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly screens: readonly Screen[];
}

type TuiResult = 'saved' | 'cancelled';

export function driveTui(args: TuiArgs): Promise<TuiResult> {
  const { stdin, stdout } = args;
  const screenStack = [...args.screens];
  if (screenStack.length === 0) {
    throw new Error('driveTui requires at least one screen.');
  }
  let renderedLines = 0;

  // Clip each line to the terminal width so a narrow terminal can't
  // wrap a description and break the cursor-up-by-N redraw math.
  // `stdout.columns` may be undefined when not on a real TTY; we
  // already guard the non-TTY case at the call site, but keep a
  // sensible fallback. Subtract 1 to leave a column for the cursor
  // and avoid edge-case wrap on some terminals when filling the row.
  const clip = (line: string): string => {
    const cols = stdout.columns ?? 80;
    const limit = Math.max(10, cols - 1);
    return line.length <= limit ? line : line.slice(0, limit);
  };

  const render = (): void => {
    if (renderedLines > 0) {
      // Move up to the top of the previous frame and clear downward.
      stdout.write(`\x1b[${renderedLines}A`);
      stdout.write('\x1b[0J');
    }
    const lines = currentScreen().render();
    for (const line of lines) stdout.write(`${clip(line)}\n`);
    renderedLines = lines.length;
  };

  const currentScreen = (): Screen => screenStack[screenStack.length - 1];

  return new Promise<TuiResult>((resolve) => {
    emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    let cleanedUp = false;

    // Single idempotent teardown path: any exit (normal key, error,
    // SIGINT/SIGTERM, terminal disconnect) must restore raw mode and
    // detach listeners exactly once. Without this, an exception
    // partway through render or an external signal can leave the
    // user's shell in raw mode and unusable.
    const cleanup = (result: TuiResult): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      stdin.removeListener('keypress', onKeypress);
      stdout.removeListener('resize', onResize);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.off('uncaughtException', onFatal);
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        // Best-effort — if even restoring raw mode fails the process
        // is in trouble already; nothing useful to do here.
      }
      stdin.pause();
      resolve(result);
    };

    const onSignal = (): void => cleanup('cancelled');
    const onFatal = (err: Error): void => {
      cleanup('cancelled');
      // Re-throw on the next tick so Node's default unhandled-error
      // path still surfaces the crash to the user. The cleanup above
      // restores the terminal first so the error message is readable.
      setImmediate(() => {
        throw err;
      });
    };

    const onResize = (): void => {
      // On resize, force a full redraw with no upward seek — the
      // previous frame's row count is no longer trustworthy after
      // the terminal reflows.
      renderedLines = 0;
      render();
    };

    const onKeypress = (
      _str: string | undefined,
      key: { name?: string; ctrl?: boolean; sequence?: string } | undefined,
    ): void => {
      if (!key) return;
      try {
        if (key.ctrl && key.name === 'c') {
          cleanup('cancelled');
          return;
        }
        const result = currentScreen().onKey(key);
        if (isPushResult(result)) {
          screenStack.push(result.push);
          render();
          return;
        }
        switch (result) {
          case 'continue':
            render();
            return;
          case 'pop':
            if (screenStack.length > 1) {
              screenStack.pop();
              render();
              return;
            }
            cleanup('cancelled');
            return;
          case 'save':
            cleanup('saved');
            return;
          case 'cancel':
            cleanup('cancelled');
            return;
        }
      } catch (err) {
        onFatal(err instanceof Error ? err : new Error(String(err)));
      }
    };

    try {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('keypress', onKeypress);
      stdout.on('resize', onResize);
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      process.on('uncaughtException', onFatal);
      render();
    } catch (err) {
      onFatal(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function createRootScreen(args: {
  readonly entries: readonly ConfigEntry[];
  readonly state: MutableCrewConfig;
  readonly beforeSave?: () => string | undefined;
  readonly extraEntries?: readonly CheckboxListEntry<MutableCrewConfig>[];
}): CheckboxListScreen<MutableCrewConfig> {
  return new CheckboxListScreen<MutableCrewConfig>({
    title: 'crew-mcp config — toggle settings',
    entries: [
      ...args.entries,
      ...(args.extraEntries ?? []),
    ],
    state: args.state,
    beforeSave: args.beforeSave,
  });
}

async function loadAgentInventory(args: {
  readonly crewHome: string;
  readonly listAgentInventory?: () => Promise<AgentInventory>;
}): Promise<AgentInventory> {
  if (args.listAgentInventory) {
    return normalizeInventory(await args.listAgentInventory());
  }

  const registry = createBuiltinRegistry();
  const agentPrefs = readAgentPrefsFile(args.crewHome);
  const { warnings } = mergeCustomAgents(registry, agentPrefs, {
    reservedNames: BUILTIN_ADAPTER_NAMES,
  });
  for (const warning of warnings) {
    logger.warn(warning);
  }
  const out = await listAgents({ registry, agentPrefs });
  return normalizeInventory({
    agentIds: out.agents.map((agent) => agent.name),
    knownIds: new Set(out.agents.flatMap((agent) => [
      agent.name,
      ...(agent.aliases ?? []),
    ])),
  });
}

function normalizeInventory(inventory: AgentInventory): AgentInventory {
  const agentIds = uniqueStrings(inventory.agentIds);
  const knownIds = new Set(uniqueStrings([
    ...agentIds,
    ...inventory.knownIds,
  ]));
  return { agentIds, knownIds };
}

function isAgentDefaultsPath(path: string): boolean {
  return path.startsWith('workflow.agentDefaults.');
}

function uniqueStrings(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
