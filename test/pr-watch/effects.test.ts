import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { git } from '../../src/pr-watch/action-worktree.js';
import { githubEffectCommandSpec } from '../../src/pr-watch/github-effects.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('typed PR-watch effect commands', () => {
  it('builds only the scoped comment, reply, and thread-resolution forms', () => {
    expect(githubEffectCommandSpec({
      repository: 'example/repo',
      kind: 'post_pr_comment',
      target: { pr: 42 },
      body: 'body',
      marker: '<!-- crew-pr-watch-effect:abc -->',
    }).args).toEqual([
      'pr', 'comment', '42', '--repo', 'example/repo',
      '--body', 'body\n\n<!-- crew-pr-watch-effect:abc -->',
    ]);
    expect(githubEffectCommandSpec({
      repository: 'example/repo',
      kind: 'reply_review_comment',
      target: { pr: 42, comment_id: 99 },
      body: 'reply',
      marker: '<!-- crew-pr-watch-effect:def -->',
    }).args).toEqual([
      'api', '--method', 'POST',
      'repos/example/repo/pulls/42/comments/99/replies',
      '-f', 'body=reply\n\n<!-- crew-pr-watch-effect:def -->',
    ]);
    const resolution = githubEffectCommandSpec({
      repository: 'example/repo',
      kind: 'resolve_review_thread',
      target: { thread_id: 'PRRT_test' },
      marker: '<!-- crew-pr-watch-effect:ghi -->',
    });
    expect(resolution.args[0]).toBe('api');
    expect(resolution.args).toContain('query=mutation CrewPrWatchResolve($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }');
    expect(resolution.args).toContain('id=PRRT_test');
  });

  it('rejects missing or malformed typed targets before a provider spawn', () => {
    expect(() => githubEffectCommandSpec({
      repository: 'example/repo',
      kind: 'reply_review_comment',
      target: { comment_id: 99 },
      marker: '<!-- crew-pr-watch-effect:def -->',
    })).toThrow('pr_watch.invalid_effect_target_pr');
    expect(() => githubEffectCommandSpec({
      repository: '../repo',
      kind: 'post_pr_comment',
      target: { pr: 1 },
      marker: '<!-- crew-pr-watch-effect:def -->',
    })).toThrow('pr_watch.invalid_repository');
    expect(() => githubEffectCommandSpec({
      repository: 'example/repo',
      kind: 'resolve_review_thread',
      target: { thread_id: 'bad\nvalue' },
      marker: '<!-- crew-pr-watch-effect:def -->',
    })).toThrow('pr_watch.invalid_effect_target_thread_id');
  });

  it.each(['--force', '--force-with-lease', '--mirror', '--delete'])(
    'rejects forbidden git mutation flag %s before spawning git',
    async (flag) => {
      const cwd = mkdtempSync(join(tmpdir(), 'crew-pr-watch-effect-git-'));
      roots.push(cwd);
      await expect(git(cwd, ['push', flag, 'origin', 'abc:refs/heads/feature']))
        .rejects.toThrow('pr_watch.forbidden_git_mutation_flag');
    },
  );
});
