import { createInterface } from 'node:readline/promises';
import { clearScreenDown, emitKeypressEvents, moveCursor } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stdin as input, stdout as output } from 'process';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { ConfigScope } from '../../workflow/config-repository.js';
import type { FullConfig } from '../../workflow/types.js';
import { getDefaultConfig, resolveCaptainModel } from '../../workflow/config-codec.js';
import { saveConfigByScope } from '../../workflow/config-repository.js';
import { validateConfig } from '../../workflow/config-validation.js';
import { AdapterId, BUILTIN_WORKER_AGENTS } from '../../workflow/agents.js';
import { normalizeProfileName, parseConfigScope } from '../../workflow/config-normalization.js';
import {
  addAgent,
  applyConfigPatch,
  getConfigProfile,
  getConfigScope,
  getConfigValueOptions,
  removeAgent,
  resetConfig,
  setConfigProfile,
  setConfigScope,
  setConfigValue,
  showConfig,
} from '../../workflow/config-service.js';

const execFileAsync = promisify(execFile);

function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function effectiveSource(scopePaths: ReturnType<typeof showConfig>['paths']): 'project' | 'global' | 'defaults' {
  if (scopePaths.effective === scopePaths.project || scopePaths.effective === scopePaths.defaultProject) return 'project';
  if (scopePaths.effective === scopePaths.global || scopePaths.effective === scopePaths.defaultGlobal) return 'global';
  return 'defaults';
}

export function formatShowOutput(cwd: string, asJson = false, profile?: string): string {
  const snapshot = showConfig(cwd, profile ? { profile } : {});

  if (asJson) {
    return renderJson({
      activeScope: snapshot.activeScope,
      activeProfile: snapshot.activeProfile,
      source: effectiveSource(snapshot.paths),
      paths: snapshot.paths,
      effectiveConfig: snapshot.effectiveConfig,
    });
  }

  const source = effectiveSource(snapshot.paths);
  const lines = [
    `${chalk.bold('Active Write Scope:')} ${snapshot.activeScope}`,
    `${chalk.bold('Active Profile:')} ${snapshot.activeProfile}`,
    `${chalk.bold('Effective Source:')} ${source}`,
    `${chalk.dim('Project config:')} ${snapshot.paths.project}`,
    `${chalk.dim('Global config:')}  ${snapshot.paths.global}`,
    '',
    chalk.bold('Effective Config'),
    renderJson(snapshot.effectiveConfig),
  ];
  return lines.join('\n');
}

function renderScopeOutput(cwd: string): string {
  const scope = getConfigScope(cwd);
  return `Active write scope: ${scope}`;
}

function renderProfileOutput(cwd: string): string {
  const profile = getConfigProfile(cwd);
  return `Active profile: ${profile}`;
}

function parseScopeOption(raw: string | undefined): ConfigScope | undefined {
  if (raw === undefined) return undefined;
  return parseConfigScope(raw);
}

function parseProfileOption(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return normalizeProfileName(raw);
}

function splitCsvList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parsed = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return parsed.length > 0 ? parsed : undefined;
}

export function formatChangedValue(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  return JSON.stringify(value);
}

function workflowRoles(config: { workflow: { steps: Array<{ role: string; action: string }>; roleModels?: Record<string, string> } }): string[] {
  const keys = new Set<string>();
  for (const step of config.workflow.steps) {
    keys.add(step.role);
    keys.add(step.action);
  }
  for (const role of Object.keys(config.workflow.roleModels ?? {})) {
    keys.add(role);
  }
  return [...keys].sort();
}

export interface SelectOption {
  label: string;
  value: string;
}

export interface ModelOptionsContext {
  configPath: string;
  adapterType?: string;
  currentConfig: FullConfig;
  fallbackOptions: string[];
}

export interface ConfigWizardIo {
  askQuestion?: (question: string) => Promise<string>;
  selectOptionMenu?: (
    title: string,
    contextLines: string[],
    options: SelectOption[],
    initialIndex?: number,
  ) => Promise<SelectOption>;
  supportsInteractiveSelection?: () => boolean;
  clearScreen?: () => void;
  getModelOptions?: (context: ModelOptionsContext) => Promise<string[]>;
  log?: (message?: string) => void;
}

interface ResolvedConfigWizardIo {
  askQuestion: (question: string) => Promise<string>;
  selectOptionMenu: (
    title: string,
    contextLines: string[],
    options: SelectOption[],
    initialIndex?: number,
  ) => Promise<SelectOption>;
  supportsInteractiveSelection: () => boolean;
  clearScreen: () => void;
  getModelOptions: (context: ModelOptionsContext) => Promise<string[]>;
  log: (message?: string) => void;
}

type SetupDepth = 'quick' | 'advanced';
const BACK_VALUE = '__crew_back__' as const;
type WizardValue = string | undefined | typeof BACK_VALUE;

function supportsInteractiveSelection(): boolean {
  return Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === 'function');
}

function clearWizardScreen(): void {
  if (!output.isTTY) return;
  output.write('\x1B[2J\x1B[H');
}

const cliModelOptionCache = new Map<string, Promise<string[]>>();

async function readCliHelp(command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(command, ['--help'], {
      timeout: 1500,
      maxBuffer: 128 * 1024,
    });
    return `${stdout}\n${stderr}`;
  } catch {
    return '';
  }
}

