import chalk from 'chalk';
import { formatStepComplete, formatStepStart } from '../step-status.js';
import type { CrewRunner } from '../../captain/runner.js';
import type { ToolDispatcher } from '../../captain/tool-dispatcher.js';

interface RunnerEventStyle {
  agentStartSymbol: string;
  successSymbol: string;
  errorSymbol: string;
  separator: string;
}

export function attachRunnerEvents(
  runner: CrewRunner,
  style: RunnerEventStyle,
  onError: (error: Error) => void,
  dispatcher?: ToolDispatcher,
): { dispose: () => void } {
  runner.on('step:start', (step, data) => {
    console.log(chalk.dim(`  [${step}] ${formatStepStart(step, data)}`));
  });

  runner.on('step:complete', (step, data) => {
    console.log(chalk.dim(`    -> ${formatStepComplete(step, data)}`));
  });

  runner.on('report', (message) => {
    console.log('\n' + message + '\n');
  });

  runner.on('error', (error) => {
    onError(error);
    console.error(chalk.red(`\n  Error: ${error.message}\n`));
  });

  const dispatcherListeners = dispatcher
    ? [
        dispatcher.onEvent('run:start', (info) => {
          const id = info.runId ?? info.toolCallId;
          console.log(chalk.green(`  ${style.agentStartSymbol} ${info.toolName}`) + chalk.dim(` ${id}`));
        }),
        dispatcher.onEvent('run:stream', (info) => {
          const chunk = info.chunk.trimEnd();
          if (chunk) console.log(chalk.dim(`    ${info.toolCallId} ${style.separator} ${chunk}`));
        }),
        dispatcher.onEvent('run:complete', (info) => {
          const id = info.runId ?? info.toolCallId;
          console.log(`  ${chalk.green(style.successSymbol)} ${info.toolName} ${style.separator} ${id}`);
        }),
        dispatcher.onEvent('run:failed', (info) => {
          console.log(
            `  ${chalk.red(style.errorSymbol)} ${info.toolName} ${style.separator} ${info.error}`,
          );
        }),
        dispatcher.onEvent('run:cancelled', (info) => {
          console.log(
            `  ${chalk.yellow(style.errorSymbol)} ${info.toolName} ${style.separator} ${info.reason}`,
          );
        }),
      ]
    : [];

  return {
    dispose: () => {
      for (const listener of dispatcherListeners) listener.dispose();
    },
  };
}
