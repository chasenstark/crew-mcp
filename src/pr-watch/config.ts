import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { sha256Canonical } from './canonical.js';

export const PR_WATCH_PROFILE_PATH = '.crew/pr-watch.yaml';
export const DEFAULT_PR_WATCH_MAX_PRS = 50;

export type GitHubChecksMode = 'github_rules' | 'explicit' | 'none';
export type PrWatchMaxPrsSource = 'tool' | 'repository_profile' | 'default';

export interface PrWatchProfileV1 {
  readonly schemaVersion: 1;
  readonly limits: { readonly maxPrs: number };
  readonly ci: {
    readonly githubChecks: {
      readonly mode: GitHubChecksMode;
      readonly requiredChecks: readonly string[];
    };
    readonly circleci?: {
      readonly projectSlug?: string;
      readonly requiredWorkflows: readonly string[];
    };
  };
}

export interface GitHubRulesBaseline {
  readonly status: 'resolved' | 'inaccessible' | 'ambiguous';
  readonly requiredChecks: readonly string[];
  readonly provenance: Readonly<Record<string, unknown>>;
}

export interface ResolvedPrWatchPolicyV1 {
  readonly profile: PrWatchProfileV1;
  readonly maxPrsSource: PrWatchMaxPrsSource;
  readonly profileHash: string;
  readonly rulesBaseline: GitHubRulesBaseline;
  readonly comparisonHash: string;
  readonly requiredGitHubChecks: readonly string[];
  readonly allowCheckless: boolean;
  readonly policyHash: string;
}

export class PrWatchPolicyConfirmationRequired extends Error {
  readonly comparisonHash: string;
  readonly missingChecks: readonly string[];
  readonly reason: 'weakened_checks' | 'unresolved_rules' | 'checkless';

  constructor(args: {
    readonly comparisonHash: string;
    readonly missingChecks: readonly string[];
    readonly reason: 'weakened_checks' | 'unresolved_rules' | 'checkless';
  }) {
    super(`pr_watch.policy_confirmation_required: ${args.reason} ${args.comparisonHash}`);
    this.name = 'PrWatchPolicyConfirmationRequired';
    this.comparisonHash = args.comparisonHash;
    this.missingChecks = args.missingChecks;
    this.reason = args.reason;
  }
}

const profileSchema = z.object({
  schema_version: z.literal(1),
  limits: z.object({
    max_prs: z.number().int().min(1).max(100).default(DEFAULT_PR_WATCH_MAX_PRS),
  }).strict().default({ max_prs: DEFAULT_PR_WATCH_MAX_PRS }),
  ci: z.object({
    github_checks: z.object({
      mode: z.enum(['github_rules', 'explicit', 'none']).default('github_rules'),
      required_checks: z.array(z.string().trim().min(1)).default([]),
    }).strict().default({ mode: 'github_rules', required_checks: [] }),
    circleci: z.object({
      project_slug: z.string().regex(/^(?:gh|github)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).optional(),
      required_workflows: z.array(z.string().trim().min(1)).min(1),
    }).strict().optional(),
  }).strict().default({
    github_checks: { mode: 'github_rules', required_checks: [] },
  }),
}).strict().superRefine((profile, ctx) => {
  const checks = profile.ci.github_checks.required_checks;
  if (new Set(checks).size !== checks.length) {
    ctx.addIssue({ code: 'custom', message: 'required checks must be unique' });
  }
  if (profile.ci.github_checks.mode === 'explicit' && checks.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'explicit check mode requires required_checks' });
  }
  if (profile.ci.github_checks.mode !== 'explicit' && checks.length > 0) {
    ctx.addIssue({ code: 'custom', message: 'required_checks is valid only in explicit mode' });
  }
  const workflows = profile.ci.circleci?.required_workflows;
  if (workflows && new Set(workflows).size !== workflows.length) {
    ctx.addIssue({ code: 'custom', message: 'CircleCI workflows must be unique' });
  }
});

