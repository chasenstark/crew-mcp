import chalk from 'chalk';
import { createBuiltinRegistry } from '../../adapters/registry.js';
import { effectiveAgentPrefs, readAgentPrefsFile } from '../../agent-prefs/store.js';
import { resolveCrewHome } from '../../utils/crew-home.js';

export async function statusCommand(): Promise<void> {
  console.log(chalk.bold('\nAgent Status\n'));

  const registry = createBuiltinRegistry();
  const adapters = registry.listAvailable();
  if (adapters.length === 0) {
    console.log(chalk.yellow('No adapters registered.'));
    return;
  }

  console.log(chalk.dim(`Checking ${adapters.length} adapter(s)...\n`));

  const prefs = readAgentPrefsFile(resolveCrewHome());
  const report = await registry.healthCheckAll();

  for (const [name, result] of Object.entries(report)) {
    const adapter = registry.get(name);
    const statusIcon = result.available
      ? result.authenticated
        ? chalk.green('\u2713')
        : chalk.yellow('\u25CB')
      : chalk.red('\u2717');

    const statusText = result.available
      ? result.authenticated
        ? chalk.green('ready')
        : chalk.yellow('not authenticated')
      : chalk.red('unavailable');

    console.log(`  ${statusIcon} ${chalk.bold(name)} - ${statusText}`);

    if (result.version) {
      console.log(`    ${chalk.dim('version:')} ${result.version}`);
    }

    if (adapter) {
      const effective = effectiveAgentPrefs(
        adapter.name,
        {
          strengths: adapter.strengths,
          useWhen: adapter.useWhen,
          effort: adapter.defaultEffort,
        },
        prefs,
      );
      if (effective.useWhen) {
        console.log(
          `    ${chalk.dim('useWhen:')} ${effective.useWhen}`,
        );
      }
      if ((effective.strengths ?? []).length > 0) {
        console.log(
          `    ${chalk.dim('strengths:')} ${(effective.strengths ?? []).join(', ')}`,
        );
      }
      if (effective.effort) {
        console.log(
          `    ${chalk.dim('default effort:')} ${effective.effort}`,
        );
      }
    }

    if (result.error) {
      console.log(`    ${chalk.dim('error:')} ${chalk.red(result.error)}`);
    }

    console.log();
  }

  const available = Object.values(report).filter((r) => r.available).length;
  const total = Object.keys(report).length;
  console.log(
    chalk.dim(`${available}/${total} agent(s) available.\n`),
  );
}
