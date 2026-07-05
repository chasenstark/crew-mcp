/**
 * End-to-end coverage for the `ephemeral_review` lifecycle (Phase 1, solo):
 * dispatch surface validation, worktree acquisition, filesModified
 * suppression, retention + discard/merge behavior, frozen-snapshot
 * continues, adapter capability parity, and read-surface wording.
 * Runs entirely against isolated temp repos + CREW_HOMEs.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentAdapter, Task, TaskResult } from '../../../src/adapters/types.js';
import { resolveReviewDispatchMode } from '../../../src/adapters/types.js';
import { createBuiltinRegistry } from '../../../src/adapters/registry.js';
import {
  dispatchRunAgentInternal,
  DispatchError,
} from '../../../src/orchestrator/dispatch-run-agent-internal.js';
import { RUN_RECEIPT_FILENAME, RUN_SUMMARY_FILENAME } from '../../../src/orchestrator/receipts.js';
import { continueRunToolHandler, CONTINUE_RUN_DESCRIPTION } from '../../../src/orchestrator/tools/continue-run.js';
import { discardRunToolHandler } from '../../../src/orchestrator/tools/discard-run.js';
import { mergeRunToolHandler } from '../../../src/orchestrator/tools/merge-run.js';
import {
  ephemeralReviewEscapedWriteNotice,
  ephemeralReviewUnsupportedMessage,
  ephemeralReviewWriteNotice,
  ephemeralWorkingDirectoryRejectMessage,
  readOnlyRejectMessage,
  RUN_AGENT_DESCRIPTION,
} from '../../../src/orchestrator/tools/run-agent.js';
import type { ToolHandlerDeps, ToolRequestExtra } from '../../../src/orchestrator/tools/shared.js';
import {
  makeHarness,
  makeMockAdapter,
  waitFor,
  type PanelHarness,
} from './panel-test-harness.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function harnessWith(adapters: AgentAdapter[]): PanelHarness {
  const h = makeHarness(adapters);
  cleanups.push(h.cleanup);
  return h;
}

/** An agy-shaped adapter: rejects read-only, reviews via ephemeral worktree. */
function makeEphemeralAdapter(
  overrides?: Partial<AgentAdapter> & { name?: string },
): AgentAdapter {
  return makeMockAdapter({
    name: 'agy',
    enforcesReadOnly: false,
    rejectsReadOnly: true,
    requiresCrewWorktree: true,
    reviewDispatchMode: 'ephemeral-worktree',
    ...overrides,
  });
}

function depsFor(h: PanelHarness): ToolHandlerDeps {
  return {
    registry: h.ctx.registry as ToolHandlerDeps['registry'],
    worktreeManager: h.worktreeManager,
    runStateStore: h.runStateStore,
    dispatcher: h.dispatcher,
    crewHome: h.crewHome,
    projectRoot: h.root,
    getClientKind: () => 'codex',
    getCrewWaitCommand: () => 'crew-wait',
    progressTokenSeen: { presentLogged: false, absentLogged: false },
    readAgentPrefs: () => ({}),
  };
}

const extra: ToolRequestExtra = {
  sendNotification: async () => undefined,
};

async function dispatchEphemeral(
  h: PanelHarness,
  input: Record<string, unknown> = {},
): Promise<{ runId: string; worktreePath: string }> {
  const result = await dispatchRunAgentInternal({
    input: {
      agent_id: 'agy',
      prompt: 'review my changes',
      run_mode: 'ephemeral_review',
      ...input,
    } as never,
    ctx: h.ctx,
  });
  return { runId: result.runId, worktreePath: result.worktreePath };
}

async function awaitTerminal(h: PanelHarness, runId: string): Promise<void> {
  await waitFor(() => h.runStateStore.read(runId)?.status !== 'running');
}

