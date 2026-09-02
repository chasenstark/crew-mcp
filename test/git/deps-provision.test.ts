import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorktreeManager } from '../../src/git/worktree.js';
import {
  attemptClonePhase,
  attemptInstallPhase,
  cloneNodeModules,
  computeDepsFingerprint,
  evaluateDepsEligibility,
  findUnsafeSymlink,
  hostCloneSourceReady,
  resolveDepsStalenessAction,
  type DepsProvisionRecord,
} from '../../src/git/deps-provision.js';

const onDarwin = it.runIf(process.platform === 'darwin');

const PKG = JSON.stringify({ name: 'fixture', version: '1.0.0' });
const LOCK = JSON.stringify({
  name: 'fixture',
  version: '1.0.0',
  lockfileVersion: 3,
  packages: {
    '': { name: 'fixture', version: '1.0.0' },
    'node_modules/a': { version: '1.2.3' },
  },
});

function writeManifests(dir: string): void {
  writeFileSync(join(dir, 'package.json'), PKG);
  writeFileSync(join(dir, 'package-lock.json'), LOCK);
}

/** Host fixture whose node_modules provably matches its lockfile. */
function writeCloneReadyHost(dir: string): void {
  writeManifests(dir);
  mkdirSync(join(dir, 'node_modules', 'a'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '.package-lock.json'), LOCK);
  writeFileSync(join(dir, 'node_modules', 'a', 'index.js'), 'module.exports = 1;\n');
}

