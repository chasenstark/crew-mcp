import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';

const DEFAULT_WORKFLOW_YAML = `# Default workflow configuration for the orchestrator.
# Edit this file to customize agents, models, and workflow behavior.

workflow:
  name: default
  steps:
    - role: coder
      agent: claude-code
      action: implement

    - role: reviewer
      agent: codex
      action: review
      max_passes: 3

    - role: judge
      agent: orchestrator
      action: evaluate_review
      criteria:
        - "Are the review findings actionable?"
        - "Is the fix complete and correct?"

    - role: coder
      agent: claude-code
      action: fix_review_issues
      condition: "judge says fixes needed"

  completion:
    strategy: judge_approval
    fallback: max_passes

agents:
  claude-code:
    adapter: claude-code
    auth: subscription
    model: claude-opus-4-6
    strengths:
      - implementation
      - refactoring
      - TypeScript
      - React

  codex:
    adapter: codex
    auth: subscription
    model: gpt-5.3-codex
    strengths:
      - review
      - testing
      - Python
      - security

orchestrator:
  cli: claude-code
  model: claude-sonnet-4-5

error_handling:
  default:
    retry: 1
    fallback: null
    on_exhausted: ask_user
`;

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

    writeFileSync(workflowFile, DEFAULT_WORKFLOW_YAML, 'utf-8');

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