describe('ephemeral_review — dispatch surface', () => {
  it('dispatches, allocates an owned worktree, and persists runMode + the readOnly shim', async () => {
    const seen: Task[] = [];
    const h = harnessWith([
      makeEphemeralAdapter({
        execute: async (task) => {
          seen.push(task);
          return { output: 'findings: fine', filesModified: [], status: 'success', metadata: {} };
        },
      }),
    ]);
    // Host uncommitted change — must be visible inside the review snapshot.
    writeFileSync(join(h.root, 'wip.txt'), 'uncommitted work\n', 'utf-8');

    const { runId, worktreePath } = await dispatchEphemeral(h);
    await awaitTerminal(h, runId);

    const state = h.runStateStore.read(runId);
    expect(state?.status).toBe('success');
    expect(state?.runMode).toBe('ephemeral_review');
    // Legacy shim = !isMergeable → persisted true so old servers refuse merge.
    expect(state?.readOnly).toBe(true);

    // Owned worktree, distinct from the host repo, seeded with host dirty state.
    expect(worktreePath).not.toBe(h.root);
    expect(existsSync(worktreePath)).toBe(true);
    expect(readFileSync(join(worktreePath, 'wip.txt'), 'utf-8')).toBe('uncommitted work\n');

    // The adapter ran INSIDE the disposable worktree, write-capable, with
    // review intent threaded (never sandbox:'read-only', which agy hard-errors on).
    expect(seen).toHaveLength(1);
    expect(seen[0].context.workingDirectory).toBe(worktreePath);
    expect(seen[0].constraints?.sandbox).toBe('workspace-write');
    expect(seen[0].constraints?.reviewIntent).toBe(true);
  });

  it('write dispatches do NOT carry reviewIntent', async () => {
    const seen: Task[] = [];
    const h = harnessWith([
      makeMockAdapter({
        name: 'codex',
        execute: async (task) => {
          seen.push(task);
          return { output: 'ok', filesModified: [], status: 'success', metadata: {} };
        },
      }),
    ]);
    const result = await dispatchRunAgentInternal({
      input: { agent_id: 'codex', prompt: 'implement' } as never,
      ctx: h.ctx,
    });
    await awaitTerminal(h, result.runId);
    expect(seen[0].constraints?.reviewIntent).toBeUndefined();
    expect(h.runStateStore.read(result.runId)?.runMode).toBe('write');
    expect(h.runStateStore.read(result.runId)?.readOnly).toBeUndefined();
  });

  it('read_only:true on an ephemeral-capable rejecting adapter redirects to run_mode ephemeral_review', async () => {
    const adapter = makeEphemeralAdapter();
    const h = harnessWith([adapter]);
    await expect(
      dispatchRunAgentInternal({
        input: { agent_id: 'agy', prompt: 'review', read_only: true } as never,
        ctx: h.ctx,
      }),
    ).rejects.toThrow(/run_mode: 'ephemeral_review'/);
    // The non-capable variant keeps the codex/host routing text.
    expect(readOnlyRejectMessage('other')).toContain('real sandbox (codex)');
    expect(readOnlyRejectMessage('agy', adapter)).toContain("run_mode: 'ephemeral_review'");
  });

  it('rejects a conflicting run_mode + read_only pair loudly', async () => {
    const h = harnessWith([makeEphemeralAdapter()]);
    await expect(
      dispatchRunAgentInternal({
        input: {
          agent_id: 'agy',
          prompt: 'review',
          run_mode: 'ephemeral_review',
          read_only: true,
        } as never,
        ctx: h.ctx,
      }),
    ).rejects.toThrow(/conflicting mode inputs/);
  });

  it('rejects a caller-supplied working_directory for ephemeral_review', async () => {
    const h = harnessWith([makeEphemeralAdapter()]);
    await expect(
      dispatchEphemeral(h, { working_directory: '/somewhere/else' }),
    ).rejects.toThrow(
      new DispatchError(ephemeralWorkingDirectoryRejectMessage('agy', '/somewhere/else')).message,
    );
  });

  it('rejects ephemeral_review for adapters without the ephemeral-worktree capability', async () => {
    const h = harnessWith([makeMockAdapter({ name: 'codex' })]);
    await expect(
      dispatchRunAgentInternal({
        input: { agent_id: 'codex', prompt: 'review', run_mode: 'ephemeral_review' } as never,
        ctx: h.ctx,
      }),
    ).rejects.toThrow(ephemeralReviewUnsupportedMessage('codex').slice(0, 60));
  });
});

