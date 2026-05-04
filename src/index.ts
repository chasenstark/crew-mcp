import { program } from 'commander';
import { agentsEditCommand } from './cli/commands/agents.js';
import { installCommand } from './cli/commands/install.js';
import { serveCommand } from './cli/commands/serve.js';
import { statusCommand } from './cli/commands/status.js';
import { uninstallCommand } from './cli/commands/uninstall.js';
import { verifyCommand } from './cli/commands/verify.js';
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

const applyDebugFlag = (): void => {
  if (program.opts<{ debug?: boolean }>().debug) {
    setLogLevel('debug');
  }
};

program
  .command('serve')
  .description('Run crew as a stdio MCP server (the host CLI spawns this)')
  .action(async () => {
    applyDebugFlag();
    await serveCommand();
  });

program
  .command('status')
  .description('Check status of available agents')
  .action(async () => {
    applyDebugFlag();
    await statusCommand();
  });

program
  .command('install')
  .description('Install the crew MCP server + skill into a host CLI')
  .option(
    '-t, --target <host>',
    'Target host: claude-code | codex | gemini | all. '
    + 'Omit to detect installed CLIs and pick interactively.',
  )
  .option(
    '--no-auto-approve',
    'Do not pre-approve mcp__crew__* tools (host CLI will prompt before each call). Default: pre-approve.',
  )
  .action(async (opts: { target?: string; autoApprove: boolean }) => {
    applyDebugFlag();
    // commander's --no-foo sets opts.foo = false; default is true.
    const result = await installCommand({
      target: opts.target,
      autoApprove: opts.autoApprove,
    });
    if (result.installed.length === 0 && result.skipped.length > 0) {
      process.exitCode = 1;
    }
  });

program
  .command('verify')
  .description('Check installed skill ↔ MCP tool catalog parity')
  .action(async () => {
    applyDebugFlag();
    const report = await verifyCommand();
    if (!report.ok) {
      process.exitCode = 1;
    }
  });

const agents = program
  .command('agents')
  .description('Manage per-machine agent preferences (strengths + effort)');

agents
  .command('edit')
  .description('Open ~/.crew/agents.json in $EDITOR (creates with defaults if missing)')
  .action(async () => {
    applyDebugFlag();
    const code = await agentsEditCommand();
    if (code !== 0) process.exitCode = code;
  });

program
  .command('uninstall')
  .description('Remove the crew MCP server + skill from a host CLI')
  .requiredOption(
    '-t, --target <host>',
    'Target host: claude-code | codex | gemini | all',
  )
  .action(async (opts: { target: string }) => {
    applyDebugFlag();
    await uninstallCommand({ target: opts.target });
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
