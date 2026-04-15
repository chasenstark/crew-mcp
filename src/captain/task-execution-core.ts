import { isAbsolute, resolve, sep } from 'path';
import type { WorkflowConfig } from '../workflow/types.js';
import type { PassSummary } from '../state/types.js';
import { logger } from '../utils/logger.js';

export type CaptainStage =
  | 'decompose'
  | 'dispatch'
  | 'ingest'
  | 'summarize'
  | 'judge'
  | 'report';

export function resolveTaskModel(
  workflow: WorkflowConfig,
  agentModels: Record<string, string | undefined>,
  task: { role: string; agent: string },
): string | undefined {
  const roleModels = workflow.roleModels ?? {};
  const directRoleModel = roleModels[task.role]?.trim();
  if (directRoleModel) return directRoleModel;

  const stepByAction = workflow.steps.find((step) => step.action === task.role);
  if (stepByAction) {
    const stepRoleModel = roleModels[stepByAction.role]?.trim();
    if (stepRoleModel) return stepRoleModel;
  }

  const agentModel = agentModels[task.agent]?.trim();
  return agentModel || undefined;
}

export function resolveCaptainModel(
  workflow: WorkflowConfig,
  captainModel: string | undefined,
  stage: CaptainStage,
): string | undefined {
  if (stage === 'judge') {
    const roleModel = workflow.roleModels?.judge?.trim();
    if (roleModel) return roleModel;
  }
  return captainModel;
}

export function resolveTaskWorkingDirectory(taskWorktree: string, requested?: string): string {
  if (!requested || !requested.trim()) return taskWorktree;
  const candidate = requested.trim();

  const ensureWithinTaskWorktree = (pathValue: string): string => {
    const normalizedWorktree = resolve(taskWorktree);
    const normalizedPath = resolve(pathValue);
    if (
      normalizedPath === normalizedWorktree ||
      normalizedPath.startsWith(normalizedWorktree + sep)
    ) {
      return normalizedPath;
    }

    logger.warn(
      `Ignoring workingDirectory "${requested}" because it is outside task worktree ${taskWorktree}`,
    );
    return taskWorktree;
  };

  if (isAbsolute(candidate)) {
    return ensureWithinTaskWorktree(candidate);
  }

  return ensureWithinTaskWorktree(resolve(taskWorktree, candidate));
}

export function getMaxPasses(workflow: WorkflowConfig, role: string): number {
  const normalizedRole = role.trim().toLowerCase();
  const aliasMap: Record<string, string[]> = {
    implement: ['implement', 'coder'],
    refactor: ['refactor', 'coder'],
    document: ['document', 'coder'],
    review: ['review', 'reviewer'],
    test: ['test', 'reviewer'],
    analyze: ['analyze', 'reviewer', 'judge'],
  };
  const candidates = aliasMap[normalizedRole] ?? [normalizedRole];

  for (const candidate of candidates) {
    const step = workflow.steps.find(
      (s) => s.role.trim().toLowerCase() === candidate,
    );
    if (typeof step?.maxPasses === 'number') {
      return step.maxPasses;
    }
  }

  return 3;
}

export function createRunId(seed?: string): string {
  const source = (seed ?? new Date().toISOString()).replace(/[:.]/g, '-');
  return `run-${source}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildFallbackReport(summaries: PassSummary[], userRequest: string): string {
  const lines = ['# Workflow Report', '', `**Request:** ${userRequest}`, ''];

  for (const summary of summaries) {
    lines.push(`## Pass ${summary.passNumber}`);
    lines.push(summary.summary);
    if (summary.unresolvedIssues.length > 0) {
      lines.push('');
      lines.push('**Unresolved issues:**');
      for (const issue of summary.unresolvedIssues) {
        lines.push(`- ${issue}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
