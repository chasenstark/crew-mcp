import chalk from 'chalk';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'process';
import type { OrchestrationRunner } from '../../orchestrator/runner.js';

export type AskUserPolicy = 'fail' | 'prompt';

export function normalizeAskUserPolicy(raw: string | undefined, fallback: AskUserPolicy): AskUserPolicy {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'fail' || normalized === 'prompt') return normalized;
  throw new Error(`Invalid --on-ask-user policy "${raw}". Expected: fail or prompt.`);
}

export function attachAskUserHandler(
  runner: OrchestrationRunner,
  options: {
    policy: AskUserPolicy;
    failPrefix: string;
  },
): void {
  runner.on('ask_user', async (question) => {
    if (options.policy === 'fail') {
      const reason = `${options.failPrefix}: ${question}`;
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
