import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'process';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { ConfigScope } from '../../workflow/config-repository.js';
import { parseConfigScope } from '../../workflow/config-normalization.js';
import {
  copyConfigProfile,
  createConfigProfile,
  deleteConfigProfile,
  getConfigProfile,
  getConfigProfileSummary,
  listConfigProfiles,
  selectConfigProfile,
} from '../../workflow/config-service.js';
import { configWizardCommand, type ConfigWizardIo } from './config.js';

function parseScopeOption(raw: string | undefined): ConfigScope | undefined {
  if (raw === undefined) return undefined;
  return parseConfigScope(raw);
}

function formatProfileValue(value: string | undefined): string {
  return value && value.trim() ? value : '(CLI default)';
}

export function formatProfileListOutput(cwd: string): string {
  const profiles = listConfigProfiles(cwd);
  const lines = [
    chalk.bold('Crew Profiles'),
    '',
    ...profiles.map((profile) => {
      const active = profile.active ? '*' : ' ';
      const scopes = [
        profile.projectExists ? 'project' : undefined,
        profile.globalExists ? 'global' : undefined,
      ].filter((value): value is string => value !== undefined).join('+') || profile.effectiveSource;
      return [
        `${active} ${profile.name}`,
        `  source: ${scopes}`,
        `  captain: ${profile.captainCli} / ${formatProfileValue(profile.captainModel)}`,
        `  agents: ${profile.agentCount}`,
        `  file: ${profile.filePath ?? '(built-in defaults)'}`,
      ].join('\n');
    }),
  ];
  return lines.join('\n');
}

export function formatProfileShowOutput(cwd: string, profileName?: string): string {
  const profile = getConfigProfileSummary(cwd, profileName ?? getConfigProfile(cwd));
  return [
    chalk.bold(`Crew Profile: ${profile.name}`),
    `${chalk.dim('active:')} ${profile.active ? 'yes' : 'no'}`,
    `${chalk.dim('source:')} ${profile.effectiveSource}`,
    `${chalk.dim('project file:')} ${profile.projectExists ? 'yes' : 'no'}`,
    `${chalk.dim('global file:')} ${profile.globalExists ? 'yes' : 'no'}`,
    `${chalk.dim('workflow:')} ${profile.workflowName}`,
    `${chalk.dim('captain:')} ${profile.captainCli}`,
    `${chalk.dim('model:')} ${formatProfileValue(profile.captainModel)}`,
    `${chalk.dim('agents:')} ${profile.agentCount}`,
    `${chalk.dim('file:')} ${profile.filePath ?? '(built-in defaults)'}`,
  ].join('\n');
}

export async function profileListCommand(options: { cwd?: string } = {}): Promise<void> {
  console.log(formatProfileListOutput(options.cwd ?? process.cwd()));
}

export async function profileShowCommand(
  profile: string | undefined,
  options: { cwd?: string } = {},
): Promise<void> {
  console.log(formatProfileShowOutput(options.cwd ?? process.cwd(), profile));
}

export async function profileUseCommand(
  profile: string,
  options: { cwd?: string } = {},
): Promise<void> {
  const result = selectConfigProfile(options.cwd ?? process.cwd(), profile);
  console.log(chalk.green(`✓ Active crew profile set to ${result.profile}.`));
  console.log(`  ${chalk.dim('file:')} ${result.profilePath}`);
}

export async function profileCreateCommand(
  profile: string,
  options: {
    cwd?: string;
    from?: string;
    scope?: string;
    select?: boolean;
  } = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const scope = parseScopeOption(options.scope);
  const result = createConfigProfile(cwd, profile, { from: options.from, scope });
  console.log(chalk.green(`✓ Crew profile created: ${result.profile}`));
  console.log(`  ${chalk.dim('scope:')} ${result.scope}`);
  console.log(`  ${chalk.dim('file:')}  ${result.filePath}`);
  if (options.select) {
    const selected = selectConfigProfile(cwd, result.profile);
    console.log(`  ${chalk.dim('active:')} ${selected.profile}`);
  }
}

export async function profileCopyCommand(
  source: string,
  target: string,
  options: {
    cwd?: string;
    scope?: string;
    select?: boolean;
  } = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const scope = parseScopeOption(options.scope);
  const result = copyConfigProfile(cwd, source, target, { scope });
  console.log(chalk.green(`✓ Crew profile copied: ${source} -> ${result.profile}`));
  console.log(`  ${chalk.dim('scope:')} ${result.scope}`);
  console.log(`  ${chalk.dim('file:')}  ${result.filePath}`);
  if (options.select) {
    const selected = selectConfigProfile(cwd, result.profile);
    console.log(`  ${chalk.dim('active:')} ${selected.profile}`);
  }
}