async function discoverModelOptionsFromCli(context: ModelOptionsContext): Promise<string[]> {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    return [];
  }

  const adapterType = context.adapterType;
  if (!adapterType) return [];

  if (!cliModelOptionCache.has(adapterType)) {
    cliModelOptionCache.set(adapterType, (async () => {
      if (adapterType === AdapterId.CLAUDE_CODE) {
        const help = await readCliHelp('claude');
        return help.includes('--model') ? ['sonnet', 'opus'] : [];
      }
      if (adapterType === AdapterId.CODEX) {
        await readCliHelp('codex');
        return [];
      }
      if (adapterType === AdapterId.GEMINI_CLI) {
        await readCliHelp('gemini');
        return [];
      }
      return [];
    })());
  }

  return cliModelOptionCache.get(adapterType)!;
}

async function selectOptionMenu(
  title: string,
  contextLines: string[],
  options: SelectOption[],
  initialIndex = 0,
): Promise<SelectOption> {
  if (!supportsInteractiveSelection()) {
    throw new Error('Interactive option selection requires a TTY.');
  }
  if (options.length === 0) {
    throw new Error('Cannot render option selector with no options.');
  }

  const ttyInput = input as NodeJS.ReadStream;
  const ttyOutput = output as NodeJS.WriteStream;
  const normalizedInitialIndex = Math.max(0, Math.min(initialIndex, options.length - 1));

  return new Promise<SelectOption>((resolve, reject) => {
    let selectedIndex = normalizedInitialIndex;
    let renderedLines = 0;
    const wasRaw = ttyInput.isRaw;

    emitKeypressEvents(ttyInput);
    ttyInput.setRawMode(true);
    ttyInput.resume();
    ttyOutput.write('\x1B[?25l');

    const render = () => {
      const lines: string[] = [
        '',
        chalk.bold(title),
        ...contextLines.map((line) => `  ${line}`),
        '',
        chalk.dim('Use ↑/↓ to highlight, Enter to select, Esc to cancel.'),
        '',
        ...options.map((option, index) => {
          const active = index === selectedIndex;
          const prefix = active ? chalk.cyan('›') : ' ';
          const label = active ? chalk.cyan(option.label) : option.label;
          return ` ${prefix} ${label}`;
        }),
      ];

      if (renderedLines > 0) {
        moveCursor(ttyOutput, 0, -renderedLines);
        clearScreenDown(ttyOutput);
      }
      ttyOutput.write(lines.join('\n'));
      renderedLines = lines.length;
    };

    const cleanup = () => {
      ttyInput.off('keypress', onKeypress);
      ttyInput.setRawMode(Boolean(wasRaw));
      ttyOutput.write('\x1B[?25h');
      ttyOutput.write('\n');
    };

    const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        reject(new Error('Cancelled. No writes performed.'));
        return;
      }

      if (key.name === 'up') {
        selectedIndex = (selectedIndex - 1 + options.length) % options.length;
        render();
        return;
      }

      if (key.name === 'down') {
        selectedIndex = (selectedIndex + 1) % options.length;
        render();
        return;
      }

      if (key.name === 'return') {
        const chosen = options[selectedIndex];
        cleanup();
        resolve(chosen);
        return;
      }

      if (key.name === 'escape') {
        cleanup();
        reject(new Error('Cancelled. No writes performed.'));
      }
    };

    ttyInput.on('keypress', onKeypress);
    render();
  });
}

function friendlyValue(value: unknown): string {
  const rendered = formatChangedValue(value);
  return rendered === undefined ? 'undefined' : rendered;
}

function configPathLine(configPath: string): string {
  return `${chalk.dim('internal setting:')} ${configPath}`;
}

function promptWithCurrent(
  question: string,
  configPath: string,
  currentValue: unknown,
  defaultValue: unknown,
  description: string,
  options: string[] = [],
  allowBack = false,
  progressLabel?: string,
): string {
  const optionLines = options.length > 0
    ? options.map((option, index) => `  ${index + 1}. ${option}`).join('\n')
    : '  (enter a custom value, or leave blank to keep current)';
  const backLine = allowBack ? '  type "back" to return to the previous question' : undefined;

  return [
    progressLabel ? chalk.dim(progressLabel) : undefined,
    `${chalk.bold(question)}`,
    `  current answer: ${friendlyValue(currentValue)}`,
    `  suggested default: ${friendlyValue(defaultValue)}`,
    `  why this matters: ${description}`,
    '  options:',
    optionLines,
    backLine,
    `  ${configPathLine(configPath)}`,
    '  your answer (or Enter to keep current): ',
  ].filter((line): line is string => line !== undefined).join('\n');
}

function normalizeWizardValue(rawInput: string, options: string[], allowBack = false): WizardValue {
  const trimmed = rawInput.trim();
  if (!trimmed) return undefined;

  const lowered = trimmed.toLowerCase();
  if (allowBack && (lowered === 'back' || lowered === 'b')) return BACK_VALUE;
  if (lowered === 'next' || lowered === 'n') return 'next';
  if (lowered === 'prev' || lowered === 'previous' || lowered === 'p') return 'prev';

  if (options.length > 0 && /^\d+$/.test(trimmed)) {
    const selected = Number.parseInt(trimmed, 10);
    if (selected < 1 || selected > options.length) {
      throw new Error(`Invalid option "${trimmed}". Choose a number between 1 and ${options.length}.`);
    }
    return options[selected - 1];
  }

  return trimmed;
}

