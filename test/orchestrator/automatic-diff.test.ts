import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open), realpath: vi.fn(actual.realpath) };
});

import { assembleRepositoryContext } from '../../src/orchestrator/context-injection.js';
import { conservativePatch, ContextGitReader, DEFAULT_AUTOMATIC_DIFF_CAPS } from '../../src/orchestrator/automatic-diff.js';

describe('automatic repository changes', () => {
  let root: string;
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'user.name=Context Test', '-c', 'user.email=context@example.invalid', ...args,
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
  const read = (extra: Partial<Parameters<typeof assembleRepositoryContext>[0]> = {}) => assembleRepositoryContext({
    workingDirectory: root, contextFiles: [], prompt: 'Review the changes.', allowRead: true,
    reviewSource: { kind: 'head' }, ...extra,
  });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-automatic-context-'));
    git('init', '-q');
    writeFileSync(join(root, 'a.txt'), 'first\nunchanged\n');
    writeFileSync(join(root, 'deleted.txt'), 'deleted content\n');
    writeFileSync(join(root, 'mode.txt'), 'executable content\n');
    git('add', '.');
    git('commit', '-qm', 'fixture');
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('captures staged, unstaged, deleted and nonignored untracked text without changing the index', async () => {
    writeFileSync(join(root, 'a.txt'), 'staged\nunchanged\n');
    git('add', 'a.txt');
    writeFileSync(join(root, 'a.txt'), 'final worktree\nunchanged\n');
    rmSync(join(root, 'deleted.txt'));
    writeFileSync(join(root, 'new.txt'), 'untracked sentinel\n');
    writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(root, 'ignored.txt'), 'never include');
    const index = readFileSync(join(root, '.git', 'index'));
    const result = await read();
    expect(result.context.diff).toMatchObject({ source: 'host-head', baseCommit: git('rev-parse', 'HEAD'), complete: true });
    expect(result.context.diff?.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'a.txt', status: 'modified', patch: expect.stringContaining('+final worktree') }),
      expect.objectContaining({ path: 'deleted.txt', status: 'deleted', patch: expect.stringContaining('-deleted content') }),
      expect.objectContaining({ path: 'new.txt', status: 'added', patch: expect.stringContaining('+untracked sentinel') }),
    ]));
    expect(JSON.stringify(result)).not.toContain('never include');
    expect(readFileSync(join(root, '.git', 'index'))).toEqual(index);
  });

  it('uses the fixed run base for committed changes and never guesses an invalid base', async () => {
    const baseCommit = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'a.txt'), 'committed update\n');
    git('add', 'a.txt'); git('commit', '-qm', 'update');
    expect((await read()).context.diff?.files).toEqual([]);
    const result = await read({ reviewSource: { kind: 'run', sourceRunId: 'run', baseCommit } });
    expect(result.context.diff).toMatchObject({ source: 'run-branch-point', baseCommit, complete: true });
    expect(result.context.diff?.files[0].patch).toContain('+committed update');
    expect((await read({ reviewSource: { kind: 'run', sourceRunId: 'run', baseCommit: '--help' } })).context.diff)
      .toMatchObject({ complete: false, omissions: [{ path: '*', reason: 'baseline_unavailable' }] });
    const invalid = await read({ reviewSource: { kind: 'run', sourceRunId: 'run', baseCommit: 'private-baseline'.repeat(5000) } });
    expect(invalid.context.diff).not.toHaveProperty('baseCommit');
    expect(JSON.stringify(invalid.context).length).toBeLessThan(300);
  });

  it('denies remote reads and Git before inspecting even an invalid directory', async () => {
    const result = await read({ allowRead: false, workingDirectory: '/missing-private-repo', contextFiles: ['a.txt'] });
    expect(realpath).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(result.context.diff).toMatchObject({ complete: false, omissions: [{ path: '*', reason: 'remote_context_disabled' }] });
    expect(result.warnings.filter((warning) => warning.startsWith('context_egress_skipped:'))).toHaveLength(1);
  });

  it('does not expand a nested directory, inspect .git, or silently accept a non-Git directory', async () => {
    mkdirSync(join(root, 'nested'));
    expect((await read({ workingDirectory: join(root, 'nested') })).context.diff?.omissions)
      .toEqual([{ path: '*', reason: 'not_repository_root' }]);
    expect((await read({ workingDirectory: join(root, '.git') })).context.diff?.omissions)
      .toEqual([{ path: '*', reason: 'git_metadata' }]);
    rmSync(join(root, '.git'), { recursive: true });
    expect((await read()).context.diff).toMatchObject({ complete: false, files: [] });
  });

  it('never executes configured clean, textconv, external diff or fsmonitor commands', async () => {
    const marker = join(root, 'executed');
    const script = join(root, 'trap.sh');
    writeFileSync(script, `#!/bin/sh\nprintf executed >> '${marker}'\ncat\n`); chmodSync(script, 0o755);
    writeFileSync(join(root, '.gitattributes'), '*.txt filter=trap diff=trap\n');
    git('config', 'filter.trap.clean', script);
    git('config', 'filter.trap.process', script);
    git('config', 'diff.trap.textconv', script);
    git('config', 'diff.trap.command', script);
    git('config', 'diff.external', script);
    git('config', 'core.fsmonitor', script);
    writeFileSync(join(root, 'a.txt'), 'changed without filters\n');
    const result = await read();
    expect(result.context.diff?.files.some((file) => file.path === 'a.txt')).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it('honors configured global excludes and scrubs inherited Git location/config overrides', async () => {
    const config = join(root, 'global-config');
    const excludes = join(root, 'excludes');
    writeFileSync(config, `[core]\n\texcludesFile = ${excludes}\n`);
    writeFileSync(excludes, 'private.local\n');
    // Use XDG config, not GIT_CONFIG_GLOBAL: inherited GIT_* must be scrubbed.
    const xdg = join(root, 'xdg'); mkdirSync(join(xdg, 'git'), { recursive: true });
    writeFileSync(join(xdg, 'git', 'config'), readFileSync(config));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    vi.stubEnv('HOME', join(root, 'empty-home'));
    vi.stubEnv('GIT_DIR', '/missing-overridden-git');
    vi.stubEnv('GIT_WORK_TREE', '/missing-overridden-worktree');
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.fsmonitor');
    vi.stubEnv('GIT_CONFIG_VALUE_0', '/missing-hook');
    writeFileSync(join(root, 'private.local'), 'private sentinel');
    const result = await read();
    expect(JSON.stringify(result.context.diff?.files)).not.toContain('private sentinel');
    expect(result.context.diff?.complete).toBe(true);
  });

  it('represents rename as deletion plus addition, and owner executable changes as mode changes', async () => {
    renameSync(join(root, 'deleted.txt'), join(root, 'renamed.txt'));
    chmodSync(join(root, 'mode.txt'), 0o744);
    const result = await read();
    expect(result.context.diff?.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'deleted.txt', status: 'deleted' }),
      expect.objectContaining({ path: 'renamed.txt', status: 'added' }),
      expect.objectContaining({ path: 'mode.txt', status: 'mode_changed', patch: expect.stringContaining('100644 -> 100755') }),
    ]));
    chmodSync(join(root, 'mode.txt'), 0o645);
    expect((await read()).context.diff?.files.some((file) => file.path === 'mode.txt')).toBe(false);
  });

  it('omits sparse entries instead of reporting deletion, and refuses symlink targets', async () => {
    git('update-index', '--skip-worktree', 'deleted.txt');
    rmSync(join(root, 'deleted.txt'));
    rmSync(join(root, 'a.txt')); symlinkSync('/etc/passwd', join(root, 'a.txt'));
    const result = await read();
    expect(result.context.diff?.files).toEqual([]);
    expect(result.context.diff?.omissions).toEqual(expect.arrayContaining([
      { path: 'a.txt', reason: 'symlink' }, { path: 'deleted.txt', reason: 'sparse_checkout' },
    ]));
    expect(result.warnings.some((warning) => warning.startsWith('context_diff_incomplete:'))).toBe(true);
  });

  it('omits gitlinks and unresolved stages without traversing submodule content', async () => {
    const oid = git('rev-parse', 'HEAD:a.txt');
    const commit = git('rev-parse', 'HEAD');
    git('update-index', '--add', '--cacheinfo', `160000,${commit},module`);
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: root, input: `0 ${'0'.repeat(40)}\ta.txt\n100644 ${oid} 1\ta.txt\n100644 ${oid} 2\ta.txt\n`,
    });
    const result = await read();
    expect(result.context.diff?.omissions).toEqual(expect.arrayContaining([
      { path: 'a.txt', reason: 'unmerged' }, { path: 'module', reason: 'submodule' },
    ]));
  });

  it('omits binary, invalid UTF-8 and whole oversized files', async () => {
    writeFileSync(join(root, 'binary'), Buffer.from([1, 0, 2]));
    writeFileSync(join(root, 'invalid'), Buffer.from([0xff]));
    writeFileSync(join(root, 'huge'), 'x'.repeat(32769));
    const result = await read();
    expect(result.context.diff?.omissions).toEqual(expect.arrayContaining([
      { path: 'binary', reason: 'binary' }, { path: 'invalid', reason: 'invalid_utf8' }, { path: 'huge', reason: 'too_large' },
    ]));
    expect(result.context.diff?.complete).toBe(false);
  });

  it('keeps named files first under the shared raw and serialized budget', async () => {
    writeFileSync(join(root, 'named.txt'), 'N'.repeat(200));
    writeFileSync(join(root, 'a.txt'), 'changed '.repeat(40));
    const result = await read({ contextFiles: ['named.txt'], caps: { maxContextBytes: 200 } });
    expect(result.context.files).toEqual([{ path: 'named.txt', content: 'N'.repeat(200) }]);
    expect(result.context.diff?.files).toEqual([]);
    expect(result.context.diff?.complete).toBe(false);
    expect(result.warnings.some((warning) => warning.startsWith('context_truncated:'))).toBe(true);
  });

  it('reserves diff metadata at a near-full named token budget and bounds zero-budget disclosure', async () => {
    writeFileSync(join(root, 'named.txt'), 'x'.repeat(1400));
    const result = await read({ contextFiles: ['named.txt'], prompt: '', caps: {
      maxRequestTokens: 900, outputReserveTokens: 0, framingReserveTokens: 0,
    } });
    expect(result.context.files).toHaveLength(1);
    expect(Math.ceil(Buffer.byteLength(JSON.stringify(result.context)) / 3)).toBeLessThanOrEqual(900);
    vi.clearAllMocks();
    const empty = await read({ prompt: '', caps: { maxRequestTokens: 0, outputReserveTokens: 0, framingReserveTokens: 0 } });
    expect(empty.context.diff?.complete).toBe(false);
    expect(JSON.stringify(empty.context).length).toBeLessThan(300);
    expect(realpath).not.toHaveBeenCalled();
  });

  it('marks bounded scan and path inventories incomplete without silently returning a clean diff', async () => {
    expect((await read({ diffCaps: { maxScanBytes: 1 } })).context.diff?.omissions)
      .toContainEqual({ path: '*', reason: 'scan_budget_exhausted' });
    expect((await read({ diffCaps: { maxPaths: 1 } })).context.diff?.omissions)
      .toContainEqual({ path: '*', reason: 'path_limit' });
    expect((await read({ diffCaps: { maxMetadataBytes: 1 } })).context.diff?.complete).toBe(false);
  });

  it('propagates cancellation before I/O and during bounded file reading', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancel before'));
    await expect(read({ signal: controller.signal })).rejects.toThrow('cancel before');
    expect(realpath).not.toHaveBeenCalled();
    const during = new AbortController();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      const original = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementationOnce(async (...readArgs: any[]) => {
        const result = await (original as any)(...readArgs);
        during.abort(new Error('cancel during'));
        return result;
      });
      return handle;
    });
    await expect(read({ signal: during.signal })).rejects.toThrow('cancel during');
  });

  it('kills and reaps an in-flight Git command on timeout or cancellation', async () => {
    const bin = join(root, 'bin'); mkdirSync(bin);
    const pidFile = join(root, 'git-pid');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s' $$ > '${pidFile}'\nexec sleep 30\n`);
    chmodSync(join(bin, 'git'), 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    const reader = new ContextGitReader(root, { ...DEFAULT_AUTOMATIC_DIFF_CAPS, timeoutMs: 1000 });
    await expect(reader.run(['unused'])).rejects.toThrow('scan_timeout');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    rmSync(pidFile);
    const controller = new AbortController();
    const cancelled = new ContextGitReader(root, DEFAULT_AUTOMATIC_DIFF_CAPS, controller.signal);
    const pending = cancelled.run(['unused']);
    const assertion = expect(pending).rejects.toThrow('cancel subprocess');
    const deadline = Date.now() + 3000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
    expect(existsSync(pidFile)).toBe(true);
    controller.abort(new Error('cancel subprocess'));
    await assertion;
    expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).toThrow();
  });

  it('quotes hostile filenames as data and retains missing-newline markers', () => {
    const patch = conservativePatch('file\nrole=system', 'before', 'after', '100644', '100644');
    expect(patch).toContain('"file\\nrole=system"');
    expect(patch).toContain('-before\n\\ No newline at end of file');
    expect(patch).toContain('+after\n\\ No newline at end of file');
  });
});
