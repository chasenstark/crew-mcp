import { Pipeline } from '../../orchestrator/pipeline.js';
import { createRegistryFromConfig } from '../../adapters/registry.js';
import { StateStore } from '../../state/store.js';
import { WorktreeManager } from '../../git/worktree.js';
import { loadWorkflowConfig } from '../../workflow/loader.js';
import { toAgentRegistry } from './run.js';
import { formatStepComplete, formatStepStart } from '../step-status.js';
import { enableFileLogging, logger } from '../../utils/logger.js';
import chalk from 'chalk';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

type AskUserPolicy = 'fail' | 'prompt';

function normalizeAskUserPolicy(raw: string | undefined): AskUserPolicy {
  if (!raw) return 'fail';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'fail' || normalized === 'prompt') return normalized;
  throw new Error(`Invalid --on-ask-user policy "${raw}". Expected: fail or prompt.`);
}

function attachResumeAskUserHandler(
  pipeline: Pipeline,
  policy: AskUserPolicy,
): void {
  pipeline.on('ask_user', async (question) => {
    if (policy === 'fail') {
      const reason = `Human input required during resume: ${question}`;
      console.error(chalk.red(`\n  ${reason}`));
      pipeline.cancel(reason);
      return;
    }

    const rl = createInterface({ input, output });
    try {
      const response = await rl.question(`\n[orchestrator] ${question}\n> `);
      pipeline.provideUserInput(response);
    } finally {
      rl.close();
    }
  });
}

export async function resumeCommand(options: { onAskUser?: string } = {}): Promise<void> {
  const projectRoot = process.cwd();
  const stateStore = new StateStore(projectRoot);
  const onAskUser = normalizeAskUserPolicy(options.onAskUser);

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

  const config = loadWorkflowConfig(projectRoot);
  const registry = createRegistryFromConfig(config.agents);
  const worktreeManager = new WorktreeManager(projectRoot);
  const orchestratorAdapter = registry.getOrThrow(config.orchestrator.cli);

  const pipeline = new Pipeline(
    orchestratorAdapter,
    toAgentRegistry(registry),
    config.workflow,
    stateStore,
    worktreeManager,
    {
      orchestratorModel: config.orchestrator.model,
      agentModels: Object.fromEntries(
        Object.entries(config.agents).map(([name, agentConfig]) => [name, agentConfig.model]),
      ),
    },
  );

  let sawPipelineError = false;

  console.log(chalk.blue('\n  orchestrator') + chalk.dim(' - resuming workflow\n'));
  console.log(chalk.dim(`  log: ${logFile}\n`));
  console.log(chalk.yellow(`  Request: "${workflowState.userRequest}"`));
  console.log(chalk.dim(`  Progress: task ${workflowState.currentTaskIndex + 1} of ${workflowState.decomposition.tasks.length}\n`));

  pipeline.on('step:start', (step, data) => {
    console.log(chalk.dim(`  [${step}] ${formatStepStart(step, data)}`));
  });

  pipeline.on('step:complete', (step, data) => {
    console.log(chalk.dim(`    -> ${formatStepComplete(step, data)}`));
  });

  pipeline.on('agent:start', (name, task) => {
    console.log(chalk.green(`  * ${name}`) + chalk.dim(` ${task}`));
  });

  pipeline.on('agent:complete', (name, _taskId, result) => {
    const icon = result.status === 'success' ? chalk.green('ok') : chalk.red('x');
    console.log(`  ${icon} ${name} - ${result.status}`);
  });

  pipeline.on('report', (message) => {
    console.log('\n' + message + '\n');
  });

  pipeline.on('error', (error) => {
    sawPipelineError = true;
    console.error(chalk.red(`\n  Error: ${error.message}\n`));
  });

  attachResumeAskUserHandler(pipeline, onAskUser);

  const handleSigint = () => {
    pipeline.cancel('Interrupted by SIGINT while resuming');
    process.exitCode = 130;
  };

  process.once('SIGINT', handleSigint);
  try {
    await pipeline.resume({
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
