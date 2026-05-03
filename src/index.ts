import { program } from 'commander';
import { statusCommand } from './cli/commands/status.js';
import { setLogLevel } from './utils/logger.js';

program
  .name('crew')
  .description('MCP server + skill for multi-agent coding orchestration')
  .version('0.2.0-dev')
  .option('--debug', 'Enable debug logging');

// v2 entry points are added in M1 (`crew serve` — stdio MCP server) and
// M3 (`crew install` / `crew verify` / `crew uninstall`). The v0.1 commands
// (`run`, `init`, `config`, `profile`, `state reset`, `resume`) are removed —
// see docs/plans/mcp-pivot/IMPLEMENTATION_PLAN.md.

program
  .command('status')
  .description('Check status of available agents')
  .action(async () => {
    if (program.opts<{ debug?: boolean }>().debug) {
      setLogLevel('debug');
    }
    await statusCommand();
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
