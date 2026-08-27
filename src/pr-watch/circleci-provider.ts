import type { ProviderCommandResult, ProviderCommandRunner, ProviderCommandSpec } from './provider-runner.js';
import type { CircleCiWorkflowEvidence, CircleCiWorkflowState } from './circleci-evidence.js';

export type CircleCiReadCommand =
  | {
    readonly kind: 'run_list';
    readonly projectSlug: string;
    readonly branch: string;
  }
  | { readonly kind: 'run_get'; readonly runId: string }
  | { readonly kind: 'workflow_get'; readonly workflowId: string };

export function toCircleCiCommandSpec(
  command: CircleCiReadCommand,
  binary = 'circleci',
): ProviderCommandSpec {
  if (command.kind === 'run_list') {
    validateProjectSlug(command.projectSlug);
    validateOpaque(command.branch, 'branch');
    return {
      binary,
      args: ['run', 'list', '--project', command.projectSlug, '--branch', command.branch, '--limit', '25', '--json'],
    };
  }
  if (command.kind === 'run_get') {
    validateOpaque(command.runId, 'run id');
    return { binary, args: ['run', 'get', command.runId, '--json'] };
  }
  validateOpaque(command.workflowId, 'workflow id');
  return { binary, args: ['workflow', 'get', command.workflowId, '--json'] };
}

export class CircleCiCliReader {
  constructor(
    private readonly runner: ProviderCommandRunner,
    private readonly binary = 'circleci',
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(args: {
    readonly branch: string;
    readonly headSha: string;
    readonly projectSlug: string;
    readonly requiredWorkflows: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<readonly CircleCiWorkflowEvidence[]> {
    const listed = await runCircleCiReadCommand({
      kind: 'run_list',
      projectSlug: args.projectSlug,
      branch: args.branch,
    }, { runner: this.runner, binary: this.binary, signal: args.signal });
    const runs = parseJsonArray(listed.stdout, 'run_list');
    const matching = runs
      .filter((candidate) => readString(candidate, 'revision') === args.headSha)
      .sort((left, right) => readTimestamp(right, 'created_at') - readTimestamp(left, 'created_at'))[0];
    if (!matching) return [];
    const runId = requiredString(matching, 'id', 'run_list');
    const detail = await runCircleCiReadCommand({ kind: 'run_get', runId }, {
      runner: this.runner,
      binary: this.binary,
      signal: args.signal,
    });
    const run = parseJsonObject(detail.stdout, 'run_get');
    const workflows = Array.isArray(run.workflows)
      ? run.workflows.filter(isRecord)
      : [];
    const observedAt = this.now().toISOString();
    return workflows
      .filter((workflow) => args.requiredWorkflows.includes(readString(workflow, 'name') ?? ''))
      .map((workflow) => ({
        workflowName: requiredString(workflow, 'name', 'run_get'),
        workflowId: requiredString(workflow, 'id', 'run_get'),
        headSha: args.headSha,
        state: circleCiState(workflow),
        observedAt,
        attempt: 1,
        detail: readString(workflow, 'current_outcome')
          ?? readString(workflow, 'outcome')
          ?? readString(workflow, 'phase'),
      }));
  }
}

export async function runCircleCiReadCommand(
  command: CircleCiReadCommand,
  options: {
    readonly runner: ProviderCommandRunner;
    readonly binary?: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  },
): Promise<ProviderCommandResult> {
  return options.runner.run(toCircleCiCommandSpec(command, options.binary), {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

function validateProjectSlug(value: string): void {
  if (!/^(?:gh|github)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('pr_watch.invalid_circleci_project_slug');
  }
}

function validateOpaque(value: string, label: string): void {
  if (
    value.length === 0
    || value.length > 256
    || /[\0\r\n]/.test(value)
    || value.startsWith('-')
  ) {
    throw new Error(`pr_watch.invalid_circleci_${label.replaceAll(' ', '_')}`);
  }
}

function parseJsonArray(raw: string, label: string): readonly Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`pr_watch.invalid_circleci_${label}_json`);
  }
  if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
    throw new Error(`pr_watch.invalid_circleci_${label}_shape`);
  }
  return parsed;
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`pr_watch.invalid_circleci_${label}_json`);
  }
  if (!isRecord(parsed)) throw new Error(`pr_watch.invalid_circleci_${label}_shape`);
  return parsed;
}

function circleCiState(workflow: Record<string, unknown>): CircleCiWorkflowState {
  const outcome = (
    readString(workflow, 'current_outcome')
    ?? readString(workflow, 'outcome')
    ?? ''
  ).toLowerCase();
  const phase = (readString(workflow, 'phase') ?? '').toLowerCase();
  if (['success', 'successful'].includes(outcome)) return 'successful';
  if (['failed', 'failure', 'error', 'canceled', 'cancelled', 'unauthorized'].includes(outcome)) {
    return 'failed';
  }
  if (['created', 'queued', 'pending', 'setup'].includes(phase)) return 'continuation_pending';
  if (['running', 'executing'].includes(phase)) return 'running';
  if (['success', 'successful'].includes(phase)) return 'successful';
  if (['failed', 'failure', 'error', 'canceled', 'cancelled'].includes(phase)) return 'failed';
  return 'error';
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === 'string' ? record[key] : undefined;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = readString(record, key);
  if (!value) throw new Error(`pr_watch.invalid_circleci_${label}_${key}`);
  return value;
}

function readTimestamp(record: Record<string, unknown>, key: string): number {
  const value = readString(record, key);
  return value === undefined ? 0 : Date.parse(value) || 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
