import { createInterface } from 'node:readline/promises';
import { clearScreenDown, emitKeypressEvents, moveCursor } from 'node:readline';
import { stdin as input, stdout as output } from 'process';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { ConfigScope } from '../../workflow/config-repository.js';
import { getDefaultConfig } from '../../workflow/config-codec.js';
import { saveConfigByScope } from '../../workflow/config-repository.js';
import { validateConfig } from '../../workflow/config-validation.js';
import { AdapterId } from '../../workflow/agents.js';
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

interface SelectOption {
  label: string;
  value: string;
}

function supportsInteractiveSelection(): boolean {
  return Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === 'function');
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

function promptWithCurrent(
  label: string,
  currentValue: unknown,
  defaultValue: unknown,
  description: string,
  options: string[] = [],
): string {
  const optionLines = options.length > 0
    ? options.map((option, index) => `  ${index + 1}. ${option}`).join('\n')
    : '  (no presets available)';

  return [
    `${chalk.bold(label)}`,
    `  current: ${formatChangedValue(currentValue)}`,
    `  default: ${formatChangedValue(defaultValue)}`,
    `  ${chalk.dim(description)}`,
    '  options:',
    optionLines,
    '  choose number | next | prev | custom value (blank keeps current): ',
  ].join('\n');
}

