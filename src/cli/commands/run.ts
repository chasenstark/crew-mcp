import { render } from 'ink';
import React from 'react';
import chalk from 'chalk';
import { App } from '../ui/App.js';
import { enableFileLogging, logger } from '../../utils/logger.js';
import { createRunner } from '../runtime/create-runner.js';
import { attachAskUserHandler, normalizeAskUserPolicy } from '../runtime/ask-user.js';
import { attachRunnerEvents } from '../runtime/attach-runner-events.js';

export async function runCommand(
  prompt?: string,
  options: { onAskUser?: string } = {},
): Promise<void> {
  const projectRoot = process.cwd();
  const logFile = enableFileLogging(projectRoot);
  logger.info(`Run log file: ${logFile}`);

  const { runner, stateStore } = createRunner(projectRoot);

  if (prompt) {
    const onAskUser = normalizeAskUserPolicy(options.onAskUser, 'fail');
    let sawPipelineError = false;

    console.log(chalk.blue('\n  orchestrator') + chalk.dim(' — starting workflow\n'));
    console.log(chalk.dim(`  log: ${logFile}\n`));

    attachRunnerEvents(
      runner,
      {
        agentStartSymbol: '●',
        successSymbol: '✓',
        errorSymbol: '✗',
        separator: '—',
      },
      () => {
        sawPipelineError = true;
      },
    );
    attachAskUserHandler(runner, {
      policy: onAskUser,
      failPrefix: 'Human input required in non-interactive mode',
    });

    const handleSigint = () => {
      runner.cancel('Interrupted by SIGINT');
      process.exitCode = 130;
    };

    process.once('SIGINT', handleSigint);
    try {
      await runner.run(prompt);
    } finally {
      process.off('SIGINT', handleSigint);
    }

    const finalState = stateStore.loadState();
    const workflowFailed = finalState?.status === 'failed';
    if ((sawPipelineError || workflowFailed) && process.exitCode === undefined) {
      process.exitCode = 1;
    }
    return;
  }

  normalizeAskUserPolicy(options.onAskUser, 'prompt');

  const { waitUntilExit } = render(
    React.createElement(App, { pipeline: runner }),
  );
  await waitUntilExit();
}
