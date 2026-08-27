import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PrWatchPolicyConfirmationRequired,
  defaultProfile,
  loadEffectivePrWatchProfile,
  loadPrWatchProfile,
  resolvePrWatchPolicy,
} from '../../src/pr-watch/config.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PR-watch repository policy', () => {
  it('loads the canonical schema and rejects unknown keys', () => {
    const repo = tempRepo();
    mkdirSync(join(repo, '.crew'));
    writeFileSync(join(repo, '.crew/pr-watch.yaml'), `
schema_version: 1
limits:
  max_prs: 37
ci:
  github_checks:
    mode: explicit
    required_checks: [unit, lint]
  circleci:
    project_slug: gh/example/repo
    required_workflows: [build, setup]
`);
    expect(loadPrWatchProfile(repo)).toEqual({
      schemaVersion: 1,
      limits: { maxPrs: 37 },
      ci: {
        githubChecks: { mode: 'explicit', requiredChecks: ['lint', 'unit'] },
        circleci: {
          projectSlug: 'gh/example/repo',
          requiredWorkflows: ['build', 'setup'],
        },
      },
    });
    writeFileSync(join(repo, '.crew/pr-watch.yaml'), 'schema_version: 1\nunknown: true\n');
    expect(() => loadPrWatchProfile(repo)).toThrow();
  });

  it('refuses a profile symlink that escapes the repository', () => {
    const repo = tempRepo();
    const outside = mkdtempSync(join(tmpdir(), 'crew-pr-watch-outside-'));
    roots.push(outside);
    mkdirSync(join(repo, '.crew'));
    writeFileSync(join(outside, 'profile.yaml'), 'schema_version: 1\n');
    symlinkSync(join(outside, 'profile.yaml'), join(repo, '.crew/pr-watch.yaml'));
    expect(() => loadPrWatchProfile(repo)).toThrow('profile_symlink_outside_repo');
  });

  it('requires comparison-bound confirmation before weakening rules', () => {
    const profile = {
      ...defaultProfile(),
      ci: { githubChecks: { mode: 'explicit' as const, requiredChecks: ['unit', 'lint'] } },
    };
    const baseline = {
      status: 'resolved' as const,
      requiredChecks: ['unit', 'lint', 'integration-check'],
      provenance: { source: 'ruleset' },
    };
    let required: PrWatchPolicyConfirmationRequired | undefined;
    try {
      resolvePrWatchPolicy({ profile, rulesBaseline: baseline });
    } catch (error) {
      required = error as PrWatchPolicyConfirmationRequired;
    }
    expect(required).toBeInstanceOf(PrWatchPolicyConfirmationRequired);
    expect(required?.missingChecks).toEqual(['integration-check']);
    const resolved = resolvePrWatchPolicy({
      profile,
      rulesBaseline: baseline,
      confirmationHash: required?.comparisonHash,
    });
    expect(resolved.requiredGitHubChecks).toEqual(['lint', 'unit']);
  });

  it('requires explicit confirmation for checkless policy', () => {
    const profile = {
      ...defaultProfile(),
      ci: { githubChecks: { mode: 'none' as const, requiredChecks: [] } },
    };
    const baseline = { status: 'resolved' as const, requiredChecks: [], provenance: {} };
    let required: PrWatchPolicyConfirmationRequired | undefined;
    try {
      resolvePrWatchPolicy({ profile, rulesBaseline: baseline });
    } catch (error) {
      required = error as PrWatchPolicyConfirmationRequired;
    }
    expect(required?.reason).toBe('checkless');
    expect(resolvePrWatchPolicy({
      profile,
      rulesBaseline: baseline,
      confirmationHash: required?.comparisonHash,
    }).allowCheckless).toBe(true);
  });

  it('binds max_prs provenance and uses locale-independent code-unit ordering', () => {
    const repo = tempRepo();
    expect(loadEffectivePrWatchProfile(repo)).toMatchObject({
      maxPrsSource: 'default',
      profile: { limits: { maxPrs: 50 } },
    });
    const overridden = loadEffectivePrWatchProfile(repo, 50);
    expect(overridden.maxPrsSource).toBe('tool');

    const baseline = { status: 'resolved' as const, requiredChecks: ['ä', 'z'], provenance: {} };
    const implicit = resolvePrWatchPolicy({
      profile: defaultProfile(),
      rulesBaseline: baseline,
      maxPrsSource: 'default',
    });
    const explicit = resolvePrWatchPolicy({
      profile: overridden.profile,
      rulesBaseline: baseline,
      maxPrsSource: overridden.maxPrsSource,
    });
    expect(implicit.requiredGitHubChecks).toEqual(['z', 'ä']);
    expect(explicit.profileHash).not.toBe(implicit.profileHash);
  });
});

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'crew-pr-watch-profile-'));
  roots.push(root);
  return root;
}
