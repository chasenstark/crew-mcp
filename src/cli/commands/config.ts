import { createInterface } from 'node:readline/promises';
import { clearScreenDown, emitKeypressEvents, moveCursor } from 'node:readline';
import { stdin as input, stdout as output } from 'process';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { ConfigScope } from '../../workflow/config-repository.js';
import { getDefaultConfig } from '../../workflow/config-codec.js';
import { saveConfigByScope } from '../../workflow/config-repository.js';
import { validateConfig } from '../../workflow/config-validation.js';
import {
  applyConfigPatch,
  getConfigScope,
  getConfigValueOptions,
  resetConfig,
  setConfigScope,
  setConfigValue,
  showConfig,
} from '../../workflow/config-service.js';

function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function effectiveSource(scopePaths: ReturnType<typeof showConfig>['paths']): 'project' | 'global' | 'defaults' {
  if (scopePaths.effective === scopePaths.project) return 'project';
  if (scopePaths.effective === scopePaths.global) return 'global';
  return 'defaults';
}

export function formatShowOutput(cwd: string, asJson = false): string {
  const snapshot = showConfig(cwd);

  if (asJson) {
    return renderJson({
      activeScope: snapshot.activeScope,
      source: effectiveSource(snapshot.paths),
      paths: snapshot.paths,
      effectiveConfig: snapshot.effectiveConfig,
    });
  }

  const source = effectiveSource(snapshot.paths);
  const lines = [
    `${chalk.bold('Active Write Scope:')} ${snapshot.activeScope}`,
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

function parseScopeOption(raw: string | undefined): ConfigScope | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'project' || raw === 'global') return raw;
  throw new Error(`Invalid scope "${raw}". Expected "project" or "global".`);
}

function formatChangedValue(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  return JSON.stringify(value);
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
} = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  console.log(formatShowOutput(cwd, options.json ?? false));
}

export async function configSetCommand(
  path: string,
  value: string,
  options: { cwd?: string; scope?: string } = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const scope = parseScopeOption(options.scope);
  const result = setConfigValue(cwd, path, value, { scope });

  console.log(chalk.green('\u2713 Configuration updated.'));
  console.log(`  ${chalk.dim('scope:')} ${result.scope}`);
  console.log(`  ${chalk.dim('file:')}  ${result.filePath}`);
  console.log(`  ${chalk.dim('path:')}  ${result.path}`);
  console.log(
    `  ${chalk.dim('value:')} ${formatChangedValue(result.previousValue)} -> ${formatChangedValue(result.nextValue)}`,
  );
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

export async function configResetCommand(options: {
  cwd?: string;
  scope?: string;
} = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const scope = parseScopeOption(options.scope);
  const result = resetConfig(cwd, { scope });

  console.log(chalk.green('\u2713 Scope config reset to defaults.'));
  console.log(`  ${chalk.dim('scope:')} ${result.scope}`);
  console.log(`  ${chalk.dim('file:')}  ${result.filePath}`);
}

export async function configWizardCommand(options: { cwd?: string } = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const snapshot = showConfig(cwd);
  const defaults = getDefaultConfig();
  const originalConfig = snapshot.effectiveConfig;
  let draft = structuredClone(originalConfig);
  let selectedScope = snapshot.activeScope;
  const changes: Array<{ path: string; before: unknown; after: unknown }> = [];

  console.log(chalk.bold('\nInteractive Config Wizard\n'));

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

  const orchestratorCliValue = await askFieldValue({
    label: 'orchestrator.cli',
    currentValue: draft.orchestrator.cli,
    defaultValue: defaults.orchestrator.cli,
    description: 'Which configured adapter should run orchestration decisions.',
    options: getConfigValueOptions(draft, 'orchestrator.cli'),
  });
  if (orchestratorCliValue) {
    const before = draft.orchestrator.cli;
    draft = applyConfigPatch(draft, { path: 'orchestrator.cli', value: orchestratorCliValue });
    changes.push({ path: 'orchestrator.cli', before, after: draft.orchestrator.cli });
  }

  const orchestratorModelValue = await askFieldValue({
    label: 'orchestrator.model',
    currentValue: draft.orchestrator.model,
    defaultValue: defaults.orchestrator.model,
    description: 'Model used by the orchestrator adapter.',
    options: getConfigValueOptions(draft, 'orchestrator.model'),
  });
  if (orchestratorModelValue) {
    const before = draft.orchestrator.model;
    draft = applyConfigPatch(draft, { path: 'orchestrator.model', value: orchestratorModelValue });
    changes.push({ path: 'orchestrator.model', before, after: draft.orchestrator.model });
  }

  const agentNames = Object.keys(draft.agents).sort();
  for (const agentName of agentNames) {
    const path = `agents.${agentName}.model`;
    const pathOptions = getConfigValueOptions(draft, path);
    const agentModelValue = await askFieldValue({
      label: path,
      currentValue: draft.agents[agentName].model,
      defaultValue: defaults.agents[agentName]?.model,
      description: 'Model used when this agent runs.',
      options: pathOptions,
    });
    if (!agentModelValue) continue;
    const before = draft.agents[agentName].model;
    draft = applyConfigPatch(draft, { path, value: agentModelValue });
    changes.push({ path, before, after: draft.agents[agentName].model });
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
  const filePath = saveConfigByScope(selectedScope, cwd, draft);
  console.log(chalk.green('\n\u2713 Configuration saved.'));
  console.log(`  ${chalk.dim('scope:')} ${selectedScope}`);
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
    .description('Inspect and update orchestrator configuration');

  command.action(() => runWithExitCode(() => configWizardCommand()));

  command
    .command('show')
    .description('Show effective config and scope information')
    .option('--json', 'Emit machine-readable output')
    .action((options: { json?: boolean }) =>
      runWithExitCode(() => configShowCommand({ json: options.json })),
    );

  command
    .command('set')
    .description('Set a config value by path (supports next|prev cycling)')
    .argument('<path>', 'Config path to update')
    .argument('<value...>', 'Value to write')
    .option('--scope <scope>', 'Write scope: project|global')
    .action((path: string, value: string[], options: { scope?: string }) =>
      runWithExitCode(() =>
        configSetCommand(path, value.join(' '), { scope: options.scope }),
      ));

  command
    .command('scope')
    .description('Show or set active write scope')
    .argument('[scope]', 'project|global')
    .action((scope: string | undefined) =>
      runWithExitCode(() => configScopeCommand(scope)),
    );

  command
    .command('reset')
    .description('Reset scoped config to defaults')
    .option('--scope <scope>', 'Scope to reset: project|global')
    .action((options: { scope?: string }) =>
      runWithExitCode(() => configResetCommand({ scope: options.scope })),
    );

  command
    .command('edit')
    .description('Open interactive config editor')
    .action(() => runWithExitCode(() => configWizardCommand()));
}
