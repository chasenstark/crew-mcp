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
import {
  AgentStrengthsListScreen,
} from './config-tui/agent-strengths-screen.js';
import {
  AgentStrengthsState,
  applyAgentStrengthsState,
  type AgentStrengthsEntry,
} from './config-tui/agent-strengths-state.js';
import { CleanupScreen } from './config-tui/cleanup-screen.js';
import { IterateLimitsScreen } from './config-tui/iterate-limits-screen.js';
import { PrWatchLimitsScreen } from './config-tui/pr-watch-limits-screen.js';
import { ProviderModelDefaultsScreen } from './config-tui/provider-model-defaults-screen.js';
import {
  ProviderModelDefaultsState,
  applyProviderModelDefaultsState,
  setProviderModelDefault,
  type ProviderModelInventoryEntry,
} from './config-tui/provider-model-defaults-state.js';
import {
  isPushResult,
  type Screen,
} from './config-tui/screen.js';
import { cleanupCommand } from './cleanup.js';
import {
  readAgentPrefsFile,
  type AgentPrefsMap,
} from '../../agent-prefs/store.js';
import {
  BUILTIN_ADAPTER_NAMES,
  createBuiltinRegistry,
  mergeCustomAgents,
} from '../../adapters/registry.js';
import type { AdapterModelResolution, ModelDescriptor } from '../../adapters/types.js';
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
  iterate: {
    maxRoundsPerEpoch: number;
    maxTotalRounds: number;
  };
  prWatch: {
    maxActionableWakes: number;
    maxActionRounds: number;
    maxWatchAgeDays: number;
  };
  cleanup: {
    worktreeTtlDays: number;
    runDirTtlDays: number;
    criteriaSetTtlDays: number;
    prWatchTtlDays: number;
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
    stdout.write(`  iterate.maxRoundsPerEpoch: ${current.iterate.maxRoundsPerEpoch}\n`);
    stdout.write(`  iterate.maxTotalRounds: ${current.iterate.maxTotalRounds}\n`);
    stdout.write(`  prWatch.maxActionableWakes: ${current.prWatch.maxActionableWakes}\n`);
    stdout.write(`  prWatch.maxActionRounds: ${current.prWatch.maxActionRounds}\n`);
    stdout.write(`  prWatch.maxWatchAgeDays: ${fmtTtlDays(current.prWatch.maxWatchAgeDays)}\n`);
    stdout.write(`  cleanup.prWatchTtlDays: ${fmtTtlDays(current.cleanup.prWatchTtlDays)}\n`);
    writeAgentDefaultsSummary(stdout, showWorkflowConfig(cwd).effectiveConfig.workflow.agentDefaults);
    writeProviderModelDefaultsSummary(stdout, readAgentPrefsFile(crewHome));
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
    iterate: {
      maxRoundsPerEpoch: current.iterate.maxRoundsPerEpoch,
      maxTotalRounds: current.iterate.maxTotalRounds,
    },
    prWatch: {
      maxActionableWakes: current.prWatch.maxActionableWakes,
      maxActionRounds: current.prWatch.maxActionRounds,
      maxWatchAgeDays: current.prWatch.maxWatchAgeDays,
    },
    cleanup: {
      worktreeTtlDays: current.cleanup.worktreeTtlDays,
      runDirTtlDays: current.cleanup.runDirTtlDays,
      criteriaSetTtlDays: current.cleanup.criteriaSetTtlDays,
      prWatchTtlDays: current.cleanup.prWatchTtlDays,
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
  const providerModelDefaultsState = new ProviderModelDefaultsState(
    agentInventory.providerModels ?? [],
  );
  const providerModelDefaultsScreen = new ProviderModelDefaultsScreen(
    providerModelDefaultsState,
  );
  const agentStrengthsState = new AgentStrengthsState(
    agentInventory.agents ?? agentInventory.agentIds.map((name) => ({
      name,
      strengths: [],
    })),
  );
  const agentStrengthsScreen = new AgentStrengthsListScreen(agentStrengthsState);
  const cleanupScreen = new CleanupScreen(state.cleanup);
  const iterateLimitsScreen = new IterateLimitsScreen(state.iterate);
  const prWatchLimitsScreen = new PrWatchLimitsScreen(state.prWatch);
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
        label: 'Provider models...',
        description: 'Choose the default model for each provider',
        onActivate: () => ({ push: providerModelDefaultsScreen }),
      },
      {
        kind: 'action',
        label: 'Agent strengths...',
        description: 'Tune per-agent routing prose and strength tags',
        onActivate: () => ({ push: agentStrengthsScreen }),
      },
      {
        kind: 'action',
        label: 'Iteration limits...',
        description: 'Set crew-iterate round limits per epoch and overall',
        onActivate: () => ({ push: iterateLimitsScreen }),
      },
      {
        kind: 'action',
        label: 'Cleanup & retention...',
        description: 'Set GC retention windows and reclaim stale worktrees/run-dirs now',
        onActivate: () => ({ push: cleanupScreen }),
      },
      {
        kind: 'action',
        label: 'PR-watch limits...',
        description: 'Set actionable wake, action-round, and watch-age limits',
        onActivate: () => ({ push: prWatchLimitsScreen }),
      },
    ],
  });
  const result = await driveTui({
    stdin,
    stdout,
    screens: [rootScreen],
    beforeSave: () => agentDefaultsState.validateForSave(),
  });

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
    || current.cleanup.criteriaSetTtlDays !== state.cleanup.criteriaSetTtlDays
    || current.cleanup.prWatchTtlDays !== state.cleanup.prWatchTtlDays
    || current.iterate.maxRoundsPerEpoch !== state.iterate.maxRoundsPerEpoch
    || current.iterate.maxTotalRounds !== state.iterate.maxTotalRounds
    || current.prWatch.maxActionableWakes !== state.prWatch.maxActionableWakes
    || current.prWatch.maxActionRounds !== state.prWatch.maxActionRounds
    || current.prWatch.maxWatchAgeDays !== state.prWatch.maxWatchAgeDays;
  const agentDefaultsChanged = agentDefaultsState.hasChanges();
  const providerModelsChanged = providerModelDefaultsState.hasChanges();
  const agentStrengthsChanged = agentStrengthsState.hasChanges();
  if (providerModelsChanged) {
    const validationError = await validateProviderModelChanges(
      providerModelDefaultsState,
      agentInventory,
    );
    if (validationError !== undefined) {
      stdout.write(`\ncrew-mcp config: could not save provider model defaults: ${validationError}\n`);
      return 1;
    }
  }
  if (agentStrengthsChanged) {
    try {
      applyAgentStrengthsState(crewHome, agentStrengthsState);
    } catch (err) {
      stdout.write(
        `\ncrew-mcp config: could not save agent strengths: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }
  if (providerModelsChanged) {
    try {
      applyProviderModelDefaultsState(crewHome, providerModelDefaultsState);
    } catch (err) {
      stdout.write(
        `\ncrew-mcp config: could not save provider model defaults: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }
  if (crewChanged) {
    writeConfigFile(crewHome, state);
  }
  if (agentDefaultsChanged) {
    applyAgentDefaultsState(cwd, agentDefaultsState);
  }
  if (
    crewChanged
    && !agentDefaultsChanged
    && !providerModelsChanged
    && !agentStrengthsChanged
  ) {
    stdout.write(`\ncrew-mcp config: saved to ${configPath}\n`);
  } else if (
    crewChanged
    || agentDefaultsChanged
    || providerModelsChanged
    || agentStrengthsChanged
  ) {
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
  /** Test seam for provider-native exact model validation. */
  readonly resolveProviderModel?: (
    providerName: string,
    requestedModel: string,
  ) => Promise<AdapterModelResolution>;
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
  const providerName = parseProviderModelPath(path);
  if (providerName !== undefined) {
    const crewHome = opts.crewHome ?? resolveCrewHome();
    const resolution = await (
      opts.resolveProviderModel ?? resolveBuiltinProviderModel
    )(providerName, rawValue);
    if (!resolution.ok) throw new Error(resolution.message);
    setProviderModelDefault(crewHome, providerName, resolution.argument);
    stdout.write(`${path}: ${JSON.stringify(resolution.argument)}\n`);
    return 0;
  }
  if (isCrewSettingPath(path)) {
    const crewHome = opts.crewHome ?? resolveCrewHome();
    const next = mutableConfig(readConfigFile(crewHome));
    writeCrewSetting(next, path, parseCrewSettingValue(path, rawValue));
    validateIterateLimits(next.iterate);
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
  const providerName = parseProviderModelPath(path);
  if (providerName !== undefined) {
    const crewHome = opts.crewHome ?? resolveCrewHome();
    setProviderModelDefault(crewHome, providerName, undefined);
    stdout.write(`${path}: null\n`);
    return 0;
  }
  if (isCrewSettingPath(path)) {
    const crewHome = opts.crewHome ?? resolveCrewHome();
    const next = mutableConfig(readConfigFile(crewHome));
    writeCrewSetting(next, path, readCrewSetting(DEFAULT_CONFIG, path));
    validateIterateLimits(next.iterate);
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
    iterate: crewConfig.iterate,
    prWatch: crewConfig.prWatch,
    cleanup: crewConfig.cleanup,
    providerModels: configuredProviderModels(readAgentPrefsFile(crewHome)),
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

function parseProviderModelPath(path: string): string | undefined {
  if (!path.startsWith('providerModels.')) return undefined;
  const providerName = path.slice('providerModels.'.length);
  if (providerName.length === 0 || providerName.includes('.')) {
    throw new Error(
      `Invalid provider model path "${path}". Expected providerModels.<provider>.`,
    );
  }
  if (!(BUILTIN_ADAPTER_NAMES as readonly string[]).includes(providerName)) {
    throw new Error(
      `Unknown provider "${providerName}". Available providers: ${BUILTIN_ADAPTER_NAMES.join(', ')}.`,
    );
  }
  return providerName;
}

async function resolveBuiltinProviderModel(
  providerName: string,
  requestedModel: string,
): Promise<AdapterModelResolution> {
  const requested = requestedModel.trim();
  if (requested.length === 0) {
    return {
      ok: false,
      code: 'model_selection.unknown',
      message: 'model_selection.unknown: model must be a non-empty string; use config unset to restore the provider CLI default',
    };
  }
  const adapter = await createBuiltinRegistry().load(providerName);
  if (!adapter?.resolveModel) {
    return {
      ok: false,
      code: 'model_selection.unsupported',
      message: `model_selection.unsupported: provider "${providerName}" does not support explicit model selection`,
    };
  }
  return adapter.resolveModel(requested, { refreshOnMiss: true });
}

type CrewSettingPath =
  | 'notifications.success'
  | 'notifications.error'
  | 'confirmBeforeMerge'
  | 'iterate.maxRoundsPerEpoch'
  | 'iterate.maxTotalRounds'
  | 'prWatch.maxActionableWakes'
  | 'prWatch.maxActionRounds'
  | 'prWatch.maxWatchAgeDays'
  | 'cleanup.prWatchTtlDays';

function isCrewSettingPath(path: string): path is CrewSettingPath {
  return path === 'notifications.success'
    || path === 'notifications.error'
    || path === 'confirmBeforeMerge'
    || path === 'iterate.maxRoundsPerEpoch'
    || path === 'iterate.maxTotalRounds'
    || path === 'prWatch.maxActionableWakes'
    || path === 'prWatch.maxActionRounds'
    || path === 'prWatch.maxWatchAgeDays'
    || path === 'cleanup.prWatchTtlDays';
}

function readCrewSetting(config: CrewConfig, path: CrewSettingPath): boolean | number {
  switch (path) {
    case 'notifications.success':
      return config.notifications.success;
    case 'notifications.error':
      return config.notifications.error;
    case 'confirmBeforeMerge':
      return config.confirmBeforeMerge;
    case 'iterate.maxRoundsPerEpoch':
      return config.iterate.maxRoundsPerEpoch;
    case 'iterate.maxTotalRounds':
      return config.iterate.maxTotalRounds;
    case 'prWatch.maxActionableWakes':
      return config.prWatch.maxActionableWakes;
    case 'prWatch.maxActionRounds':
      return config.prWatch.maxActionRounds;
    case 'prWatch.maxWatchAgeDays':
      return config.prWatch.maxWatchAgeDays;
    case 'cleanup.prWatchTtlDays':
      return config.cleanup.prWatchTtlDays;
    default:
      throw new Error(`Unsupported config path "${path}".`);
  }
}

function writeCrewSetting(
  config: MutableCrewConfig,
  path: CrewSettingPath,
  value: boolean | number,
): void {
  switch (path) {
    case 'notifications.success':
      config.notifications.success = value as boolean;
      return;
    case 'notifications.error':
      config.notifications.error = value as boolean;
      return;
    case 'confirmBeforeMerge':
      config.confirmBeforeMerge = value as boolean;
      return;
    case 'iterate.maxRoundsPerEpoch':
      config.iterate.maxRoundsPerEpoch = value as number;
      return;
    case 'iterate.maxTotalRounds':
      config.iterate.maxTotalRounds = value as number;
      return;
    case 'prWatch.maxActionableWakes':
      config.prWatch.maxActionableWakes = value as number;
      return;
    case 'prWatch.maxActionRounds':
      config.prWatch.maxActionRounds = value as number;
      return;
    case 'prWatch.maxWatchAgeDays':
      config.prWatch.maxWatchAgeDays = value as number;
      return;
    case 'cleanup.prWatchTtlDays':
      config.cleanup.prWatchTtlDays = value as number;
      return;
    default:
      throw new Error(`Unsupported config path "${path}".`);
  }
}

function parseCrewSettingValue(path: CrewSettingPath, raw: string): boolean | number {
  if (
    path.startsWith('iterate.')
    || path === 'prWatch.maxActionableWakes'
    || path === 'prWatch.maxActionRounds'
  ) return parsePositiveIntegerValue(path, raw);
  if (path === 'prWatch.maxWatchAgeDays') return parseBoundedOrDisabledDays(path, raw, 365);
  if (path === 'cleanup.prWatchTtlDays') return parseTtlValue(path, raw);
  return parseBooleanValue(path, raw);
}

function parseBooleanValue(path: string, raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (['true', 'on', '1', 'yes'].includes(normalized)) return true;
  if (['false', 'off', '0', 'no'].includes(normalized)) return false;
  throw new Error(`Invalid value for ${path}: expected boolean, received "${raw}".`);
}

function parsePositiveIntegerValue(path: string, raw: string): number {
  const normalized = raw.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`Invalid value for ${path}: expected a positive integer, received "${raw}".`);
  }
  const value = Number(normalized);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Invalid value for ${path}: expected a safe positive integer, received "${raw}".`);
  }
  return value;
}

function parseBoundedOrDisabledDays(path: string, raw: string, maximum: number): number {
  const normalized = raw.trim();
  if (normalized === '-1') return -1;
  const value = parsePositiveIntegerValue(path, normalized);
  if (value > maximum) {
    throw new Error(`Invalid value for ${path}: expected -1 or 1..${maximum}, received "${raw}".`);
  }
  return value;
}

function parseTtlValue(path: string, raw: string): number {
  const normalized = raw.trim();
  if (!/^(?:-1|0|[1-9]\d*)$/.test(normalized)) {
    throw new Error(`Invalid value for ${path}: expected an integer >= -1, received "${raw}".`);
  }
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value < -1) {
    throw new Error(`Invalid value for ${path}: expected a safe integer >= -1, received "${raw}".`);
  }
  return value;
}

function validateIterateLimits(iterate: MutableCrewConfig['iterate']): void {
  if (iterate.maxTotalRounds < iterate.maxRoundsPerEpoch) {
    throw new Error(
      'Invalid iterate limits: iterate.maxTotalRounds must be greater than or equal to '
      + 'iterate.maxRoundsPerEpoch.',
    );
  }
}

function mutableConfig(config: CrewConfig): MutableCrewConfig {
  return {
    notifications: {
      success: config.notifications.success,
      error: config.notifications.error,
    },
    confirmBeforeMerge: config.confirmBeforeMerge,
    iterate: {
      maxRoundsPerEpoch: config.iterate.maxRoundsPerEpoch,
      maxTotalRounds: config.iterate.maxTotalRounds,
    },
    prWatch: {
      maxActionableWakes: config.prWatch.maxActionableWakes,
      maxActionRounds: config.prWatch.maxActionRounds,
      maxWatchAgeDays: config.prWatch.maxWatchAgeDays,
    },
    cleanup: {
      worktreeTtlDays: config.cleanup.worktreeTtlDays,
      runDirTtlDays: config.cleanup.runDirTtlDays,
      criteriaSetTtlDays: config.cleanup.criteriaSetTtlDays,
      prWatchTtlDays: config.cleanup.prWatchTtlDays,
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

function writeProviderModelDefaultsSummary(
  stdout: Pick<NodeJS.WriteStream, 'write'>,
  prefs: AgentPrefsMap,
): void {
  stdout.write('\n');
  const configured = configuredProviderModels(prefs);
  for (const providerName of BUILTIN_ADAPTER_NAMES) {
    stdout.write(
      `  providerModels.${providerName}: ${configured[providerName] ?? '(provider CLI default)'}\n`,
    );
  }
}

function configuredProviderModels(
  prefs: AgentPrefsMap,
): Record<string, string | null> {
  return Object.fromEntries(
    BUILTIN_ADAPTER_NAMES.map((providerName) => [
      providerName,
      prefs[providerName]?.model ?? null,
    ]),
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
  /**
   * Validation gate run whenever ANY screen returns `save` (enter now
   * means "save the whole config" from any depth, not just the root).
   * Return an error string to block the save and surface it under the
   * current frame; return undefined to allow it. The root screen also
   * runs its own inline copy of this, so a root-initiated save that
   * passed there passes here too — this catches saves fired from a
   * submenu where the root's inline check never runs.
   */
  readonly beforeSave?: () => string | undefined;
}

type TuiResult = 'saved' | 'cancelled';

export function driveTui(args: TuiArgs): Promise<TuiResult> {
  const { stdin, stdout } = args;
  const screenStack = [...args.screens];
  if (screenStack.length === 0) {
    throw new Error('driveTui requires at least one screen.');
  }
  let renderedLines = 0;
  // A validation error from a save attempt, shown under the current
  // frame until the next keypress clears it.
  let pendingError: string | undefined;

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
    if (pendingError !== undefined) {
      lines.push('', pendingError);
    }
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
        // Any keypress dismisses a stale save-validation error.
        pendingError = undefined;
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
          case 'save': {
            // Enter means "save the whole config" from any screen; gate
            // it centrally so a save fired from inside a submenu still
            // hits validation the root screen would otherwise run.
            const error = args.beforeSave?.();
            if (error !== undefined) {
              pendingError = error;
              render();
              return;
            }
            cleanup('saved');
            return;
          }
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
  const providerModels = await Promise.all(
    BUILTIN_ADAPTER_NAMES.map(async (providerName): Promise<ProviderModelInventoryEntry> => {
      const listed = out.agents.find((agent) => agent.name === providerName);
      const adapter = await registry.load(providerName);
      if (!adapter?.listModels) {
        return {
          name: providerName,
          displayName: PROVIDER_DISPLAY_NAMES[providerName],
          ...(listed?.model ? { configuredModel: listed.model } : {}),
          models: [],
          warnings: [`Provider "${providerName}" does not expose a model catalog.`],
        };
      }
      try {
        const catalog = await adapter.listModels();
        return {
          name: providerName,
          displayName: PROVIDER_DISPLAY_NAMES[providerName],
          ...(listed?.model ? { configuredModel: listed.model } : {}),
          models: catalog.models,
          ...(catalog.warnings !== undefined ? { warnings: catalog.warnings } : {}),
        };
      } catch (err) {
        return {
          name: providerName,
          displayName: PROVIDER_DISPLAY_NAMES[providerName],
          ...(listed?.model ? { configuredModel: listed.model } : {}),
          models: [],
          warnings: [
            `Model discovery failed: ${err instanceof Error ? err.message : String(err)}`,
          ],
        };
      }
    }),
  );
  return normalizeInventory({
    agentIds: out.agents.map((agent) => agent.name),
    knownIds: new Set(out.agents.flatMap((agent) => [
      agent.name,
      ...(agent.aliases ?? []),
    ])),
    agents: out.agents.map((agent) => ({
      name: agent.name,
      strengths: agent.strengths,
      ...(agent.useWhen ? { useWhen: agent.useWhen } : {}),
    })),
    providerModels,
    resolveProviderModel: async (providerName, requestedModel) => {
      const adapter = await registry.load(providerName);
      if (!adapter?.resolveModel) {
        return {
          ok: false,
          code: 'model_selection.unsupported',
          message: `model_selection.unsupported: provider "${providerName}" does not support explicit model selection`,
        };
      }
      return adapter.resolveModel(requestedModel, { refreshOnMiss: true });
    },
  });
}

function normalizeInventory(inventory: AgentInventory): AgentInventory {
  const agentIds = uniqueStrings(inventory.agentIds);
  const knownIds = new Set(uniqueStrings([
    ...agentIds,
    ...inventory.knownIds,
  ]));
  const agents = normalizeAgentStrengthEntries(inventory.agents ?? agentIds.map((name) => ({
    name,
    strengths: [],
  })));
  const providerModels = normalizeProviderModelEntries(inventory.providerModels ?? []);
  return {
    agentIds,
    knownIds,
    agents,
    providerModels,
    ...(inventory.resolveProviderModel !== undefined
      ? { resolveProviderModel: inventory.resolveProviderModel }
      : {}),
  };
}

async function validateProviderModelChanges(
  state: ProviderModelDefaultsState,
  inventory: AgentInventory,
): Promise<string | undefined> {
  for (const change of state.changes()) {
    if (change.model === undefined) continue;
    if (inventory.resolveProviderModel) {
      let resolution: AdapterModelResolution;
      try {
        resolution = await inventory.resolveProviderModel(change.providerName, change.model);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      if (!resolution.ok) return resolution.message;
      state.setModel(change.providerName, resolution.argument);
      continue;
    }
    const provider = inventory.providerModels?.find(
      (entry) => entry.name === change.providerName,
    );
    if (!provider?.models.some((model) => model.model === change.model)) {
      return `model_selection.discovery_unavailable: could not validate "${change.model}" for provider "${change.providerName}"`;
    }
  }
  return undefined;
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

function normalizeAgentStrengthEntries(
  entries: readonly AgentStrengthsEntry[],
): AgentStrengthsEntry[] {
  const seen = new Set<string>();
  const out: AgentStrengthsEntry[] = [];
  for (const entry of entries) {
    const name = entry.name.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      strengths: uniqueStrings(entry.strengths),
      ...(entry.useWhen && entry.useWhen.trim().length > 0
        ? { useWhen: entry.useWhen.trim() }
        : {}),
    });
  }
  return out;
}

function normalizeProviderModelEntries(
  entries: readonly ProviderModelInventoryEntry[],
): ProviderModelInventoryEntry[] {
  const seen = new Set<string>();
  const out: ProviderModelInventoryEntry[] = [];
  for (const entry of entries) {
    const name = entry.name.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      displayName: entry.displayName.trim() || name,
      ...(entry.configuredModel && entry.configuredModel.trim().length > 0
        ? { configuredModel: entry.configuredModel.trim() }
        : {}),
      models: normalizeModelDescriptors(entry.models),
      ...(entry.warnings !== undefined ? { warnings: [...entry.warnings] } : {}),
    });
  }
  return out;
}

function normalizeModelDescriptors(models: readonly ModelDescriptor[]): ModelDescriptor[] {
  const seen = new Set<string>();
  const out: ModelDescriptor[] = [];
  for (const model of models) {
    const name = model.model.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push({
      ...model,
      model: name,
      displayName: model.displayName.trim() || name,
    });
  }
  return out;
}

const PROVIDER_DISPLAY_NAMES: Record<(typeof BUILTIN_ADAPTER_NAMES)[number], string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  agy: 'Antigravity',
};
