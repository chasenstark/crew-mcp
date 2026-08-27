import type { ProviderCommandResult, ProviderCommandRunner, ProviderCommandSpec } from './provider-runner.js';

export const MINIMUM_GH_VERSION = '2.40.0';

export type GitHubReadCommand =
  | { readonly kind: 'version' }
  | { readonly kind: 'auth_status'; readonly hostname: string }
  | {
    readonly kind: 'graphql';
    readonly hostname: string;
    readonly document: string;
    readonly variables?: Readonly<Record<string, string | number | boolean>>;
  };

export interface GhCapability {
  readonly ok: boolean;
  readonly version?: string;
  readonly hostname: string;
  readonly scopes: readonly string[];
  readonly viewer?: string;
  readonly blockedReason?:
    | 'provider_missing'
    | 'provider_version'
    | 'provider_auth'
    | 'provider_scope'
    | 'provider_timeout'
    | 'provider_cancelled';
  readonly detail?: string;
}

export interface GitHubReadClientOptions {
  readonly runner: ProviderCommandRunner;
  readonly binary?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export async function runGitHubReadCommand(
  command: GitHubReadCommand,
  options: GitHubReadClientOptions,
): Promise<ProviderCommandResult> {
  return options.runner.run(toGitHubCommandSpec(command, options.binary), {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

export function toGitHubCommandSpec(command: GitHubReadCommand, binary = 'gh'): ProviderCommandSpec {
  if (command.kind === 'version') return { binary, args: ['--version'] };
  validateHostname(command.hostname);
  if (command.kind === 'auth_status') {
    return { binary, args: ['auth', 'status', '--active', '--hostname', command.hostname] };
  }
  assertReadOnlyGraphql(command.document);
  const args = ['api', 'graphql', '--hostname', command.hostname, '-f', `query=${command.document}`];
  for (const [name, value] of Object.entries(command.variables ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(name)) throw new Error('pr_watch.invalid_graphql_variable');
    args.push('-F', `${name}=${String(value)}`);
  }
  return { binary, args };
}

export function assertReadOnlyGraphql(document: string): void {
  const normalized = document.replace(/#[^\n]*/g, ' ').trim();
  if (normalized.length === 0 || Buffer.byteLength(normalized, 'utf-8') > 256 * 1024) {
    throw new Error('pr_watch.invalid_graphql_document');
  }
  if (/\bmutation\b/i.test(normalized)) {
    throw new Error('pr_watch.github_mutation_forbidden');
  }
  if (!/^(?:query\b|\{)/i.test(normalized)) {
    throw new Error('pr_watch.graphql_read_query_required');
  }
}

export async function detectGhCapability(args: {
  readonly runner: ProviderCommandRunner;
  readonly hostname?: string;
  readonly requiredScopes?: readonly string[];
  readonly binary?: string;
  readonly signal?: AbortSignal;
}): Promise<GhCapability> {
  const hostname = args.hostname ?? 'github.com';
  let versionResult: ProviderCommandResult;
  try {
    versionResult = await runGitHubReadCommand({ kind: 'version' }, {
      runner: args.runner,
      binary: args.binary,
      signal: args.signal,
    });
  } catch (error) {
    return capabilityFailure(hostname, error, 'provider_missing');
  }
  const version = parseGhVersion(versionResult.stdout);
  if (!version || compareVersions(version, MINIMUM_GH_VERSION) < 0) {
    return {
      ok: false,
      hostname,
      scopes: [],
      ...(version ? { version } : {}),
      blockedReason: 'provider_version',
      detail: `gh >= ${MINIMUM_GH_VERSION} is required`,
    };
  }

  let auth: ProviderCommandResult;
  try {
    auth = await runGitHubReadCommand({ kind: 'auth_status', hostname }, {
      runner: args.runner,
      binary: args.binary,
      signal: args.signal,
    });
  } catch (error) {
    return { ...capabilityFailure(hostname, error, 'provider_auth'), version };
  }
  const scopes = parseGhScopes(`${auth.stdout}\n${auth.stderr}`);
  const required = new Set(args.requiredScopes ?? ['repo']);
  const missing = [...required].filter((scope) => !scopes.includes(scope));
  if (missing.length > 0) {
    return {
      ok: false,
      hostname,
      version,
      scopes,
      blockedReason: 'provider_scope',
      detail: `missing scopes: ${missing.join(', ')}`,
    };
  }
  return { ok: true, hostname, version, scopes };
}

function capabilityFailure(
  hostname: string,
  error: unknown,
  fallback: NonNullable<GhCapability['blockedReason']>,
): GhCapability {
  const message = error instanceof Error ? error.message : String(error);
  const blockedReason = message.includes('provider_timeout')
    ? 'provider_timeout'
    : message.includes('provider_cancelled')
      ? 'provider_cancelled'
      : fallback;
  return { ok: false, hostname, scopes: [], blockedReason, detail: message };
}

export function parseGhVersion(output: string): string | undefined {
  return output.match(/gh version\s+(\d+\.\d+\.\d+)/i)?.[1];
}

export function parseGhScopes(output: string): readonly string[] {
  const line = output.split(/\r?\n/).find((entry) => /token scopes:/i.test(entry));
  if (!line) return [];
  return [...new Set(
    [...line.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1].trim()).filter(Boolean),
  )].sort();
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function validateHostname(value: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value) || value.includes('..')) {
    throw new Error('pr_watch.invalid_github_hostname');
  }
}
