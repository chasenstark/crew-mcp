import type { FullConfig } from './types.js';
import { ModelId } from './models.js';
import { ADAPTER_PRESETS, AdapterId, AgentId, BUILTIN_WORKER_AGENTS } from './agents.js';
import { findReviewStep } from './review-step.js';

export interface ConfigDiagnostic {
  path: string;
  expected: string;
  received: unknown;
  example: string;
  message: string;
}

const SUPPORTED_ADAPTERS = new Set<string>(ADAPTER_PRESETS);
const SUPPORTED_CAPABILITIES = new Set([
  'implement',
  'review',
  'refactor',
  'test',
  'document',
  'analyze',
]);

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
  const validRoleModelKeys = new Set([
    ...config.workflow.steps.map((step) => step.role),
    ...config.workflow.steps.map((step) => step.action),
  ]);

  const knownOrchestratorCli = new Set([
    ...Object.keys(config.agents),
    ...BUILTIN_WORKER_AGENTS,
  ]);
  if (!knownOrchestratorCli.has(config.orchestrator.cli)) {
    diagnostics.push(
      createDiagnostic(
        'orchestrator.cli',
        `a known agent key or built-in adapter key (${BUILTIN_WORKER_AGENTS.join('|')})`,
        config.orchestrator.cli,
        `/config set orchestrator.cli ${AgentId.CODEX}`,
      ),
    );
  }

  if (
    config.workflow.execution?.mode !== undefined
    && config.workflow.execution.mode !== 'linear'
    && config.workflow.execution.mode !== 'judgment'
  ) {
    diagnostics.push(
      createDiagnostic(
        'workflow.execution.mode',
        'one of: linear, judgment',
        config.workflow.execution.mode,
        '/config set workflow.execution.mode judgment',
      ),
    );
  }

  const reviewerStep = findReviewStep(config);
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
    const adapterType = (agent.adapter ?? name).trim();

    if (!SUPPORTED_ADAPTERS.has(adapterType)) {
      diagnostics.push(
      createDiagnostic(
        `agents.${name}.adapter`,
        `one of: ${ADAPTER_PRESETS.join(', ')}`,
        agent.adapter ?? name,
        `/config set agents.${name}.adapter ${AdapterId.GENERIC}`,
      ),
      );
    }

    if (
      (adapterType === AdapterId.CLAUDE_CODE || adapterType === AdapterId.CODEX || adapterType === AdapterId.GEMINI_CLI)
      && name !== adapterType
    ) {
      diagnostics.push(
        createDiagnostic(
          `agents.${name}.adapter`,
          `built-in adapter "${adapterType}" must use key "${adapterType}"`,
          name,
          `Use "agents.${adapterType}" for adapter "${adapterType}"`,
        ),
      );
    }

    if (agent.model !== undefined && agent.model.trim().length === 0) {
      diagnostics.push(
        createDiagnostic(
          `agents.${name}.model`,
          'non-empty string',
          agent.model,
          `/config set agents.${name}.model ${ModelId.CLAUDE_SONNET}`,
        ),
      );
    }

    if (adapterType === AdapterId.GENERIC && (!agent.command || agent.command.trim().length === 0)) {
      diagnostics.push(
        createDiagnostic(
          `agents.${name}.command`,
          'non-empty string when adapter=generic',
          agent.command,
          `Set agents.${name}.command to a runnable CLI command`,
        ),
      );
    }

    if (agent.args && agent.args.some((value) => value.trim().length === 0)) {
      diagnostics.push(
        createDiagnostic(
          `agents.${name}.args`,
          'array of non-empty strings',
          agent.args,
          `/config set agents.${name}.args run,gemma4:latest,{{prompt}}`,
        ),
      );
    }

    if (
      agent.capabilities
      && agent.capabilities.some((capability) => !SUPPORTED_CAPABILITIES.has(capability.trim().toLowerCase()))
    ) {
      diagnostics.push(
        createDiagnostic(
          `agents.${name}.capabilities`,
          'comma-delimited values from implement|review|refactor|test|document|analyze',
          agent.capabilities,
          `/config set agents.${name}.capabilities implement,review`,
        ),
      );
    }
  }

  for (const [role, model] of Object.entries(config.workflow.roleModels ?? {})) {
    if (!validRoleModelKeys.has(role)) {
      diagnostics.push(
        createDiagnostic(
          `workflow.roleModels.${role}`,
          'role key present in workflow.steps[*].role or workflow.steps[*].action',
          role,
          `/config set workflow.roleModels.reviewer ${ModelId.GPT}`,
        ),
      );
    }
    if (typeof model !== 'string' || model.trim().length === 0) {
      diagnostics.push(
        createDiagnostic(
          `workflow.roleModels.${role}`,
          'non-empty string',
          model,
          `/config set workflow.roleModels.reviewer ${ModelId.GPT}`,
        ),
      );
    }
  }

  return diagnostics;
}
