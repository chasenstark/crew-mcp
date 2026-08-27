import type { ProviderCommandRunner, ProviderCommandSpec } from './provider-runner.js';
import type { PrWatchEffectKind } from './types.js';

export interface GitHubEffectRequest {
  readonly repository: string;
  readonly kind: Exclude<PrWatchEffectKind, 'push_single_branch'>;
  readonly target: Readonly<Record<string, string | number>>;
  readonly body?: string;
  readonly marker: string;
}

export class GitHubEffectAdapter {
  constructor(private readonly runner: ProviderCommandRunner) {}

  async observe(request: GitHubEffectRequest, signal?: AbortSignal): Promise<boolean> {
    const [owner, name] = splitRepository(request.repository);
    if (request.kind === 'resolve_review_thread') {
      const threadId = requiredTargetString(request.target, 'thread_id');
      const document = `query CrewPrWatchThread($id: ID!) { node(id: $id) { ... on PullRequestReviewThread { id isResolved } } }`;
      const result = await this.runner.run({
        binary: 'gh',
        args: ['api', 'graphql', '-f', `query=${document}`, '-F', `id=${threadId}`],
      }, { signal });
      const parsed = parseJson(result.stdout);
      return readNestedBoolean(parsed, ['data', 'node', 'isResolved']) === true;
    }
    const pr = requiredTargetNumber(request.target, 'pr');
    const endpoint = request.kind === 'post_pr_comment'
      ? `repos/${owner}/${name}/issues/${pr}/comments`
      : `repos/${owner}/${name}/pulls/${pr}/comments`;
    const result = await this.runner.run({
      binary: 'gh',
      args: ['api', '--method', 'GET', endpoint, '--paginate'],
    }, { signal });
    return bodiesFromJson(result.stdout).some((body) => body.includes(request.marker));
  }

  async apply(request: GitHubEffectRequest, signal?: AbortSignal): Promise<void> {
    const [owner, name] = splitRepository(request.repository);
    const spec = githubEffectCommandSpec(request, owner, name);
    await this.runner.run(spec, { signal });
  }
}

export function githubEffectCommandSpec(
  request: GitHubEffectRequest,
  owner?: string,
  name?: string,
): ProviderCommandSpec {
  const [resolvedOwner, resolvedName] = owner && name
    ? [owner, name]
    : splitRepository(request.repository);
  if (request.kind === 'post_pr_comment') {
    const pr = requiredTargetNumber(request.target, 'pr');
    return {
      binary: 'gh',
      args: [
        'pr', 'comment', String(pr), '--repo', request.repository,
        '--body', `${request.body ?? ''}\n\n${request.marker}`.trim(),
      ],
    };
  }
  if (request.kind === 'reply_review_comment') {
    const pr = requiredTargetNumber(request.target, 'pr');
    const commentId = requiredTargetNumber(request.target, 'comment_id');
    return {
      binary: 'gh',
      args: [
        'api', '--method', 'POST',
        `repos/${resolvedOwner}/${resolvedName}/pulls/${pr}/comments/${commentId}/replies`,
        '-f', `body=${`${request.body ?? ''}\n\n${request.marker}`.trim()}`,
      ],
    };
  }
  const threadId = requiredTargetString(request.target, 'thread_id');
  const document = `mutation CrewPrWatchResolve($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }`;
  return {
    binary: 'gh',
    args: ['api', 'graphql', '-f', `query=${document}`, '-F', `id=${threadId}`],
  };
}

function splitRepository(repository: string): readonly [string, string] {
  const match = repository.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (
    !match
    || match[1] === '.'
    || match[1] === '..'
    || match[2] === '.'
    || match[2] === '..'
  ) throw new Error('pr_watch.invalid_repository');
  return [match[1], match[2]];
}

function requiredTargetNumber(target: Readonly<Record<string, string | number>>, key: string): number {
  const value = target[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`pr_watch.invalid_effect_target_${key}`);
  }
  return value as number;
}

function requiredTargetString(target: Readonly<Record<string, string | number>>, key: string): string {
  const value = target[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\0\r\n]/.test(value)) {
    throw new Error(`pr_watch.invalid_effect_target_${key}`);
  }
  return value;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('pr_watch.invalid_github_effect_json');
  }
}

function bodiesFromJson(raw: string): readonly string[] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) throw new Error('pr_watch.invalid_github_effect_shape');
  return parsed.flatMap((entry) => (
    entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).body === 'string'
      ? [(entry as Record<string, unknown>).body as string]
      : []
  ));
}

function readNestedBoolean(value: unknown, path: readonly string[]): boolean | undefined {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'boolean' ? current : undefined;
}