function normalizeWizardValue(rawInput: string, options: string[]): string | undefined {
  const trimmed = rawInput.trim();
  if (!trimmed) return undefined;

  const lowered = trimmed.toLowerCase();
  if (lowered === 'next' || lowered === 'n') return 'next';
  if (lowered === 'prev' || lowered === 'previous' || lowered === 'p') return 'prev';

  if (/^\d+$/.test(trimmed)) {
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

async function askFieldValue(args: {
  label: string;
  currentValue: unknown;
  defaultValue: unknown;
  description: string;
  options: string[];
}): Promise<string | undefined> {
  const { label, currentValue, defaultValue, description, options } = args;

  if (supportsInteractiveSelection() && options.length > 0) {
    const menuOptions: SelectOption[] = [
      ...options.map((option) => ({ label: option, value: option })),
      { label: '[Custom value...]', value: '__custom__' },
      { label: '[Keep current value]', value: '__keep__' },
    ];
    const currentIndex = options.indexOf(String(currentValue ?? ''));
    const selected = await selectOptionMenu(
      label,
      [
        `current: ${formatChangedValue(currentValue)}`,
        `default: ${formatChangedValue(defaultValue)}`,
        description,
      ],
      menuOptions,
      currentIndex >= 0 ? currentIndex : 0,
    );

    if (selected.value === '__keep__') return undefined;
    if (selected.value === '__custom__') {
      const custom = (await askQuestion('Custom value (blank keeps current): ')).trim();
      return custom || undefined;
    }
    return selected.value;
  }

  const raw = (await askQuestion(
    promptWithCurrent(label, currentValue, defaultValue, description, options),
  )).trim();
  return normalizeWizardValue(raw, options);
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

export async function configWizardCommand(options: { cwd?: string } = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const snapshot = showConfig(cwd);
  const defaults = getDefaultConfig();
  const originalConfig = snapshot.effectiveConfig;
  let draft = structuredClone(originalConfig);
  let selectedScope = snapshot.activeScope;
  const selectedProfile = snapshot.activeProfile;
  const changes: Array<{ path: string; before: unknown; after: unknown }> = [];

  console.log(chalk.bold('\nInteractive Config Wizard\n'));
  console.log(`${chalk.dim('Active profile:')} ${selectedProfile}\n`);

  if (supportsInteractiveSelection()) {
    const selected = await selectOptionMenu(
      'Write scope',
      [`current: ${snapshot.activeScope}`],
      [
        { label: 'project', value: 'project' },
        { label: 'global', value: 'global' },
      ],
      snapshot.activeScope === 'global' ? 1 : 0,
    );
    selectedScope = selected.value as ConfigScope;
  } else {
    const enteredScope = (await askQuestion(
      `Write scope [project/global] (current: ${snapshot.activeScope}): `,
    )).trim();
    if (enteredScope) {
      if (enteredScope !== 'project' && enteredScope !== 'global') {
        throw new Error(`Invalid scope "${enteredScope}". Expected "project" or "global".`);
      }
      selectedScope = enteredScope;
    }
  }

  const captainCliValue = await askFieldValue({
    label: 'captain.cli',
    currentValue: draft.captain.cli,
    defaultValue: defaults.captain.cli,
    description: 'Which configured adapter acts as the captain.',
    options: getConfigValueOptions(draft, 'captain.cli'),
  });
  if (captainCliValue) {
    const before = draft.captain.cli;
    draft = applyConfigPatch(draft, { path: 'captain.cli', value: captainCliValue });
    changes.push({ path: 'captain.cli', before, after: draft.captain.cli });
  }

  const captainModelValue = await askFieldValue({
    label: 'captain.model',
    currentValue: draft.captain.model,
    defaultValue: defaults.captain.model,
    description: 'Model used by the captain adapter.',
    options: getConfigValueOptions(draft, 'captain.model'),
  });
  if (captainModelValue) {
    const before = draft.captain.model;
    draft = applyConfigPatch(draft, { path: 'captain.model', value: captainModelValue });
    changes.push({ path: 'captain.model', before, after: draft.captain.model });
  }

  const executionModeValue = await askFieldValue({
    label: 'workflow.execution.mode',
    currentValue: draft.workflow.execution?.mode ?? 'linear',
    defaultValue: defaults.workflow.execution?.mode ?? 'linear',
    description: 'Execution path: deterministic linear pipeline or judgment controller.',
    options: getConfigValueOptions(draft, 'workflow.execution.mode'),
  });
  if (executionModeValue) {
    const before = draft.workflow.execution?.mode ?? 'linear';
    draft = applyConfigPatch(draft, { path: 'workflow.execution.mode', value: executionModeValue });
    const after = draft.workflow.execution?.mode ?? 'linear';
    changes.push({ path: 'workflow.execution.mode', before, after });
  }

  for (const role of workflowRoles(draft)) {
    const rolePath = `workflow.roleModels.${role}`;
    const roleModelValue = await askFieldValue({
      label: rolePath,
      currentValue: draft.workflow.roleModels?.[role],
      defaultValue: defaults.workflow.roleModels?.[role],
      description: `Optional model override for workflow role/action "${role}".`,
      options: getConfigValueOptions(draft, rolePath),
    });
    if (!roleModelValue) continue;

    const before = draft.workflow.roleModels?.[role];
    draft = applyConfigPatch(draft, { path: rolePath, value: roleModelValue });
    const after = draft.workflow.roleModels?.[role];
    changes.push({ path: rolePath, before, after });
  }

  const agentNames = Object.keys(draft.agents).sort();
  for (const agentName of agentNames) {
    const adapterPath = `agents.${agentName}.adapter`;
    const adapterValue = await askFieldValue({
      label: adapterPath,
      currentValue: draft.agents[agentName].adapter ?? agentName,
      defaultValue: defaults.agents[agentName]?.adapter ?? agentName,
      description: 'Adapter backend for this agent (claude-code, codex, generic).',
      options: getConfigValueOptions(draft, adapterPath),
    });
    if (adapterValue) {
      const before = draft.agents[agentName].adapter ?? agentName;
      draft = applyConfigPatch(draft, { path: adapterPath, value: adapterValue });
      changes.push({ path: adapterPath, before, after: draft.agents[agentName].adapter ?? agentName });
    }

    const modelPath = `agents.${agentName}.model`;
    const modelValue = await askFieldValue({
      label: modelPath,
      currentValue: draft.agents[agentName].model,
      defaultValue: defaults.agents[agentName]?.model,
      description: 'Model used when this agent runs.',
      options: getConfigValueOptions(draft, modelPath),
    });
    if (modelValue) {
      const before = draft.agents[agentName].model;
      draft = applyConfigPatch(draft, { path: modelPath, value: modelValue });
      changes.push({ path: modelPath, before, after: draft.agents[agentName].model });
    }

    const adapterType = draft.agents[agentName].adapter ?? agentName;
    const shouldConfigureGenericFields = adapterType === AdapterId.GENERIC
      || draft.agents[agentName].command !== undefined
      || draft.agents[agentName].args !== undefined;

    if (shouldConfigureGenericFields) {
      const commandPath = `agents.${agentName}.command`;
      const commandValue = await askFieldValue({
        label: commandPath,
        currentValue: draft.agents[agentName].command,
        defaultValue: defaults.agents[agentName]?.command,
        description: 'CLI command used by generic adapters (for example: ollama).',
        options: [],
      });
      if (commandValue) {
        const before = draft.agents[agentName].command;
        draft = applyConfigPatch(draft, { path: commandPath, value: commandValue });
        changes.push({ path: commandPath, before, after: draft.agents[agentName].command });
      }

      const argsPath = `agents.${agentName}.args`;
      const argsValue = await askFieldValue({
        label: argsPath,
        currentValue: draft.agents[agentName].args,
        defaultValue: defaults.agents[agentName]?.args,
        description: 'Comma list or JSON array. Use {{prompt}} where prompt should be injected.',
        options: [],
      });
      if (argsValue) {
        const before = draft.agents[agentName].args;
        draft = applyConfigPatch(draft, { path: argsPath, value: argsValue });
        changes.push({ path: argsPath, before, after: draft.agents[agentName].args });
      }
    }

    const capabilitiesPath = `agents.${agentName}.capabilities`;
    const capabilitiesValue = await askFieldValue({
      label: capabilitiesPath,
      currentValue: draft.agents[agentName].capabilities,
      defaultValue: defaults.agents[agentName]?.capabilities,
      description: 'Comma list or JSON array of capabilities (implement, review, etc.).',
      options: getConfigValueOptions(draft, capabilitiesPath),
    });
    if (capabilitiesValue) {
      const before = draft.agents[agentName].capabilities;
      draft = applyConfigPatch(draft, { path: capabilitiesPath, value: capabilitiesValue });
      changes.push({ path: capabilitiesPath, before, after: draft.agents[agentName].capabilities });
    }
  }

  const reviewerOptions = getConfigValueOptions(draft, 'workflow.reviewer.maxPasses');
  if (reviewerOptions.length === 0) {
    console.log(
      chalk.yellow(
        'Skipping workflow.reviewer.maxPasses: no review step found (role includes "reviewer" or action is "review").',
      ),
    );
  } else {
    const reviewerCurrent = draft.workflow.steps.find((s) =>
      s.role === 'reviewer' || s.action === 'review' || s.role.toLowerCase().includes('review'),
    )?.maxPasses;
    const reviewerDefault = defaults.workflow.steps.find((s) =>
      s.role === 'reviewer' || s.action === 'review' || s.role.toLowerCase().includes('review'),
    )?.maxPasses;
    const reviewerMaxPassesValue = await askFieldValue({
      label: 'workflow.reviewer.maxPasses',
      currentValue: reviewerCurrent,
      defaultValue: reviewerDefault,
      description: 'Maximum review/fix cycles before fallback.',
      options: reviewerOptions,
    });
    if (reviewerMaxPassesValue) {
      const before = reviewerCurrent;
      draft = applyConfigPatch(draft, { path: 'workflow.reviewer.maxPasses', value: reviewerMaxPassesValue });
      const after = draft.workflow.steps.find((s) =>
        s.role === 'reviewer' || s.action === 'review' || s.role.toLowerCase().includes('review'),
      )?.maxPasses;
      changes.push({ path: 'workflow.reviewer.maxPasses', before, after });
    }
  }

  const retryCountValue = await askFieldValue({
    label: 'errorHandling.default.retry',
    currentValue: draft.errorHandling.default.retry,
    defaultValue: defaults.errorHandling.default.retry,
    description: 'Retries before fallback handling for failed steps.',
    options: getConfigValueOptions(draft, 'errorHandling.default.retry'),
  });
  if (retryCountValue) {
    const before = draft.errorHandling.default.retry;
    draft = applyConfigPatch(draft, { path: 'errorHandling.default.retry', value: retryCountValue });
    changes.push({ path: 'errorHandling.default.retry', before, after: draft.errorHandling.default.retry });
  }

  const scopeChanged = selectedScope !== snapshot.activeScope;
  if (!scopeChanged && changes.length === 0) {
    console.log(chalk.dim('\nNo changes. Exiting without writes.\n'));
    return;
  }

  const diagnostics = validateConfig(draft);
  if (diagnostics.length > 0) {
    throw new Error(diagnostics[0].message);
  }

  console.log(chalk.bold('\nPending Changes'));
  if (scopeChanged) {
    console.log(`  scope: ${snapshot.activeScope} -> ${selectedScope}`);
  }
  for (const change of changes) {
    console.log(
      `  ${change.path}: ${formatChangedValue(change.before)} -> ${formatChangedValue(change.after)}`,
    );
  }

  const confirmation = (await askQuestion('\nApply changes? [y/N]: ')).trim().toLowerCase();
  if (confirmation !== 'y' && confirmation !== 'yes') {
    console.log(chalk.dim('\nCancelled. No writes performed.\n'));
    return;
  }

  if (scopeChanged) {
    setConfigScope(cwd, selectedScope);
  }
  const filePath = saveConfigByScope(selectedScope, cwd, draft, { profile: selectedProfile });
  console.log(chalk.green('\n\u2713 Configuration saved.'));
  console.log(`  ${chalk.dim('scope:')} ${selectedScope}`);
  console.log(`  ${chalk.dim('profile:')} ${selectedProfile}`);
  console.log(`  ${chalk.dim('file:')}  ${filePath}\n`);
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
    .command('edit')
    .description('Open interactive config editor')
    .action(() => runWithExitCode(() => configWizardCommand()));
}
