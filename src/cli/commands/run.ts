import { render } from 'ink';
import React from 'react';
import { App } from '../ui/App.js';
import { Pipeline, type AgentRegistry } from '../../orchestrator/pipeline.js';
import { AdapterRegistry } from '../../adapters/registry.js';
import { StateStore } from '../../state/store.js';
import { WorktreeManager } from '../../git/worktree.js';
import { loadWorkflowConfig } from '../../workflow/loader.js';
import chalk from 'chalk';
import { formatStepComplete, formatStepStart } from '../step-status.js';
import { enableFileLogging, logger } from '../../utils/logger.js';

/**
 * Wrap AdapterRegistry to satisfy Pipeline's AgentRegistry interface.
 */
function toAgentRegistry(registry: AdapterRegistry): AgentRegistry {
  return {
    get: (name: string) => registry.get(name),
    list: () =>
      registry.listAvailable().map((a) => ({
        name: a.name,
        capabilities: a.capabilities as string[],
      })),
  };
}

export async function runCommand(prompt?: string): Promise<void> {
  const projectRoot = process.cwd();
  const logFile = enableFileLogging(projectRoot);
  logger.info(`Run log file: ${logFile}`);

  // Load config
  const config = loadWorkflowConfig(projectRoot);

  // Initialize components
  const registry = new AdapterRegistry();
  const state = new StateStore(projectRoot);
  const worktreeManager = new WorktreeManager(projectRoot);

  // Get orchestrator adapter
  const orchestratorAdapter = registry.getOrThrow(config.orchestrator.cli);

  // Wrap registry for pipeline's interface
  const agentRegistry = toAgentRegistry(registry);

  // Create pipeline
  const pipeline = new Pipeline(
    orchestratorAdapter,
    agentRegistry,
    config.workflow,
    state,
    worktreeManager,
  );

  if (prompt) {
    // Non-interactive mode: run directly
    console.log(chalk.blue('\n  orchestrator') + chalk.dim(' \u2014 starting workflow\n'));
    console.log(chalk.dim(`  log: ${logFile}\n`));

    pipeline.on('step:start', (step, data) => {
      console.log(chalk.dim(`  [${step}] ${formatStepStart(step, data)}`));
    });

    pipeline.on('step:complete', (step, data) => {
      console.log(chalk.dim(`    -> ${formatStepComplete(step, data)}`));
    });

    pipeline.on('agent:start', (name, task) => {
      console.log(chalk.green(`  \u25CF ${name}`) + chalk.dim(` ${task}`));
    });

    pipeline.on('agent:complete', (name, _taskId, result) => {
      const icon = result.status === 'success' ? chalk.green('\u2713') : chalk.red('\u2717');
      console.log(`  ${icon} ${name} \u2014 ${result.status}`);
    });

    pipeline.on('report', (message) => {
      console.log('\n' + message + '\n');
    });

    pipeline.on('error', (error) => {
      console.error(chalk.red(`\n  Error: ${error.message}\n`));
    });

    await pipeline.run(prompt);
  } else {
    // Interactive mode: render Ink app
    const { waitUntilExit } = render(
      React.createElement(App, { pipeline }),
    );
    await waitUntilExit();
  }
}
