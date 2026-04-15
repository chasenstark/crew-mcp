import type { FullConfig } from './types.js';
import type { WorkflowStep } from './types.js';

export function findReviewStepIndex(config: Pick<FullConfig, 'workflow'>): number {
  const roleMatch = config.workflow.steps.findIndex((step) => step.role === 'reviewer');
  if (roleMatch >= 0) return roleMatch;

  const actionMatch = config.workflow.steps.findIndex((step) => step.action === 'review');
  if (actionMatch >= 0) return actionMatch;

  return config.workflow.steps.findIndex((step) => step.role.toLowerCase().includes('review'));
}

export function findReviewStep(config: Pick<FullConfig, 'workflow'>): WorkflowStep | undefined {
  const index = findReviewStepIndex(config);
  return index >= 0 ? config.workflow.steps[index] : undefined;
}