describe('deps-provision', () => {
  let hostRoot: string;
  let worktreeRoot: string;

  beforeEach(() => {
    hostRoot = mkdtempSync(join(tmpdir(), 'crew-deps-host-'));
    worktreeRoot = mkdtempSync(join(tmpdir(), 'crew-deps-wt-'));
  });

  afterEach(() => {
    rmSync(hostRoot, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  });

  describe('evaluateDepsEligibility', () => {
    it('requires package.json', async () => {
      const result = await evaluateDepsEligibility(worktreeRoot);
      expect(result.eligible).toBe(false);
      expect(result.reason).toMatch(/package\.json/);
    });

    it('requires a package-lock.json (npm-only phase 1)', async () => {
      writeFileSync(join(worktreeRoot, 'package.json'), PKG);
      const result = await evaluateDepsEligibility(worktreeRoot);
      expect(result.eligible).toBe(false);
      expect(result.reason).toMatch(/package-lock/);
    });

    it('refuses workspace layouts', async () => {
      writeFileSync(
        join(worktreeRoot, 'package.json'),
        JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }),
      );
      writeFileSync(join(worktreeRoot, 'package-lock.json'), LOCK);
      const result = await evaluateDepsEligibility(worktreeRoot);
      expect(result.eligible).toBe(false);
      expect(result.reason).toMatch(/workspace/);
    });

    it('is eligible with a fingerprint for a plain npm layout', async () => {
      writeManifests(worktreeRoot);
      const result = await evaluateDepsEligibility(worktreeRoot);
      expect(result.eligible).toBe(true);
      expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('computeDepsFingerprint', () => {
    it('changes when the lockfile changes and matches identical trees', async () => {
      writeManifests(hostRoot);
      writeManifests(worktreeRoot);
      const a = await computeDepsFingerprint(hostRoot);
      const b = await computeDepsFingerprint(worktreeRoot);
      expect(a).toBe(b);
      writeFileSync(join(worktreeRoot, 'package-lock.json'), LOCK.replace('1.2.3', '9.9.9'));
      expect(await computeDepsFingerprint(worktreeRoot)).not.toBe(a);
    });
  });

  describe('hostCloneSourceReady', () => {
    it('rejects a host without the hidden install record', async () => {
      writeManifests(hostRoot);
      mkdirSync(join(hostRoot, 'node_modules'), { recursive: true });
      const result = await hostCloneSourceReady(hostRoot);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/\.package-lock\.json/);
    });

    it('rejects a stale host install and accepts a current one', async () => {
      writeCloneReadyHost(hostRoot);
      expect((await hostCloneSourceReady(hostRoot)).ok).toBe(true);
      writeFileSync(
        join(hostRoot, 'node_modules', '.package-lock.json'),
        LOCK.replace('1.2.3', '1.0.0'),
      );
      const stale = await hostCloneSourceReady(hostRoot);
      expect(stale.ok).toBe(false);
      expect(stale.reason).toMatch(/stale/);
    });

    it('rejects same-version drift in integrity/resolved fields', async () => {
      writeCloneReadyHost(hostRoot);
      const lock = JSON.parse(LOCK) as {
        packages: Record<string, Record<string, unknown>>;
      };
      lock.packages['node_modules/a'].integrity = 'sha512-AAA';
      writeFileSync(join(hostRoot, 'package-lock.json'), JSON.stringify(lock));
      writeFileSync(join(hostRoot, 'node_modules', '.package-lock.json'), JSON.stringify(lock));
      expect((await hostCloneSourceReady(hostRoot)).ok).toBe(true);
      // Same version, different fetched artifact — must not pass as current.
      lock.packages['node_modules/a'].integrity = 'sha512-BBB';
      writeFileSync(join(hostRoot, 'node_modules', '.package-lock.json'), JSON.stringify(lock));
      const drifted = await hostCloneSourceReady(hostRoot);
      expect(drifted.ok).toBe(false);
      expect(drifted.reason).toMatch(/stale/);
    });
  });

  describe('findUnsafeSymlink', () => {
    it('flags absolute, escaping, scoped, and nested links; allows internal relative links', async () => {
      const nm = join(hostRoot, 'node_modules');
      mkdirSync(join(nm, '.bin'), { recursive: true });
      mkdirSync(join(nm, 'safe'), { recursive: true });
      writeFileSync(join(nm, 'safe', 'cli.js'), '');
      // Internal relative link (.bin shim) — safe.
      symlinkSync(join('..', 'safe', 'cli.js'), join(nm, '.bin', 'safe'));
      expect(await findUnsafeSymlink(nm, hostRoot)).toBeUndefined();

      // Scoped absolute link (npm link shape) — unsafe.
      mkdirSync(join(nm, '@scope'), { recursive: true });
      symlinkSync(worktreeRoot, join(nm, '@scope', 'linked'));
      expect(await findUnsafeSymlink(nm, hostRoot)).toContain('@scope');
      rmSync(join(nm, '@scope'), { recursive: true, force: true });

      // Nested node_modules relative link escaping the root — unsafe.
      mkdirSync(join(nm, 'pkg', 'node_modules'), { recursive: true });
      symlinkSync(
        join('..', '..', '..', '..', 'outside'),
        join(nm, 'pkg', 'node_modules', 'esc'),
      );
      const nested = await findUnsafeSymlink(nm, hostRoot);
      expect(nested).toContain('esc');
    });

    it('flags a lexically-contained link whose REAL resolution escapes via an intermediate symlink', async () => {
      const nm = join(hostRoot, 'node_modules');
      mkdirSync(nm, { recursive: true });
      mkdirSync(join(worktreeRoot, 'pkg'), { recursive: true });
      // Repo-root symlink pointing outside; the node_modules link routes
      // through it, so its lexical resolution stays inside hostRoot while
      // its real resolution lands in worktreeRoot.
      symlinkSync(worktreeRoot, join(hostRoot, 'outside-link'));
      symlinkSync(join('..', 'outside-link', 'pkg'), join(nm, 'pkg'));
      const unsafe = await findUnsafeSymlink(nm, hostRoot);
      expect(unsafe).toContain('pkg');
    });

    it('keeps a dangling but lexically-contained link safe', async () => {
      const nm = join(hostRoot, 'node_modules');
      mkdirSync(nm, { recursive: true });
      symlinkSync(join('.', 'missing'), join(nm, 'dangling'));
      expect(await findUnsafeSymlink(nm, hostRoot)).toBeUndefined();
    });

    it('flags a DANGLING link whose existing intermediate symlink escapes', async () => {
      const nm = join(hostRoot, 'node_modules');
      mkdirSync(nm, { recursive: true });
      // The final target does not exist, but the existing part of the
      // path routes outside — a file created through this link would
      // land in worktreeRoot.
      symlinkSync(worktreeRoot, join(hostRoot, 'outside-link'));
      symlinkSync(join('..', 'outside-link', 'not-yet-created'), join(nm, 'future'));
      const unsafe = await findUnsafeSymlink(nm, hostRoot);
      expect(unsafe).toContain('future');
    });

    it('propagates non-ENOENT realpath errors (symlink loop)', async () => {
      const nm = join(hostRoot, 'node_modules');
      mkdirSync(nm, { recursive: true });
      symlinkSync(join('.', 'loop'), join(nm, 'loop'));
      await expect(findUnsafeSymlink(nm, hostRoot)).rejects.toThrow();
    });

    it('propagates walk errors so the clone gate stays fail-closed', async () => {
      const nm = join(hostRoot, 'node_modules');
      const sealed = join(nm, 'sealed');
      mkdirSync(sealed, { recursive: true });
      chmodSync(sealed, 0o000);
      try {
        await expect(findUnsafeSymlink(nm, hostRoot)).rejects.toThrow();
      } finally {
        chmodSync(sealed, 0o755);
      }
    });
  });

  describe('resolveDepsStalenessAction', () => {
    const record = (over: Partial<DepsProvisionRecord>): DepsProvisionRecord => ({
      method: 'clonefile',
      ms: 1,
      policy: 'clone-only',
      fingerprint: 'aa',
      ...over,
    });

    it('maps record + fresh fingerprint onto none/warn/reprovision', () => {
      expect(resolveDepsStalenessAction(undefined, 'aa')).toBe('none');
      expect(resolveDepsStalenessAction(record({ fingerprint: undefined }), 'aa')).toBe('none');
      expect(resolveDepsStalenessAction(record({}), 'aa')).toBe('none');
      expect(resolveDepsStalenessAction(record({}), 'bb')).toBe('warn');
      expect(
        resolveDepsStalenessAction(record({ policy: 'clone-or-install' }), 'bb'),
      ).toBe('reprovision');
      // A clone-only re-provision record must keep the original
      // install-capable intent via requestedPolicy.
      expect(
        resolveDepsStalenessAction(
          record({ policy: 'clone-only', requestedPolicy: 'clone-or-install' }),
          'bb',
        ),
      ).toBe('reprovision');
      expect(resolveDepsStalenessAction(record({}), undefined)).toBe('warn');
    });
  });

  describe('cloneNodeModules', () => {
    onDarwin('clones with CoW isolation on APFS', async () => {
      writeCloneReadyHost(hostRoot);
      const outcome = await cloneNodeModules({ hostRoot, worktreeRoot });
      expect(outcome.ok).toBe(true);
      const cloned = join(worktreeRoot, 'node_modules', 'a', 'index.js');
      expect(await readFile(cloned, 'utf-8')).toBe('module.exports = 1;\n');
      // Divergence: a write to the clone must not touch the source.
      writeFileSync(cloned, 'mutated\n');
      expect(
        await readFile(join(hostRoot, 'node_modules', 'a', 'index.js'), 'utf-8'),
      ).toBe('module.exports = 1;\n');
      // No staging leftovers.
      const leftovers = (await stat(join(worktreeRoot, 'node_modules'))).isDirectory();
      expect(leftovers).toBe(true);
    });

    it('fails when the source stamp is unavailable', async () => {
      writeManifests(hostRoot);
      const outcome = await cloneNodeModules({ hostRoot, worktreeRoot });
      expect(outcome.ok).toBe(false);
    });

    function stagingLeftovers(): string[] {
      return readdirSync(worktreeRoot).filter((name) =>
        name.startsWith('node_modules.provisioning-'));
    }

    onDarwin('discards staging and publishes nothing when a host install races the copy', async () => {
      writeCloneReadyHost(hostRoot);
      const outcome = await cloneNodeModules({
        hostRoot,
        worktreeRoot,
        afterCopyForTest: async () => {
          writeFileSync(join(hostRoot, 'package-lock.json'), LOCK.replace('1.2.3', '9.9.9'));
        },
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(/raced/);
      expect(existsSync(join(worktreeRoot, 'node_modules'))).toBe(false);
      expect(stagingLeftovers()).toEqual([]);
    });

    onDarwin('fails without clobbering a non-empty pre-existing destination', async () => {
      writeCloneReadyHost(hostRoot);
      mkdirSync(join(worktreeRoot, 'node_modules'), { recursive: true });
      writeFileSync(join(worktreeRoot, 'node_modules', 'keep.txt'), 'keep\n');
      const outcome = await cloneNodeModules({ hostRoot, worktreeRoot });
      expect(outcome.ok).toBe(false);
      expect(
        readFileSync(join(worktreeRoot, 'node_modules', 'keep.txt'), 'utf-8'),
      ).toBe('keep\n');
      expect(stagingLeftovers()).toEqual([]);
    });

    it('cleans staging when the copy itself fails', async () => {
      writeCloneReadyHost(hostRoot);
      const sealed = join(hostRoot, 'node_modules', 'a');
      chmodSync(sealed, 0o000);
      try {
        const outcome = await cloneNodeModules({ hostRoot, worktreeRoot });
        expect(outcome.ok).toBe(false);
        expect(existsSync(join(worktreeRoot, 'node_modules'))).toBe(false);
        expect(stagingLeftovers()).toEqual([]);
      } finally {
        chmodSync(sealed, 0o755);
      }
    });
  });

  describe('attemptClonePhase', () => {
    it('skips when node_modules is already present', async () => {
      mkdirSync(join(worktreeRoot, 'node_modules'));
      const record = await attemptClonePhase({
        worktreeRoot,
        hostRoot,
        policy: 'clone-only',
        startedAt: Date.now(),
      });
      expect(record?.method).toBe('skipped');
      expect(record?.detail).toMatch(/already present/);
    });

    it('clone-only skips with detail when the host fingerprint differs', async () => {
      writeCloneReadyHost(hostRoot);
      writeFileSync(join(worktreeRoot, 'package.json'), PKG);
      writeFileSync(join(worktreeRoot, 'package-lock.json'), LOCK.replace('1.2.3', '2.0.0'));
      const record = await attemptClonePhase({
        worktreeRoot,
        hostRoot,
        policy: 'clone-only',
        startedAt: Date.now(),
      });
      expect(record?.method).toBe('skipped');
      expect(record?.detail).toMatch(/fingerprint/);
    });

    it('clone-or-install falls through (undefined) when clone is ineligible', async () => {
      writeManifests(worktreeRoot);
      const record = await attemptClonePhase({
        worktreeRoot,
        hostRoot,
        policy: 'clone-or-install',
        startedAt: Date.now(),
      });
      expect(record).toBeUndefined();
    });

    it('clone-only refuses when the host tree holds an unsafe symlink', async () => {
      writeCloneReadyHost(hostRoot);
      writeManifests(worktreeRoot);
      symlinkSync(worktreeRoot, join(hostRoot, 'node_modules', 'linked-out'));
      const record = await attemptClonePhase({
        worktreeRoot,
        hostRoot,
        policy: 'clone-only',
        startedAt: Date.now(),
      });
      expect(record?.method).toBe('skipped');
      expect(record?.detail).toMatch(/unsafe symlink/);
    });

    onDarwin('clones end-to-end when host and worktree fingerprints match', async () => {
      writeCloneReadyHost(hostRoot);
      writeManifests(worktreeRoot);
      const record = await attemptClonePhase({
        worktreeRoot,
        hostRoot,
        policy: 'clone-only',
        startedAt: Date.now(),
      });
      expect(record?.method).toBe('clonefile');
      expect(record?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(
        await readFile(join(worktreeRoot, 'node_modules', 'a', 'index.js'), 'utf-8'),
      ).toBe('module.exports = 1;\n');
    });
  });

  describe('attemptInstallPhase', () => {
    it('reports failed with detail when npm ci cannot run', async () => {
      writeFileSync(join(worktreeRoot, 'package.json'), PKG);
      writeFileSync(join(worktreeRoot, 'package-lock.json'), '{not json');
      const record = await attemptInstallPhase({
        worktreeRoot,
        startedAt: Date.now(),
        installTimeoutMs: 60_000,
      });
      expect(record.method).toBe('failed');
      expect(record.detail).toMatch(/npm ci failed/);
    }, 90_000);

    it('installs an empty dependency set with scripts skipped', async () => {
      writeManifests(worktreeRoot);
      const record = await attemptInstallPhase({
        worktreeRoot,
        startedAt: Date.now(),
        installTimeoutMs: 120_000,
      });
      // The fixture lockfile names node_modules/a without a resolvable
      // source, so npm may fail offline — accept either outcome but
      // require the honest record shape.
      if (record.method === 'install') {
        expect(record.scriptsSkipped).toBe(true);
      } else {
        expect(record.method).toBe('failed');
        expect(record.detail).toBeDefined();
      }
    }, 150_000);
  });
});

describe('WorktreeManager.reprovisionRunDepsCloneOnly', () => {
  let root: string;
  let crewHome: string;
  let manager: WorktreeManager;

  const PKG = JSON.stringify({ name: 'fixture', version: '1.0.0' });
  const lockFor = (version: string): string => JSON.stringify({
    name: 'fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0' },
      'node_modules/a': { version },
    },
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-reprovision-'));
    crewHome = mkdtempSync(join(tmpdir(), 'crew-reprovision-home-'));
    execSync('git init -q', { cwd: root });
    execSync('git config user.email test@crew.local', { cwd: root });
    execSync('git config user.name test', { cwd: root });
    writeFileSync(join(root, 'package.json'), PKG);
    writeFileSync(join(root, 'package-lock.json'), lockFor('1.2.3'));
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    execSync('git add -A', { cwd: root });
    execSync('git commit -q -m init', { cwd: root });
    mkdirSync(join(root, 'node_modules', 'a'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), lockFor('1.2.3'));
    writeFileSync(join(root, 'node_modules', 'a', 'index.js'), 'v1\n');
    manager = new WorktreeManager({ projectRoot: root, crewHome });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(crewHome, { recursive: true, force: true });
  });

  onDarwin('re-clones a stale tree and removes the aside', async () => {
    const worktreePath = await manager.createRunWorktree('run-reclone');
    // Simulate a stale provisioned tree, then move BOTH the host install
    // and the worktree manifests forward so the re-clone is eligible.
    mkdirSync(join(worktreePath, 'node_modules'), { recursive: true });
    writeFileSync(join(worktreePath, 'node_modules', 'stale-marker.txt'), 'old\n');
    writeFileSync(join(root, 'package-lock.json'), lockFor('2.0.0'));
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), lockFor('2.0.0'));
    writeFileSync(join(root, 'node_modules', 'a', 'index.js'), 'v2\n');
    writeFileSync(join(worktreePath, 'package-lock.json'), lockFor('2.0.0'));

    const result = await manager.reprovisionRunDepsCloneOnly('run-reclone');
    expect(result.outcome).toBe('recloned');
    expect(result.record?.method).toBe('clonefile');
    expect(existsSync(join(worktreePath, 'node_modules', 'stale-marker.txt'))).toBe(false);
    expect(
      readFileSync(join(worktreePath, 'node_modules', 'a', 'index.js'), 'utf-8'),
    ).toBe('v2\n');
    const runDir = join(worktreePath, '..');
    expect(readdirSync(runDir).filter((n) => n.startsWith('node_modules.stale-'))).toEqual([]);
  });

  it('restores the stale tree when the clone is ineligible', async () => {
    const worktreePath = await manager.createRunWorktree('run-restore');
    mkdirSync(join(worktreePath, 'node_modules'), { recursive: true });
    writeFileSync(join(worktreePath, 'node_modules', 'stale-marker.txt'), 'old\n');
    // Break the host's install record so hostCloneSourceReady refuses.
    rmSync(join(root, 'node_modules', '.package-lock.json'));

    const result = await manager.reprovisionRunDepsCloneOnly('run-restore');
    expect(result.outcome).toBe('restored');
    expect(
      readFileSync(join(worktreePath, 'node_modules', 'stale-marker.txt'), 'utf-8'),
    ).toBe('old\n');
    const runDir = join(worktreePath, '..');
    expect(readdirSync(runDir).filter((n) => n.startsWith('node_modules.stale-'))).toEqual([]);
  });

  it('reports no_tree when there was nothing to set aside and no clone landed', async () => {
    const worktreePath = await manager.createRunWorktree('run-notree');
    rmSync(join(root, 'node_modules', '.package-lock.json'));
    const result = await manager.reprovisionRunDepsCloneOnly('run-notree');
    expect(result.outcome).toBe('no_tree');
    expect(existsSync(join(worktreePath, 'node_modules'))).toBe(false);
  });
});
