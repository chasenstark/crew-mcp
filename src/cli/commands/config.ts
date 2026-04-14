import { createInterface } from 'node:readline/promises';
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

function promptWithCurrent(
  label: string,
  currentValue: unknown,
  defaultValue: unknown,
  description: string,
): string {
  return [
    `${chalk.bold(label)}`,
    `  current: ${formatChangedValue(currentValue)}`,
    `  default: ${formatChangedValue(defaultValue)}`,
    `  ${chalk.dim(description)}`,
    '  new value (leave blank to keep current): ',
  ].join('\n');
}

async function askQuestion(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
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

  const enteredScope = (await askQuestion(
    `Write scope [project/global] (current: ${snapshot.activeScope}): `,
  )).trim();
  if (enteredScope) {
    if (enteredScope !== 'project' && enteredScope !== 'global') {
      throw new Error(`Invalid scope "${enteredScope}". Expected "project" or "global".`);
    }
    selectedScope = enteredScope;
  }

  const orchestratorCli = (await askQuestion(
    promptWithCurrent(
      'orchestrator.cli',
      draft.orchestrator.cli,
      defaults.orchestrator.cli,
      'Which configured adapter should run orchestration decisions.',
    ),
  )).trim();
  if (orchestratorCli) {
    const before = draft.orchestrator.cli;
    draft = applyConfigPatch(draft, { path: 'orchestrator.cli', value: orchestratorCli });
    changes.push({ path: 'orchestrator.cli', before, after: draft.orchestrator.cli });
  }

  const orchestratorModel = (await askQuestion(
    promptWithCurrent(
      'orchestrator.model',
      draft.orchestrator.model,
      defaults.orchestrator.model,
      'Model used by the orchestrator adapter.',
    ),
  )).trim();
  if (orchestratorModel) {
    const before = draft.orchestrator.model;
    draft = applyConfigPatch(draft, { path: 'orchestrator.model', value: orchestratorModel });
    changes.push({ path: 'orchestrator.model', before, after: draft.orchestrator.model });
  }

  const agentNames = Object.keys(draft.agents).sort();
  for (const agentName of agentNames) {
    const agentModel = (await askQuestion(
      promptWithCurrent(
        `agents.${agentName}.model`,
        draft.agents[agentName].model,
        defaults.agents[agentName]?.model,
        'Model used when this agent runs.',
      ),
    )).trim();
    if (!agentModel) continue;
    const path = `agents.${agentName}.model`;
    const before = draft.agents[agentName].model;
    draft = applyConfigPatch(draft, { path, value: agentModel });
    changes.push({ path, before, after: draft.agents[agentName].model });
  }

  const reviewerMaxPasses = (await askQuestion(
    promptWithCurrent(
      'workflow.reviewer.maxPasses',
      draft.workflow.steps.find((s) => s.role === 'reviewer')?.maxPasses,
      defaults.workflow.steps.find((s) => s.role === 'reviewer')?.maxPasses,
      'Maximum review/fix cycles before fallback.',
    ),
  )).trim();
  if (reviewerMaxPasses) {
    const before = draft.workflow.steps.find((s) => s.role === 'reviewer')?.maxPasses;
    draft = applyConfigPatch(draft, { path: 'workflow.reviewer.maxPasses', value: reviewerMaxPasses });
    const after = draft.workflow.steps.find((s) => s.role === 'reviewer')?.maxPasses;
    changes.push({ path: 'workflow.reviewer.maxPasses', before, after });
  }

  const retryCount = (await askQuestion(
    promptWithCurrent(
      'errorHandling.default.retry',
      draft.errorHandling.default.retry,
      defaults.errorHandling.default.retry,
      'Retries before fallback handling for failed steps.',
    ),
  )).trim();
  if (retryCount) {
    const before = draft.errorHandling.default.retry;
    draft = applyConfigPatch(draft, { path: 'errorHandling.default.retry', value: retryCount });
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
    .description('Set a config value by path')
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
