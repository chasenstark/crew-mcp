import { Pipeline } from '../../orchestrator/pipeline.js';
import { JudgmentRunner } from '../../orchestrator/judgment-runner.js';
import { createRegistryFromConfig } from '../../adapters/registry.js';
import { StateStore } from '../../state/store.js';
import { WorktreeManager } from '../../git/worktree.js';
import { loadWorkflowConfig } from '../../workflow/loader.js';
import { toAgentRegistry } from './run.js';
import { formatStepComplete, formatStepStart } from '../step-status.js';
import { enableFileLogging, logger } from '../../utils/logger.js';
import chalk from 'chalk';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'process';
import type { OrchestrationRunner } from '../../orchestrator/runner.js';

type AskUserPolicy = 'fail' | 'prompt';

function normalizeAskUserPolicy(raw: string | undefined): AskUserPolicy {
  if (!raw) return 'fail';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'fail' || normalized === 'prompt') return normalized;
  throw new Error(`Invalid --on-ask-user policy "${raw}". Expected: fail or prompt.`);
}

function attachResumeAskUserHandler(
  runner: OrchestrationRunner,
  policy: AskUserPolicy,
): void {
  runner.on('ask_user', async (question) => {
    if (policy === 'fail') {
      const reason = `Human input required during resume: ${question}`;
      console.error(chalk.red(`\n  ${reason}`));
      runner.cancel(reason);
      return;
    }

    const rl = createInterface({ input, output });
    try {
      const response = await rl.question(`\n[orchestrator] ${question}\n> `);
      runner.provideUserInput(response);
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

  const mode = workflowState.executionMode ?? config.workflow.execution?.mode ?? 'linear';
  const runner: OrchestrationRunner =
    mode === 'judgment'
      ? new JudgmentRunner(
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
      )
      : new Pipeline(
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

  runner.on('step:start', (step, data) => {
    console.log(chalk.dim(`  [${step}] ${formatStepStart(step, data)}`));
  });

  runner.on('step:complete', (step, data) => {
    console.log(chalk.dim(`    -> ${formatStepComplete(step, data)}`));
  });

  runner.on('agent:start', (name, task) => {
    console.log(chalk.green(`  * ${name}`) + chalk.dim(` ${task}`));
  });

  runner.on('agent:complete', (name, _taskId, result) => {
    const icon = result.status === 'success' ? chalk.green('ok') : chalk.red('x');
    console.log(`  ${icon} ${name} - ${result.status}`);
  });

  runner.on('report', (message) => {
    console.log('\n' + message + '\n');
  });

  runner.on('error', (error) => {
    sawPipelineError = true;
    console.error(chalk.red(`\n  Error: ${error.message}\n`));
  });

  attachResumeAskUserHandler(runner, onAskUser);

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