async function askQuestion(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function resolveConfigWizardIo(io: ConfigWizardIo = {}): ResolvedConfigWizardIo {
  return {
    askQuestion: io.askQuestion ?? askQuestion,
    selectOptionMenu: io.selectOptionMenu ?? selectOptionMenu,
    supportsInteractiveSelection: io.supportsInteractiveSelection ?? supportsInteractiveSelection,
    clearScreen: io.clearScreen ?? clearWizardScreen,
    getModelOptions: io.getModelOptions ?? discoverModelOptionsFromCli,
    log: io.log ?? ((message?: string) => console.log(message)),
  };
}

async function askFieldValue(args: {
  question: string;
  configPath: string;
  currentValue: unknown;
  defaultValue: unknown;
  description: string;
  options: string[];
  allowBack?: boolean;
  progressLabel?: string;
}, io: ResolvedConfigWizardIo): Promise<WizardValue> {
  const {
    question,
    configPath,
    currentValue,
    defaultValue,
    description,
    options,
    allowBack = false,
    progressLabel,
  } = args;

  if (io.supportsInteractiveSelection() && options.length > 0) {
    const menuOptions: SelectOption[] = [
      ...options.map((option) => ({ label: option, value: option })),
      { label: '[Custom value...]', value: '__custom__' },
      { label: '[Keep current value]', value: '__keep__' },
      ...(allowBack ? [{ label: '[Back]', value: BACK_VALUE }] : []),
    ];
    const currentIndex = options.indexOf(String(currentValue ?? ''));
    const selected = await io.selectOptionMenu(
      question,
      [
        ...(progressLabel ? [progressLabel] : []),
        `Current answer: ${friendlyValue(currentValue)}`,
        `Suggested default: ${friendlyValue(defaultValue)}`,
        `Why this matters: ${description}`,
        ...(allowBack ? ['Back returns to the previous question.'] : []),
        configPathLine(configPath),
      ],
      menuOptions,
      currentIndex >= 0 ? currentIndex : 0,
    );

    if (selected.value === '__keep__') return undefined;
    if (selected.value === BACK_VALUE) return BACK_VALUE;
    if (selected.value === '__custom__') {
      const custom = (await io.askQuestion('Custom value (blank keeps current): ')).trim();
      return custom || undefined;
    }
    return selected.value;
  }

  const raw = (await io.askQuestion(
    promptWithCurrent(
      question,
      configPath,
      currentValue,
      defaultValue,
      description,
      options,
      allowBack,
      progressLabel,
    ),
  )).trim();
  return normalizeWizardValue(raw, options, allowBack);
}

async function askSetupDepth(
  io: ResolvedConfigWizardIo,
  allowBack = false,
  progressLabel?: string,
): Promise<SetupDepth | typeof BACK_VALUE> {
  if (io.supportsInteractiveSelection()) {
    const selected = await io.selectOptionMenu(
      'How detailed should setup be?',
      [
        ...(progressLabel ? [progressLabel] : []),
        'Quick setup asks only the most common decisions.',
        'Advanced setup walks through role and agent internals.',
        ...(allowBack ? ['Back returns to the previous question.'] : []),
      ],
      [
        { label: 'quick (recommended)', value: 'quick' },
        { label: 'advanced', value: 'advanced' },
        ...(allowBack ? [{ label: '[Back]', value: BACK_VALUE }] : []),
      ],
      0,
    );
    if (selected.value === BACK_VALUE) return BACK_VALUE;
    return selected.value === 'advanced' ? 'advanced' : 'quick';
  }

  const answer = (await io.askQuestion(
    [
      progressLabel ? `${chalk.dim(progressLabel)}\n` : '',
      'How detailed should setup be? [quick/advanced] (default: quick)',
      allowBack ? ' or "back"' : '',
      ': ',
    ].join(''),
  )).trim().toLowerCase();
  if (allowBack && (answer === 'back' || answer === 'b')) return BACK_VALUE;
  if (!answer || answer === 'quick' || answer === 'q') return 'quick';
  if (answer === 'advanced' || answer === 'a') return 'advanced';
  throw new Error(`Invalid setup mode "${answer}". Expected "quick" or "advanced".`);
}

export async function configShowCommand(options: {
  cwd?: string;
  json?: boolean;
  profile?: string;
} = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const profile = parseProfileOption(options.profile);
  console.log(formatShowOutput(cwd, options.json ?? false, profile));
}

export async function configSetCommand(
  path: string,
  value: string,
  options: { cwd?: string; scope?: string; profile?: string } = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const scope = parseScopeOption(options.scope);
  const profile = parseProfileOption(options.profile);
  const result = setConfigValue(cwd, path, value, { scope, profile });

  console.log(chalk.green('\u2713 Configuration updated.'));
  console.log(`  ${chalk.dim('scope:')} ${result.scope}`);
  console.log(`  ${chalk.dim('profile:')} ${result.profile}`);
  console.log(`  ${chalk.dim('file:')}  ${result.filePath}`);
  console.log(`  ${chalk.dim('path:')}  ${result.path}`);
  console.log(
    `  ${chalk.dim('value:')} ${formatChangedValue(result.previousValue)} -> ${formatChangedValue(result.nextValue)}`,
  );
}

export async function configAddAgentCommand(
  name: string,
  options: {
    cwd?: string;
    scope?: string;
    profile?: string;
    adapter?: string;
    model?: string;
    command?: string;
    args?: string;
    capabilities?: string;
  } = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const scope = parseScopeOption(options.scope);
  const profile = parseProfileOption(options.profile);
  const result = addAgent(cwd, name, {
    scope,
    profile,
    adapter: options.adapter,
    model: options.model,
    command: options.command,
    args: splitCsvList(options.args),
    capabilities: splitCsvList(options.capabilities),
  });

  console.log(chalk.green('\u2713 Agent added.'));
  console.log(`  ${chalk.dim('scope:')} ${result.scope}`);
  console.log(`  ${chalk.dim('profile:')} ${result.profile}`);
  console.log(`  ${chalk.dim('file:')}  ${result.filePath}`);
  console.log(`  ${chalk.dim('name:')}  ${result.name}`);
  console.log(`  ${chalk.dim('agent:')} ${formatChangedValue(result.agent)}`);
}

export async function configRemoveAgentCommand(
  name: string,
  options: { cwd?: string; scope?: string; profile?: string } = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const scope = parseScopeOption(options.scope);
  const profile = parseProfileOption(options.profile);
  const result = removeAgent(cwd, name, { scope, profile });

  console.log(chalk.green('\u2713 Agent removed.'));
  console.log(`  ${chalk.dim('scope:')} ${result.scope}`);
  console.log(`  ${chalk.dim('profile:')} ${result.profile}`);
  console.log(`  ${chalk.dim('file:')}  ${result.filePath}`);
  console.log(`  ${chalk.dim('name:')}  ${result.name}`);
}

export async function configScopeCommand(
  scope: string | undefined,
  options: { cwd?: string } = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  if (!scope) {
    console.log(renderScopeOutput(cwd));
    return;
  }

  const normalizedScope = parseScopeOption(scope);
  if (!normalizedScope) {
    throw new Error('Scope is required.');
  }
  const result = setConfigScope(cwd, normalizedScope);
  console.log(chalk.green(`\u2713 Active write scope set to ${result.scope}.`));
  console.log(`  ${chalk.dim('file:')} ${result.scopePath}`);
}

export async function configProfileCommand(
  profile: string | undefined,
  options: { cwd?: string } = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  if (!profile) {
    console.log(renderProfileOutput(cwd));
    return;
  }

  const normalizedProfile = parseProfileOption(profile);
  if (!normalizedProfile) {
    throw new Error('Profile is required.');
  }
  const result = setConfigProfile(cwd, normalizedProfile);
  console.log(chalk.green(`\u2713 Active profile set to ${result.profile}.`));
  console.log(`  ${chalk.dim('file:')} ${result.profilePath}`);
}

export async function configResetCommand(options: {
  cwd?: string;
  scope?: string;
  profile?: string;
} = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const scope = parseScopeOption(options.scope);
  const profile = parseProfileOption(options.profile);
  const result = resetConfig(cwd, { scope, profile });

  console.log(chalk.green('\u2713 Scope config reset to defaults.'));
  console.log(`  ${chalk.dim('scope:')} ${result.scope}`);
  console.log(`  ${chalk.dim('profile:')} ${result.profile}`);
  console.log(`  ${chalk.dim('file:')}  ${result.filePath}`);
}

interface WizardState {
  selectedScope: ConfigScope;
  setupDepth: SetupDepth;
  draft: FullConfig;
}

interface WizardStep {
  id: string;
  include?: (state: WizardState) => boolean;
  ask: (
    state: WizardState,
    io: ResolvedConfigWizardIo,
    allowBack: boolean,
    progressLabel: string,
  ) => Promise<WizardValue>;
  apply: (state: WizardState, value: WizardValue) => WizardState;
  change?: {
    path: string;
    read: (config: FullConfig) => unknown;
  };
}

function uniqueWizardOptions(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function resolveCaptainAdapterTypeForWizard(config: FullConfig): string | undefined {
  const captainAgent = config.agents[config.captain.cli];
  return captainAgent?.adapter ?? config.captain.cli;
}

function shouldAskAgentAdapter(config: FullConfig, agentName: string): boolean {
  const agent = config.agents[agentName];
  if (!agent) return false;
  const adapterType = agent.adapter ?? agentName;
  return !BUILTIN_WORKER_AGENTS.includes(agentName as typeof BUILTIN_WORKER_AGENTS[number])
    || !BUILTIN_WORKER_AGENTS.includes(adapterType as typeof BUILTIN_WORKER_AGENTS[number]);
}

function shouldAskGenericAgentFields(config: FullConfig, agentName: string): boolean {
  const agent = config.agents[agentName];
  if (!agent) return false;
  const adapterType = agent.adapter ?? agentName;
  return adapterType === AdapterId.GENERIC
    || agent.command !== undefined
    || agent.args !== undefined;
}

function shouldAskAgentCapabilities(config: FullConfig, defaults: FullConfig, agentName: string): boolean {
  const agent = config.agents[agentName];
  const defaultAgent = defaults.agents[agentName];
  return Boolean(
    shouldAskGenericAgentFields(config, agentName)
    || agent?.capabilities?.length
    || defaultAgent?.capabilities?.length,
  );
}

async function modelOptionsForWizardField(args: {
  io: ResolvedConfigWizardIo;
  configPath: string;
  adapterType?: string;
  currentConfig: FullConfig;
  fallbackOptions: string[];
}): Promise<string[]> {
  const fallbackOptions = uniqueWizardOptions(args.fallbackOptions);
  let discoveredOptions: string[] = [];
  try {
    discoveredOptions = await args.io.getModelOptions({
      configPath: args.configPath,
      adapterType: args.adapterType,
      currentConfig: args.currentConfig,
      fallbackOptions,
    });
  } catch {
    discoveredOptions = [];
  }
  return uniqueWizardOptions([...discoveredOptions, ...fallbackOptions]);
}

function readReviewerMaxPasses(config: FullConfig): number | undefined {
  return config.workflow.steps.find((s) =>
    s.role === 'reviewer' || s.action === 'review' || s.role.toLowerCase().includes('review'),
  )?.maxPasses;
}

function sameConfigValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function askScopeStep(
  currentScope: ConfigScope,
  io: ResolvedConfigWizardIo,
  allowBack: boolean,
  progressLabel: string,
): Promise<WizardValue> {
  if (io.supportsInteractiveSelection()) {
    const selected = await io.selectOptionMenu(
      'Where should Crew save these answers?',
      [
        progressLabel,
        `Current write scope: ${currentScope}`,
        ...(allowBack ? ['Back returns to the previous question.'] : []),
      ],
      [
        { label: 'project', value: 'project' },
        { label: 'global', value: 'global' },
        ...(allowBack ? [{ label: '[Back]', value: BACK_VALUE }] : []),
      ],
      currentScope === 'global' ? 1 : 0,
    );
    return selected.value === BACK_VALUE ? BACK_VALUE : selected.value;
  }

  const enteredScope = (await io.askQuestion(
    [
      `${chalk.dim(progressLabel)}\n`,
      `Where should Crew save these answers? [project/global] (current: ${currentScope})`,
      allowBack ? ' or "back"' : '',
      ': ',
    ].join(''),
  )).trim().toLowerCase();
  if (allowBack && (enteredScope === 'back' || enteredScope === 'b')) return BACK_VALUE;
  if (!enteredScope) return undefined;
  if (enteredScope !== 'project' && enteredScope !== 'global') {
    throw new Error(`Invalid scope "${enteredScope}". Expected "project" or "global".`);
  }
  return enteredScope;
}

function fieldStep(args: {
  id: string;
  path: string;
  question: string;
  description: string;
  currentValue: (config: FullConfig) => unknown;
  defaultValue: (defaults: FullConfig, state: WizardState) => unknown;
  options: (state: WizardState, io: ResolvedConfigWizardIo) => Promise<string[]> | string[];
  defaults: FullConfig;
  include?: (state: WizardState) => boolean;
}): WizardStep {
  return {
    id: args.id,
    include: args.include,
    change: {
      path: args.path,
      read: args.currentValue,
    },
    ask: async (state, io, allowBack, progressLabel) => askFieldValue({
      question: args.question,
      configPath: args.path,
      currentValue: args.currentValue(state.draft),
      defaultValue: args.defaultValue(args.defaults, state),
      description: args.description,
      options: await args.options(state, io),
      allowBack,
      progressLabel,
    }, io),
    apply: (state, value) => {
      if (value === undefined || value === BACK_VALUE) return state;
      return {
        ...state,
        draft: applyConfigPatch(state.draft, { path: args.path, value }),
      };
    },
  };
}

function buildWizardSteps(originalConfig: FullConfig, defaults: FullConfig): WizardStep[] {
  const steps: WizardStep[] = [
    {
      id: 'scope',
      ask: (state, io, allowBack, progressLabel) =>
        askScopeStep(state.selectedScope, io, allowBack, progressLabel),
      apply: (state, value) => {
        if (value !== 'project' && value !== 'global') return state;
        return { ...state, selectedScope: value };
      },
    },
    {
      id: 'setup-depth',
      ask: (state, io, allowBack, progressLabel) =>
        askSetupDepth(io, allowBack, progressLabel),
      apply: (state, value) => {
        if (value !== 'quick' && value !== 'advanced') return state;
        return { ...state, setupDepth: value };
      },
    },
    fieldStep({
      id: 'captain-cli',
      path: 'captain.cli',
      question: 'Which CLI should coordinate the crew?',
      description: 'The captain reads the request, delegates work, and decides when the run is done.',
      currentValue: (config) => config.captain.cli,
      defaultValue: (config) => config.captain.cli,
      options: (state) => getConfigValueOptions(state.draft, 'captain.cli'),
      defaults,
    }),
    fieldStep({
      id: 'captain-model',
      path: 'captain.model',
      question: 'Which model should the captain use?',
      description: 'Choose the model for planning, delegation, and final decisions. You can enter a newer model ID if your CLI supports it.',
      currentValue: (config) => resolveCaptainModel(config.captain),
      defaultValue: (config, state) => resolveCaptainModel({
        ...config.captain,
        cli: state.draft.captain.cli,
      }),
      options: (state, io) => modelOptionsForWizardField({
        io,
        configPath: 'captain.model',
        adapterType: resolveCaptainAdapterTypeForWizard(state.draft),
        currentConfig: state.draft,
        fallbackOptions: getConfigValueOptions(state.draft, 'captain.model'),
      }),
      defaults,
    }),
    fieldStep({
      id: 'captain-preset',
      path: 'captain.preset',
      question: 'What default behavior should the captain follow?',
      description: 'Presets tune the captain toward balanced, stricter-review, or read-only behavior.',
      currentValue: (config) => config.captain.preset,
      defaultValue: (config) => config.captain.preset,
      options: (state) => getConfigValueOptions(state.draft, 'captain.preset'),
      defaults,
      include: (state) => getConfigValueOptions(state.draft, 'captain.preset').length > 0,
    }),
  ];

  for (const role of workflowRoles(originalConfig)) {
    const rolePath = `workflow.roleModels.${role}`;
    steps.push(fieldStep({
      id: `role-model:${role}`,
      path: rolePath,
      question: `Which model should the "${role}" workflow role use?`,
      description: 'Leave this blank to use the agent or captain default for that role.',
      currentValue: (config) => config.workflow.roleModels?.[role],
      defaultValue: (config) => config.workflow.roleModels?.[role],
      options: (state, io) => modelOptionsForWizardField({
        io,
        configPath: rolePath,
        currentConfig: state.draft,
        fallbackOptions: getConfigValueOptions(state.draft, rolePath),
      }),
      defaults,
      include: (state) => state.setupDepth === 'advanced',
    }));
  }

  const agentNames = Object.keys(originalConfig.agents).sort();
  for (const agentName of agentNames) {
    const adapterPath = `agents.${agentName}.adapter`;
    steps.push(fieldStep({
      id: `agent-adapter:${agentName}`,
      path: adapterPath,
      question: `Which backend should the "${agentName}" custom agent use?`,
      description: 'Used for custom agents that do not map directly to a built-in Crew CLI.',
      currentValue: (config) => config.agents[agentName]?.adapter ?? agentName,
      defaultValue: (config) => config.agents[agentName]?.adapter ?? agentName,
      options: (state) => getConfigValueOptions(state.draft, adapterPath),
      defaults,
      include: (state) => state.setupDepth === 'advanced' && shouldAskAgentAdapter(state.draft, agentName),
    }));

    const modelPath = `agents.${agentName}.model`;
    steps.push(fieldStep({
      id: `agent-model:${agentName}`,
      path: modelPath,
      question: `Which model should the "${agentName}" agent use?`,
      description: 'Leave this blank to keep the current model for this agent. You can enter a newer model ID if the agent CLI supports it.',
      currentValue: (config) => config.agents[agentName]?.model,
      defaultValue: (config) => config.agents[agentName]?.model,
      options: (state, io) => modelOptionsForWizardField({
        io,
        configPath: modelPath,
        adapterType: state.draft.agents[agentName]?.adapter ?? agentName,
        currentConfig: state.draft,
        fallbackOptions: getConfigValueOptions(state.draft, modelPath),
      }),
      defaults,
      include: (state) => state.setupDepth === 'advanced',
    }));

    const commandPath = `agents.${agentName}.command`;
    steps.push(fieldStep({
      id: `agent-command:${agentName}`,
      path: commandPath,
      question: `What command should launch the "${agentName}" agent?`,
      description: 'Used only for generic or custom CLI agents, for example: ollama.',
      currentValue: (config) => config.agents[agentName]?.command,
      defaultValue: (config) => config.agents[agentName]?.command,
      options: () => [],
      defaults,
      include: (state) => state.setupDepth === 'advanced' && shouldAskGenericAgentFields(state.draft, agentName),
    }));

    const argsPath = `agents.${agentName}.args`;
    steps.push(fieldStep({
      id: `agent-args:${agentName}`,
      path: argsPath,
      question: `What arguments should Crew pass to the "${agentName}" command?`,
      description: 'Use a comma list or JSON array. Include {{prompt}} where the task prompt should be injected.',
      currentValue: (config) => config.agents[agentName]?.args,
      defaultValue: (config) => config.agents[agentName]?.args,
      options: () => [],
      defaults,
      include: (state) => state.setupDepth === 'advanced' && shouldAskGenericAgentFields(state.draft, agentName),
    }));

    const capabilitiesPath = `agents.${agentName}.capabilities`;
    steps.push(fieldStep({
      id: `agent-capabilities:${agentName}`,
      path: capabilitiesPath,
      question: `What work should the "${agentName}" agent be allowed to do?`,
      description: 'Use a comma list or JSON array, for example: implement,review,test.',
      currentValue: (config) => config.agents[agentName]?.capabilities,
      defaultValue: (config) => config.agents[agentName]?.capabilities,
      options: (state) => getConfigValueOptions(state.draft, capabilitiesPath),
      defaults,
      include: (state) =>
        state.setupDepth === 'advanced' && shouldAskAgentCapabilities(state.draft, defaults, agentName),
    }));
  }

  steps.push(fieldStep({
    id: 'reviewer-max-passes',
    path: 'workflow.reviewer.maxPasses',
    question: 'How many review/fix passes should run before Crew stops trying?',
    description: 'Higher values can catch more issues but may take longer.',
    currentValue: readReviewerMaxPasses,
    defaultValue: readReviewerMaxPasses,
    options: (state) => getConfigValueOptions(state.draft, 'workflow.reviewer.maxPasses'),
    defaults,
    include: (state) => getConfigValueOptions(state.draft, 'workflow.reviewer.maxPasses').length > 0,
  }));

  steps.push(fieldStep({
    id: 'retry-count',
    path: 'errorHandling.default.retry',
    question: 'How many times should Crew retry a failed step?',
    description: 'This applies before fallback handling asks the user or stops.',
    currentValue: (config) => config.errorHandling.default.retry,
    defaultValue: (config) => config.errorHandling.default.retry,
    options: (state) => getConfigValueOptions(state.draft, 'errorHandling.default.retry'),
    defaults,
  }));

  return steps;
}

async function runWizardSteps(args: {
  steps: WizardStep[];
  initialState: WizardState;
  io: ResolvedConfigWizardIo;
}): Promise<{ state: WizardState; answers: Map<string, WizardValue> }> {
  const { steps, initialState, io } = args;
  const answers = new Map<string, WizardValue>();

  const isIncluded = (step: WizardStep, state: WizardState): boolean =>
    step.include ? step.include(state) : true;

  const buildStateBefore = (targetIndex: number): WizardState => {
    let state = structuredClone(initialState);
    for (let index = 0; index < targetIndex; index += 1) {
      const step = steps[index];
      if (!isIncluded(step, state)) continue;
      if (!answers.has(step.id)) continue;
      state = step.apply(state, answers.get(step.id));
    }
    return state;
  };

  const previousIncludedIndex = (currentIndex: number): number => {
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      const state = buildStateBefore(index);
      if (isIncluded(steps[index], state)) return index;
    }
    return currentIndex;
  };

  const questionNumber = (currentIndex: number): number => {
    let count = 0;
    for (let index = 0; index <= currentIndex; index += 1) {
      const state = buildStateBefore(index);
      if (isIncluded(steps[index], state)) count += 1;
    }
    return count;
  };

  let index = 0;
  while (index < steps.length) {
    const step = steps[index];
    const state = buildStateBefore(index);
    if (!isIncluded(step, state)) {
      answers.delete(step.id);
      index += 1;
      continue;
    }

    const allowBack = previousIncludedIndex(index) !== index;
    io.clearScreen();
    const value = await step.ask(state, io, allowBack, `Question ${questionNumber(index)}`);
    if (value === BACK_VALUE) {
      answers.delete(step.id);
      index = previousIncludedIndex(index);
      continue;
    }

    answers.set(step.id, value);
    index += 1;
  }

  return {
    state: buildStateBefore(steps.length),
    answers,
  };
}

function collectWizardChanges(
  steps: WizardStep[],
  originalConfig: FullConfig,
  finalConfig: FullConfig,
): Array<{ path: string; before: unknown; after: unknown }> {
  const changes: Array<{ path: string; before: unknown; after: unknown }> = [];
  const seen = new Set<string>();
  for (const step of steps) {
    if (!step.change || seen.has(step.change.path)) continue;
    seen.add(step.change.path);
    const before = step.change.read(originalConfig);
    const after = step.change.read(finalConfig);
    if (!sameConfigValue(before, after)) {
      changes.push({ path: step.change.path, before, after });
    }
  }
  return changes;
}

export async function configWizardCommand(options: {
  cwd?: string;
  io?: ConfigWizardIo;
  profile?: string;
  scope?: ConfigScope;
} = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const io = resolveConfigWizardIo(options.io);
  const profile = options.profile ? parseProfileOption(options.profile) : undefined;
  const snapshot = showConfig(cwd, profile ? { profile } : {});
  const defaults = getDefaultConfig();
  const originalConfig = snapshot.effectiveConfig;
  const selectedProfile = snapshot.activeProfile;

  io.log(chalk.bold('\nGuided Config Setup\n'));
  io.log(chalk.dim('Answer one question at a time. Press Enter to keep the current value, or type "back" after the first question.'));
  io.log(`${chalk.dim('Active profile:')} ${selectedProfile}\n`);

  const steps = buildWizardSteps(originalConfig, defaults);
  const initialState: WizardState = {
    selectedScope: options.scope ?? snapshot.activeScope,
    setupDepth: 'quick',
    draft: structuredClone(originalConfig),
  };
  const { state: finalState } = await runWizardSteps({ steps, initialState, io });
  const { selectedScope, setupDepth, draft } = finalState;
  const changes = collectWizardChanges(steps, originalConfig, draft);

  io.clearScreen();
  io.log(chalk.dim(`Setup mode: ${setupDepth}\n`));
  if (setupDepth === 'quick') {
    io.log(
      chalk.dim(
        'Quick setup skips workflow role-model and per-agent internals. Use "advanced" mode (or /config set) to tune those later.\n',
      ),
    );
  }

  if (getConfigValueOptions(draft, 'workflow.reviewer.maxPasses').length === 0) {
    io.log(
      chalk.yellow(
        'Skipping workflow.reviewer.maxPasses: no review step found (role includes "reviewer" or action is "review").',
      ),
    );
  }

  const scopeChanged = selectedScope !== snapshot.activeScope;
  if (!scopeChanged && changes.length === 0) {
    io.log(chalk.dim('\nNo changes. Exiting without writes.\n'));
    return;
  }

  const diagnostics = validateConfig(draft);
  if (diagnostics.length > 0) {
    throw new Error(diagnostics[0].message);
  }

  io.log(chalk.bold('\nPending Changes'));
  if (scopeChanged) {
    io.log(`  scope: ${snapshot.activeScope} -> ${selectedScope}`);
  }
  for (const change of changes) {
    io.log(
      `  ${change.path}: ${formatChangedValue(change.before)} -> ${formatChangedValue(change.after)}`,
    );
  }

  const confirmation = (await io.askQuestion('\nApply changes? [y/N]: ')).trim().toLowerCase();
  if (confirmation !== 'y' && confirmation !== 'yes') {
    io.log(chalk.dim('\nCancelled. No writes performed.\n'));
    return;
  }

  if (scopeChanged) {
    setConfigScope(cwd, selectedScope);
  }
  const filePath = saveConfigByScope(selectedScope, cwd, draft, { profile: selectedProfile });
  io.log(chalk.green('\n\u2713 Configuration saved.'));
  io.log(`  ${chalk.dim('scope:')} ${selectedScope}`);
  io.log(`  ${chalk.dim('profile:')} ${selectedProfile}`);
  io.log(`  ${chalk.dim('file:')}  ${filePath}\n`);
}

async function runWithExitCode(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(message));
    process.exitCode = 1;
  }
}

