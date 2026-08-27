import { sha256Canonical } from './canonical.js';
import type { PrWatchEventRecordV1 } from './types.js';

export type CircleCiWorkflowState =
  | 'unregistered'
  | 'continuation_pending'
  | 'running'
  | 'failed'
  | 'successful'
  | 'error';

export interface CircleCiWorkflowEvidence {
  readonly workflowName: string;
  readonly workflowId?: string;
  readonly headSha: string;
  readonly state: CircleCiWorkflowState;
  readonly observedAt: string;
  readonly attempt: number;
  readonly detail?: string;
}

export interface CircleCiEvaluation {
  readonly complete: boolean;
  readonly successful: boolean;
  readonly incompleteReasons: readonly string[];
  readonly actionableEvents: readonly PrWatchEventRecordV1[];
  readonly fingerprint: string;
}

export function evaluateCircleCiEvidence(args: {
  readonly prNumber: number;
  readonly headSha: string;
  readonly requiredWorkflows: readonly string[];
  readonly evidence: readonly CircleCiWorkflowEvidence[];
  readonly observedAt: string;
}): CircleCiEvaluation {
  if (args.requiredWorkflows.length === 0 || new Set(args.requiredWorkflows).size !== args.requiredWorkflows.length) {
    throw new Error('pr_watch.invalid_circleci_required_workflows');
  }
  const byName = new Map(args.evidence
    .filter((item) => item.headSha === args.headSha)
    .map((item) => [item.workflowName, item]));
  const incomplete: string[] = [];
  const events: PrWatchEventRecordV1[] = [];
  let successful = true;
  const fingerprintItems: unknown[] = [];
  for (const workflowName of [...args.requiredWorkflows].sort()) {
    const item = byName.get(workflowName);
    if (!item) {
      incomplete.push(`circleci:${workflowName}:unregistered`);
      successful = false;
      fingerprintItems.push({ workflowName, state: 'unregistered' });
      continue;
    }
    fingerprintItems.push(item);
    if (item.state === 'failed') {
      successful = false;
      const identity = {
        prNumber: args.prNumber,
        headSha: args.headSha,
        kind: 'check_failure' as const,
        providerSourceId: item.workflowId ?? `circleci:${workflowName}`,
        attempt: item.attempt,
      };
      events.push({
        id: sha256Canonical(identity),
        identity,
        firstObservedAt: args.observedAt,
        lastObservedAt: args.observedAt,
        fixAttemptCount: 0,
      });
    } else if (item.state !== 'successful') {
      incomplete.push(`circleci:${workflowName}:${item.state}`);
      successful = false;
    }
  }
  return {
    complete: incomplete.length === 0,
    successful,
    incompleteReasons: incomplete,
    actionableEvents: events,
    fingerprint: sha256Canonical({
      provider: 'circleci',
      headSha: args.headSha,
      workflows: fingerprintItems,
    }),
  };
}
