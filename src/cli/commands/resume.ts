import chalk from 'chalk';
import { StateStore } from '../../state/store.js';
import { enableFileLogging, logger } from '../../utils/logger.js';
import { createRunner } from '../runtime/create-runner.js';
import { attachRunnerEvents } from '../runtime/attach-runner-events.js';
import { attachAskUserHandler, normalizeAskUserPolicy } from '../runtime/ask-user.js';

export async function resumeCommand(options: { onAskUser?: string } = {}): Promise<void> {
  const projectRoot = process.cwd();
  const stateStore = new StateStore(projectRoot);
  const onAskUser = normalizeAskUserPolicy(options.onAskUser, 'fail');

  if (!stateStore.hasInterruptedWorkflow()) {
    console.log(chalk.dim('\n  No interrupted workflow found.\n'));
    return;
  }

  const workflowState = stateStore.loadState();
  if (!workflowState) {
    console.log(chalk.dim('\n  No resumable state found.\n'));
    return;
  }

  const logFile = enableFileLogging(projectRoot);
  logger.info(`Resume log file: ${logFile}`);

  const mode = workflowState.executionMode ?? 'linear';
  const { runner } = createRunner(projectRoot, { stateStore, mode });

  let sawPipelineError = false;

  console.log(chalk.blue('\n  orchestrator') + chalk.dim(' - resuming workflow\n'));
  console.log(chalk.dim(`  log: ${logFile}\n`));
  console.log(chalk.yellow(`  Request: "${workflowState.userRequest}"`));
  console.log(chalk.dim(`  Progress: task ${workflowState.currentTaskIndex + 1} of ${workflowState.decomposition.tasks.length}\n`));

  attachRunnerEvents(
    runner,
    {
      agentStartSymbol: '*',
      successSymbol: 'ok',
      errorSymbol: 'x',
      separator: '-',
    },
    () => {
      sawPipelineError = true;
    },
  );

  attachAskUserHandler(runner, {
    policy: onAskUser,
    failPrefix: 'Human input required during resume',
  });

  const handleSigint = () => {
    runner.cancel('Interrupted by SIGINT while resuming');
    process.exitCode = 130;
  };

  process.once('SIGINT', handleSigint);
  try {
    await runner.resume({
      workflowState,
      previousSummaries: stateStore.loadPassSummaries(workflowState.runId),
    });
  } finally {
    process.off('SIGINT', handleSigint);
  }

  const finalState = stateStore.loadState();
  const workflowFailed = finalState?.status === 'failed';
  if ((sawPipelineError || workflowFailed) && process.exitCode === undefined) {
    process.exitCode = 1;
  }
}
