import { program } from 'commander';
import { runCommand } from './cli/commands/run.js';
import { statusCommand } from './cli/commands/status.js';
import { initCommand } from './cli/commands/init.js';
import { resumeCommand } from './cli/commands/resume.js';

program
  .name('orchestrator')
  .description('Provider-agnostic agent orchestration through conversation')
  .version('0.1.0');

program
  .command('run')
  .description('Start a new workflow or enter conversation mode')
  .argument('[prompt]', 'Initial prompt (or enter interactive mode)')
  .action(async (prompt?: string) => {
    await runCommand(prompt);
  });

program
  .command('init')
  .description('Initialize orchestrator config (global by default)')
  .option('--project', 'Write config to .orchestra/ in the current project instead of globally')
  .action(async (opts: { project?: boolean }) => {
    await initCommand({ project: opts.project });
  });

program
  .command('resume')
  .description('Resume an interrupted workflow')
  .action(async () => {
    await resumeCommand();
  });

program
  .command('status')
  .description('Check status of available agents')
  .action(async () => {
    await statusCommand();
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
