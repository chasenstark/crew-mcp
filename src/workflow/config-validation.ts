import type { FullConfig } from './types.js';

export interface ConfigDiagnostic {
  path: string;
  expected: string;
  received: unknown;
  example: string;
  message: string;
}

function createDiagnostic(
  path: string,
  expected: string,
  received: unknown,
  example: string,
): ConfigDiagnostic {
  const rendered = typeof received === 'string'
    ? `"${received}"`
    : JSON.stringify(received);

  return {
    path,
    expected,
    received,
    example,
    message: `Invalid value for ${path}: expected ${expected}, received ${rendered}. Example: ${example}`,
  };
}

export function validateConfig(config: FullConfig): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];

  const knownOrchestratorCli = new Set([
    ...Object.keys(config.agents),
    'claude-code',
    'codex',
  ]);
  if (!knownOrchestratorCli.has(config.orchestrator.cli)) {
    diagnostics.push(
      createDiagnostic(
        'orchestrator.cli',
        'a known agent key or built-in adapter key (claude-code|codex)',
        config.orchestrator.cli,
        '/config set orchestrator.cli codex',
      ),
    );
  }

  const reviewerStep = config.workflow.steps.find((step) => step.role === 'reviewer');
  if (reviewerStep && (!Number.isInteger(reviewerStep.maxPasses) || (reviewerStep.maxPasses ?? 0) < 1)) {
    diagnostics.push(
      createDiagnostic(
        'workflow.reviewer.maxPasses',
        'integer >= 1',
        reviewerStep.maxPasses,
        '/config set workflow.reviewer.maxPasses 3',
      ),
    );
  }

  if (!Number.isInteger(config.errorHandling.default.retry) || config.errorHandling.default.retry < 0) {
    diagnostics.push(
      createDiagnostic(
        'errorHandling.default.retry',
        'integer >= 0',
        config.errorHandling.default.retry,
        '/config set errorHandling.default.retry 1',
      ),
    );
  }

  for (const [name, agent] of Object.entries(config.agents)) {
    if (agent.model !== undefined && agent.model.trim().length === 0) {
      diagnostics.push(
        createDiagnostic(
          `agents.${name}.model`,
          'non-empty string',
          agent.model,
          `/config set agents.${name}.model claude-sonnet-4-5`,
        ),
      );
    }

    if (agent.adapter === 'generic' && (!agent.command || agent.command.trim().length === 0)) {
      diagnostics.push(
        createDiagnostic(
          `agents.${name}.command`,
          'non-empty string when adapter=generic',
          agent.command,
          `Set agents.${name}.command to a runnable CLI command`,
        ),
      );
    }
  }

  return diagnostics;
}
