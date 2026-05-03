import chalk from 'chalk';
import { formatStepComplete, formatStepStart } from '../step-status.js';
import type { CrewRunner } from '../../captain/runner.js';
import type { ToolDispatcher } from '../../captain/tool-dispatcher.js';
import { logger } from '../../utils/logger.js';

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
    logger.info(`[${step}] ${formatStepStart(step, data)}`);
  });

  runner.on('step:complete', (step, data) => {
    logger.info(`[${step}] ${formatStepComplete(step, data)}`);
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
          logger.info(`${style.agentStartSymbol} ${info.toolName} ${id}`);
        }),
        dispatcher.onEvent('run:stream', (info) => {
          const chunk = info.chunk.trimEnd();
          if (chunk) logger.debug(`${info.toolCallId} ${style.separator} ${chunk}`);
        }),
        dispatcher.onEvent('run:complete', (info) => {
          const id = info.runId ?? info.toolCallId;
          logger.info(`${style.successSymbol} ${info.toolName} ${style.separator} ${id}`);
        }),
        dispatcher.onEvent('run:failed', (info) => {
          logger.error(`${style.errorSymbol} ${info.toolName} ${style.separator} ${info.error}`);
        }),
        dispatcher.onEvent('run:cancelled', (info) => {
          logger.warn(`${style.errorSymbol} ${info.toolName} ${style.separator} ${info.reason}`);
        }),
      ]
    : [];

  return {
    dispose: () => {
      for (const listener of dispatcherListeners) listener.dispose();
    },
  };
}
