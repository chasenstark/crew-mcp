import { program } from 'commander';
import { statusCommand } from './cli/commands/status.js';
import { initCommand } from './cli/commands/init.js';
import { registerConfigCommand } from './cli/commands/config.js';
import { registerProfileCommand } from './cli/commands/profile.js';
import { stateResetCommand } from './cli/commands/state-reset.js';
import { setLogLevel } from './utils/logger.js';

program
  .name('crew')
  .description('MCP server + skill for multi-agent coding orchestration')
  .version('0.2.0-dev')
  .option('--debug', 'Enable debug logging');

// `crew run` (the v0.1 TUI entry point) is removed in v2. The host CLI is
// the user-facing UI; v2 ships `crew serve` (M1) and `crew install` (M3).

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
registerProfileCommand(program);

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
