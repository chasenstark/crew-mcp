import chalk from 'chalk';
import { existsSync, realpathSync } from 'node:fs';
import { createBuiltinRegistry } from '../../adapters/registry.js';
import { effectiveAgentPrefs, readAgentPrefsFile } from '../../agent-prefs/store.js';
import { PrWatchStore } from '../../pr-watch/store.js';
import { resolveCrewHome } from '../../utils/crew-home.js';

export interface StatusCommandOptions {
  readonly cwd?: string;
  readonly crewHome?: string;
  readonly stdout?: Pick<NodeJS.WriteStream, 'write'>;
}

export async function statusCommand(options: StatusCommandOptions = {}): Promise<void> {
  const write = (line = '') => (options.stdout ?? process.stdout).write(`${line}\n`);
  const crewHome = options.crewHome ?? resolveCrewHome();
  console.log(chalk.bold('\nAgent Status\n'));

  const registry = createBuiltinRegistry();
  const adapters = registry.listAvailable();
  if (adapters.length === 0) {
    console.log(chalk.yellow('No adapters registered.'));
  } else {
    console.log(chalk.dim(`Checking ${adapters.length} adapter(s)...\n`));

    const prefs = readAgentPrefsFile(crewHome);
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

  const watchRoot = `${crewHome}/pr-watches`;
  const repoRoot = realpathSync(options.cwd ?? process.cwd());
  const counts: Record<string, number> = {};
  let corrupt = 0;
  let pendingRemedies = 0;
  if (existsSync(watchRoot)) {
    const store = new PrWatchStore(crewHome);
    for (const watchId of store.listWatchIds()) {
      try {
        const state = store.read(watchId).state;
        if (state.repoRoot !== repoRoot) continue;
        counts[state.status] = (counts[state.status] ?? 0) + 1;
        const pendingBlocker = state.status === 'blocked'
          && state.blockerSurfaces.some((surface) => (
            surface.surfaceId === state.currentBlockerSurfaceId
            && surface.closedAt === undefined
            && surface.state !== 'delivered'
          ));
        const pendingExpiry = state.status === 'expired'
          && state.expirySurfaces.some((surface) => (
            surface.surfaceId === state.currentExpirySurfaceId
            && surface.closedAt === undefined
            && surface.state !== 'delivered'
          ));
        if (pendingBlocker || pendingExpiry) pendingRemedies += 1;
      } catch {
        corrupt += 1;
      }
    }
  }
  const totalWatches = Object.values(counts).reduce((sum, count) => sum + count, 0);
  write(chalk.bold('PR Watch Status'));
  write('');
  write(`  ${totalWatches} watch(es) for ${repoRoot}`);
  for (const status of ['active', 'actionable', 'blocked', 'expired', 'terminal', 'cancelled']) {
    if ((counts[status] ?? 0) > 0) write(`    ${status}: ${counts[status]}`);
  }
  if (pendingRemedies > 0) write(`    pending remedies: ${pendingRemedies}`);
  if (corrupt > 0) write(`    corrupt entries: ${corrupt}`);
  write('');
}