export function registerConfigCommand(program: Command): void {
  const command = program
    .command('config')
    .description('Inspect and update captain configuration');

  command.action(() => runWithExitCode(() => configWizardCommand()));

  command
    .command('show')
    .description('Show effective config and scope information')
    .option('--json', 'Emit machine-readable output')
    .option('--profile <profile>', 'Read from a specific profile')
    .action((options: { json?: boolean; profile?: string }) =>
      runWithExitCode(() => configShowCommand({ json: options.json, profile: options.profile })),
    );

  command
    .command('set')
    .description('Set a config value by path (supports next|prev cycling)')
    .argument('<path>', 'Config path to update')
    .argument('<value...>', 'Value to write')
    .option('--scope <scope>', 'Write scope: project|global')
    .option('--profile <profile>', 'Write to a specific profile')
    .action((path: string, value: string[], options: { scope?: string; profile?: string }) =>
      runWithExitCode(() =>
        configSetCommand(path, value.join(' '), { scope: options.scope, profile: options.profile }),
      ));

  command
    .command('add-agent')
    .description('Add an agent entry (generic by default)')
    .argument('<name>', 'Agent key')
    .option('--scope <scope>', 'Write scope: project|global')
    .option('--profile <profile>', 'Write to a specific profile')
    .option('--adapter <adapter>', 'Adapter: claude-code|codex|generic')
    .option('--model <model>', 'Optional model value')
    .option('--command <command>', 'CLI command (required for generic unless name should be used)')
    .option('--args <csv>', 'Comma-delimited args (for example: run,gemma4:latest,{{prompt}})')
    .option('--capabilities <csv>', 'Comma-delimited capabilities')
    .action((name: string, options: {
      scope?: string;
      profile?: string;
      adapter?: string;
      model?: string;
      command?: string;
      args?: string;
      capabilities?: string;
    }) =>
      runWithExitCode(() => configAddAgentCommand(name, options)));

  command
    .command('remove-agent')
    .description('Remove an agent entry (fails if still referenced)')
    .argument('<name>', 'Agent key')
    .option('--scope <scope>', 'Write scope: project|global')
    .option('--profile <profile>', 'Write to a specific profile')
    .action((name: string, options: { scope?: string; profile?: string }) =>
      runWithExitCode(() => configRemoveAgentCommand(name, options)));

  command
    .command('scope')
    .description('Show or set active write scope')
    .argument('[scope]', 'project|global')
    .action((scope: string | undefined) =>
      runWithExitCode(() => configScopeCommand(scope)),
    );

  command
    .command('profile')
    .description('Show or set active config profile')
    .argument('[profile]', 'Profile name (for example: claude-captain)')
    .action((profile: string | undefined) =>
      runWithExitCode(() => configProfileCommand(profile)),
    );

  command
    .command('reset')
    .description('Reset scoped config to defaults')
    .option('--scope <scope>', 'Scope to reset: project|global')
    .option('--profile <profile>', 'Reset a specific profile')
    .action((options: { scope?: string; profile?: string }) =>
      runWithExitCode(() => configResetCommand({ scope: options.scope, profile: options.profile })),
    );

  command
    .command('setup')
    .description('Run guided config setup questions')
    .option('--profile <profile>', 'Edit a specific profile')
    .option('--scope <scope>', 'Initial write scope: project|global')
    .action((options: { profile?: string; scope?: string }) =>
      runWithExitCode(() =>
        configWizardCommand({
          profile: options.profile,
          scope: parseScopeOption(options.scope),
        }),
      ));

  command
    .command('edit')
    .description('Open guided config setup')
    .option('--profile <profile>', 'Edit a specific profile')
    .option('--scope <scope>', 'Initial write scope: project|global')
    .action((options: { profile?: string; scope?: string }) =>
      runWithExitCode(() =>
        configWizardCommand({
          profile: options.profile,
          scope: parseScopeOption(options.scope),
        }),
      ));
}