describe('ephemeral_review — filesModified suppression', () => {
  for (const status of ['success', 'partial', 'error'] as const) {
    it(`suppresses filesModified and lists no paths on ${status}`, async () => {
      const h = harnessWith([
        makeEphemeralAdapter({
          execute: async (task) => {
            // The reviewer misbehaves: writes into its disposable worktree AND
            // claims the file in its result.
            writeFileSync(
              join(task.context.workingDirectory, 'stray-review-edit.txt'),
              'oops\n',
              'utf-8',
            );
            return {
              output: 'findings',
              filesModified: ['stray-review-edit.txt'],
              status,
              metadata: {},
            };
          },
        }),
      ]);
      const { runId } = await dispatchEphemeral(h);
      await awaitTerminal(h, runId);

      const state = h.runStateStore.read(runId);
      expect(state?.status).toBe(status);
      // Suppressed at the data layer BEFORE terminal persistence.
      expect(state?.filesChanged).toEqual([]);
      // Exactly one pathless advisory; the path must never leak.
      const warnings = state?.warnings ?? [];
      expect(warnings).toContain(ephemeralReviewWriteNotice());
      expect(warnings.join('\n')).not.toContain('stray-review-edit');
    });
  }

  it('distinguishes ESCAPED writes: adapter claims filesModified but the worktree is clean', async () => {
    const h = harnessWith([
      makeEphemeralAdapter({
        // Claims a write in its result WITHOUT touching the worktree — the
        // write went somewhere outside the snapshot (scratch-dir shape). The
        // containment notice would be false reassurance here.
        execute: async () => ({
          output: 'findings',
          filesModified: ['ghost.txt'],
          status: 'success',
          metadata: {},
        }),
      }),
    ]);
    const { runId } = await dispatchEphemeral(h);
    await awaitTerminal(h, runId);

    const state = h.runStateStore.read(runId);
    expect(state?.filesChanged).toEqual([]);
    const warnings = state?.warnings ?? [];
    expect(warnings).toContain(ephemeralReviewEscapedWriteNotice());
    expect(warnings).not.toContain(ephemeralReviewWriteNotice());
    expect(warnings.join('\n')).not.toContain('ghost.txt');
  });

  it('emits NO write notice when the reviewer kept its hands off', async () => {
    const h = harnessWith([makeEphemeralAdapter()]);
    // Pre-existing host dirt is mirrored into the worktree at allocation and
    // must NOT false-positive the write notice.
    writeFileSync(join(h.root, 'dirty-before.txt'), 'host wip\n', 'utf-8');
    const { runId } = await dispatchEphemeral(h);
    await awaitTerminal(h, runId);
    const state = h.runStateStore.read(runId);
    expect(state?.filesChanged).toEqual([]);
    expect(state?.warnings ?? []).not.toContain(ephemeralReviewWriteNotice());
  });
});

describe('ephemeral_review — retention, discard, merge', () => {
  it('retains the worktree on terminal (no auto-discard), removes it on discard, idempotently', async () => {
    const h = harnessWith([makeEphemeralAdapter()]);
    const { runId, worktreePath } = await dispatchEphemeral(h);
    await awaitTerminal(h, runId);

    // Retained: terminal status is success (never silently 'discarded') and
    // the worktree survives for conversational follow-ups.
    expect(h.runStateStore.read(runId)?.status).toBe('success');
    expect(existsSync(worktreePath)).toBe(true);

    // discard_run is what disposes the snapshot — worktree removal happens
    // because ephemeral_review OWNS its worktree (resolver, not readOnly).
    const first = await discardRunToolHandler({ run_id: runId }, depsFor(h));
    expect(first.isError).not.toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
    expect(h.runStateStore.read(runId)?.status).toBe('discarded');

    const second = await discardRunToolHandler({ run_id: runId }, depsFor(h));
    expect(second.isError).not.toBe(true);
  });

  it('merge_run refuses an ephemeral review permanently, with the ephemeral message', async () => {
    const h = harnessWith([makeEphemeralAdapter()]);
    const { runId, worktreePath } = await dispatchEphemeral(h);
    await awaitTerminal(h, runId);

    const out = await mergeRunToolHandler({ run_id: runId, confirmed: true }, depsFor(h));
    expect(out.isError).toBe(true);
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain('ephemeral review');
    expect(text).toContain('NEVER mergeable');
    // Refusal must not have touched the retained worktree.
    expect(existsSync(worktreePath)).toBe(true);
    expect(h.runStateStore.read(runId)?.status).toBe('success');
  });

  it('writes receipts that name the mode and never list suppressed paths', async () => {
    const h = harnessWith([
      makeEphemeralAdapter({
        execute: async (task) => {
          writeFileSync(join(task.context.workingDirectory, 'stray.txt'), 'x\n', 'utf-8');
          return { output: 'findings', filesModified: [], status: 'success', metadata: {} };
        },
      }),
    ]);
    const { runId } = await dispatchEphemeral(h);
    await awaitTerminal(h, runId);

    const runDir = h.runStateStore.runDir(runId);
    const receipt = JSON.parse(readFileSync(join(runDir, RUN_RECEIPT_FILENAME), 'utf-8'));
    expect(receipt.runMode).toBe('ephemeral_review');
    expect(receipt.readOnly).toBe(true);
    expect(receipt.filesChanged).toEqual([]);

    const summary = readFileSync(join(runDir, RUN_SUMMARY_FILENAME), 'utf-8');
    expect(summary).toContain('**Mode:** ephemeral review');
    expect(summary).not.toContain('stray.txt');
  });
});

