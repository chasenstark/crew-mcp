import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { CREW_MCP_VERSION } from './cli/version.js';
import { setLogLevel } from './utils/logger.js';

// v2 entry points: `crew-mcp serve` (M1, stdio MCP server) and the
// `crew-mcp install` / `crew-mcp verify` / `crew-mcp uninstall` commands (M3).
// The v0.1 commands (`run`, `init`, `config`, `profile`, `state reset`,
// `resume`) are removed — see docs/plans/completed/mcp-pivot/IMPLEMENTATION_PLAN.md.

const applyDebugFlag = (program: Command): void => {
  if (program.opts<{ debug?: boolean }>().debug) {
    setLogLevel('debug');
  }
};

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('crew-mcp')
    .description('MCP server + skill for multi-agent coding orchestration')
    .version(CREW_MCP_VERSION)
    .option('--debug', 'Enable debug logging');

  program
    .command('serve')
    .description('Run crew-mcp as a stdio MCP server (the host CLI spawns this)')
    .action(async () => {
      applyDebugFlag(program);
      const { serveCommand } = await import('./cli/commands/serve.js');
      await serveCommand();
    });

  program
    .command('status')
    .description('Check status of available agents')
    .action(async () => {
      applyDebugFlag(program);
      const { statusCommand } = await import('./cli/commands/status.js');
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
      applyDebugFlag(program);
      const { installCommand } = await import('./cli/commands/install.js');
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
    .command('install-tail-handler')
    .description('Install the optional macOS crew-tail:// Terminal handler')
    .option('-y, --yes', 'Skip the prompt and trigger the Gatekeeper dialog')
    .option('--no-gatekeeper', 'Install and register the handler without triggering Gatekeeper')
    .option('--trigger-gatekeeper', 'Only open the installed handler to trigger Gatekeeper approval')
    .action(async (opts: {
      yes?: boolean;
      gatekeeper?: boolean;
      triggerGatekeeper?: boolean;
    }) => {
      applyDebugFlag(program);
      const { installTailHandlerCommand } = await import('./cli/commands/install-tail-handler.js');
      const result = await installTailHandlerCommand({
        yes: opts.yes,
        gatekeeper: opts.gatekeeper,
        triggerGatekeeper: opts.triggerGatekeeper,
      });
      if (!result.verified) {
        process.exitCode = 1;
      }
    });

  program
    .command('verify')
    .description('Check installed skill ↔ MCP tool catalog parity')
    .action(async () => {
      applyDebugFlag(program);
      const { verifyCommand } = await import('./cli/commands/verify.js');
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
      applyDebugFlag(program);
      const { agentsEditCommand } = await import('./cli/commands/agents.js');
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
      applyDebugFlag(program);
      const { uninstallCommand } = await import('./cli/commands/uninstall.js');
      await uninstallCommand({ target: opts.target });
    });

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  await buildProgram().parseAsync(argv);
}

function isEntrypoint(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url))
      === realpathSync(resolve(process.argv[1]));
  } catch {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  }
}

if (isEntrypoint()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
