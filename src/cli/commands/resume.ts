import { StateStore } from '../../state/store.js';
import chalk from 'chalk';

export async function resumeCommand(): Promise<void> {
  const projectRoot = process.cwd();
  const state = new StateStore(projectRoot);

  if (!state.hasInterruptedWorkflow()) {
    console.log(chalk.dim('\n  No interrupted workflow found.\n'));
    return;
  }

  const workflow = state.loadState()!;
  console.log(chalk.yellow('\n  Found interrupted workflow:'));
  console.log(chalk.dim(`    Request: "${workflow.userRequest}"`));
  console.log(chalk.dim(`    Status: ${workflow.status}`));
  console.log(chalk.dim(`    Tasks: ${workflow.decomposition.tasks.length}`));
  console.log(chalk.dim(`    Progress: task ${workflow.currentTaskIndex + 1} of ${workflow.decomposition.tasks.length}`));
  console.log('');
  console.log(chalk.dim('  Resume support coming in a future update.\n'));
}
