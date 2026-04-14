import { render } from 'ink';
import React from 'react';
import { App } from '../ui/App.js';
import { Pipeline, type AgentRegistry } from '../../orchestrator/pipeline.js';
import { JudgmentRunner } from '../../orchestrator/judgment-runner.js';
import { AdapterRegistry, createRegistryFromConfig } from '../../adapters/registry.js';
import { StateStore } from '../../state/store.js';
import { WorktreeManager } from '../../git/worktree.js';
import { loadWorkflowConfig } from '../../workflow/loader.js';
import chalk from 'chalk';
import { formatStepComplete, formatStepStart } from '../step-status.js';
import { enableFileLogging, logger } from '../../utils/logger.js';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'process';
import type { OrchestrationRunner } from '../../orchestrator/runner.js';

/**
 * Wrap AdapterRegistry to satisfy Pipeline's AgentRegistry interface.
 */
export function toAgentRegistry(registry: AdapterRegistry): AgentRegistry {
  return {
    get: (name: string) => registry.get(name),
    list: () =>
      registry.listAvailable().map((a) => ({
        name: a.name,
        capabilities: a.capabilities as string[],
      })),
  };
}

type AskUserPolicy = 'fail' | 'prompt';

function normalizeAskUserPolicy(raw: string | undefined, mode: 'interactive' | 'non-interactive'): AskUserPolicy {
  if (mode === 'interactive') return 'prompt';
  if (!raw) return 'fail';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'fail' || normalized === 'prompt') return normalized;
  throw new Error(`Invalid --on-ask-user policy "${raw}". Expected: fail or prompt.`);
}

function attachNonInteractiveAskUserHandler(
  runner: OrchestrationRunner,
  policy: AskUserPolicy,
): void {
  runner.on('ask_user', async (question) => {
    if (policy === 'fail') {
      const reason = `Human input required in non-interactive mode: ${question}`;
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

export async function runCommand(
  prompt?: string,
  options: { onAskUser?: string } = {},
): Promise<void> {
  const projectRoot = process.cwd();
  const logFile = enableFileLogging(projectRoot);
  logger.info(`Run log file: ${logFile}`);

  // Load config
  const config = loadWorkflowConfig(projectRoot);

  // Initialize components
  const registry = createRegistryFromConfig(config.agents);
  const state = new StateStore(projectRoot);
  const worktreeManager = new WorktreeManager(projectRoot);

  // Get orchestrator adapter
  const orchestratorAdapter = registry.getOrThrow(config.orchestrator.cli);

  // Wrap registry for pipeline's interface
  const agentRegistry = toAgentRegistry(registry);

  const runner: OrchestrationRunner =
    (config.workflow.execution?.mode ?? 'linear') === 'judgment'
      ? new JudgmentRunner(
        orchestratorAdapter,
        agentRegistry,
        config.workflow,
        state,
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
        agentRegistry,
        config.workflow,
        state,
        worktreeManager,
        {
          orchestratorModel: config.orchestrator.model,
          agentModels: Object.fromEntries(
            Object.entries(config.agents).map(([name, agentConfig]) => [name, agentConfig.model]),
          ),
        },
      );

  if (prompt) {
    const onAskUser = normalizeAskUserPolicy(options.onAskUser, 'non-interactive');
    // Non-interactive mode: run directly
    let sawPipelineError = false;
    console.log(chalk.blue('\n  orchestrator') + chalk.dim(' \u2014 starting workflow\n'));
    console.log(chalk.dim(`  log: ${logFile}\n`));

    runner.on('step:start', (step, data) => {
      console.log(chalk.dim(`  [${step}] ${formatStepStart(step, data)}`));
    });

    runner.on('step:complete', (step, data) => {
      console.log(chalk.dim(`    -> ${formatStepComplete(step, data)}`));
    });

    runner.on('agent:start', (name, task) => {
      console.log(chalk.green(`  \u25CF ${name}`) + chalk.dim(` ${task}`));
    });

    runner.on('agent:complete', (name, _taskId, result) => {
      const icon = result.status === 'success' ? chalk.green('\u2713') : chalk.red('\u2717');
      console.log(`  ${icon} ${name} \u2014 ${result.status}`);
    });

    runner.on('report', (message) => {
      console.log('\n' + message + '\n');
    });

    runner.on('error', (error) => {
      sawPipelineError = true;
      console.error(chalk.red(`\n  Error: ${error.message}\n`));
    });

    attachNonInteractiveAskUserHandler(runner, onAskUser);

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

    const finalState = state.loadState();
    const workflowFailed = finalState?.status === 'failed';
    if ((sawPipelineError || workflowFailed) && process.exitCode === undefined) {
      process.exitCode = 1;
    }
  } else {
    // Interactive mode: render Ink app
    const { waitUntilExit } = render(
      React.createElement(App, { pipeline: runner }),
    );
    await waitUntilExit();
  }
}