describe('ephemeral_review — frozen-snapshot continue', () => {
  it('continue_run succeeds against the FROZEN snapshot and stays non-mergeable', async () => {
    const h = harnessWith([makeEphemeralAdapter()]);
    writeFileSync(join(h.root, 'reviewed.txt'), 'v1\n', 'utf-8');
    const { runId, worktreePath } = await dispatchEphemeral(h);
    await awaitTerminal(h, runId);

    // The host moves on AFTER the review snapshot was taken...
    writeFileSync(join(h.root, 'reviewed.txt'), 'v2 — newer than the review\n', 'utf-8');
    writeFileSync(join(h.root, 'brand-new.txt'), 'appeared after review\n', 'utf-8');

    const out = await continueRunToolHandler(
      { run_id: runId, prompt: 'why did you flag line 42?' },
      extra,
      depsFor(h),
    );
    expect(out.isError).toBeUndefined();
    await awaitTerminal(h, runId);

    const state = h.runStateStore.read(runId);
    expect(state?.status).toBe('success');
    expect(state?.prompts).toHaveLength(2);
    // FROZEN: the follow-up reasons about exactly what was reviewed — the
    // host's newer edits must NOT have been re-synced in.
    expect(readFileSync(join(worktreePath, 'reviewed.txt'), 'utf-8')).toBe('v1\n');
    expect(existsSync(join(worktreePath, 'brand-new.txt'))).toBe(false);
    // Mode is sticky across continues; still never mergeable.
    expect(state?.runMode).toBe('ephemeral_review');
    const merge = await mergeRunToolHandler({ run_id: runId, confirmed: true }, depsFor(h));
    expect(merge.isError).toBe(true);
  });

  it('control: a write-run continue DOES re-sync host changes in', async () => {
    const h = harnessWith([makeMockAdapter({ name: 'codex' })]);
    const result = await dispatchRunAgentInternal({
      input: { agent_id: 'codex', prompt: 'implement' } as never,
      ctx: h.ctx,
    });
    await awaitTerminal(h, result.runId);

    writeFileSync(join(h.root, 'later.txt'), 'host edit between turns\n', 'utf-8');
    const out = await continueRunToolHandler(
      { run_id: result.runId, prompt: 'keep going' },
      extra,
      depsFor(h),
    );
    expect(out.isError).toBeUndefined();
    await awaitTerminal(h, result.runId);
    expect(readFileSync(join(result.worktreePath, 'later.txt'), 'utf-8'))
      .toBe('host edit between turns\n');
  });
});

describe('reviewDispatchMode — capability matrix + proxy/instance parity', () => {
  it('resolves the default to read-only-dispatch; only explicit ephemeral-worktree opts in', () => {
    expect(resolveReviewDispatchMode({})).toBe('read-only-dispatch');
    expect(resolveReviewDispatchMode({ reviewDispatchMode: undefined })).toBe('read-only-dispatch');
    expect(resolveReviewDispatchMode({ reviewDispatchMode: 'ephemeral-worktree' }))
      .toBe('ephemeral-worktree');
    expect(resolveReviewDispatchMode({ reviewDispatchMode: 'unsupported' })).toBe('unsupported');
  });

  it('populates the full builtin matrix identically on the lazy proxy and the loaded instance', async () => {
    const expected: Record<string, string> = {
      'claude-code': 'read-only-dispatch',
      codex: 'read-only-dispatch',
      'gemini-cli': 'read-only-dispatch',
      agy: 'ephemeral-worktree',
    };
    const registry = createBuiltinRegistry();
    for (const [name, mode] of Object.entries(expected)) {
      // Proxy (pre-load) — what planRunAgent sees on a cold registry.get.
      const fresh = createBuiltinRegistry();
      expect(fresh.get(name)?.reviewDispatchMode).toBe(mode);
      // Loaded instance must agree (proxy/instance parity).
      const loaded = await registry.load(name);
      expect(loaded?.reviewDispatchMode).toBe(mode);
    }
    // Alias regression: alias lookups resolve to the same capability.
    expect(createBuiltinRegistry().get('claude')?.reviewDispatchMode).toBe('read-only-dispatch');
  });
});

describe('schema/description parity', () => {
  it('run_agent + continue_run descriptions document the new lifecycle', () => {
    expect(RUN_AGENT_DESCRIPTION).toContain('run_mode');
    expect(RUN_AGENT_DESCRIPTION).toContain('ephemeral_review');
    expect(CONTINUE_RUN_DESCRIPTION).toContain('ephemeral_review');
    expect(CONTINUE_RUN_DESCRIPTION.toLowerCase()).toContain('frozen');
  });
});