async function confirmDelete(profile: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`Delete crew profile "${profile}"? [y/N]: `);
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

export async function profileDeleteCommand(
  profile: string,
  options: {
    cwd?: string;
    scope?: string;
    yes?: boolean;
  } = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  if (!options.yes && !(await confirmDelete(profile))) {
    console.log(chalk.dim('Cancelled. No files changed.'));
    return;
  }

  const scope = parseScopeOption(options.scope);
  const result = deleteConfigProfile(cwd, profile, { scope });
  console.log(chalk.green(`✓ Crew profile deleted: ${result.profile}`));
  console.log(`  ${chalk.dim('scope:')} ${result.scope}`);
  console.log(`  ${chalk.dim('file:')}  ${result.filePath}`);
  if (result.profilePath) {
    console.log(`  ${chalk.dim('active:')} ${result.activeProfile}`);
  }
}

export async function profileSetupCommand(
  profile: string,
  options: {
    cwd?: string;
    from?: string;
    scope?: string;
    select?: boolean;
    wizardIo?: ConfigWizardIo;
  } = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const scope = parseScopeOption(options.scope);
  try {
    getConfigProfileSummary(cwd, profile);
  } catch {
    createConfigProfile(cwd, profile, { from: options.from, scope });
  }

  await configWizardCommand({
    cwd,
    profile,
    scope,
    io: options.wizardIo,
  });

  if (options.select) {
    const selected = selectConfigProfile(cwd, profile);
    console.log(chalk.green(`✓ Active crew profile set to ${selected.profile}.`));
    console.log(`  ${chalk.dim('file:')} ${selected.profilePath}`);
  }
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

export function registerProfileCommand(program: Command): void {
  const command = program
    .command('profile')
    .description('Manage saved crew profiles')
    .action(() => runWithExitCode(() => profileListCommand()));

  command
    .command('list')
    .alias('ls')
    .description('List saved crew profiles')
    .action(() => runWithExitCode(() => profileListCommand()));

  command
    .command('show')
    .description('Show profile details')
    .argument('[profile]', 'Profile name; defaults to the active profile')
    .action((profile: string | undefined) =>
      runWithExitCode(() => profileShowCommand(profile)));

  command
    .command('use')
    .description('Select the active crew profile')
    .argument('<profile>', 'Profile name')
    .action((profile: string) =>
      runWithExitCode(() => profileUseCommand(profile)));

  command
    .command('create')
    .description('Create a new crew profile')
    .argument('<profile>', 'Profile name')
    .option('--from <profile>', 'Source profile: current, default, or another profile', 'current')
    .option('--scope <scope>', 'Write scope: project|global')
    .option('--select', 'Make the new profile active')
    .action((profile: string, options: { from?: string; scope?: string; select?: boolean }) =>
      runWithExitCode(() => profileCreateCommand(profile, options)));

  command
    .command('copy')
    .description('Copy a crew profile')
    .argument('<source>', 'Source profile name')
    .argument('<target>', 'Target profile name')
    .option('--scope <scope>', 'Write scope: project|global')
    .option('--select', 'Make the copied profile active')
    .action((source: string, target: string, options: { scope?: string; select?: boolean }) =>
      runWithExitCode(() => profileCopyCommand(source, target, options)));

  command
    .command('delete')
    .alias('rm')
    .description('Delete a crew profile')
    .argument('<profile>', 'Profile name')
    .option('--scope <scope>', 'Delete from scope: project|global')
    .option('--yes', 'Skip the confirmation prompt')
    .action((profile: string, options: { scope?: string; yes?: boolean }) =>
      runWithExitCode(() => profileDeleteCommand(profile, options)));

  command
    .command('setup')
    .description('Create or edit a profile with guided setup')
    .argument('<profile>', 'Profile name')
    .option('--from <profile>', 'Source profile when creating: current, default, or another profile', 'current')
    .option('--scope <scope>', 'Write scope: project|global')
    .option('--select', 'Make the profile active after setup')
    .action((profile: string, options: { from?: string; scope?: string; select?: boolean }) =>
      runWithExitCode(() => profileSetupCommand(profile, options)));
}
