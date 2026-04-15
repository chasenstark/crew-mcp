import chalk from 'chalk';
import { formatStepComplete, formatStepStart } from '../step-status.js';
import type { OrchestrationRunner } from '../../orchestrator/runner.js';

interface RunnerEventStyle {
  agentStartSymbol: string;
  successSymbol: string;
  errorSymbol: string;
  separator: string;
}

export function attachRunnerEvents(
  runner: OrchestrationRunner,
  style: RunnerEventStyle,
  onError: (error: Error) => void,
): void {
  runner.on('step:start', (step, data) => {
    console.log(chalk.dim(`  [${step}] ${formatStepStart(step, data)}`));
  });

  runner.on('step:complete', (step, data) => {
    console.log(chalk.dim(`    -> ${formatStepComplete(step, data)}`));
  });

  runner.on('agent:start', (name, task) => {
    console.log(chalk.green(`  ${style.agentStartSymbol} ${name}`) + chalk.dim(` ${task}`));
  });

  runner.on('agent:complete', (name, _taskId, result) => {
    const icon = result.status === 'success' ? chalk.green(style.successSymbol) : chalk.red(style.errorSymbol);
    console.log(`  ${icon} ${name} ${style.separator} ${result.status}`);
  });

  runner.on('report', (message) => {
    console.log('\n' + message + '\n');
  });

  runner.on('error', (error) => {
    onError(error);
    console.error(chalk.red(`\n  Error: ${error.message}\n`));
  });
}
