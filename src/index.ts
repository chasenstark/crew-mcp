import { program } from 'commander';
import { serveCommand } from './cli/commands/serve.js';
import { statusCommand } from './cli/commands/status.js';
import { setLogLevel } from './utils/logger.js';

program
  .name('crew')
  .description('MCP server + skill for multi-agent coding orchestration')
  .version('0.2.0-dev')
  .option('--debug', 'Enable debug logging');

// v2 entry points: `crew serve` (M1, stdio MCP server) and the
// `crew install` / `crew verify` / `crew uninstall` commands (M3). The v0.1
// commands (`run`, `init`, `config`, `profile`, `state reset`, `resume`) are
// removed — see docs/plans/mcp-pivot/IMPLEMENTATION_PLAN.md.

program
  .command('serve')
  .description('Run crew as a stdio MCP server (the host CLI spawns this)')
  .action(async () => {
    if (program.opts<{ debug?: boolean }>().debug) {
      setLogLevel('debug');
    }
    await serveCommand();
  });

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
