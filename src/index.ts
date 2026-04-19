import { program } from 'commander';
import { runCommand } from './cli/commands/run.js';
import { statusCommand } from './cli/commands/status.js';
import { initCommand } from './cli/commands/init.js';
import { registerConfigCommand } from './cli/commands/config.js';
import { stateResetCommand } from './cli/commands/state-reset.js';
import { setLogLevel } from './utils/logger.js';

program
  .name('crew')
  .description('Provider-agnostic multi-agent coding crew through conversation')
  .version('0.1.0')
  .option('--debug', 'Enable debug logging');

program
  .command('run')
  .description('Start a new workflow or enter conversation mode')
  .argument('[prompt]', 'Initial prompt (or enter interactive mode)')
  .option('--on-ask-user <policy>', 'Behavior when human input is required in non-interactive mode: fail or prompt')
  .option('--skip-preflight', 'Skip adapter readiness/authentication checks before running')
  .action(async (prompt: string | undefined, opts: { onAskUser?: string; skipPreflight?: boolean }) => {
    if (program.opts<{ debug?: boolean }>().debug) {
      setLogLevel('debug');
    }
    await runCommand(prompt, {
      onAskUser: opts.onAskUser,
      skipPreflight: opts.skipPreflight,
    });
  });

program
  .command('init')
  .description('Initialize crew config (global by default)')
  .option('--project', 'Write config to .crew/ in the current project instead of globally')
  .action(async (opts: { project?: boolean }) => {
    if (program.opts<{ debug?: boolean }>().debug) {
      setLogLevel('debug');
    }
    await initCommand({ project: opts.project });
  });

// M3-12: `crew resume` is removed. The captain session is durable; run
// auto-continues any prior conversation so a separate entry point is
// unnecessary. A stale invocation now falls through to commander's
// "unknown command" help.

program
  .command('status')
  .description('Check status of available agents')
  .action(async () => {
    if (program.opts<{ debug?: boolean }>().debug) {
      setLogLevel('debug');
    }
    await statusCommand();
  });

registerConfigCommand(program);

const stateCommand = program
  .command('state')
  .description('Manage crew runtime state under .crew/');

stateCommand
  .command('reset')
  .description('Wipe runtime state (state.json, runs, passes, summaries, captain, conversation files)')
  .option('--yes', 'Skip the confirmation prompt')
  .action(async (opts: { yes?: boolean }) => {
    if (program.opts<{ debug?: boolean }>().debug) {
      setLogLevel('debug');
    }
    await stateResetCommand({ yes: opts.yes });
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
