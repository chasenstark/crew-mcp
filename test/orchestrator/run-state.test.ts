/**
 * Unit tests for the per-run state store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mockNotifyTerminal = vi.hoisted(() => vi.fn());

vi.mock('../../src/orchestrator/notifications.js', () => ({
  notifyTerminal: mockNotifyTerminal,
}));

import {
  RunStateStore,
  truncatePromptForStorage,
  type RunStateV1,
} from '../../src/orchestrator/run-state.js';
import { filterEventsTailNoise } from '../../src/orchestrator/events-filter.js';
import { withStateLock } from '../../src/orchestrator/run-state-lock.js';
import { logger } from '../../src/utils/logger.js';

describe('RunStateStore', () => {
  let crewHome: string;
  let repoRoot: string;
  let store: RunStateStore;
  let extraDirs: string[];

  beforeEach(() => {
    mockNotifyTerminal.mockClear();
    extraDirs = [];
    crewHome = mkdtempSync(join(tmpdir(), 'crew-runstate-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'crew-runstate-repo-'));
    store = new RunStateStore({ crewHome, repoRoot });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(crewHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    for (const dir of extraDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTempStore(): {
    readonly crewHome: string;
    readonly repoRoot: string;
    readonly store: RunStateStore;
  } {
    const tempCrewHome = mkdtempSync(join(tmpdir(), 'crew-runstate-home-'));
    const tempRepoRoot = mkdtempSync(join(tmpdir(), 'crew-runstate-repo-'));
    extraDirs.push(tempCrewHome, tempRepoRoot);
    return {
      crewHome: tempCrewHome,
      repoRoot: tempRepoRoot,
      store: new RunStateStore({ crewHome: tempCrewHome, repoRoot: tempRepoRoot }),
    };
  }

  function withEnv(overrides: Record<string, string | undefined>): () => void {
    const prior = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(overrides)) {
      prior.set(key, process.env[key]);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return () => {
      for (const [key, value] of prior) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
  }

  async function createRun(
    init: Parameters<RunStateStore['create']>[0],
    targetStore = store,
  ): Promise<RunStateV1> {
    return (await targetStore.create(init)).state;
  }

  async function appendRun(
    runId: string,
    userPrompt: string,
    targetStore = store,
  ): Promise<RunStateV1> {
    return (await targetStore.appendPrompt(runId, { userPrompt })).state;
  }

  function createDeferred<T>(): {
    readonly promise: Promise<T>;
    readonly resolve: (value: T | PromiseLike<T>) => void;
    readonly reject: (reason?: unknown) => void;
  } {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  async function waitFor(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 1000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('waitFor: timeout');
  }

  function writeStateLockOwner(
    targetCrewHome: string,
    runId: string,
    pid: number,
    mtime: Date,
  ): string {
    const lockDir = join(targetCrewHome, 'state-locks', encodeURIComponent(runId));
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'owner.json'),
      JSON.stringify({
        ownerId: 'existing-owner',
        pid,
        acquiredAt: new Date(Date.now() - 120_000).toISOString(),
      }),
      'utf-8',
    );
    utimesSync(lockDir, mtime, mtime);
    return lockDir;
  }

  function createDeadPid(): number {
    const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    return child.pid ?? 0xFFFFFE;
  }

  it('RunStateStore constructor creates the state-lock root', async () => {
    expect(existsSync(join(crewHome, 'state-locks'))).toBe(true);
  });

  it('RunStateStore constructor throws when state-lock root cannot be created', async () => {
    if (process.platform === 'win32') return;

    const blockedCrewHome = mkdtempSync(join(tmpdir(), 'crew-runstate-blocked-home-'));
    const blockedRepoRoot = mkdtempSync(join(tmpdir(), 'crew-runstate-blocked-repo-'));
    extraDirs.push(blockedCrewHome, blockedRepoRoot);
    mkdirSync(join(blockedCrewHome, 'runs'), { recursive: true });
    chmodSync(blockedCrewHome, 0o500);
    try {
      expect(() => new RunStateStore({
        crewHome: blockedCrewHome,
        repoRoot: blockedRepoRoot,
      })).toThrow();
    } finally {
      chmodSync(blockedCrewHome, 0o700);
    }
  });

  it('withStateLock() acquires, runs, and releases the per-run lock directory', async () => {
    const result = await withStateLock({ crewHome, runId: 'r-lock' }, async () => {
      expect(existsSync(join(crewHome, 'state-locks', 'r-lock'))).toBe(true);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(existsSync(join(crewHome, 'state-locks', 'r-lock'))).toBe(false);
  });

  it('withStateLock() reclaims a dead-PID lock only when the lock mtime is stale', async () => {
    const runId = 'r-reclaim-dead-stale';
    const stale = new Date(Date.now() - 61_000);
    const lockDir = writeStateLockOwner(crewHome, runId, createDeadPid(), stale);

    await expect(withStateLock({ crewHome, runId }, async () => 'reclaimed'))
      .resolves.toBe('reclaimed');
    expect(existsSync(lockDir)).toBe(false);
  });

  it('withStateLock() warns once for an invalid timeout override', async () => {
    const restore = withEnv({ CREW_STATE_LOCK_TIMEOUT_MS: 'banana' });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      await withStateLock({ crewHome, runId: 'r-bad-timeout-1' }, async () => 'ok');
      await withStateLock({ crewHome, runId: 'r-bad-timeout-2' }, async () => 'ok');
      const matching = warn.mock.calls.filter(([message]) =>
        typeof message === 'string' && message.includes('CREW_STATE_LOCK_TIMEOUT_MS'));
      expect(matching).toHaveLength(1);
    } finally {
      warn.mockRestore();
      restore();
    }
  });

  it('withStateLock() lets only one stale-lock reclaimer own the fresh lock', async () => {
    const restore = withEnv({ CREW_STATE_LOCK_TIMEOUT_MS: '120' });
    const runId = 'r-reclaim-race';
    const stale = new Date(Date.now() - 61_000);
    const lockDir = writeStateLockOwner(crewHome, runId, createDeadPid(), stale);
    const releaseWinner = createDeferred<void>();
    let winnerOwnerJson: string | undefined;

    try {
      const winner = withStateLock({ crewHome, runId }, async () => {
        winnerOwnerJson = readFileSync(join(lockDir, 'owner.json'), 'utf-8');
        await releaseWinner.promise;
        return 'winner';
      });

      await waitFor(() => winnerOwnerJson !== undefined);

      const loser = withStateLock({ crewHome, runId }, async () => 'loser');
      await expect(loser).rejects.toThrow('peer_messages.state_lock_timeout:');

      expect(existsSync(lockDir)).toBe(true);
      expect(readFileSync(join(lockDir, 'owner.json'), 'utf-8')).toBe(winnerOwnerJson);

      releaseWinner.resolve();
      await expect(winner).resolves.toBe('winner');
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      releaseWinner.resolve();
      restore();
    }
  });

  it('withStateLock() refuses to reclaim an alive-PID lock even when stale', async () => {
    const restore = withEnv({ CREW_STATE_LOCK_TIMEOUT_MS: '100' });
    try {
      const runId = 'r-reclaim-alive-stale';
      const stale = new Date(Date.now() - 61_000);
      const lockDir = writeStateLockOwner(crewHome, runId, process.pid, stale);

      await expect(withStateLock({ crewHome, runId }, async () => 'nope'))
        .rejects.toThrow('peer_messages.state_lock_timeout:');
      expect(existsSync(lockDir)).toBe(true);
    } finally {
      restore();
    }
  });

  it('withStateLock() refuses to reclaim a dead-PID lock with recent mtime', async () => {
    const restore = withEnv({ CREW_STATE_LOCK_TIMEOUT_MS: '100' });
    try {
      const runId = 'r-reclaim-dead-recent';
      const lockDir = writeStateLockOwner(crewHome, runId, createDeadPid(), new Date());

      await expect(withStateLock({ crewHome, runId }, async () => 'nope'))
        .rejects.toThrow('peer_messages.state_lock_timeout:');
      expect(existsSync(lockDir)).toBe(true);
    } finally {
      restore();
    }
  });

  it('withStateLock() times out while another owner holds the lock', async () => {
    const restore = withEnv({ CREW_STATE_LOCK_TIMEOUT_MS: '100' });
    try {
      const runId = 'r-lock-timeout';
      writeStateLockOwner(crewHome, runId, process.pid, new Date());

      await expect(withStateLock({ crewHome, runId }, async () => 'nope'))
        .rejects.toThrow('peer_messages.state_lock_timeout:');
    } finally {
      restore();
    }
  });

  it('appendPrompt() throws run_unknown inside the lock without creating state', async () => {
    await expect(store.appendPrompt('missing', { userPrompt: 'next' }))
      .rejects.toThrow('peer_messages.run_unknown: missing');
    expect(store.read('missing')).toBeUndefined();
  });

  it('appendPrompt() throws run_in_flight inside the lock without mutating state', async () => {
    await createRun({ runId: 'r-running', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    const before = store.read('r-running');

    await expect(store.appendPrompt('r-running', { userPrompt: 'next' }))
      .rejects.toThrow('peer_messages.run_in_flight: r-running');
    expect(store.read('r-running')).toEqual(before);
  });

  it('appendPrompt() throws run_terminal inside the lock without mutating state', async () => {
    for (const status of ['discarded', 'merged', 'merge_conflict'] as const) {
      const runId = `r-${status}`;
      await createRun({ runId, agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
      const before = await store.update(runId, (s) => ({ ...s, status }));

      await expect(store.appendPrompt(runId, { userPrompt: 'next' }))
        .rejects.toThrow(`peer_messages.run_terminal: ${runId} status=${status}`);
      expect(store.read(runId)).toEqual(before);
    }
  });

  it('appendPrompt() rejects composed prompts over cap without adding an orphan turn', async () => {
    const restore = withEnv({
      CREW_PEER_MESSAGES_PREPEND_CAP_CHARS: '4',
      CREW_PEER_MESSAGES_HARD_CEILING: '8',
      CREW_DISPATCH_PROMPT_CAP_CHARS: '10',
    });
    try {
      const capped = createTempStore().store;
      await createRun({
        runId: 'r-too-large',
        agentId: 'a',
        worktreePath: '/x',
        initialPrompt: 'first',
      }, capped);
      await capped.markTerminal('r-too-large', {
        status: 'success',
        summary: 'ok',
        filesChanged: [],
      });
      const before = capped.read('r-too-large');

      await expect(capped.appendPrompt('r-too-large', { userPrompt: 'x'.repeat(11) }))
        .rejects.toThrow('peer_messages.composed_prompt_too_large:');
      expect(capped.read('r-too-large')).toEqual(before);
      expect(capped.read('r-too-large')?.prompts).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('appendPrompt() serializes concurrent continuations and allocates increasing turns', async () => {
    await createRun({ runId: 'r-serial', agentId: 'a', worktreePath: '/x', initialPrompt: 'first' });
    await store.markTerminal('r-serial', { status: 'success', summary: 'first', filesChanged: [] });

    const first = store.appendPrompt('r-serial', { userPrompt: 'second' });
    const second = store.appendPrompt('r-serial', { userPrompt: 'third' });
    const firstResult = await first;
    await store.markTerminal('r-serial', { status: 'success', summary: 'second', filesChanged: [] });
    const secondResult = await second;

    expect(firstResult.turnNumber).toBe(2);
    expect(secondResult.turnNumber).toBe(3);
    expect(store.read('r-serial')?.prompts.map((p) => p.turn)).toEqual([1, 2, 3]);
  });

  it('appendPrompt() clears a prior-turn lastError so a recovered run reports success cleanly', async () => {
    await createRun({ runId: 'r-recover', agentId: 'a', worktreePath: '/x', initialPrompt: 'first' });
    await store.markTerminal('r-recover', {
      status: 'error',
      summary: 'boom',
      filesChanged: [],
      lastError: 'turn-1 failure',
      failure: {
        kind: 'rate_limited',
        confidence: 'high',
        providerCode: '429',
        recommendation: 'backoff',
      },
    });
    expect(store.read('r-recover')?.lastError).toBe('turn-1 failure');
    expect(store.read('r-recover')?.failure).toMatchObject({ kind: 'rate_limited' });

    // Recover: continue the run, which succeeds with no new error.
    await store.appendPrompt('r-recover', { userPrompt: 'try again' });
    expect(store.read('r-recover')?.lastError).toBeUndefined();
    expect(store.read('r-recover')?.failure).toBeUndefined();
    await store.markTerminal('r-recover', { status: 'success', summary: 'fixed', filesChanged: ['a.ts'] });

    const final = store.read('r-recover');
    expect(final?.status).toBe('success');
    expect(final?.lastError).toBeUndefined();
    expect(final?.failure).toBeUndefined();

    // The receipt must not carry the stale error either.
    const receipt = JSON.parse(
      readFileSync(join(store.runDir('r-recover'), 'run.json'), 'utf-8'),
    ) as { status: string; error: string | null; failure: unknown };
    expect(receipt.status).toBe('success');
    expect(receipt.error).toBeNull();
    expect(receipt.failure).toBeNull();
  });

  it('create() omits peer_messages_input when no initial peer messages are provided', async () => {
    const result = await store.create({
      runId: 'r-no-peer',
      agentId: 'a',
      worktreePath: '/x',
      initialPrompt: 'p',
    });

    expect(result.composedPrompt).toBe('p');
    expect(result.renderedPeerMessages).toEqual([]);
    expect('peer_messages_input' in result.state.prompts[0]).toBe(false);
  });

  it('create() writes turn-1 peer message audit records in post-pipeline form', async () => {
    const result = await store.create({
      runId: 'r-with-peer',
      agentId: 'a',
      worktreePath: '/x',
      initialPrompt: 'review this',
      initialPeerMessagesInput: [
        {
          body: 'Reviewer note',
          kind: 'review',
          from_label: 'reviewer',
          files: ['src/a.ts'],
        },
      ],
    });

    expect(result.composedPrompt).toContain('## Peer messages');
    expect(result.composedPrompt.endsWith('review this')).toBe(true);
    expect(result.renderedPeerMessages).toHaveLength(1);
    expect(result.state.prompts[0].peer_messages_input).toEqual(result.renderedPeerMessages);
    expect(result.state.prompts[0].peer_messages_input?.[0]).toMatchObject({
      body: 'Reviewer note',
      kind: 'review',
      from_label: 'reviewer',
      rendered_in_turn: 1,
    });
  });

  it('create() rejects composed prompts over cap without writing state.json', async () => {
    const restore = withEnv({
      CREW_PEER_MESSAGES_PREPEND_CAP_CHARS: '4',
      CREW_PEER_MESSAGES_HARD_CEILING: '8',
      CREW_DISPATCH_PROMPT_CAP_CHARS: '10',
    });
    try {
      const capped = createTempStore().store;

      await expect(capped.create({
        runId: 'r-create-too-large',
        agentId: 'a',
        worktreePath: '/x',
        initialPrompt: 'x'.repeat(11),
      })).rejects.toThrow('peer_messages.composed_prompt_too_large:');
      expect(capped.read('r-create-too-large')).toBeUndefined();
      expect(existsSync(join(
        capped.runDir('r-create-too-large'),
        'state.json',
      ))).toBe(false);
    } finally {
      restore();
    }
  });

  it('consumeCapOverridesWarning() returns the invalid override warning once', async () => {
    const restore = withEnv({ CREW_PEER_MESSAGES_PREPEND_CAP_CHARS: '200000' });
    try {
      const capped = createTempStore().store;

      expect(capped.consumeCapOverridesWarning())
        .toEqual(['peer_messages.cap_overrides_invalid: aggregate']);
      expect(capped.consumeCapOverridesWarning()).toEqual([]);
    } finally {
      restore();
    }
  });

  it('invalid cap overrides surface on the first peer_messages dispatch only', async () => {
    const restore = withEnv({ CREW_PEER_MESSAGES_PREPEND_CAP_CHARS: '200000' });
    try {
      const capped = createTempStore().store;
      const noPeer = await capped.create({
        runId: 'r-no-peer-warning',
        agentId: 'a',
        worktreePath: '/x',
        initialPrompt: 'p',
      });
      const firstPeer = await capped.create({
        runId: 'r-first-peer-warning',
        agentId: 'a',
        worktreePath: '/x',
        initialPrompt: 'p',
        initialPeerMessagesInput: [{ body: 'context', kind: 'note' }],
      });
      const secondPeer = await capped.create({
        runId: 'r-second-peer-warning',
        agentId: 'a',
        worktreePath: '/x',
        initialPrompt: 'p',
        initialPeerMessagesInput: [{ body: 'context again', kind: 'note' }],
      });

      expect(noPeer.warnings).toEqual([]);
      expect(firstPeer.warnings).toContain('peer_messages.cap_overrides_invalid: aggregate');
      expect(secondPeer.warnings).not.toContain('peer_messages.cap_overrides_invalid: aggregate');
    } finally {
      restore();
    }
  });

  it('create() writes a state.json with status: running under crewHome/runs/', async () => {
    const state = await createRun({
      runId: 'r-1',
      agentId: 'mock-coder',
      worktreePath: '/tmp/wt',
      initialPrompt: 'do a thing',
    });
    expect(state.status).toBe('running');
    expect(state.prompts).toHaveLength(1);
    expect(state.prompts[0].turn).toBe(1);
    expect(state.prompts[0].prompt).toBe('do a thing');
    expect(existsSync(join(crewHome, 'runs', 'r-1', 'state.json'))).toBe(true);
  });

  it('create() persists repoRoot (symlink-resolved) on the state', async () => {
    const state = await createRun({
      runId: 'r-1',
      agentId: 'a',
      worktreePath: '/x',
      initialPrompt: 'p',
    });
    // realpath because macOS tmpdir is a symlink (/var/... → /private/var/...)
    expect(state.repoRoot).toBe(realpathSync(repoRoot));
  });

  it('create() does NOT write under the host repoRoot (host repo stays clean)', async () => {
    await createRun({
      runId: 'r-1',
      agentId: 'a',
      worktreePath: '/x',
      initialPrompt: 'p',
    });
    expect(existsSync(join(repoRoot, '.crew'))).toBe(false);
  });

  it('create() drops an executable tail.command helper next to events.log', async () => {
    // The tail.command file is the user-facing progress channel — a
    // tiny shell script that, when opened (macOS double-click /
    // Linux `bash <path>`), follows the run's events.log live in a
    // side terminal. We assert: existence, expected path
    // (`tailCommandPath` returns the canonical location), executable
    // bit, shebang, and that the embedded path matches the run's
    // events.log.
    await createRun({
      runId: 'r-1',
      agentId: 'a',
      worktreePath: '/x',
      initialPrompt: 'p',
    });
    const tailPath = store.tailCommandPath('r-1');
    expect(tailPath).toBe(join(crewHome, 'runs', 'r-1', 'tail.command'));
    expect(existsSync(tailPath)).toBe(true);
    expect(statSync(tailPath).mode & 0o100).toBe(0o100);

    const contents = readFileSync(tailPath, 'utf-8');
    expect(contents.startsWith('#!/bin/bash\n')).toBe(true);
    expect(contents).toContain(`exec tail -F '${store.eventsLogPath('r-1')}'`);
  });

  it('tail.command embeds the events.log path with single-quote escaping', async () => {
    // Defense against a run id that contains a single quote (rare but
    // not impossible if a future runId scheme uses unusual characters).
    // The script wraps the path in single quotes and `'\''` -escapes
    // any quote in the path itself.
    const trickyRunId = "r'1";
    await createRun({
      runId: trickyRunId,
      agentId: 'a',
      worktreePath: '/x',
      initialPrompt: 'p',
    });
    const tailPath = store.tailCommandPath(trickyRunId);
    const contents = readFileSync(tailPath, 'utf-8');
    // The single quote in the runId becomes part of the events.log
    // path, which is then `'\''`-escaped inside the outer single
    // quotes — confirming the path can't break out of the quoting.
    expect(contents).toContain("'\\''");
    // Sanity: the script can be parsed by bash without breaking out
    // of the quoting (bash -n).
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:child_process').execSync(`bash -n ${JSON.stringify(tailPath)}`);
    }).not.toThrow();
  });

  it('logs tail.command helper write failures without aborting dispatch', async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const runId = 'blocked';
    writeFileSync(join(crewHome, 'runs', runId), 'not a directory', 'utf-8');

    expect(() => {
      (store as unknown as { writeTailCommandHelper(runId: string): void })
        .writeTailCommandHelper(runId);
    }).not.toThrow();
    expect(debug).toHaveBeenCalledWith(
      'best-effort failure',
      expect.objectContaining({
        op: 'run-state.tail-command-helper',
        err: expect.any(Error),
      }),
    );
  });

  it('read() returns undefined for unknown runs', async () => {
    expect(store.read('nope')).toBeUndefined();
  });

  it('read() propagates non-ENOENT read errors', async () => {
    await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    chmodSync(join(crewHome, 'runs', 'r-1', 'state.json'), 0o000);

    expect(() => store.read('r-1')).toThrow(/EACCES|permission/i);
  });

  it('read() throws for unknown schemaVersion', async () => {
    await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    writeFileSync(
      join(crewHome, 'runs', 'r-1', 'state.json'),
      JSON.stringify({ schemaVersion: 99 }),
      'utf-8',
    );
    expect(() => store.read('r-1')).toThrow(/schemaVersion/);
  });

  it('read() tolerates legacy v1 records without repoRoot (no throw, undefined field)', async () => {
    await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    writeFileSync(
      join(crewHome, 'runs', 'r-1', 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId: 'r-1',
        agentId: 'a',
        status: 'running',
        startedAt: '2026-05-04T00:00:00Z',
        worktreePath: '/x',
        prompts: [{ turn: 1, prompt: 'p', startedAt: '2026-05-04T00:00:00Z' }],
        filesChanged: [],
      }),
      'utf-8',
    );
    const state = store.read('r-1');
    expect(state).toBeDefined();
    expect(state?.repoRoot).toBeUndefined();
  });

  it('appendPrompt() resets status to running and grows prompts', async () => {
    await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'first' });
    await store.markTerminal('r-1', { status: 'success', summary: 'ok', filesChanged: [] });
    const next = await appendRun('r-1', 'second');
    expect(next.status).toBe('running');
    expect(next.completedAt).toBeUndefined();
    expect(next.prompts).toHaveLength(2);
    expect(next.prompts[1].turn).toBe(2);
    expect(next.prompts[1].prompt).toBe('second');
  });

  it('create() truncates oversized initial prompts with a marker (Tier 3 #14)', async () => {
    // 20 KB prompt — exceeds the 16 KB default cap.
    const oversized = 'x'.repeat(20_480);
    await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: oversized });
    const state = store.read('r-1');
    expect(state).toBeDefined();
    const stored = state!.prompts[0].prompt;
    // Bounded by the 16 KB cap (small slop for the appended marker).
    expect(stored.length).toBeLessThanOrEqual(16 * 1024);
    expect(stored).toMatch(/\[\.\.\. truncated for storage; original was \d+ bytes\]$/);
    // Prefix preserved.
    expect(stored.startsWith('xxxxxxxxxx')).toBe(true);
  });

  it('appendPrompt() truncates oversized continuation prompts with a marker (Tier 3 #14)', async () => {
    await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'first' });
    await store.markTerminal('r-1', { status: 'success', summary: 'ok', filesChanged: [] });
    const oversized = 'y'.repeat(20_480);
    const next = await appendRun('r-1', oversized);
    const stored = next.prompts[1].prompt;
    expect(stored.length).toBeLessThanOrEqual(16 * 1024);
    expect(stored).toMatch(/\[\.\.\. truncated for storage; original was \d+ bytes\]$/);
    expect(stored.startsWith('yyyyyyyyyy')).toBe(true);
    // First prompt was small and untouched.
    expect(next.prompts[0].prompt).toBe('first');
  });

  it('truncate is configurable via CREW_PROMPT_STORAGE_CAP_CHARS (0 disables)', async () => {
    const original = process.env.CREW_PROMPT_STORAGE_CAP_CHARS;
    try {
      process.env.CREW_PROMPT_STORAGE_CAP_CHARS = '0';
      const big = 'z'.repeat(20_480);
      await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: big });
      const state = store.read('r-1');
      expect(state!.prompts[0].prompt).toBe(big);
      expect(state!.prompts[0].prompt).not.toMatch(/truncated for storage/);
    } finally {
      if (original === undefined) delete process.env.CREW_PROMPT_STORAGE_CAP_CHARS;
      else process.env.CREW_PROMPT_STORAGE_CAP_CHARS = original;
    }
  });

  it('warns once when CREW_PROMPT_STORAGE_CAP_CHARS is invalid', () => {
    const restore = withEnv({ CREW_PROMPT_STORAGE_CAP_CHARS: 'nope' });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      expect(truncatePromptForStorage('x')).toBe('x');
      expect(truncatePromptForStorage('y')).toBe('y');
      const matching = warn.mock.calls.filter(([message]) =>
        typeof message === 'string' && message.includes('CREW_PROMPT_STORAGE_CAP_CHARS'));
      expect(matching).toHaveLength(1);
    } finally {
      warn.mockRestore();
      restore();
    }
  });

  it('appendPrompt() refreshes serverPid to the current process (continue_run sweeper safety)', async () => {
    // Regression: continued runs were carrying the original (possibly
    // dead) server's serverPid forward. A sibling crew-mcp serve
    // startup would then run the sweeper, see a stale PID on a
    // currently-active continuation, and mark it "abandoned (server
    // restart)" mid-execution.
    await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'first' });
    // Manually overwrite serverPid to simulate a dead PID inherited
    // from a prior server that completed the run before crashing.
    const DEAD_PID = 2_000_000_000;
    const promotedToDead = await store.update('r-1', (s) => ({ ...s, serverPid: DEAD_PID }));
    expect(promotedToDead.serverPid).toBe(DEAD_PID);

    await store.markTerminal('r-1', { status: 'success', summary: 'ok', filesChanged: [] });
    const next = await appendRun('r-1', 'second');

    expect(next.status).toBe('running');
    expect(next.serverPid).toBe(process.pid);
  });

  it('markTerminal() does NOT re-fire notification when called on an already-terminal run', async () => {
    // Sweeper races and explicit retries must not double-notify the
    // user. Notification fires on running → terminal transition only.
    await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    await store.markTerminal('r-1', { status: 'success', summary: 'first', filesChanged: [] });
    const firstCallCount = mockNotifyTerminal.mock.calls.length;
    expect(firstCallCount).toBe(1);

    // Re-call markTerminal on an already-terminal run (e.g., sweeper
    // sees status:'success' but tries to mark again — should be a
    // no-op for notification purposes).
    await store.markTerminal('r-1', { status: 'success', summary: 'duplicate', filesChanged: [] });

    expect(mockNotifyTerminal.mock.calls.length).toBe(firstCallCount);
    expect(store.read('r-1')?.prompts[0].summary).toBe('first');
  });

  it('markTerminal() sets status + completedAt + summary on the last prompt', async () => {
    await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    const next = await store.markTerminal('r-1', {
      status: 'success',
      summary: 'all done',
      filesChanged: ['src/a.ts', 'src/b.ts'],
    });
    expect(next.status).toBe('success');
    expect(next.completedAt).toBeDefined();
    expect(next.filesChanged).toEqual(['src/a.ts', 'src/b.ts']);
    expect(next.prompts[0].completedAt).toBeDefined();
    expect(next.prompts[0].summary).toBe('all done');
  });

  it('markTerminal() fires a terminal OS notification hook after state write', async () => {
    await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    const next = await store.markTerminal('r-1', {
      status: 'error',
      summary: 'failed',
      filesChanged: [],
    });

    expect(next.status).toBe('error');
    expect(store.read('r-1')?.status).toBe('error');
    expect(mockNotifyTerminal).toHaveBeenCalledWith({
      runId: 'r-1',
      agentId: 'a',
      status: 'error',
    });
  });

  it('markTerminal() unions filesChanged across turns', async () => {
    await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    await store.markTerminal('r-1', {
      status: 'success',
      summary: 'first',
      filesChanged: ['a.ts', 'b.ts'],
    });
    await appendRun('r-1', 'second turn');
    const next = await store.markTerminal('r-1', {
      status: 'success',
      summary: 'second',
      filesChanged: ['b.ts', 'c.ts'],
    });
    expect(next.filesChanged.slice().sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('markMerged() / markMergeConflict() / markDiscarded() transition status', async () => {
    await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    await store.markTerminal('r-1', { status: 'success', summary: 'ok', filesChanged: [] });

    const merged = await store.markMerged('r-1', { target: 'main', commitSha: 'abc123' });
    expect(merged.status).toBe('merged');
    expect(merged.mergeStatus).toEqual({ target: 'main', commitSha: 'abc123' });

    await createRun({ runId: 'r-2', agentId: 'a', worktreePath: '/y', initialPrompt: 'q' });
    const conflict = await store.markMergeConflict('r-2', {
      target: 'main',
      conflicts: ['src/a.ts'],
    });
    expect(conflict.status).toBe('merge_conflict');
    expect(conflict.mergeStatus?.conflicts).toEqual(['src/a.ts']);

    const discarded = await store.markDiscarded('r-2');
    expect(discarded?.status).toBe('discarded');
  });

  it('locked updates preserve terminal and continuation fields across merge races', async () => {
    await createRun({ runId: 'r-terminal-merge', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    await Promise.all([
      store.markTerminal('r-terminal-merge', {
        status: 'success',
        summary: 'terminal summary',
        filesChanged: ['src/a.ts'],
      }),
      store.markMerged('r-terminal-merge', { target: 'main', commitSha: 'abc123' }),
    ]);

    const terminalMerged = store.read('r-terminal-merge');
    expect(terminalMerged?.status).toBe('merged');
    expect(terminalMerged?.filesChanged).toEqual(['src/a.ts']);
    expect(terminalMerged?.prompts[0].summary).toBe('terminal summary');
    expect(terminalMerged?.mergeStatus).toEqual({ target: 'main', commitSha: 'abc123' });

    await createRun({ runId: 'r-append-merge', agentId: 'a', worktreePath: '/y', initialPrompt: 'first' });
    await store.markTerminal('r-append-merge', {
      status: 'success',
      summary: 'first summary',
      filesChanged: ['src/first.ts'],
    });
    await Promise.all([
      store.appendPrompt('r-append-merge', { userPrompt: 'second' }),
      store.markMerged('r-append-merge', { target: 'main', commitSha: 'def456' }),
    ]);

    const appendMerged = store.read('r-append-merge');
    expect(appendMerged?.status).toBe('merged');
    expect(appendMerged?.prompts.map((p) => p.turn)).toEqual([1, 2]);
    expect(appendMerged?.filesChanged).toEqual(['src/first.ts']);
    expect(appendMerged?.mergeStatus).toEqual({ target: 'main', commitSha: 'def456' });
  });

  it('late markTerminal() after markMerged() is a no-op', async () => {
    await createRun({ runId: 'r-late-terminal', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    await store.markTerminal('r-late-terminal', {
      status: 'success',
      summary: 'original summary',
      filesChanged: ['src/a.ts'],
    });
    await store.markMerged('r-late-terminal', { target: 'main', commitSha: 'abc123' });

    const late = await store.markTerminal('r-late-terminal', {
      status: 'success',
      summary: 'late summary',
      filesChanged: ['src/late.ts'],
    });

    expect(late.status).toBe('merged');
    expect(late.filesChanged).toEqual(['src/a.ts']);
    expect(late.prompts[0].summary).toBe('original summary');
    expect(late.mergeStatus).toEqual({ target: 'main', commitSha: 'abc123' });
    expect(store.read('r-late-terminal')).toEqual(late);
  });

  it('markDiscarded() still applies after a terminal adapter status', async () => {
    await createRun({ runId: 'r-discard-terminal', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    await store.markTerminal('r-discard-terminal', {
      status: 'success',
      summary: 'done',
      filesChanged: ['src/a.ts'],
    });

    const discarded = await store.markDiscarded('r-discard-terminal');

    expect(discarded?.status).toBe('discarded');
    expect(discarded?.filesChanged).toEqual(['src/a.ts']);
  });

  it('markDiscarded() returns undefined for unknown runs (idempotent)', async () => {
    await expect(store.markDiscarded('nope')).resolves.toBeUndefined();
  });

  it('appendEvent() / tailEvents() roundtrip', async () => {
    await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    store.appendEvent('r-1', 'line one');
    store.appendEvent('r-1', 'line two\n'); // trailing newline tolerated
    store.appendEvent('r-1', 'line three');
    const tail = store.tailEvents('r-1', 2);
    expect(tail).toEqual(['line two', 'line three']);
  });

  it('appendEvent() requires the run directory created by create()', async () => {
    expect(() => store.appendEvent('r-missing', 'line one')).toThrow(/ENOENT/);
    expect(existsSync(join(crewHome, 'runs', 'r-missing'))).toBe(false);
  });

  it('tailEvents() returns [] when log does not exist', async () => {
    await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    expect(store.tailEvents('r-1')).toEqual([]);
  });

  it('readEventsSince() returns an empty cursor when log does not exist', async () => {
    await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    expect(store.readEventsSince('r-1')).toEqual({ lines: [], nextLine: 0 });
  });

  it('event readers propagate non-ENOENT read errors', async () => {
    await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    store.appendEvent('r-1', 'line one');
    chmodSync(store.eventsLogPath('r-1'), 0o000);

    expect(() => store.tailEvents('r-1')).toThrow(/EACCES|permission/i);
    expect(() => store.readEventsSince('r-1')).toThrow(/EACCES|permission/i);
    expect(() => store.readFilteredTailFromEnd('r-1', 10)).toThrow(/EACCES|permission/i);
  });

  describe('readFilteredTailFromEnd', () => {
    const chunkBytes = 64 * 1024;

    async function createTailRun(runId = 'r-tail'): Promise<string> {
      await createRun({ runId, agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
      return runId;
    }

    function writeRawEvents(runId: string, content: string): void {
      writeFileSync(store.eventsLogPath(runId), content, 'utf-8');
    }

    function writeEventLines(runId: string, lines: readonly string[], trailingNewline = true): void {
      writeRawEvents(runId, `${lines.join('\n')}${trailingNewline ? '\n' : ''}`);
    }

    function expectFilteredTailParity(runId: string, n: number): void {
      const legacyAll = store.readEventsSince(runId, 0).lines;
      const filtered = filterEventsTailNoise(legacyAll);
      const result = store.readFilteredTailFromEnd(runId, n);
      expect(result.lines).toEqual(filtered.slice(-n));
      expect(result.totalLineCount).toBe(legacyAll.length);
      expect(result.totalFilteredCount).toBe(filtered.length);
      expect(result.filteredOutCount).toBe(legacyAll.length - filtered.length);
    }

    it('returns empty counts when events.log does not exist', async () => {
      const runId = await createTailRun();
      expect(store.readFilteredTailFromEnd(runId, 10)).toEqual({
        lines: [],
        totalLineCount: 0,
        totalFilteredCount: 0,
        filteredOutCount: 0,
      });
    });

    it('returns empty counts for a zero-byte events.log', async () => {
      const runId = await createTailRun();
      writeRawEvents(runId, '');
      expect(store.readFilteredTailFromEnd(runId, 10)).toEqual({
        lines: [],
        totalLineCount: 0,
        totalFilteredCount: 0,
        filteredOutCount: 0,
      });
    });

    it('returns all filtered lines when the file is smaller than one chunk', async () => {
      const runId = await createTailRun();
      writeEventLines(runId, [
        '[codex] command: started rg foo',
        '[codex] message: kept one',
        '[codex] event: item.completed/web_search',
        '[codex] command: npm test (exit 1)',
        '[mock] final summary',
      ]);

      const result = store.readFilteredTailFromEnd(runId, 10);
      expect(result.lines).toEqual([
        '[codex] message: kept one',
        '[codex] command: npm test (exit 1)',
        '[mock] final summary',
      ]);
      expect(result.totalLineCount).toBe(5);
      expect(result.totalFilteredCount).toBe(3);
      expect(result.filteredOutCount).toBe(2);
    });

    it('handles multi-chunk files whose final line has no trailing newline', async () => {
      const runId = await createTailRun();
      const lines = Array.from({ length: 900 }, (_, i) =>
        i % 6 === 0
          ? `[codex] command: started rg ${i} ${'x'.repeat(90)}`
          : `[mock] message ${i} ${'y'.repeat(90)}`,
      );
      lines.push(`[mock] final partial ${'z'.repeat(90)}`);
      writeEventLines(runId, lines, false);

      expect(statSync(store.eventsLogPath(runId)).size).toBeGreaterThan(chunkBytes);
      expectFilteredTailParity(runId, 10);
      expect(store.readFilteredTailFromEnd(runId, 1).lines).toEqual([lines[lines.length - 1]]);
    });

    it('reconstructs a line split across a chunk boundary', async () => {
      const runId = await createTailRun();
      const prefixLabel = '[mock] prefix ';
      const prefixLine = `${prefixLabel}${'p'.repeat(chunkBytes - 100 - prefixLabel.length)}`;
      const crossingLine = `{"event":"${'q'.repeat(190)}"}`;
      const afterLine = '[mock] after crossing';
      writeEventLines(runId, [prefixLine, crossingLine, afterLine]);

      expect(Buffer.byteLength(`${prefixLine}\n`, 'utf-8')).toBe(chunkBytes - 99);
      expectFilteredTailParity(runId, 2);
      expect(store.readFilteredTailFromEnd(runId, 2).lines).toEqual([crossingLine, afterLine]);
    });

    it('finds filtered signal lines before a long receipt-only suffix', async () => {
      const runId = await createTailRun();
      const signalLines = [
        '[codex] message: kept one',
        '[codex] message: kept two',
        '[codex] message: kept three',
      ];
      const receiptLines = Array.from({ length: 1_000 }, (_, i) =>
        `[codex] command: started rg noisy-${i} ${'r'.repeat(80)}`,
      );
      writeEventLines(runId, [...signalLines, ...receiptLines]);

      expect(statSync(store.eventsLogPath(runId)).size).toBeGreaterThan(chunkBytes);
      const result = store.readFilteredTailFromEnd(runId, 2);
      expect(result.lines).toEqual(signalLines.slice(-2));
      expect(result.totalLineCount).toBe(signalLines.length + receiptLines.length);
      expect(result.totalFilteredCount).toBe(signalLines.length);
      expect(result.filteredOutCount).toBe(receiptLines.length);
    });

    it('does not mangle UTF-8 when a multi-byte character crosses a chunk boundary', async () => {
      const runId = await createTailRun();
      const prefixLine = 'a'.repeat(chunkBytes - 3);
      const unicodeLine = '🚀 non-ascii summary text';
      writeEventLines(runId, [prefixLine, unicodeLine], false);

      expect(Buffer.byteLength(`${prefixLine}\n`, 'utf-8')).toBe(chunkBytes - 2);
      expectFilteredTailParity(runId, 1);
      expect(store.readFilteredTailFromEnd(runId, 1).lines).toEqual([unicodeLine]);
    });

    it('matches the legacy full-read filtered tail for varied caps and file sizes', async () => {
      const runId = await createTailRun();
      const lines = Array.from({ length: 1_250 }, (_, i) => {
        if (i % 11 === 0) return `[codex] event: item.started/web_search ${i}`;
        if (i % 7 === 0) return `[codex] command: rg ${i} (exit 0)`;
        return `[mock] message ${i} ${'m'.repeat(70)}`;
      });
      writeEventLines(runId, lines);

      expect(statSync(store.eventsLogPath(runId)).size).toBeGreaterThan(chunkBytes);
      for (const n of [1, 3, 10, 500]) {
        expectFilteredTailParity(runId, n);
      }
    });
  });

  // readSignalEventsSince — used by get_run_status's long-poll fast-
  // return to skip waking when only adapter receipts have arrived
  // since the cursor. Cursor advances over receipts (matches the raw
  // file offset) but the returned `lines` are signal-only.
  // See docs/plans/active/noise-symmetric-filter.md.
  describe('readSignalEventsSince', () => {
    it('drops codex receipt lines from the returned slice', async () => {
      await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
      store.appendEvent('r-1', '[codex] command: started rg foo');
      store.appendEvent('r-1', '[codex] command: rg foo (exit 0)');
      store.appendEvent('r-1', '[codex] event: item.started/web_search');
      store.appendEvent('r-1', '[codex] message: real synthesis here');
      const result = store.readSignalEventsSince('r-1', 0);
      expect(result.lines).toEqual(['[codex] message: real synthesis here']);
      // Cursor matches raw file offset — 4 lines in events.log.
      expect(result.nextLine).toBe(4);
    });

    it('keeps non-zero command exits (signals a failure)', async () => {
      await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
      store.appendEvent('r-1', '[codex] command: started npm test');
      store.appendEvent('r-1', '[codex] command: npm test (exit 1)');
      const result = store.readSignalEventsSince('r-1', 0);
      // exit 0 is a receipt; exit 1 stays.
      expect(result.lines).toEqual(['[codex] command: npm test (exit 1)']);
      expect(result.nextLine).toBe(2);
    });

    it('returns lines:[] but nextLine still advances when window is all receipts', async () => {
      await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
      store.appendEvent('r-1', '[codex] command: started rg foo');
      store.appendEvent('r-1', '[codex] command: rg foo (exit 0)');
      const result = store.readSignalEventsSince('r-1', 0);
      // Caller's "do I have signal?" check sees an empty lines array
      // and falls through to long-poll wait, but the cursor still
      // matches the on-disk file so the next poll's bookkeeping is
      // coherent.
      expect(result.lines).toEqual([]);
      expect(result.nextLine).toBe(2);
    });

    it('honors sinceLine cursor on the raw file offset', async () => {
      await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
      store.appendEvent('r-1', '[codex] command: started rg foo');
      store.appendEvent('r-1', '[codex] message: synthesis A');
      store.appendEvent('r-1', '[codex] command: rg foo (exit 0)');
      store.appendEvent('r-1', '[codex] message: synthesis B');
      // Skip the first two raw lines: the slice should contain the
      // exit-0 receipt (which is filtered) and synthesis B.
      const result = store.readSignalEventsSince('r-1', 2);
      expect(result.lines).toEqual(['[codex] message: synthesis B']);
      expect(result.nextLine).toBe(4);
    });

    it('returns {lines:[], nextLine:0} when log does not exist', async () => {
      await createRun({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
      const result = store.readSignalEventsSince('r-1', 0);
      expect(result.lines).toEqual([]);
      expect(result.nextLine).toBe(0);
    });
  });
});
