import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';
import { getDefaultWorkflowYamlTemplate } from '../../workflow/loader.js';

export async function initCommand(options: { project?: boolean; cwd?: string } = {}): Promise<void> {
  let configDir: string;
  let workflowFile: string;

  if (options.project) {
    const workingDir = options.cwd ?? process.cwd();
    configDir = join(workingDir, '.orchestra');
    workflowFile = join(configDir, 'workflow.yaml');
  } else {
    configDir = join(homedir(), '.orchestra');
    workflowFile = join(configDir, 'workflow.yaml');
  }

  if (existsSync(workflowFile)) {
    console.log(
      chalk.yellow(
        `\n  ${workflowFile} already exists. Delete it first to reinitialize.\n`,
      ),
    );
    return;
  }

  try {
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    writeFileSync(workflowFile, getDefaultWorkflowYamlTemplate(), 'utf-8');

    const label = options.project ? 'project' : 'global';
    console.log(chalk.green(`\u2713 Initialized ${label} orchestrator configuration.\n`));
    console.log(`  ${chalk.dim('Config directory:')} ${configDir}`);
    console.log(`  ${chalk.dim('Workflow file:')}    ${workflowFile}`);
    console.log();
    if (options.project) {
      console.log(
        chalk.dim('This config overrides global settings for this project only.'),
      );
    } else {
      console.log(
        chalk.dim('This config applies to all projects. Override per-project with `orchestrator init --project`.'),
      );
    }
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';
    console.error(chalk.red(`Failed to initialize: ${message}`));
    process.exitCode = 1;
  }
}