export function loadPrWatchProfile(repoRoot: string): PrWatchProfileV1 {
  const root = realpathSync(repoRoot);
  const profilePath = join(root, PR_WATCH_PROFILE_PATH);
  if (!existsSync(profilePath)) return defaultProfile();
  const stats = lstatSync(profilePath);
  if (stats.isSymbolicLink()) {
    const resolved = realpathSync(profilePath);
    if (!isPathInside(root, resolved)) {
      throw new Error('pr_watch.profile_symlink_outside_repo');
    }
  }
  if (!lstatSync(profilePath).isFile() && !stats.isSymbolicLink()) {
    throw new Error('pr_watch.profile_not_regular_file');
  }
  const raw = readFileSync(profilePath, 'utf-8');
  if (Buffer.byteLength(raw, 'utf-8') > 64 * 1024) {
    throw new Error('pr_watch.profile_too_large');
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new Error(`pr_watch.invalid_profile_yaml: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeProfile(profileSchema.parse(parsed));
}

export function loadEffectivePrWatchProfile(
  repoRoot: string,
  maxPrsOverride?: number,
): {
  readonly profile: PrWatchProfileV1;
  readonly maxPrsSource: PrWatchMaxPrsSource;
} {
  const root = realpathSync(repoRoot);
  const hasRepositoryProfile = existsSync(join(root, PR_WATCH_PROFILE_PATH));
  const loaded = loadPrWatchProfile(root);
  if (maxPrsOverride === undefined) {
    return {
      profile: loaded,
      maxPrsSource: hasRepositoryProfile ? 'repository_profile' : 'default',
    };
  }
  return {
    profile: {
      ...loaded,
      limits: { ...loaded.limits, maxPrs: maxPrsOverride },
    },
    maxPrsSource: 'tool',
  };
}

export function resolvePrWatchPolicy(args: {
  readonly profile: PrWatchProfileV1;
  readonly rulesBaseline: GitHubRulesBaseline;
  readonly confirmationHash?: string;
  readonly maxPrsSource?: PrWatchMaxPrsSource;
}): ResolvedPrWatchPolicyV1 {
  const profile = normalizeProfile(args.profile);
  const maxPrsSource = args.maxPrsSource ?? 'default';
  const baseline: GitHubRulesBaseline = {
    ...args.rulesBaseline,
    requiredChecks: uniqueSorted(args.rulesBaseline.requiredChecks),
  };
  const configured = uniqueSorted(profile.ci.githubChecks.requiredChecks);
  const comparison = {
    mode: profile.ci.githubChecks.mode,
    configured,
    baseline,
  };
  const comparisonHash = sha256Canonical(comparison);
  const confirmed = args.confirmationHash === comparisonHash;

  if (baseline.status !== 'resolved' && !confirmed) {
    throw new PrWatchPolicyConfirmationRequired({
      comparisonHash,
      missingChecks: [],
      reason: 'unresolved_rules',
    });
  }

  let requiredGitHubChecks: readonly string[];
  let allowCheckless = false;
  if (profile.ci.githubChecks.mode === 'github_rules') {
    if (baseline.status !== 'resolved') {
      throw new Error('pr_watch.github_rules_mode_requires_resolved_rules');
    }
    requiredGitHubChecks = baseline.requiredChecks;
  } else if (profile.ci.githubChecks.mode === 'explicit') {
    const missing = baseline.requiredChecks.filter((check) => !configured.includes(check));
    if (missing.length > 0 && !confirmed) {
      throw new PrWatchPolicyConfirmationRequired({
        comparisonHash,
        missingChecks: missing,
        reason: 'weakened_checks',
      });
    }
    requiredGitHubChecks = configured;
  } else {
    if (!confirmed) {
      throw new PrWatchPolicyConfirmationRequired({
        comparisonHash,
        missingChecks: baseline.requiredChecks,
        reason: 'checkless',
      });
    }
    requiredGitHubChecks = [];
    allowCheckless = true;
  }

  const profileHash = sha256Canonical({ profile, maxPrsSource });
  return {
    profile,
    maxPrsSource,
    profileHash,
    rulesBaseline: baseline,
    comparisonHash,
    requiredGitHubChecks,
    allowCheckless,
    policyHash: sha256Canonical({ profileHash, comparisonHash, requiredGitHubChecks, allowCheckless }),
  };
}

export function defaultProfile(): PrWatchProfileV1 {
  return {
    schemaVersion: 1,
    limits: { maxPrs: DEFAULT_PR_WATCH_MAX_PRS },
    ci: {
      githubChecks: { mode: 'github_rules', requiredChecks: [] },
    },
  };
}

function normalizeProfile(value: z.infer<typeof profileSchema> | PrWatchProfileV1): PrWatchProfileV1 {
  if ('schemaVersion' in value) {
    return {
      ...value,
      ci: {
        ...value.ci,
        githubChecks: {
          ...value.ci.githubChecks,
          requiredChecks: uniqueSorted(value.ci.githubChecks.requiredChecks),
        },
        ...(value.ci.circleci
          ? { circleci: {
            ...value.ci.circleci,
            requiredWorkflows: uniqueSorted(value.ci.circleci.requiredWorkflows),
          } }
          : {}),
      },
    };
  }
  return {
    schemaVersion: 1,
    limits: { maxPrs: value.limits.max_prs },
    ci: {
      githubChecks: {
        mode: value.ci.github_checks.mode,
        requiredChecks: uniqueSorted(value.ci.github_checks.required_checks),
      },
      ...(value.ci.circleci
        ? { circleci: {
          ...(value.ci.circleci.project_slug
            ? { projectSlug: value.ci.circleci.project_slug }
            : {}),
          requiredWorkflows: uniqueSorted(value.ci.circleci.required_workflows),
        } }
        : {}),
    },
  };
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
