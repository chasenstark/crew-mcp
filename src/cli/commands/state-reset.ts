import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';

const RESET_ENTRIES: readonly string[] = [
  'state.json',
  'runs',
  'passes',
  'summaries',
  'conversation.json',
  'conversation.legacy.json',
  'captain',
];

const PRESERVED_ENTRIES: readonly string[] = [
  'workflow.yaml',
  'logs',
  'profiles',
];

export interface StateResetOptions {
  cwd?: string;
  yes?: boolean;
}

export interface StateResetResult {
  crewDir: string;
  removed: string[];
  skipped: string[];
  confirmed: boolean;
}

async function promptConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export async function stateResetCommand(
  options: StateResetOptions = {},
  promptFn: (question: string) => Promise<boolean> = promptConfirm,
): Promise<StateResetResult> {
  const cwd = options.cwd ?? process.cwd();
  const crewDir = join(cwd, '.crew');

  if (!existsSync(crewDir)) {
    console.log(chalk.dim('\n  No .crew/ directory found; nothing to reset.\n'));
    return { crewDir, removed: [], skipped: [], confirmed: true };
  }

  const presentEntries = RESET_ENTRIES.filter((entry) =>
    existsSync(join(crewDir, entry)),
  );

  if (presentEntries.length === 0) {
    console.log(chalk.dim('\n  No resettable runtime state under .crew/.\n'));
    return { crewDir, removed: [], skipped: [], confirmed: true };
  }

  console.log(chalk.bold('\ncrew state reset\n'));
  console.log(`  ${chalk.dim('target:')} ${crewDir}`);
  console.log(`  ${chalk.dim('will remove:')}`);
  for (const entry of presentEntries) {
    console.log(`    - ${entry}`);
  }
  console.log(`  ${chalk.dim('preserved:')} ${PRESERVED_ENTRIES.join(', ')}\n`);

  let confirmed = options.yes === true;
  if (!confirmed) {
    confirmed = await promptFn('Proceed with reset? [y/N]: ');
  }

  if (!confirmed) {
    console.log(chalk.dim('\n  Cancelled. Nothing removed.\n'));
    return { crewDir, removed: [], skipped: presentEntries.slice(), confirmed: false };
  }

  const removed: string[] = [];
  for (const entry of presentEntries) {
    const target = join(crewDir, entry);
    rmSync(target, { recursive: true, force: true });
    removed.push(entry);
  }

  console.log(chalk.green(`\u2713 Reset ${removed.length} entr${removed.length === 1 ? 'y' : 'ies'} under ${crewDir}.`));
  for (const entry of removed) {
    console.log(`  ${chalk.dim('removed:')} ${entry}`);
  }
  console.log();

  return { crewDir, removed, skipped: [], confirmed: true };
}
